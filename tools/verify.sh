#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
cd "$ROOT"
if [[ ! -f firmware/build/qemu_flash.bin || ! -x "$ESPEMU_TOOLS/qemu/build/qemu-system-xtensa" ]]; then
    bash tools/bootstrap.sh
    bash tools/build-qemu.sh
    bash tools/build-firmware.sh
fi
for kind in qemu firmware; do
    status=0
    bash tools/artifact-provenance.sh check "$kind" || status=$?
    if [[ "$status" != 0 && ( "$status" != 2 || ${ESPEMU_REQUIRE_PROVENANCE:-0} == 1 ) ]]; then exit "$status"; fi
done
if [[ ! -d node_modules ]]; then npm ci --no-audit --no-fund; fi
bash tools/build-gpio-fixture.sh
bash tools/build-framework-fixtures.sh
bash tools/build-ws2812-fixture.sh
npm run build
node --test tools/gate.test.mjs
npm test
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$ROOT/.cache/playwright}"
if [[ ! -d "$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-1169" ]]; then
    PLAYWRIGHT_HOST_PLATFORM_OVERRIDE="${PLAYWRIGHT_HOST_PLATFORM_OVERRIDE:-ubuntu24.04-x64}" npm exec playwright install chromium
fi
PORT="${TEST_PORT:-4100}" npm run test:e2e
PORT="${PROJECT_TEST_PORT:-4120}" npm run test:e2e -- --config playwright.project.config.ts
PORT="${MATRIX_TEST_PORT:-4122}" npm run test:e2e -- --config playwright.matrix.config.ts
npm run test:creator
if [[ "${SOAK:-0}" == 1 ]]; then
    PORT="${TEST_PORT:-4100}" npm run test:e2e -- --config playwright.soak.config.ts
fi
