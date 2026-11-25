#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
source "$IDF_PATH/export.sh" >/dev/null
for fixture in empty-firmware multi-sensor gyro-firmware device-sdk max7219; do
    cd "$ROOT/tests/fixtures/$fixture"
    idf.py -B "$ROOT/.cache/$fixture" build
    cd "$ROOT/.cache/$fixture"
    esptool.py --chip esp32 merge_bin --fill-flash-size 4MB -o qemu_flash.bin @flash_args
done
