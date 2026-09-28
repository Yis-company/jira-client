import { syncVersions } from './release-version.mjs';

try {
  console.log(`Synchronized native versions to ${await syncVersions()}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
