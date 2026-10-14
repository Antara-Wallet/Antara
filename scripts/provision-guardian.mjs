#!/usr/bin/env node
/**
 * Provision ANTARA's Solana paired-vault guardian (G) as a Privy server wallet.
 *
 * The OWNER runs this by hand. Nothing in the app, CI or deploy runs it.
 *
 *   node scripts/provision-guardian.mjs --generate-admin-key <path>
 *       Offline helper: writes a new P-256 admin PRIVATE key (PKCS#8 PEM, mode
 *       0600) to <path> and prints only its public key. Keep that file offline.
 *
 *   node scripts/provision-guardian.mjs --admin-public-key <base64-spki|file> --dry-run
 *       Validates inputs and prints the planned Privy API calls. No network,
 *       no key generation, no file writes.
 *
 *   node scripts/provision-guardian.mjs --admin-public-key <base64-spki|file> (--write-env | --key-out <path>)
 *       1. Generates the server P-256 authorization key pair and stores the
 *          private key first (in server/.env with --write-env, or a new 0600
 *          file with --key-out). The private key is never printed.
 *       2. Creates key quorum OWNER = {server, admin}, threshold 2.
 *       3. Creates key quorum SIGNER = {server}, threshold 1.
 *       4. Creates a deny-by-default Solana policy owned by OWNER that allows
 *          signAndSendTransaction/signTransaction only when every instruction
 *          is Squads v4 proposal_approve (programId + IDL instruction name).
 *          ComputeBudget is NOT allowed by default: Privy cannot cap the
 *          compute-unit price, so allowing it lets the server key drain G's SOL
 *          through fees. --allow-compute-budget opts in; such a guardian fails
 *          --verify-policy by design.
 *       5. Creates the Solana server wallet owned by OWNER, with the policy, and
 *          SIGNER as an additional signer bound to the same policy.
 *       Prints only public ids and addresses.
 *
 *   node scripts/provision-guardian.mjs --verify-policy [--server-env server/.env]
 *       Live acceptance check of the Privy policy with the 1-of-1 signer key
 *       alone (sign only, never broadcast; random multisig and blockhash): a
 *       proposal_approve must be signed. A SOL transfer, approve+transfer, a
 *       ComputeBudget-only transaction, approve with a priority fee, reject,
 *       cancel, proposal_create, signMessage, rawSign (hash and bytes), the
 *       transfer action and key export must each be refused, and a refusal
 *       only counts when Privy says it is a policy violation (export: an
 *       authorization refusal). Any other error is reported as FAIL.
 *
 *   node scripts/provision-guardian.mjs --probe-user-jwt <file> [--server-env server/.env]
 *       Go-live gate for the 2-of-2 claim. <file> holds the access token of a
 *       TEST user of the DEV app (never a real user). Checks whether Privy's
 *       user-JWT exchange gives a server holding only that token a session
 *       key for the user's wallets, then confirms with a harmless signMessage
 *       and a signTransaction with a random blockhash (never broadcast) as the
 *       user's embedded Solana wallet (U). If the exchange succeeds or either
 *       is signed, a compromised ANTARA server could act as U.
 *
 * Needs PRIVY_APP_ID and PRIVY_APP_SECRET in the environment or server/.env
 * (never printed). Uses the SDK installed in server/node_modules/@privy-io/node.
 * See docs/GUARDIAN.md.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENV = join(ROOT, 'server', '.env');
export const SQUADS_PROGRAM_ID = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const PROPOSAL_APPROVE_DISCRIMINATOR = [144, 37, 164, 136, 188, 216, 42, 248];
const ENV = {
  authKey: 'ANTARA_GUARDIAN_AUTH_KEY',
  walletId: 'ANTARA_GUARDIAN_SOLANA_WALLET_ID',
  address: 'ANTARA_GUARDIAN_SOLANA_ADDRESS',
  policyId: 'ANTARA_GUARDIAN_POLICY_ID',
  signerId: 'ANTARA_GUARDIAN_SIGNER_ID',
  ownerId: 'ANTARA_GUARDIAN_OWNER_QUORUM_ID',
};

/** Anchor >= 0.30 IDL subset for Squads v4 proposal_approve (accounts in on-chain order). */
export const PROPOSAL_APPROVE_IDL = Object.freeze({
  address: SQUADS_PROGRAM_ID,
  metadata: { name: 'squads_multisig_program', version: '2.0.0', spec: '0.1.0' },
  instructions: [{
    name: 'proposal_approve',
    discriminator: PROPOSAL_APPROVE_DISCRIMINATOR,
    accounts: [{ name: 'multisig' }, { name: 'member', writable: true, signer: true }, { name: 'proposal', writable: true }],
    args: [{ name: 'args', type: { defined: { name: 'ProposalVoteArgs' } } }],
  }],
  types: [{ name: 'ProposalVoteArgs', type: { kind: 'struct', fields: [{ name: 'memo', type: { option: 'string' } }] } }],
});

