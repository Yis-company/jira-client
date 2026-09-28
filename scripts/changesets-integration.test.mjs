import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixture } from './test-fixtures.mjs';
import { syncVersions, validateVersions } from './release-version.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/@changesets/cli/bin.js', import.meta.url));

async function changesetsFixture(t) {
  const root = await fixture(t);
  await mkdir(join(root, '.changeset'));
  await copyFile(join(project, '.changeset/config.json'), join(root, '.changeset/config.json'));
  await copyFile(join(project, 'pnpm-workspace.yaml'), join(root, 'pnpm-workspace.yaml'));
  // Resolve the configured changelog generator without installing a second dependency tree.
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Release test', '-c', 'user.email=release@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture'], { cwd: root, stdio: 'pipe' });
  return root;
}

function changeset(root, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

test('actual Changesets versions the private root app, writes notes and synchronizes native metadata', async (t) => {
  const root = await changesetsFixture(t);
  await writeFile(join(root, '.changeset/example.md'), '---\n"jira-client": minor\n---\n\nAdd a reviewed feature.\n');
  execFileSync('git', ['add', '.changeset/example.md'], { cwd: root });
  changeset(root, 'version');
  await syncVersions(root);
  assert.equal(await validateVersions(root), '1.3.0');
  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /## 1\.3\.0/);
  assert.match(changelog, /Add a reviewed feature/);
  await assert.rejects(readFile(join(root, '.changeset/example.md')), { code: 'ENOENT' });
});

test('actual Changesets status rejects missing notes and accepts an explicit empty maintenance note', async (t) => {
  const root = await changesetsFixture(t);
  await writeFile(join(root, 'app.js'), 'export const changed = true;\n');
  execFileSync('git', ['add', 'app.js'], { cwd: root });
  const missing = spawnSync(process.execPath, [cli, 'status', '--since', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(missing.status, 1, `${missing.stdout}\n${missing.stderr}`);
  await writeFile(join(root, '.changeset/maintenance.md'), '---\n---\n');
  execFileSync('git', ['add', '.changeset/maintenance.md'], { cwd: root });
  changeset(root, 'status', '--since', 'HEAD');
});
