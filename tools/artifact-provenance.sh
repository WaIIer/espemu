#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

ACTION=${1:-}
KIND=${2:-}
case "$KIND" in
    firmware)
        PROJECT=$(realpath -e "${3:-$ROOT/firmware}")
        ARTIFACT="$PROJECT/build/qemu_flash.bin"
        REBUILD='make build in the project directory'
        ;;
    qemu)
        SOURCE="$ESPEMU_TOOLS/qemu"
        ARTIFACT="$SOURCE/build/qemu-system-xtensa"
        if [[ ${ESPEMU_QEMU:-} == /* ]]; then ARTIFACT="$ESPEMU_QEMU"
        elif [[ -n ${ESPEMU_QEMU:-} ]]; then ARTIFACT="$ROOT/$ESPEMU_QEMU"; fi
        REBUILD='bash tools/build-qemu.sh from the framework directory'
        ;;
    *) printf 'Usage: bash tools/artifact-provenance.sh record|check firmware [PROJECT] | qemu\n' >&2; exit 4 ;;
esac
STAMP="$ARTIFACT.espemu-source"

# espemu.json is not compiled; its firmware-visible wiring reaches the build through main/device_pins.h.
project_files() (
    cd "$PROJECT"
    find . \( -type d \( -name build -o -name .git -o -name .cache -o -name .vscode -o -name node_modules \) -prune \) -o \
        \( -type f \( -name CMakeLists.txt -o -name '*.cmake' -o -name '*.[chSs]' -o -name '*.cpp' -o -name '*.cc' -o -name '*.cxx' -o -name '*.hpp' -o -name '*.hh' -o -name Kconfig -o -name 'Kconfig.*' -o -name 'sdkconfig*' -o -name 'idf_component.yml' -o -name 'dependencies.lock' -o -name '*.csv' -o -name '*.ld' -o -name '*.a' \) ! -name sdkconfig.old -print0 \) |
        LC_ALL=C sort -z | xargs -0 -r sha256sum
)

inputs() (
    cd "$ROOT"
    sha256sum versions.env
    if [[ "$KIND" == firmware ]]; then
        sha256sum tools/build-firmware.sh tools/idf-python.lock
        if [[ "$PROJECT" == "$ROOT/firmware" ]]; then
            find components/espemu_devices -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
        fi
        project_files
    else
        export GIT_OPTIONAL_LOCKS=0
        sha256sum qemu/espemu.patch tools/build-qemu.sh
        cd "$SOURCE"
        git rev-parse HEAD
        git diff --binary --no-ext-diff HEAD
        git ls-files --others --exclude-standard -z | LC_ALL=C sort -z | xargs -0 -r sha256sum
        git submodule status --recursive
        sha256sum build/build.ninja
    fi
)

if [[ ! -f "$ARTIFACT" ]]; then printf 'Missing %s: run %s.\n' "$KIND" "$REBUILD"; exit 1; fi
ARTIFACT_HASH=$(sha256sum < "$ARTIFACT" | cut -d ' ' -f 1)
case "$ACTION" in
    check)
        if [[ ! -f "$STAMP" ]]; then printf 'Unrecorded %s SHA256 %s (source freshness unknown).\n' "$KIND" "$ARTIFACT_HASH"; exit 2; fi
        ;;
    record)
        if [[ "$KIND" == qemu && "$ARTIFACT" != "$SOURCE/build/qemu-system-xtensa" ]]; then
            printf 'Cannot record a source fingerprint for an external emulator.\n' >&2; exit 4
        fi
        ;;
    *) printf 'Expected record or check.\n' >&2; exit 4 ;;
esac
if ! INPUT_HASH=$( (set -e; inputs) | sha256sum | cut -d ' ' -f 1); then
    printf 'Cannot fingerprint %s inputs.\n' "$KIND" >&2; exit 4
fi
RECORD="$INPUT_HASH $ARTIFACT_HASH"
if [[ "$ACTION" == record ]]; then
    TEMPORARY=$(mktemp "$STAMP.XXXXXXXX")
    trap 'rm -f -- "$TEMPORARY"' EXIT
    printf '%s\n' "$RECORD" > "$TEMPORARY"
    mv -f -- "$TEMPORARY" "$STAMP"
elif [[ $(< "$STAMP") != "$RECORD" ]]; then
    printf 'Stale %s inputs or artifact SHA256 %s: run %s.\n' "$KIND" "$ARTIFACT_HASH" "$REBUILD"; exit 3
fi
printf 'Recorded %s SHA256 %s (input fingerprint %s).\n' "$KIND" "$ARTIFACT_HASH" "$INPUT_HASH"