import { execFileSync } from 'node:child_process';
import { appendFile, readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergedReleaseSha } from './release-event.mjs';
import { changelogNotes, validateVersions } from './release-version.mjs';

function githubApi(method, path, body) {
  try {
    const args = ['api', '--method', method, path];
    if (body) args.push('--input', '-');
    return JSON.parse(execFileSync('gh', args, {
      encoding: 'utf8', input: body ? JSON.stringify(body) : undefined, stdio: ['pipe', 'pipe', 'pipe'],
    }));
  } catch (error) {
    if (method === 'GET' && /\(HTTP 404\)/.test(String(error.stderr))) return null;
    throw new Error(`GitHub ${method} ${path} failed: ${String(error.stderr || error.message).trim()}`);
  }
}

const defaultTools = {
  api: githubApi,
  git: (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim(),
  upload: (repository, tag, files) => execFileSync('gh', ['release', 'upload', tag, ...files, '--clobber', '--repo', repository], { stdio: 'inherit' }),
};

async function tagCommit(api, repository, tag) {
  const ref = await api('GET', `repos/${repository}/git/ref/tags/${tag}`);
  if (!ref) return null;
  let object = ref.object;
  // Resolve annotated as well as lightweight tags, without trusting target_commitish.
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
    const annotated = await api('GET', `repos/${repository}/git/tags/${object.sha}`);
    object = annotated?.object;
  }
  if (object?.type !== 'commit') throw new Error(`Tag ${tag} does not resolve to a commit`);
  return object.sha;
}

// Tauri 2 names each bundle with an architecture suffix.
const installerSuffixes = {
  'linux-x64': ['_amd64.deb', '_amd64.AppImage'],
  'linux-arm64': ['_arm64.deb', '_aarch64.AppImage'],
  'macos-arm64': ['_aarch64.dmg'],
};

function completePublishedRelease(release) {
  const assets = release.assets ?? [];
  const complete = Object.values(installerSuffixes).flat().every((suffix) =>
    assets.filter((asset) => asset.name.endsWith(suffix) && asset.size > 0).length === 1);
  if (!complete) throw new Error('Published release is missing expected installers; refusing to modify it');
}

export async function prepareRelease(event, repository, root = process.cwd(), tools = defaultTools) {
  const sha = mergedReleaseSha(event, repository);
  if (tools.git('rev-parse', 'HEAD') !== sha) throw new Error('Checkout does not match the release merge commit');
  tools.git('fetch', '--no-tags', 'origin', 'main');
  tools.git('merge-base', '--is-ancestor', sha, 'FETCH_HEAD');
  const version = await validateVersions(root);
  const tag = `v${version}`;
  const notes = changelogNotes(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), version);
  const prefix = `repos/${repository}`;
  const existingSha = await tagCommit(tools.api, repository, tag);
  if (existingSha && existingSha !== sha) throw new Error(`Tag ${tag} points to a different commit`);
  let release = await tools.api('GET', `${prefix}/releases/tags/${tag}`);
  if (release && release.tag_name !== tag) throw new Error('Release tag does not match');
  if (release && !existingSha) throw new Error('Existing release has no matching tag');
  if (release && !release.draft) {
    completePublishedRelease(release);
    return { tag, sha, release_id: String(release.id), build: 'false' };
  }
  if (!existingSha) await tools.api('POST', `${prefix}/git/refs`, { ref: `refs/tags/${tag}`, sha });
  if (!release) {
    release = await tools.api('POST', `${prefix}/releases`, {
      tag_name: tag, target_commitish: sha, name: tag, body: notes, draft: true, prerelease: false,
    });
  }
  return { tag, sha, release_id: String(release.id), build: 'true' };
}

export async function installerFiles(root) {
  const files = [];
  for (const [platform, extensions] of Object.entries(installerSuffixes)) {
    const directory = join(root, platform);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length !== extensions.length || entries.some((entry) => !entry.isFile())) throw new Error(`Unexpected installers in ${platform}`);
    for (const extension of extensions) {
      const matches = entries.filter((entry) => entry.name.endsWith(extension));
      if (matches.length !== 1) throw new Error(`Expected one ${extension} in ${platform}`);
      const file = join(directory, matches[0].name);
      if ((await stat(file)).size === 0) throw new Error(`Empty installer: ${file}`);
      files.push(file);
    }
  }
  if (new Set(files.map((file) => basename(file))).size !== files.length) throw new Error('Installer names must be unique across architectures');
  return files;
}

export async function finalizeRelease({ repository, tag, sha, releaseId, root }, tools = defaultTools) {
  if (await tagCommit(tools.api, repository, tag) !== sha) throw new Error(`Tag ${tag} points to a different commit`);
  const path = `repos/${repository}/releases/${releaseId}`;
  let release = await tools.api('GET', path);
  if (!release || String(release.id) !== String(releaseId) || release.tag_name !== tag) throw new Error('Release identity does not match');
  if (!release.draft) {
    completePublishedRelease(release);
    return 'Release already published; left unchanged.';
  }
  const files = await installerFiles(root);
  await tools.upload(repository, tag, files);
  release = await tools.api('GET', path);
  if (!release?.draft || release.tag_name !== tag) throw new Error('Release changed while uploading; publication stopped');
  for (const file of files) {
    const matches = (release.assets ?? []).filter((asset) => asset.name === basename(file));
    if (matches.length !== 1 || matches[0].size !== (await stat(file)).size) throw new Error(`Upload verification failed: ${basename(file)}`);
  }
  if (await tagCommit(tools.api, repository, tag) !== sha) throw new Error('Tag changed while uploading; publication stopped');
  await tools.api('PATCH', path, { draft: false });
  return `Published ${tag} with all five installers.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'prepare') {
      const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
      const output = await prepareRelease(event, process.env.GITHUB_REPOSITORY);
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''));
      console.log(JSON.stringify(output));
    } else if (process.argv[2] === 'finalize') {
      console.log(await finalizeRelease({ repository: process.env.GITHUB_REPOSITORY, tag: process.env.RELEASE_TAG,
        sha: process.env.RELEASE_SHA, releaseId: process.env.RELEASE_ID, root: resolve(process.argv[3] ?? 'installers') }));
    } else throw new Error('Expected prepare or finalize');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
