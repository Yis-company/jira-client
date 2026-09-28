import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { changelogNotes, syncVersions, validateVersions } from './release-version.mjs';
import { checkChangeset } from './check-changeset.mjs';
import { fixture, releaseEvent, repository } from './test-fixtures.mjs';

test('accepts matching stable release versions, with or without a tag', async (t) => {
  const root = await fixture(t);
  assert.equal(await validateVersions(root), '1.2.3');
  assert.equal(await validateVersions(root, 'v1.2.3'), '1.2.3');
  for (const tag of ['1.2.3', 'v1.2', 'v1.2.3-rc.1', 'v01.2.3', 'v1.2.4']) {
    await assert.rejects(validateVersions(root, tag), /stable vMAJOR.MINOR.PATCH/);
  }
});

test('rejects a mismatch in each native version location', async (t) => {
  for (const location of ['src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
    const root = await fixture(t);
    const path = join(root, location);
    await writeFile(path, (await readFile(path, 'utf8')).replace('1.2.3', '1.2.4'));
    await assert.rejects(validateVersions(root), (error) => error.message.includes(location));
  }
});

test('sync changes only app version values and preserves formatting and dependencies', async (t) => {
  const root = await fixture(t);
  const paths = ['src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
  const originals = await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8')));
  await writeFile(join(root, 'package.json'), '{"version":"2.0.0"}');
  await syncVersions(root);
  assert.equal(await validateVersions(root), '2.0.0');
  for (const [i, path] of paths.entries()) assert.equal(await readFile(join(root, path), 'utf8'), originals[i].replace('1.2.3', '2.0.0'));
  await syncVersions(root);
  assert.equal(await validateVersions(root), '2.0.0');
});

test('malformed native versions fail before any files are modified', async (t) => {
  for (const malformed of ['[package]\nname="jira-client"\n[dependencies.other]\nversion="9.0.0"\n', '[package]\nversion="1.0.0"\nversion="2.0.0"\n']) {
    const root = await fixture(t);
    await writeFile(join(root, 'src-tauri/Cargo.toml'), malformed);
    const before = await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8');
    await assert.rejects(syncVersions(root), /Expected one version/);
    assert.equal(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'), before);
  }
});

test('duplicate root lock entries and missing Tauri version are rejected', async (t) => {
  const root = await fixture(t);
  const lock = join(root, 'src-tauri/Cargo.lock');
  await writeFile(lock, (await readFile(lock, 'utf8')) + '\n[[package]]\nname="jira-client"\nversion="1.2.3"\n');
  await assert.rejects(syncVersions(root), /Expected one jira-client/);
  const other = await fixture(t);
  await writeFile(join(other, 'src-tauri/tauri.conf.json'), '{}');
  await assert.rejects(syncVersions(other), /Expected one version/);
});

test('release notes select only the reviewed version and reject missing or duplicate sections', () => {
  const notes = '# App\n\n## 1.2.3\n\nReviewed.\n\n## 1.2.2\nOld.';
  assert.equal(changelogNotes(notes, '1.2.3'), 'Reviewed.');
  assert.throws(() => changelogNotes(notes, '9.0.0'), /Expected one changelog/);
  assert.throws(() => changelogNotes(notes + '\n## 1.2.3\nOther.', '1.2.3'), /Expected one changelog/);
  assert.throws(() => changelogNotes('## 1.2.3\n', '1.2.3'), /Empty changelog/);
});

test('ordinary PR uses its base SHA and must not bump versions manually', async (t) => {
  const root = await fixture(t);
  const event = releaseEvent();
  event.pull_request.head.ref = 'feature/example';
  const commands = [];
  await checkChangeset(event, repository, root, (command, args) => {
    commands.push([command, args]);
    return '{"version":"1.2.3"}';
  });
  assert.deepEqual(commands[1], ['pnpm', ['exec', 'changeset', 'status', '--since', 'b'.repeat(40)]]);
  await assert.rejects(checkChangeset(event, repository, root, () => '{"version":"1.0.0"}'), /Version bumps belong/);
});

test('release PR skips new-note requirement but validates reviewed changelog; fork branch does not bypass', async (t) => {
  const root = await fixture(t);
  const event = releaseEvent();
  await checkChangeset(event, repository, root, () => assert.fail('release PR must not require a new changeset'));
  event.pull_request.head.repo.full_name = 'fork/jira-client';
  let ranStatus = false;
  await checkChangeset(event, repository, root, (command) => {
    if (command === 'pnpm') ranStatus = true;
    return '{"version":"1.2.3"}';
  });
  assert.equal(ranStatus, true);
  event.pull_request.head.repo.full_name = repository;
  await writeFile(join(root, 'CHANGELOG.md'), '## 1.0.0\nOld.');
  await assert.rejects(checkChangeset(event, repository, root), /Expected one changelog/);
});
