import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReleasePr } from './release-event.mjs';
import { changelogNotes, validateVersions } from './release-version.mjs';

export async function checkChangeset(event, repository, root = process.cwd(), run = execFileSync) {
  if (isReleasePr(event, repository)) {
    const version = await validateVersions(root);
    changelogNotes(await readFile(resolve(root, 'CHANGELOG.md'), 'utf8'), version);
    return 'Validated release PR versions and changelog; consumed notes need no replacement.';
  }
  const base = event.pull_request?.base?.sha;
  if (!/^[a-f0-9]{40}$/.test(base ?? '')) throw new Error('Missing or invalid PR base commit');
  run('pnpm', ['exec', 'changeset', 'status', '--since', base], { cwd: root, stdio: 'inherit' });
  return 'Changeset metadata validated.';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    console.log(await checkChangeset(event, process.env.GITHUB_REPOSITORY));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
