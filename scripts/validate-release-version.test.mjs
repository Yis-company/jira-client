import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = fileURLToPath(new URL('./validate-release-version.mjs', import.meta.url));

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'release-version-'));
  await mkdir(join(root, 'src-tauri'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(join(root, 'src-tauri/Cargo.toml'), '[package]\nname = "jira-client"\nversion = "1.2.3"\n\n[dependencies]\nversion = "99.0.0"\n');
  await writeFile(join(root, 'src-tauri/Cargo.lock'), '[[package]]\nname = "jira-client"\nversion = "1.2.3"\n');
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function validate(tag, root) {
  return spawnSync(process.execPath, [script, tag, root], { encoding: 'utf8' });
}

test('accepts a stable tag when all four package versions agree', async () => {
  await withFixture((root) => {
    const result = validate('v1.2.3', root);
    assert.equal(result.status, 0, result.stderr);
  });
});

test('rejects malformed and prerelease tags', async () => {
  await withFixture((root) => {
    for (const tag of ['1.2.3', 'v1.2', 'v1.2.3-rc.1']) {
      const result = validate(tag, root);
      assert.equal(result.status, 1, `${tag} should fail`);
      assert.match(result.stderr, /stable vMAJOR\.MINOR\.PATCH/);
    }
  });
});

test('rejects a mismatch in each authoritative version location', async () => {
  for (const location of ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
    await withFixture(async (root) => {
      const path = join(root, location);
      const contents = await readFile(path, 'utf8');
      if (location.endsWith('.json')) {
        const data = JSON.parse(contents);
        await writeFile(path, JSON.stringify({ ...data, version: '1.2.4' }));
      } else {
        await writeFile(path, contents.replace('version = "1.2.3"', 'version = "1.2.4"'));
      }
      const result = validate('v1.2.3', root);
      assert.equal(result.status, 1, `${location} mismatch should fail`);
      assert.ok(result.stderr.includes(location), result.stderr);
    });
  }
});
