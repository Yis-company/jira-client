#!/bin/sh
set -eu
cd "$(git rev-parse --show-toplevel)"
unset $(git rev-parse --local-env-vars)
pnpm exec tsc -b
pnpm test
node --test scripts/*.test.mjs
