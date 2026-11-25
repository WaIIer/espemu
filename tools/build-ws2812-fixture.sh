#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
source "$IDF_PATH/export.sh" >/dev/null
cd "$ROOT/tests/fixtures/ws2812"
idf.py -B "$ROOT/.cache/ws2812" build
cd "$ROOT/.cache/ws2812"
esptool.py --chip esp32 merge_bin --fill-flash-size 4MB -o qemu_flash.bin @flash_args