/**
 * Deny-by-default guardian policy rules (Privy evaluates every Solana
 * instruction; every one must be allowed). The server never adds a
 * ComputeBudget instruction, so it is allowed only on explicit opt-in.
 */
export function guardianPolicyRules({ computeBudget = false } = {}) {
  const approve = [
    { field_source: 'solana_program_instruction', field: 'programId', operator: 'eq', value: SQUADS_PROGRAM_ID },
    // Not in the @privy-io/node 0.35.0 type union; documented at
    // https://docs.privy.io/controls/policies/example-policies/solana-idls
    { field_source: 'solana_instruction_data', idl: PROPOSAL_APPROVE_IDL, field: 'instruction_name', operator: 'eq', value: 'proposal_approve' },
  ];
  const rules = [];
  for (const method of ['signAndSendTransaction', 'signTransaction']) {
    rules.push({ name: `Squads approve only (${method})`, method, action: 'ALLOW', conditions: approve });
    if (computeBudget) rules.push({ name: `Compute budget (${method})`, method, action: 'ALLOW', conditions: [{ field_source: 'solana_program_instruction', field: 'programId', operator: 'eq', value: COMPUTE_BUDGET_PROGRAM_ID }] });
  }
  return rules;
}

export function parseArgs(argv) {
  const options = { dryRun: false, writeEnv: false, computeBudget: false, name: 'ANTARA guardian (Solana)', envFile: SERVER_ENV };
  let budgetFlags = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value.`); return value; };
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--write-env') options.writeEnv = true;
    else if (arg === '--allow-compute-budget') { options.computeBudget = true; budgetFlags += 1; }
    else if (arg === '--no-compute-budget') { options.computeBudget = false; budgetFlags += 1; } // the default; accepted for clarity
    else if (arg === '--admin-public-key') options.adminPublicKey = next();
    else if (arg === '--key-out') options.keyOut = resolve(next());
    else if (arg === '--server-env') options.envFile = resolve(next());
    else if (arg === '--name') options.name = next();
    else if (arg === '--generate-admin-key') options.generateAdminKey = resolve(next());
    else if (arg === '--verify-policy') options.verifyPolicy = true;
    else if (arg === '--probe-user-jwt') options.probeUserJwt = resolve(next());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument ${arg}. Run with --help.`);
  }
  if (budgetFlags > 1) throw new Error('Choose at most one of --allow-compute-budget or --no-compute-budget.');
  if (options.help || options.generateAdminKey || options.verifyPolicy || options.probeUserJwt) return options;
  if (!options.adminPublicKey) throw new Error('--admin-public-key is required: your OFFLINE admin P-256 public key (base64 SPKI DER, or a PEM/DER file).');
  if (!options.dryRun && options.writeEnv === !!options.keyOut) throw new Error('Choose exactly one of --write-env or --key-out <path> for the server private key (it is never printed).');
  if (!/^[\w ().-]{1,60}$/.test(options.name)) throw new Error('--name must be 1-60 plain characters.');
  return options;
}

