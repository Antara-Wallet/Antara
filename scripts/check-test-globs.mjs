#!/usr/bin/env node
// Fails when a test file pattern in a package.json script matches no file.
// Node's test runner treats a pattern that matches nothing as zero tests and
// exits 0, so a moved or renamed test folder would silently drop its coverage.
//
//   node scripts/check-test-globs.mjs <script name> [--package <path to package.json>]
//
// Patterns are the script's arguments that end in .test.ts, .test.mjs or .test.js.
// A `*` is supported in the file name only (dir/*.test.ts), which is every form
// the ANTARA scripts use; anything else is refused rather than guessed.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = /\.test\.(?:ts|mjs|js)$/;

/** Test file patterns among a script's arguments. */
export function testPatterns(script) {
  return script.split(/\s+/).filter(argument => TEST_FILE.test(argument));
}

/** Files a `dir/name*.test.ts` pattern matches, relative to `base`. */
export function expand(pattern, base) {
  const slash = pattern.lastIndexOf('/');
  const dir = slash === -1 ? '.' : pattern.slice(0, slash);
  const name = pattern.slice(slash + 1);
  if (/[*?[\]{}]/.test(dir)) throw new Error(`${pattern}: wildcards are supported in the file name only.`);
  if (/[?[\]{}]/.test(name)) throw new Error(`${pattern}: only "*" is supported.`);
  const directory = resolve(base, dir);
  if (!existsSync(directory)) return [];
  const matcher = new RegExp(`^${name.split('*').map(part => part.replace(/[.+^${}()|\\]/g, '\\$&')).join('[^/]*')}$`);
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && matcher.test(entry.name)).map(entry => `${dir}/${entry.name}`);
}

/** Problems for one package script: a missing script, no test patterns, or a pattern that matches nothing. */
export function globProblems(packagePath, scriptName) {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const script = pkg.scripts?.[scriptName];
  if (typeof script !== 'string') return [`${scriptName}: no such script in ${packagePath}.`];
  const patterns = testPatterns(script);
  if (!patterns.length) return [`${scriptName}: no test file patterns found.`];
  const base = dirname(packagePath);
  return patterns.flatMap(pattern => {
    try { return expand(pattern, base).length ? [] : [`${scriptName}: "${pattern}" matches no test file.`]; }
    catch (error) { return [`${scriptName}: ${error.message}`]; }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const scriptName = args.find(argument => !argument.startsWith('--') && args[args.indexOf(argument) - 1] !== '--package');
  const packagePath = resolve(args.includes('--package') ? args[args.indexOf('--package') + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
  if (!scriptName) { console.error('Usage: node scripts/check-test-globs.mjs <script name> [--package <package.json>]'); process.exit(2); }
  const problems = globProblems(packagePath, scriptName);
  if (problems.length) {
    for (const problem of problems) console.error(`  error: ${problem}`);
    console.error('A test pattern that matches nothing runs zero tests and still passes; fix the pattern or the folder.');
    process.exit(1);
  }
}
