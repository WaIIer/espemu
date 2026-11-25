#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
PROJECT_DIR=$(realpath -e "${1:-$ROOT/firmware}")
if [[ ! -f "$PROJECT_DIR/CMakeLists.txt" ]]; then
	printf 'Not an ESP-IDF project: %s\n' "$PROJECT_DIR" >&2
	exit 2
fi
JOBS=${BUILD_JOBS:-2}
if [[ ! "$JOBS" =~ ^[1-9][0-9]*$ ]]; then
	printf 'BUILD_JOBS must be a positive integer.\n' >&2
	exit 2
fi
source "$IDF_PATH/export.sh" >/dev/null
cd "$PROJECT_DIR"
if [[ "$PROJECT_DIR" == "$ROOT/firmware" ]]; then
	idf.py -D "EXTRA_COMPONENT_DIRS=$ROOT/components/espemu_devices" reconfigure
else
	idf.py reconfigure
fi
CMAKE_BUILD_PARALLEL_LEVEL="$JOBS" cmake --build build --parallel "$JOBS"
cd build
FLASH=$(mktemp qemu_flash.XXXXXXXX)
trap 'rm -f -- "$FLASH"' EXIT
esptool.py --chip esp32 merge_bin --fill-flash-size 4MB -o "$FLASH" @flash_args
mv -f -- "$FLASH" qemu_flash.bin
bash "$ROOT/tools/artifact-provenance.sh" record firmware "$PROJECT_DIR"
