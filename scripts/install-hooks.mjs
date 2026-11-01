import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
const repository = git('rev-parse', '--show-toplevel');
if (repository.error) throw repository.error;
if (repository.status !== 0 || resolve(repository.stdout.trim()) !== resolve(root)) {
  console.log('Skipping hook installation: this source directory is not a Git checkout.');
  process.exit(0);
}

const configured = git('config', '--get', 'core.hooksPath');
if (configured.status === 0) throw new Error('Cannot install pre-push hook: core.hooksPath is configured. Integrate scripts/pre-push.sh into your hooks manually.');
if (configured.status !== 1) throw new Error(`Cannot inspect core.hooksPath: ${configured.stderr.trim()}`);

const hook = resolve(root, execFileSync('git', ['rev-parse', '--git-path', 'hooks/pre-push'], { cwd: root, encoding: 'utf8' }).trim());
const content = '#!/bin/sh\nexec sh "$(git rev-parse --show-toplevel)/scripts/pre-push.sh" "$@"\n';
mkdirSync(dirname(hook), { recursive: true });
try {
  writeFileSync(hook, content, { flag: 'wx', mode: 0o755 });
} catch (error) {
  if (error.code !== 'EEXIST' || !lstatSync(hook).isFile() || readFileSync(hook, 'utf8') !== content) {
    throw new Error(`Cannot install pre-push hook at ${hook}; preserve and integrate the existing hook manually.`, { cause: error });
  }
}
chmodSync(hook, 0o755);
console.log('Pre-push hook installed.');
