import { validateVersions } from './release-version.mjs';

try {
  const [tag, root] = process.argv.slice(2);
  const version = await validateVersions(root, tag);
  console.log(`Release version ${version} matches all package versions.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
