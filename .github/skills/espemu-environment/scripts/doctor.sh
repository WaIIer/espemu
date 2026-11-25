#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
NATIVE=false
for argument in "$@"; do
    case "$argument" in
        --native) NATIVE=true ;;
        --help|-h) printf 'Usage: bash doctor.sh [--native]\nRead-only ESPEmu tool and artifact diagnostics.\n'; exit 0 ;;
        *) printf 'Unknown option: %s\n' "$argument" >&2; exit 2 ;;
    esac
done
source "$ROOT/tools/env.sh"
source "$ROOT/versions.env"
MISSING=0
if [[ "$NATIVE" == true ]]; then printf 'Profile: native\n'; else printf 'Profile: web\n'; fi
check() {
    local label=$1
    shift
    if "$@" >/dev/null 2>&1; then
        printf 'OK       %s\n' "$label"
    else
        printf 'MISSING  %s\n' "$label"
        MISSING=$((MISSING + 1))
    fi
}
executable() { [[ -x "$1" ]]; }
regular_file() { [[ -f "$1" ]]; }
check_pin() {
    local label=$1 directory=$2 expected=$3 actual
    if actual=$(git -C "$directory" rev-parse HEAD 2>/dev/null); then
        if [[ "$actual" == "$expected" ]]; then
            printf 'OK       %s upstream pin\n' "$label"
        else
            printf 'MISSING  %s upstream pin mismatch\n' "$label"
            MISSING=$((MISSING + 1))
        fi
    else
        printf 'MISSING  %s source checkout\n' "$label"
        MISSING=$((MISSING + 1))
    fi
}
check 'git' command -v git
check 'Node executable' command -v node
check 'npm executable' command -v npm
if command -v node >/dev/null 2>&1; then
    NODE_ACTUAL=$(node --version)
    if [[ "$NODE_ACTUAL" == "v$NODE_VERSION" ]]; then
        printf 'OK       Node pin %s\n' "$NODE_ACTUAL"
    else
        printf 'MISSING  Node pin: expected v%s, observed %s\n' "$NODE_VERSION" "$NODE_ACTUAL"
        MISSING=$((MISSING + 1))
    fi
fi
if [[ -d "$ROOT/node_modules/tsx" ]]; then printf 'OK       JS dependencies\n'; else printf 'MISSING  JS dependencies (npm ci)\n'; MISSING=$((MISSING + 1)); fi
for artifact in .cache/qemu/build/qemu-system-xtensa firmware/build/qemu_flash.bin .cache/playwright; do
    if [[ -e "$ROOT/$artifact" ]]; then printf 'PRESENT  %s\n' "$artifact"; else printf 'OPTIONAL %s\n' "$artifact"; fi
done
if [[ "$NATIVE" == true ]]; then
    for required in curl tar xz sha256sum apt-get dpkg-deb gcc make cmake ninja meson; do check "$required" command -v "$required"; done
    check 'native build Python' executable "$ROOT/.cache/build-env/bin/python"
    check 'ESP-IDF source' regular_file "$IDF_PATH/export.sh"
    check 'IDF Python environment' executable "$IDF_TOOLS_PATH/python_env/idf5.4_py3.11_env/bin/python"
    check 'QEMU executable' executable "$ROOT/.cache/qemu/build/qemu-system-xtensa"
    check 'tracked QEMU patch' regular_file "$ROOT/qemu/espemu.patch"
    check_pin QEMU "$ROOT/.cache/qemu" "$QEMU_COMMIT"
    check_pin ESP-IDF "$IDF_PATH" "$IDF_COMMIT"
    printf 'NOTE     Native .deb pins require compatible apt repositories; artifact presence does not prove freshness.\n'
fi
printf '\nSelected-profile missing requirements: %s\n' "$MISSING"
if [[ "$MISSING" -gt 0 ]]; then
    if [[ "$NATIVE" == true ]]; then printf 'Next: bash .github/skills/espemu-environment/scripts/setup.sh --models\n';
    else printf 'Next: bash .github/skills/espemu-environment/scripts/setup.sh --web\n'; fi
    exit 1
fi
