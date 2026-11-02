#!/bin/sh
set -eu
cd "$(git rev-parse --show-toplevel)"
unset $(git rev-parse --local-env-vars)
export PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=error
pnpm check
