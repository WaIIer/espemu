#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$ROOT/versions.env"
SOURCE="$ROOT/.cache/qemu"
if [[ ${ESPEMU_TOOLS_ROOT:-} == "$ROOT" ]]; then SOURCE="$ESPEMU_TOOLS/qemu"; fi
PATCH="$ROOT/qemu/espemu.patch"
[[ $(git -C "$SOURCE" rev-parse HEAD) == "$QEMU_COMMIT" ]]
STAGING=$(mktemp -d "$ROOT/qemu/.patch-export.XXXXXXXX")
trap 'rm -rf -- "$STAGING"' EXIT
export GIT_INDEX_FILE="$STAGING/index"
git -C "$SOURCE" read-tree HEAD
git -C "$SOURCE" add -N hw/sensor/espemu.c hw/sensor/bh1750.c hw/sensor/bme280.c hw/sensor/mpu6050.c hw/sensor/sht3x.c include/hw/sensor/espemu.h hw/misc/esp32_rmt.c include/hw/misc/esp32_rmt.h hw/gpio/espemu_max7219.c include/hw/gpio/espemu_max7219.h hw/misc/esp32_i2s.c include/hw/misc/esp32_i2s.h hw/sensor/espemu_ov2640.c hw/sensor/hd44780.c hw/sensor/espemu_speaker.c
git -C "$SOURCE" diff HEAD --check
CANDIDATE="$STAGING/espemu.patch"
git -C "$SOURCE" diff HEAD --binary > "$CANDIDATE"
[[ -s "$CANDIDATE" ]]
git -C "$SOURCE" apply --numstat "$PATCH" | cut -f3 > "$STAGING/required"
git -C "$SOURCE" apply --numstat "$CANDIDATE" | cut -f3 > "$STAGING/actual"
while IFS= read -r path; do
	grep -Fxq -- "$path" "$STAGING/actual" || { printf 'Missing QEMU integration: %s\n' "$path" >&2; exit 1; }
done < "$STAGING/required"
git -C "$SOURCE" apply --reverse --check "$CANDIDATE"
git -C "$SOURCE" read-tree HEAD
git -C "$SOURCE" apply --cached --check "$CANDIDATE"
git -C "$SOURCE" apply --stat "$CANDIDATE"
chmod --reference="$PATCH" "$CANDIDATE"
mv -f -- "$CANDIDATE" "$PATCH"
