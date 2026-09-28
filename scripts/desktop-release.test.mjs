import assert from 'node:assert/strict';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import test from 'node:test';
import { prepareRelease, finalizeRelease, installerFiles } from './desktop-release.mjs';
import { mergedReleaseSha } from './release-event.mjs';
import { fixture, installers, releaseEvent, repository, sha } from './test-fixtures.mjs';

function github() {
  const state = { tag: null, release: null, writes: [], uploads: 0 };
  const tools = {
    git: (...args) => args[0] === 'rev-parse' ? sha : '',
    api: async (method, path, body) => {
      if (method === 'GET') {
        if (path.includes('/git/ref/tags/')) return state.tag ? { object: { type: 'commit', sha: state.tag } } : null;
        if (path.includes('/releases/')) return structuredClone(state.release);
      }
      state.writes.push({ method, path, body });
      if (method === 'POST' && path.endsWith('/git/refs')) state.tag = body.sha;
      else if (method === 'POST' && path.endsWith('/releases')) state.release = { id: 123, ...body, assets: [] };
      else if (method === 'PATCH') Object.assign(state.release, body);
      else if (method !== 'POST') assert.fail(`Unexpected API call ${method} ${path}`);
      return structuredClone(state.release);
    },
    upload: async (_repository, _tag, files) => {
      state.uploads++;
      state.release.assets = await Promise.all(files.map(async (file) => ({ name: basename(file), size: (await stat(file)).size })));
    },
  };
  return { state, tools };
}

const finalizeOptions = (root) => ({ repository, tag: 'v1.2.3', sha, releaseId: '123', root });

test('only a merged same-repository release PR can start a release', () => {
  assert.equal(mergedReleaseSha(releaseEvent(), repository), sha);
  const mutations = [
    (event) => { event.action = 'opened'; },
    (event) => { event.pull_request.merged = false; },
    (event) => { event.pull_request.head.ref = 'feature'; },
    (event) => { event.pull_request.head.repo.full_name = 'fork/jira-client'; },
    (event) => { event.pull_request.base.ref = 'other'; },
  ];
  for (const mutate of mutations) {
    const event = releaseEvent();
    mutate(event);
    assert.throws(() => mergedReleaseSha(event, repository), /Only a merged/);
  }
});

test('preparation creates a tag at the merged SHA and draft with reviewed notes before building', async (t) => {
  const root = await fixture(t);
  const { state, tools } = github();
  const result = await prepareRelease(releaseEvent(), repository, root, tools);
  assert.deepEqual(result, { tag: 'v1.2.3', sha, release_id: '123', build: 'true' });
  assert.equal(state.tag, sha);
  assert.equal(state.release.draft, true);
  assert.equal(state.release.body, '### Patch Changes\n\n- Reviewed release notes.');
  assert.equal(state.uploads, 0);
  assert.equal(state.writes.length, 2);
  const retry = await prepareRelease(releaseEvent(), repository, root, tools);
  assert.deepEqual(retry, result);
  assert.equal(state.writes.length, 2, 'retry must reuse tag and draft');
});

test('wrong checkout, off-main source, and an existing tag at another commit cannot release', async (t) => {
  const root = await fixture(t);
  const { state, tools } = github();
  await assert.rejects(prepareRelease(releaseEvent(), repository, root, { ...tools, git: () => 'b'.repeat(40) }), /Checkout does not match/);
  await assert.rejects(prepareRelease(releaseEvent(), repository, root, { ...tools, git: (...args) => {
    if (args[0] === 'merge-base') throw new Error('not on main');
    return args[0] === 'rev-parse' ? sha : '';
  } }), /not on main/);
  state.tag = 'b'.repeat(40);
  await assert.rejects(prepareRelease(releaseEvent(), repository, root, tools), /different commit/);
  assert.equal(state.writes.length, 0);
});

test('missing installer leaves draft unpublished with no uploads', async (t) => {
  const root = await fixture(t);
  const artifacts = join(root, 'artifacts');
  await installers(artifacts);
  await rm(join(artifacts, 'linux-arm64/client_aarch64.AppImage'));
  const { state, tools } = github();
  await prepareRelease(releaseEvent(), repository, root, tools);
  await assert.rejects(finalizeRelease(finalizeOptions(artifacts), tools), /Unexpected installers/);
  assert.equal(state.release.draft, true);
  assert.equal(state.uploads, 0);
});

test('all five installers upload and verify before automatic publication', async (t) => {
  const root = await fixture(t);
  const artifacts = join(root, 'artifacts');
  await installers(artifacts);
  const { state, tools } = github();
  await prepareRelease(releaseEvent(), repository, root, tools);
  await finalizeRelease(finalizeOptions(artifacts), tools);
  assert.equal(state.release.assets.length, 5);
  assert.equal(state.release.draft, false);
  assert.equal(state.uploads, 1);
  const writeCount = state.writes.length;
  assert.equal((await prepareRelease(releaseEvent(), repository, root, tools)).build, 'false');
  await finalizeRelease(finalizeOptions(artifacts), tools);
  assert.equal(state.writes.length, writeCount);
  assert.equal(state.uploads, 1, 'published assets must never be overwritten');
});

test('partial uploads, tag changes and release identity mismatches stop publication', async (t) => {
  const root = await fixture(t);
  const artifacts = join(root, 'artifacts');
  await installers(artifacts);
  for (const failure of ['upload', 'tag', 'identity']) {
    const { state, tools } = github();
    await prepareRelease(releaseEvent(), repository, root, tools);
    const originalUpload = tools.upload;
    tools.upload = async (...args) => {
      await originalUpload(...args);
      if (failure === 'upload') state.release.assets.pop();
      if (failure === 'tag') state.tag = 'b'.repeat(40);
    };
    if (failure === 'identity') state.release.tag_name = 'v9.9.9';
    await assert.rejects(finalizeRelease(finalizeOptions(artifacts), tools), /Upload verification|Tag changed|identity does not match/);
    assert.equal(state.release.draft, true);
  }
});

test('a manually published incomplete release is not rebuilt or modified', async (t) => {
  const root = await fixture(t);
  const { state, tools } = github();
  await prepareRelease(releaseEvent(), repository, root, tools);
  state.release.draft = false;
  await assert.rejects(prepareRelease(releaseEvent(), repository, root, tools), /Published release is missing/);
  assert.equal(state.writes.length, 2);
});

test('artifact directories and filenames distinguish every platform', async (t) => {
  const root = await fixture(t);
  const artifacts = join(root, 'artifacts');
  await installers(artifacts);
  assert.equal((await installerFiles(artifacts)).length, 5);
  await mkdir(join(artifacts, 'macos-arm64/extra'));
  await assert.rejects(installerFiles(artifacts), /Unexpected installers/);
});

test('published completion requires each architecture, not just five installer extensions', async (t) => {
  const root = await fixture(t);
  const { state, tools } = github();
  await prepareRelease(releaseEvent(), repository, root, tools);
  state.release.draft = false;
  state.release.assets = [
    { name: 'one_amd64.deb', size: 1 }, { name: 'two_amd64.deb', size: 1 },
    { name: 'one_amd64.AppImage', size: 1 }, { name: 'two_amd64.AppImage', size: 1 },
    { name: 'client_aarch64.dmg', size: 1 },
  ];
  await assert.rejects(prepareRelease(releaseEvent(), repository, root, tools), /Published release is missing/);
  assert.equal(state.writes.length, 2);
});