/** Normalises the admin public key to base64 SPKI DER and proves it is P-256. */
export function normaliseAdminPublicKey(input) {
  let source = input.trim();
  if (existsSync(source)) source = readFileSync(source);
  if (source.includes('PRIVATE KEY')) throw new Error('That is a PRIVATE key. Provide only the admin PUBLIC key; keep the private key offline.');
  let key;
  try {
    if (Buffer.isBuffer(source) && source.includes('-----BEGIN')) key = createPublicKey(source.toString('utf8'));
    else if (Buffer.isBuffer(source)) key = createPublicKey({ key: source, format: 'der', type: 'spki' });
    else if (source.includes('-----BEGIN')) key = createPublicKey(source);
    else key = createPublicKey({ key: Buffer.from(source, 'base64'), format: 'der', type: 'spki' });
  } catch { throw new Error('The admin public key could not be parsed. Provide a P-256 public key as base64 SPKI DER or a PEM file.'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('The admin key must be a P-256 (prime256v1) public key.');
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

function generateP256() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKeyPkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  };
}

/** Secrets may only land in files git ignores (or outside the repository). */
function assertNotTracked(path) {
  const rel = relative(ROOT, path);
  if (rel.startsWith('..') || isAbsolute(rel)) return;
  const result = spawnSync('git', ['check-ignore', '-q', rel], { cwd: ROOT });
  if (result.status !== 0) throw new Error(`${rel} is inside the repository and not git-ignored. Refusing to write a secret there.`);
}
function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function plannedCalls(options, adminPublicKey, serverPublicKey = '<generated server P-256 public key>') {
  return [
    { call: 'privy.keyQuorums().create', body: { display_name: `${options.name} owner`, public_keys: [serverPublicKey, adminPublicKey], authorization_threshold: 2 } },
    { call: 'privy.keyQuorums().create', body: { display_name: `${options.name} signer`, public_keys: [serverPublicKey], authorization_threshold: 1 } },
    { call: 'privy.policies().create', body: { version: '1.0', name: `${options.name} policy`, chain_type: 'solana', owner_id: '<owner quorum id>', rules: guardianPolicyRules(options) } },
    { call: 'privy.wallets().create', body: { chain_type: 'solana', display_name: options.name, owner_id: '<owner quorum id>', policy_ids: ['<policy id>'], additional_signers: [{ signer_id: '<signer quorum id>', override_policy_ids: ['<policy id>'] }] } },
  ];
}

async function provision(options) {
  const adminPublicKey = normaliseAdminPublicKey(options.adminPublicKey);
  const fileEnv = readEnvFile(SERVER_ENV);
  const appId = process.env.PRIVY_APP_ID || fileEnv.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET || fileEnv.PRIVY_APP_SECRET;

  if (options.computeBudget) console.log('WARNING: --allow-compute-budget lets the server key make G pay any priority fee. Such a guardian fails --verify-policy and must not be used for releases.');
  if (options.dryRun) {
    console.log('Dry run: no network calls, no keys generated, no files written.');
    console.log(`Admin public key (normalised): ${adminPublicKey}`);
    console.log(`PRIVY_APP_ID: ${appId ? 'present' : 'MISSING'}; PRIVY_APP_SECRET: ${appSecret ? 'present' : 'MISSING'}`);
    console.log(`Server private key destination: ${options.writeEnv ? options.envFile : options.keyOut ?? '(choose --write-env or --key-out)'}`);
    console.log(JSON.stringify(plannedCalls(options, adminPublicKey), null, 2));
    return;
  }
  if (!appId || !appSecret) throw new Error('Set PRIVY_APP_ID and PRIVY_APP_SECRET (environment or server/.env) first.');

  // Validate destinations before generating anything.
  if (options.writeEnv) {
    assertNotTracked(options.envFile);
    const existing = readEnvFile(options.envFile);
    const present = Object.values(ENV).filter(name => existing[name]);
    if (present.length) throw new Error(`${options.envFile} already contains ${present.join(', ')}. Remove them deliberately before provisioning a new guardian.`);
  } else {
    assertNotTracked(options.keyOut);
    if (existsSync(options.keyOut)) throw new Error(`${options.keyOut} already exists. Choose a new path.`);
  }

  const require = createRequire(join(ROOT, 'server', 'package.json'));
  const { PrivyClient } = require('@privy-io/node');
  const privy = new PrivyClient({ appId, appSecret });
  // Read-only credential check, so a typo never leaves a stored key with nothing bound to it.
  try { await privy.wallets().list({ limit: 1 }); }
  catch (error) { throw new Error(`Privy rejected the app credentials or is unreachable${error?.status ? ` (status ${error.status})` : ''}. Nothing was created or written.`); }
  const server = generateP256();
  if (server.publicKey === adminPublicKey) throw new Error('Unexpected key collision.');

  // Persist the server private key FIRST, so a later failure never orphans resources bound to an unknown key.
  const stamp = new Date().toISOString();
  if (options.writeEnv) appendFileSync(options.envFile, `\n# ANTARA paired-vault guardian, provisioned ${stamp} by scripts/provision-guardian.mjs\n${ENV.authKey}=${server.privateKeyPkcs8}\n`, { mode: 0o600 });
  else writeFileSync(options.keyOut, `${server.privateKeyPem}`, { flag: 'wx', mode: 0o600 });
  console.log(`Server authorization private key stored in ${options.writeEnv ? options.envFile : options.keyOut} (not printed).`);

  const runId = randomUUID();
  const [ownerBody, signerBody, policyBody, walletBody] = plannedCalls(options, adminPublicKey, server.publicKey).map(item => item.body);
  const owner = await privy.keyQuorums().create(ownerBody);
  const signer = await privy.keyQuorums().create(signerBody);
  const policy = await privy.policies().create({ ...policyBody, owner_id: owner.id, idempotency_key: `antara-guardian-policy-${runId}` });
  const wallet = await privy.wallets().create({
    ...walletBody, owner_id: owner.id, policy_ids: [policy.id],
    additional_signers: [{ signer_id: signer.id, override_policy_ids: [policy.id] }],
    idempotency_key: `antara-guardian-wallet-${runId}`,
  });
  if (wallet.chain_type !== 'solana' || wallet.owner_id !== owner.id || !wallet.policy_ids?.includes(policy.id)) throw new Error(`Privy returned an unexpected wallet configuration for ${wallet.id}. Do not use it; inspect it in the dashboard.`);

  const publicIds = { [ENV.walletId]: wallet.id, [ENV.address]: wallet.address, [ENV.policyId]: policy.id, [ENV.signerId]: signer.id, [ENV.ownerId]: owner.id };
  if (options.writeEnv) appendFileSync(options.envFile, `${Object.entries(publicIds).map(([name, value]) => `${name}=${value}`).join('\n')}\n`);
  console.log('\nGuardian provisioned. Public values only:');
  console.log(`  Owner key quorum (server + admin, 2 of 2): ${owner.id}`);
  console.log(`  Signer key quorum (server, 1 of 1):       ${signer.id}`);
  console.log(`  Policy (deny by default):                  ${policy.id}`);
  console.log(`  Solana guardian wallet id:                 ${wallet.id}`);
  console.log(`  Solana guardian address:                   ${wallet.address}`);
  console.log(`  Server authorization public key:           ${server.publicKey}`);
  console.log('\nNext steps (see docs/GUARDIAN.md):');
  if (!options.writeEnv) console.log(`  - Put the key from ${options.keyOut} into ${ENV.authKey} as base64 PKCS#8 DER (no PEM headers) on the server only.`);
  console.log(`  - Render (server only): ${ENV.authKey} (secret), ${Object.keys(publicIds).join(', ')}, DATA_DIR on the persistent disk.`);
  console.log(`  - Client build: VITE_ANTARA_GUARDIAN_SOLANA=${wallet.address}`);
  console.log('  - Fund the guardian address with a small SOL float (it pays its own vote fees).');
  console.log('  - Run the live negative policy test before enabling releases.');
}

/**
 * Classifies a Privy SDK error. Only a policy violation proves the policy held:
 * an unrelated 4xx (bad request shape, insufficient funds, unsupported chain)
 * proves nothing. Privy reports policy denials as 400 with code
 * `policy_violation`. Signers cannot export at all, so for export an
 * authorization refusal (401/403) also counts.
 */
export function classifyRefusal(error) {
  const status = typeof error?.status === 'number' ? error.status : null;
  const body = error?.error && typeof error.error === 'object' ? error.error : {};
  const code = typeof body.code === 'string' ? body.code : null;
  const message = String(body.error ?? body.message ?? error?.message ?? '');
  const clientError = status !== null && status >= 400 && status < 500;
  const policy = clientError && (code === 'policy_violation' || /policy[ _-]?violation|denied by (the )?polic|violat\w* (the |a |its )?polic/i.test(message));
  // Privy has no raw_sign for Solana wallets at all (verified 2026-10-13): the capability does not exist for G.
  const unsupported = status === 400 && code === 'invalid_data' && /solana wallets are not supported for this low-level signature endpoint/i.test(message);
  return { status, code, policy, unsupported, unauthorised: status === 401 || status === 403 };
}
/** PASS only for the expected outcome; 'allow' must sign, 'policy' needs a policy denial, 'policy-or-unsupported' a policy denial or Privy's
 *  'endpoint not supported for Solana wallets' refusal, 'owner-only' a policy or authorization denial. */
export function judgePolicyCase(expect, outcome) {
  if (outcome.signed) return expect === 'allow';
  if (expect === 'allow') return false;
  const refusal = classifyRefusal(outcome.error);
  if (expect === 'policy-or-unsupported') return refusal.policy || refusal.unsupported;
  return expect === 'policy' ? refusal.policy : refusal.policy || refusal.unauthorised;
}

/**
 * Live check, with the 1-of-1 signer key alone, that Privy's policy evaluates
 * EVERY instruction and every signing path. Uses signTransaction (sign only,
 * never broadcast) on throwaway transactions with a random multisig and
 * blockhash. Prints pass/fail per case and nothing secret.
 */
async function verifyPolicy(options) {
  const fileEnv = readEnvFile(options.envFile);
  const read = name => process.env[name] || fileEnv[name];
  const appId = read('PRIVY_APP_ID'), appSecret = read('PRIVY_APP_SECRET');
  const walletId = read(ENV.walletId), address = read(ENV.address), key = read(ENV.authKey)?.replace(/^wallet-auth:/, '');
  const missing = [['PRIVY_APP_ID', appId], ['PRIVY_APP_SECRET', appSecret], [ENV.walletId, walletId], [ENV.address, address], [ENV.authKey, key]].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')} (environment or ${options.envFile}).`);
  const require = createRequire(join(ROOT, 'server', 'package.json'));
  const { PrivyClient } = require('@privy-io/node');
  const web3 = await import('@solana/web3.js');
  const squads = await import('@sqds/multisig');
  const privy = new PrivyClient({ appId, appSecret });
  const guardian = new web3.PublicKey(address), attacker = web3.Keypair.generate().publicKey;
  const multisigPda = squads.getMultisigPda({ createKey: web3.Keypair.generate().publicKey })[0];
  const recentBlockhash = web3.Keypair.generate().publicKey.toBase58();
  const message = instructions => new web3.TransactionMessage({ payerKey: guardian, recentBlockhash, instructions }).compileToV0Message();
  const tx = instructions => new web3.VersionedTransaction(message(instructions)).serialize();
  const vote = { multisigPda, transactionIndex: 1n, member: guardian };
  const approve = () => squads.instructions.proposalApprove(vote);
  const transfer = web3.SystemProgram.transfer({ fromPubkey: guardian, toPubkey: attacker, lamports: 1 });
  const priority = web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000_000 });
  const computeLimit = web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  // An ed25519 signature over these exact bytes would be a valid signature for a SOL transfer out of G.
  const transferMessageHex = Buffer.from(message([transfer]).serialize()).toString('hex');
  const auth = { authorization_context: { authorization_private_keys: [key] } };
  const signTx = bytes => () => privy.wallets().solana().signTransaction(walletId, { transaction: bytes, ...auth });
  const cases = [
    ['proposal_approve by the guardian (positive control)', 'allow', signTx(tx([approve()]))],
    ['SOL transfer from the guardian', 'policy', signTx(tx([transfer]))],
    ['proposal_approve plus a SOL transfer in one transaction', 'policy', signTx(tx([approve(), transfer]))],
    ['ComputeBudget-only transaction (fee drain)', 'policy', signTx(tx([computeLimit, priority]))],
    ['proposal_approve with a priority fee', 'policy', signTx(tx([priority, approve()]))],
    ['proposal_reject by the guardian', 'policy', signTx(tx([squads.instructions.proposalReject(vote)]))],
    ['proposal_cancel by the guardian', 'policy', signTx(tx([squads.instructions.proposalCancel(vote)]))],
    ['proposal_create by the guardian', 'policy', signTx(tx([squads.instructions.proposalCreate({ multisigPda, transactionIndex: 1n, creator: guardian })]))],
    ['signMessage', 'policy', () => privy.wallets().solana().signMessage(walletId, { message: Buffer.from('ANTARA policy check'), ...auth })],
    ['rawSign {hash: a SOL-transfer message} (would be a valid transfer signature)', 'policy-or-unsupported', () => privy.wallets().rawSign(walletId, { params: { hash: `0x${transferMessageHex}` }, ...auth })],
    ['rawSign {bytes: a SOL-transfer message, sha256}', 'policy-or-unsupported', () => privy.wallets().rawSign(walletId, { params: { bytes: transferMessageHex, encoding: 'hex', hash_function: 'sha256' }, ...auth })],
    // To itself, so even a wrongly allowed transfer moves nothing but a fee.
    ['transfer action: 1 lamport of SOL', 'policy', () => privy.wallets().transfer(walletId, { source: { asset: 'sol', chain: 'solana' }, amount: '0.000000001', destination: { address }, ...auth })],
    ['exportPrivateKey with the signer key alone', 'owner-only', () => privy.wallets().exportPrivateKey(walletId, auth)],
    ['exportSeedPhrase with the signer key alone', 'owner-only', () => privy.wallets().exportSeedPhrase(walletId, auth)],
  ];
  let failures = 0;
  for (const [index, [name, expect, run]] of cases.entries()) {
    let outcome;
    // Results are discarded unread: an export that wrongly succeeds must never print key material.
    try { await run(); outcome = { signed: true }; } catch (error) { outcome = { signed: false, error }; }
    const ok = judgePolicyCase(expect, outcome);
    const refusal = outcome.signed ? null : classifyRefusal(outcome.error);
    const detail = outcome.signed ? (expect === 'allow' ? '' : ' (Privy ALLOWED it)') : ` (status ${refusal.status ?? 'none'}${refusal.code ? `, code ${refusal.code}` : ''}${ok ? '' : expect === 'allow' ? '' : '; refused for another reason, which proves nothing'})`;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${expect === 'allow' ? 'allowed' : 'denied '}  ${name}${detail}`);
    if (!ok) failures += 1;
    if (index === 0 && !ok) throw new Error('The positive control was not signed, so denials cannot be interpreted. Check the wallet id, key and policy.');
    if (expect === 'owner-only' && outcome.signed) console.log('      The guardian key was EXPORTED with the signer key alone. Treat this guardian as compromised and provision a new one.');
  }
  if (failures) throw new Error(`${failures} policy expectation(s) failed. Do not enable paired-vault releases.`);
  console.log('All guardian policy expectations hold. Record this run in docs/VERIFICATION.md.');
}

/**
 * Go-live gate: can a server that holds a user's Privy access token sign as
 * that user's embedded Solana wallet (U)? Uses a DEV-app TEST user only.
 * Prints the wallet address and flags, never the token.
 */
async function probeUserJwt(options) {
  const fileEnv = readEnvFile(options.envFile);
  const read = name => process.env[name] || fileEnv[name];
  const appId = read('PRIVY_APP_ID'), appSecret = read('PRIVY_APP_SECRET');
  if (!appId || !appSecret) throw new Error(`Missing PRIVY_APP_ID or PRIVY_APP_SECRET (environment or ${options.envFile}).`);
  let token;
  try { token = readFileSync(options.probeUserJwt, 'utf8').trim(); } catch { throw new Error('The access-token file could not be read.'); }
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new Error('The file must contain exactly one Privy access token (a JWT).');
  const require = createRequire(join(ROOT, 'server', 'package.json'));
  const { PrivyClient } = require('@privy-io/node');
  const web3 = await import('@solana/web3.js');
  const privy = new PrivyClient({ appId, appSecret });
  let userId;
  try { userId = (await privy.utils().auth().verifyAccessToken(token)).user_id; }
  catch { throw new Error('Privy did not accept that access token for this app. Use a fresh token of a dev-app test user.'); }
  const user = await privy.users()._get(userId);
  const wallet = user.linked_accounts.find(account => account.type === 'wallet' && account.chain_type === 'solana' && account.connector_type === 'embedded' && account.wallet_client_type === 'privy');
  if (!wallet?.id) throw new Error('That user has no Privy embedded Solana wallet with a wallet id.');
  console.log(`Test user's embedded Solana wallet (U): ${wallet.address}`);
  console.log(`  delegated: ${wallet.delegated}; user_can_sign: ${wallet.user_can_sign ?? 'not reported'}; imported: ${wallet.imported}`);
  const u = new web3.PublicKey(wallet.address);
  const noop = new web3.VersionedTransaction(new web3.TransactionMessage({
    payerKey: u, recentBlockhash: web3.Keypair.generate().publicKey.toBase58(),
    instructions: [web3.SystemProgram.transfer({ fromPubkey: u, toPubkey: u, lamports: 0 })],
  }).compileToV0Message()).serialize();
  const describe = refusal => `status ${refusal.status ?? 'none'}${refusal.code ? `, code ${refusal.code}` : ''}`;
  let exposed = 0, exchangeRefused = false;
  // Step 1, decisive: the SDK's user_jwts path first exchanges the token for a session key (internal helper in 0.35.0).
  const exchange = typeof privy._jwtExchange === 'function' ? privy._jwtExchange() : null;
  if (typeof exchange?.exchangeJwtForAuthorizationKey !== 'function') throw new Error('This @privy-io/node version has no JWT exchange helper. Update the probe before relying on it.');
  try {
    await exchange.exchangeJwtForAuthorizationKey(token); // the returned session key is discarded unread
    exposed += 1;
    console.log('FAIL  user-JWT exchange: Privy issued a session key for this user\'s wallets to a server holding only the access token.');
  } catch (error) {
    const refusal = classifyRefusal(error);
    exchangeRefused = refusal.status !== null && refusal.status >= 400 && refusal.status < 500;
    console.log(`${exchangeRefused ? 'PASS' : 'FAIL'}  user-JWT exchange: ${exchangeRefused ? 'refused' : 'no answer from Privy, which proves nothing'} (${describe(refusal)})`);
  }
  // Step 2, confirmation end to end.
  const auth = { authorization_context: { user_jwts: [token] } };
  const attempts = [
    ['signMessage as U with only the access token', () => privy.wallets().solana().signMessage(wallet.id, { message: Buffer.from(`ANTARA user-JWT probe ${new Date().toISOString()}`), ...auth })],
    ['signTransaction as U with only the access token (random blockhash, never broadcast)', () => privy.wallets().solana().signTransaction(wallet.id, { transaction: noop, ...auth })],
  ];
  for (const [name, run] of attempts) {
    try { await run(); exposed += 1; console.log(`FAIL  ${name}: Privy SIGNED.`); }
    catch (error) { console.log(`info  ${name}: not signed (${describe(classifyRefusal(error))})`); }
  }
  console.log('Delete the token file now; the token stays valid until it expires. Record these lines in docs/VERIFICATION.md.');
  if (exposed) throw new Error('A server holding a user access token can act as U. The paired vault is NOT an independent 2-of-2 against a compromised ANTARA server. Do not enable paired vaults; revisit the design (docs/GUARDIAN.md).');
  if (!exchangeRefused) throw new Error('The probe was inconclusive. Rerun it before enabling paired vaults.');
  console.log('A server holding only this access token could not act as U.');
}

