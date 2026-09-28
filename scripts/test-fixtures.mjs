import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const repository = 'example/jira-client';
export const sha = 'a'.repeat(40);
export const releaseEvent = () => ({ action: 'closed', pull_request: {
  merged: true, merge_commit_sha: sha,
  base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: repository } },
  head: { ref: 'changeset-release/main', repo: { full_name: repository } },
} });

export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jira-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src-tauri'));
  await writeFile(join(root, 'package.json'), '{"name":"jira-client","private":true,"version":"1.2.3"}\n');
  await writeFile(join(root, 'src-tauri/tauri.conf.json'), '{ "version": "1.2.3", "productName": "Jira Client" }\n');
  await writeFile(join(root, 'src-tauri/Cargo.toml'), '[package]\nname = "jira-client"\nversion = "1.2.3" # keep this\n\n[dependencies.other]\nversion = "99.0.0"\n');
  await writeFile(join(root, 'src-tauri/Cargo.lock'), 'version = 3\n\n[[package]]\nname = "another"\nversion = "7.0.0"\n\n[[package]]\nname = "jira-client"\nversion = "1.2.3"\ndependencies = ["another"]\n\n[[package]]\nname = "last"\nversion = "8.0.0"\n');
  await writeFile(join(root, 'CHANGELOG.md'), '# jira-client\n\n## 1.2.3\n\n### Patch Changes\n\n- Reviewed release notes.\n\n## 1.2.2\n\nOld notes.\n');
  return root;
}

export async function installers(root) {
  const files = [];
  for (const [platform, names] of Object.entries({ 'linux-x64': ['client_amd64.deb', 'client_amd64.AppImage'], 'linux-arm64': ['client_arm64.deb', 'client_aarch64.AppImage'], 'macos-arm64': ['client_aarch64.dmg'] })) {
    await mkdir(join(root, platform), { recursive: true });
    for (const name of names) {
      await writeFile(join(root, platform, name), 'installer');
      files.push({ name, size: 9 });
    }
  }
  return files;
}
