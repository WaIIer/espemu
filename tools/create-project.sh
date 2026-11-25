#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
espemu_prepare_web
for argument in "$@"; do
    if [[ "$argument" == --web ]]; then espemu_ensure_web_bundle || exit; break; fi
done
exec node --import "$ROOT/node_modules/tsx/dist/loader.mjs" "$ROOT/tools/project-creator.ts" "$@"
