#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
espemu_prepare_web
exec node --import "$ROOT/node_modules/tsx/dist/loader.mjs" "$ROOT/tools/project-artifacts.ts" "$@"