function generateAdminKey(path) {
  assertNotTracked(path);
  if (existsSync(path)) throw new Error(`${path} already exists. Choose a new path.`);
  const key = generateP256();
  writeFileSync(path, key.privateKeyPem, { flag: 'wx', mode: 0o600 });
  // Sanity: the written key parses and matches.
  const check = createPublicKey(createPrivateKey(readFileSync(path, 'utf8'))).export({ format: 'der', type: 'spki' }).toString('base64');
  if (check !== key.publicKey) throw new Error('The admin key file could not be verified.');
  console.log(`Admin PRIVATE key written to ${path} (mode 0600). Move it offline; never upload it.`);
  console.log(`Admin PUBLIC key (pass to --admin-public-key): ${key.publicKey}`);
}

const HELP = (/\/\*\*([\s\S]*?)\*\//.exec(readFileSync(fileURLToPath(import.meta.url), 'utf8'))?.[1] ?? '')
  .split('\n').map(line => line.replace(/^ \* ?/, '')).join('\n').trim();
async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) { console.log(HELP); return; }
  if (options.generateAdminKey) { generateAdminKey(options.generateAdminKey); return; }
  if (options.verifyPolicy) { await verifyPolicy(options); return; }
  if (options.probeUserJwt) { await probeUserJwt(options); return; }
  await provision(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Requests carry only public keys; still keep Privy's error text short.
    const text = error instanceof Error ? error.message : String(error);
    console.error(`provision-guardian: ${error?.status ? `Privy request failed (status ${error.status}): ${text.slice(0, 300)}` : text}`);
    process.exitCode = 1;
  });
}
