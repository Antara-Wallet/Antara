import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSecurityStore, writeSecurityStore } from './storage.js';

test('security storage fails closed for corrupt, null and array data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'solares-storage-'));
  const path = join(dir, 'policy.json');
  try {
    assert.deepEqual(readSecurityStore(path), {});
    for (const value of ['{broken', 'null', '[]', '"unsafe"']) {
      writeFileSync(path, value);
      assert.throws(() => readSecurityStore(path));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('atomic policy replacement preserves complete documents and leaves no staging files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'solares-storage-'));
  const path = join(dir, 'policy.json');
  try {
    writeSecurityStore(path, { safe: { requireWebauthn: true } });
    writeSecurityStore(path, { safe: { requireWebauthn: true, maxValueWei: '1' } });
    assert.deepEqual(readSecurityStore(path), { safe: { requireWebauthn: true, maxValueWei: '1' } });
    assert.deepEqual(readdirSync(dir), ['policy.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
