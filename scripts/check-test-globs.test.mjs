// Tests for scripts/check-test-globs.mjs: a test pattern that matches nothing must fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expand, globProblems, testPatterns } from './check-test-globs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(scripts) {
  const dir = mkdtempSync(join(tmpdir(), 'antara-test-globs-'));
  mkdirSync(join(dir, 'src/a'), { recursive: true });
  writeFileSync(join(dir, 'src/a/one.test.ts'), '');
  writeFileSync(join(dir, 'src/a/helper.ts'), '');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
  return dir;
}

test('finds the test patterns in a script', () => {
  assert.deepEqual(testPatterns('tsx --test src/a/*.test.ts src/b/*.test.ts && echo done'), ['src/a/*.test.ts', 'src/b/*.test.ts']);
  assert.deepEqual(testPatterns('node --test scripts/doctor.test.mjs'), ['scripts/doctor.test.mjs']);
});

test('a pattern that matches nothing, a missing script or an unsupported wildcard fails', () => {
  const dir = fixture({ ok: 'tsx --test src/a/*.test.ts', empty: 'tsx --test src/a/*.test.ts src/gone/*.test.ts', deep: 'tsx --test src/*/one.test.ts' });
  try {
    assert.deepEqual(expand('src/a/*.test.ts', dir), ['src/a/one.test.ts']);
    assert.deepEqual(globProblems(join(dir, 'package.json'), 'ok'), []);
    assert.deepEqual(globProblems(join(dir, 'package.json'), 'empty'), ['empty: "src/gone/*.test.ts" matches no test file.']);
    assert.match(globProblems(join(dir, 'package.json'), 'deep')[0], /file name only/);
    assert.match(globProblems(join(dir, 'package.json'), 'missing')[0], /no such script/);
    const run = spawnSync(process.execPath, [join(root, 'scripts/check-test-globs.mjs'), 'empty', '--package', join(dir, 'package.json')], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /matches no test file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every test pattern in ANTARA’s own test scripts matches at least one file', () => {
  for (const script of ['test:unit', 'test:config']) assert.deepEqual(globProblems(join(root, 'package.json'), script), [], script);
  assert.deepEqual(globProblems(join(root, 'server/package.json'), 'test'), []);
});
