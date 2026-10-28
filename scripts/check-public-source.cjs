'use strict';

// Inspect the exact Git index, not local runtime directories or credential stores.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.length) throw new Error('No tracked files to check. Stage the intended source files first.');
const errors = [];
const forbidden = /(^|\/)(node_modules|dist|qa|recovery[^/]*|publish|runtime-[^/]*|Partitions|Local Storage|Session Storage|Network)(\/|$)|(^|\/)(sites\.json|agents\.json|agent-windows\.json|manual-snapshot\.json|Cookies|Login Data|Web Data|Local State|Preferences)(\.|$)|(^|\/)\.env(?:\.|$)|\.(exe|dll|pdb|dmp|log|pem|key|pfx|zip|7z)$/i;
const textFile = /\.(js|jsx|cjs|json|css|html|md|ps1|cs|manifest|yml|yaml|txt)$|(^|\/)(LICENSE|\.gitignore|\.gitattributes|pre-commit|pre-push)$/i;
const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential-like token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b/],
  ['absolute Windows path', /(?<![A-Za-z0-9])[A-Za-z]:[\\/]{1,2}(?![\\/])/],
  ['personal home path', /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
  ['URL containing credentials', /https?:\/\/[^/\s"']+:[^/\s"']+@/],
];
for (const file of files) {
  if (forbidden.test(file) || /^src\/(?:ui-dist|native\/bin)\//.test(file)) errors.push(`${file}: generated or private file`);
  const content = execFileSync('git', ['show', ':' + file], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  if (content.length > 10 * 1024 * 1024) errors.push(`${file}: large file belongs in a release asset`);
  if (textFile.test(file)) {
    const text = content.toString('utf8');
    for (const [name, pattern] of rules) if (pattern.test(text)) errors.push(`${file}: ${name}`);
  }
}
const presets = JSON.parse(execFileSync('git', ['show', ':src/agent-presets.json'], { cwd: root, encoding: 'utf8' }));
for (const preset of presets) {
  if ('selectedWindow' in preset || 'protectedWindows' in preset) errors.push('src/agent-presets.json: machine-specific window references');
  if (preset.launchPath) errors.push('src/agent-presets.json: release defaults must not contain local launch paths');
}
const pkg = JSON.parse(execFileSync('git', ['show', ':package.json'], { cwd: root, encoding: 'utf8' }));
const lock = JSON.parse(execFileSync('git', ['show', ':package-lock.json'], { cwd: root, encoding: 'utf8' }));
if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) errors.push('Version mismatch between package and lockfile');
for (const file of files.filter(file => /\.(js|cjs)$/.test(file))) {
  try { execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' }); }
  catch { errors.push(`${file}: JavaScript syntax check failed`); }
}
const readme = execFileSync('git', ['show', ':README.md'], { cwd: root, encoding: 'utf8' });
if (!readme.includes('https://github.com/chthollyphile/folia-major')) errors.push('README.md: Folia inspiration credit missing');
for (const match of readme.matchAll(/\]\(([^)]+)\)/g)) {
  const target = match[1].split('#')[0];
  if (target && !/^https?:/.test(target) && !files.includes(target)) errors.push(`README.md: untracked or missing link ${target}`);
}
if (errors.length) {
  // Report only filenames and rule names, never matching values.
  console.error(errors.join('\n')); process.exitCode = 1;
} else console.log(`Public-source check passed: ${files.length} files, version ${pkg.version}.`);
