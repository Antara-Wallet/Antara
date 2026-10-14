import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COMPUTE_BUDGET_PROGRAM_ID, SQUADS_PROGRAM_ID, classifyRefusal, guardianPolicyRules, judgePolicyCase, parseArgs,
} from './provision-guardian.mjs';

const programIds = rules => rules.flatMap(rule => rule.conditions.filter(condition => condition.field === 'programId').map(condition => condition.value));

describe('guardian policy rules', () => {
  it('allow only Squads proposal_approve by default, never ComputeBudget', () => {
    const rules = guardianPolicyRules();
    assert.deepEqual(rules.map(rule => rule.method), ['signAndSendTransaction', 'signTransaction']);
    assert.ok(rules.every(rule => rule.action === 'ALLOW'));
    assert.deepEqual(programIds(rules), [SQUADS_PROGRAM_ID, SQUADS_PROGRAM_ID]);
    assert.ok(rules.every(rule => rule.conditions.some(condition => condition.field === 'instruction_name' && condition.value === 'proposal_approve')));
    assert.ok(!programIds(rules).includes(COMPUTE_BUDGET_PROGRAM_ID));
  });
  it('add ComputeBudget only on explicit opt-in', () => {
    assert.ok(programIds(guardianPolicyRules({ computeBudget: true })).includes(COMPUTE_BUDGET_PROGRAM_ID));
  });
});

describe('parseArgs', () => {
  const key = 'MFkw';
  it('defaults to no ComputeBudget and accepts one explicit choice', () => {
    assert.equal(parseArgs(['--admin-public-key', key, '--dry-run']).computeBudget, false);
    assert.equal(parseArgs(['--admin-public-key', key, '--dry-run', '--no-compute-budget']).computeBudget, false);
    assert.equal(parseArgs(['--admin-public-key', key, '--dry-run', '--allow-compute-budget']).computeBudget, true);
    assert.throws(() => parseArgs(['--admin-public-key', key, '--dry-run', '--allow-compute-budget', '--no-compute-budget']), /at most one/);
  });
  it('takes the user-JWT probe with a token file and no admin key', () => {
    const options = parseArgs(['--probe-user-jwt', 'token.txt']);
    assert.match(options.probeUserJwt, /token\.txt$/);
    assert.throws(() => parseArgs(['--probe-user-jwt']), /needs a value/);
  });
});

describe('policy check verdicts', () => {
  const error = (status, body) => Object.assign(new Error(`${status ?? ''} ${JSON.stringify(body ?? {})}`), { status, error: body });
  it('count only a policy violation as proof that the policy held', () => {
    assert.equal(classifyRefusal(error(400, { error: 'Policy violation', code: 'policy_violation' })).policy, true);
    assert.equal(classifyRefusal(error(403, { error: 'Request denied by policy rule' })).policy, true);
    assert.equal(classifyRefusal(error(400, { error: 'Invalid request body', code: 'invalid_data' })).policy, false);
    // Privy refuses raw_sign for every Solana wallet: the capability does not exist, which counts as denied.
    const unsupported = classifyRefusal(error(400, { error: 'solana wallets are not supported for this low-level signature endpoint.', code: 'invalid_data' }));
    assert.equal(unsupported.unsupported, true);
    assert.equal(judgePolicyCase('policy-or-unsupported', { signed: false, error: error(400, { error: 'solana wallets are not supported for this low-level signature endpoint.', code: 'invalid_data' }) }), true);
    assert.equal(judgePolicyCase('policy-or-unsupported', { signed: false, error: error(400, { error: 'Invalid request body', code: 'invalid_data' }) }), false);
    assert.equal(judgePolicyCase('policy-or-unsupported', { signed: true }), false);
    assert.equal(classifyRefusal(error(400, { error: 'Insufficient funds' })).policy, false);
    assert.equal(classifyRefusal(error(500, { code: 'policy_violation' })).policy, false, 'a server error is not a policy decision');
    assert.equal(classifyRefusal(new Error('fetch failed')).policy, false);
    assert.equal(classifyRefusal(error(401, { error: 'Invalid authorization signature' })).unauthorised, true);
  });
  it('judge each expectation strictly', () => {
    const policy = { signed: false, error: error(400, { code: 'policy_violation' }) };
    const unrelated = { signed: false, error: error(400, { error: 'Invalid request body' }) };
    const unauthorised = { signed: false, error: error(401, { error: 'Missing owner signature' }) };
    assert.equal(judgePolicyCase('allow', { signed: true }), true);
    assert.equal(judgePolicyCase('allow', policy), false);
    assert.equal(judgePolicyCase('policy', policy), true);
    assert.equal(judgePolicyCase('policy', { signed: true }), false);
    assert.equal(judgePolicyCase('policy', unrelated), false);
    assert.equal(judgePolicyCase('policy', unauthorised), false);
    assert.equal(judgePolicyCase('owner-only', unauthorised), true);
    assert.equal(judgePolicyCase('owner-only', policy), true);
    assert.equal(judgePolicyCase('owner-only', unrelated), false);
    assert.equal(judgePolicyCase('owner-only', { signed: true }), false);
  });
});
