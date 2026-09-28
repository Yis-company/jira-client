import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionField(section, label) {
  const matches = [...section.matchAll(/^(version\s*=\s*")([^"]+)("[^\n]*)$/gm)];
  if (matches.length !== 1) throw new Error(`Expected one version field in ${label}`);
  return matches[0];
}

function tomlSection(text, header, label) {
  const sections = [...text.matchAll(/^\[[^\n]+\][^\S\n]*\r?$/gm)];
  const matching = sections.filter((match) => match[0].trim() === header);
  if (matching.length !== 1) throw new Error(`Expected one ${header} section in ${label}`);
  const start = matching[0].index;
  const end = sections.find((match) => match.index > start)?.index ?? text.length;
  return { start, end, text: text.slice(start, end) };
}

function lockSection(text) {
  const starts = [...text.matchAll(/^\[\[package\]\]\s*$/gm)];
  const sections = starts.map((match, index) => {
    const start = match.index;
    const end = starts[index + 1]?.index ?? text.length;
    return { start, end, text: text.slice(start, end) };
  }).filter((section) => /^name\s*=\s*"jira-client"\s*$/m.test(section.text));
  if (sections.length !== 1) throw new Error('Expected one jira-client package in src-tauri/Cargo.lock');
  return sections[0];
}

export async function readVersions(root = process.cwd()) {
  const paths = ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
  const texts = await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8')));
  const cargo = tomlSection(texts[2], '[package]', paths[2]);
  const lock = lockSection(texts[3]);
  const versions = [JSON.parse(texts[0]).version, JSON.parse(texts[1]).version,
    versionField(cargo.text, paths[2])[2], versionField(lock.text, paths[3])[2]];
  return { paths, texts, versions, cargo, lock };
}

export async function validateVersions(root = process.cwd(), tag) {
  const data = await readVersions(root);
  const version = data.versions[0];
  if (typeof version !== 'string' || !stableVersion.test(version)) throw new Error('Expected a stable package version');
  if (tag !== undefined && (tag !== `v${version}` || !stableVersion.test(tag.slice(1)))) {
    throw new Error(`Expected a stable vMAJOR.MINOR.PATCH tag matching package.json; received ${tag}`);
  }
  const mismatches = data.paths.filter((_, i) => data.versions[i] !== version);
  if (mismatches.length) throw new Error(`Release versions do not match package.json: ${mismatches.join(', ')}`);
  return version;
}

export async function syncVersions(root = process.cwd()) {
  const { paths, texts, versions, cargo, lock } = await readVersions(root);
  const version = versions[0];
  if (typeof version !== 'string' || !stableVersion.test(version)) throw new Error('Expected a stable package version');
  // All fields are validated before any write; replace only the existing version values.
  const config = texts[1];
  const jsonMatches = [...config.matchAll(/"version"\s*:\s*"[^"]*"/g)];
  if (jsonMatches.length !== 1) throw new Error('Expected one version field in src-tauri/tauri.conf.json');
  const replacements = [
    config.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`),
    ...[cargo, lock].map((section, i) => texts[i + 2].slice(0, section.start)
      + section.text.replace(/^(version\s*=\s*")[^"]+("[^\n]*)$/m, `$1${version}$2`)
      + texts[i + 2].slice(section.end)),
  ];
  for (let i = 0; i < replacements.length; i++) {
    if (replacements[i] !== texts[i + 1]) await writeFile(join(root, paths[i + 1]), replacements[i]);
  }
  return version;
}

export function changelogNotes(changelog, version) {
  const headings = [...changelog.matchAll(/^## (\S+)\s*$/gm)];
  const matching = headings.filter((heading) => heading[1] === version);
  if (matching.length !== 1) throw new Error(`Expected one changelog section for ${version}`);
  const heading = matching[0];
  const end = headings.find((item) => item.index > heading.index)?.index ?? changelog.length;
  const notes = changelog.slice(heading.index + heading[0].length, end).trim();
  if (!notes) throw new Error(`Empty changelog section for ${version}`);
  return notes;
}
