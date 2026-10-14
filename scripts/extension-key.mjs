#!/usr/bin/env node
// Creates (or reuses) the ANTARA extension signing key OUTSIDE the repository and
// prints only PUBLIC data: the manifest "key" (base64 DER SubjectPublicKeyInfo)
// and the resulting stable Chrome extension ID. The private key is never printed.
//
//   node scripts/extension-key.mjs            # reuse or create, print public JSON
//   node scripts/extension-key.mjs --check    # fail if extension/extension-key.json differs
//   node scripts/extension-key.mjs --public-key <base64>
//                                             # ID for a public key from the Chrome Web Store
//                                             # dashboard (Package tab, View public key)
//
// Override the location with ANTARA_EXTENSION_KEY=<path to PKCS#8 PEM>.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function storeKeyResult(text) {
  const base64 = String(text ?? '').replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
  let der;
  try {
    der = createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' }).export({ type: 'spki', format: 'der' });
  } catch {
    console.error('--public-key needs the base64 public key from the Chrome Web Store dashboard.');
    process.exit(1);
  }
  return { id: extensionIdFromDer(der), key: der.toString('base64') };
}
const keyPath = process.env.ANTARA_EXTENSION_KEY || join(homedir(), '.antara', 'extension-signing-key.pem');
if (resolve(keyPath).toLowerCase().startsWith(root.toLowerCase())) {
  console.error('Refusing to keep the extension signing key inside the repository.');
  process.exit(1);
}

export function extensionIdFromDer(der) {
  return createHash('sha256').update(der).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
}

if (process.argv.includes('--public-key')) {
  console.log(JSON.stringify(storeKeyResult(process.argv[process.argv.indexOf('--public-key') + 1]), null, 2));
  process.exit(0);
}

let privatePem;
if (existsSync(keyPath)) {
  privatePem = readFileSync(keyPath, 'utf8');
} else {
  if (process.argv.includes('--check')) { console.error(`No signing key at ${keyPath}.`); process.exit(1); }
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
  privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, privatePem, { mode: 0o600, flag: 'wx' });
  console.error(`Created a new extension signing key at ${keyPath}. Back it up privately.`);
}
const der = createPublicKey(createPrivateKey(privatePem)).export({ type: 'spki', format: 'der' });
const result = { id: extensionIdFromDer(der), key: der.toString('base64') };

if (process.argv.includes('--check')) {
  const committed = JSON.parse(readFileSync(join(root, 'extension', 'extension-key.json'), 'utf8'));
  if (committed.id !== result.id || committed.key !== result.key) {
    console.error('extension/extension-key.json does not match the local signing key.');
    process.exit(1);
  }
  console.log(`Extension key matches: ${result.id}`);
} else {
  console.log(JSON.stringify(result, null, 2));
}
