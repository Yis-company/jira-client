import { readFile } from 'node:fs/promises';

const [tag, root = process.cwd()] = process.argv.slice(2);
const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag ?? '');

if (!match) {
  console.error(`Expected a stable vMAJOR.MINOR.PATCH tag; received ${tag ?? '(missing)'}`);
  process.exit(1);
}

const taggedVersion = match.slice(1).join('.');
const [packageJson, tauriConfig, cargoToml, cargoLock] = await Promise.all([
  readFile(`${root}/package.json`, 'utf8'),
  readFile(`${root}/src-tauri/tauri.conf.json`, 'utf8'),
  readFile(`${root}/src-tauri/Cargo.toml`, 'utf8'),
  readFile(`${root}/src-tauri/Cargo.lock`, 'utf8'),
]);

const versions = {
  'package.json': JSON.parse(packageJson).version,
  'src-tauri/tauri.conf.json': JSON.parse(tauriConfig).version,
  'src-tauri/Cargo.toml': /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1],
};
const rootPackage = /^\[\[package\]\]\s*\nname = "jira-client"\s*\nversion = "([^"]+)"/m.exec(cargoLock);
versions['src-tauri/Cargo.lock jira-client'] = rootPackage?.[1];

const mismatches = Object.entries(versions).filter(([, version]) => version !== taggedVersion);
if (mismatches.length) {
  console.error(`Tag ${tag} does not match ${taggedVersion} in all release version files:`);
  for (const [file, version] of mismatches) console.error(`- ${file}: ${version ?? '(not found)'}`);
  process.exit(1);
}

console.log(`Release tag ${tag} matches all package versions.`);
