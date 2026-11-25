#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
source "$ROOT/versions.env"
cd "$ESPEMU_TOOLS/qemu"
[[ $(git rev-parse HEAD) == "$QEMU_COMMIT" ]]
# Prints a temporary copy of an earlier published patch that exactly matches this checkout.
espemu_previous_patch() {
    git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || return 1
    local revision candidate
    candidate=$(mktemp)
    for revision in $(git -C "$ROOT" log --format=%H -n 30 -- qemu/espemu.patch); do
        git -C "$ROOT" show "$revision:qemu/espemu.patch" > "$candidate" 2>/dev/null || continue
        if git apply --reverse --check "$candidate" 2>/dev/null; then printf '%s\n' "$candidate"; return 0; fi
    done
    rm -f -- "$candidate"
    return 1
}
if [[ -f "$ROOT/qemu/espemu.patch" ]]; then
    if git apply --reverse --check "$ROOT/qemu/espemu.patch" 2>/dev/null; then
        printf 'ESPEmu source patch already applied.\n'
    elif previous=$(espemu_previous_patch); then
        trap 'rm -f -- "$previous"' EXIT
        git apply --reverse "$previous"
        if ! git apply "$ROOT/qemu/espemu.patch"; then
            git apply "$previous"
            printf 'Could not apply the current qemu/espemu.patch; the previous integration was restored.\n' >&2
            exit 1
        fi
        printf 'Upgraded the unmodified ESPEmu QEMU integration to the current patch.\n'
    elif [[ -f hw/sensor/espemu.c && -f hw/sensor/bh1750.c && -f hw/sensor/bme280.c && -f hw/sensor/sht3x.c && -f hw/sensor/espemu_ov2640.c && -f hw/misc/esp32_i2s.c && -f hw/sensor/hd44780.c && -f hw/sensor/espemu_speaker.c && -f include/hw/sensor/espemu.h ]] &&
         grep -Fq 'espemu_attach(OBJECT(s), i2c_bus)' hw/xtensa/esp32.c &&
         grep -Fq 'espemu-inputs' hw/sensor/espemu.c &&
         grep -Fq 'espemu-trace' hw/i2c/esp32_i2c.c; then
        printf 'Using locally modified ESPEmu source; existing edits are preserved.\n'
    elif ! git apply --check "$ROOT/qemu/espemu.patch" 2>/dev/null; then
        printf '%s\n' "The QEMU checkout in $ESPEMU_TOOLS/qemu has an older or locally modified ESPEmu integration, so the current qemu/espemu.patch cannot be applied." \
            "If you have no QEMU edits of your own, reset that checkout and rebuild:" \
            "  git -C \"$ESPEMU_TOOLS/qemu\" checkout -- . && git -C \"$ESPEMU_TOOLS/qemu\" clean -fd -e subprojects && bash tools/build-qemu.sh" \
            "Otherwise update your edits to include every file in qemu/espemu.patch." >&2
        exit 1
    else
        git apply "$ROOT/qemu/espemu.patch"
    fi
fi
if [[ ! -f build/build.ninja || ! -f build/.espemu-config-v3 ]]; then
    ./configure --target-list=xtensa-softmmu --disable-user --enable-gcrypt \
        --enable-slirp --disable-sdl --disable-gtk --disable-vnc \
        --disable-docs --disable-tools --disable-guest-agent --disable-werror \
        --disable-capstone \
        --extra-cflags="-Wno-error=discarded-qualifiers -isystem $ESPEMU_TOOLS/sysroot/usr/include/x86_64-linux-gnu" \
        --python="$ESPEMU_TOOLS/build-env/bin/python"
    touch build/.espemu-config-v3
fi
ninja -C build -j "${BUILD_JOBS:-8}" qemu-system-xtensa
build/qemu-system-xtensa --version
ESPEMU_QEMU= bash "$ROOT/tools/artifact-provenance.sh" record qemu
