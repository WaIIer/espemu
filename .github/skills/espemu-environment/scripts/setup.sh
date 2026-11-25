#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
NATIVE=false
MODELS=false
FIXTURES=false
BROWSER=false
CHECK=false
usage() {
    printf 'Usage: bash setup.sh [--web] [--browser] [--native] [--models] [--fixtures] [--check]\n'
    printf 'Default: pinned Node + npm ci only; no builds or running simulator.\n'
    printf '  --native    Repository native bootstrap (requires compatible apt pins).\n'
    printf '  --models    Native bootstrap and QEMU build.\n'
    printf '  --fixtures  Native bootstrap, QEMU, bundled firmware and framework fixtures.\n'
    printf '  --browser   Download Chromium without privileged OS package installation.\n'
    printf '  --check     Read-only diagnostics; combine with --native for native requirements.\n'
}
for argument in "$@"; do
    case "$argument" in
        --web) ;;
        --native) NATIVE=true ;;
        --models) NATIVE=true; MODELS=true ;;
        --fixtures) NATIVE=true; MODELS=true; FIXTURES=true ;;
        --browser) BROWSER=true ;;
        --check) CHECK=true ;;
        --help|-h) usage; exit 0 ;;
        *) printf 'Unknown option: %s\n' "$argument" >&2; usage >&2; exit 2 ;;
    esac
done
if [[ "$CHECK" == true ]]; then
    if [[ "$MODELS" == true || "$FIXTURES" == true || "$BROWSER" == true ]]; then printf '%s\n' '--check cannot be combined with build/browser options.' >&2; exit 2; fi
    if [[ "$NATIVE" == true ]]; then exec bash "$ROOT/.github/skills/espemu-environment/scripts/doctor.sh" --native; fi
    exec bash "$ROOT/.github/skills/espemu-environment/scripts/doctor.sh"
fi
source "$ROOT/versions.env"
cd "$ROOT"
if [[ ! -x "$ROOT/.cache/node/bin/node" ]]; then
    if [[ -e "$ROOT/.cache/node" || -L "$ROOT/.cache/node" ]]; then printf 'Incomplete Node cache; inspect it before retrying. No existing cache was replaced.\n' >&2; exit 1; fi
    if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then printf 'Pinned local Node setup currently supports Linux x64 only.\n' >&2; exit 1; fi
    for required in curl tar xz sha256sum mktemp; do command -v "$required" >/dev/null || { printf 'Missing prerequisite: %s\n' "$required" >&2; exit 1; }; done
    mkdir -p "$ROOT/.cache/downloads"
    NODE_STAGING=$(mktemp -d "$ROOT/.cache/downloads/copilot-node.XXXXXXXX")
    trap 'rm -rf -- "$NODE_STAGING"' EXIT
    ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
    printf 'Downloading pinned Node %s.\n' "$NODE_VERSION"
    curl -fL --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/$ARCHIVE" -o "$NODE_STAGING/node.tar.xz"
    curl -fsSL --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "$NODE_STAGING/SHASUMS256.txt"
    EXPECTED=$(awk -v name="$ARCHIVE" '$2 == name {print $1}' "$NODE_STAGING/SHASUMS256.txt")
    if [[ ! "$EXPECTED" =~ ^[a-f0-9]{64}$ ]]; then printf 'Missing or ambiguous Node checksum.\n' >&2; exit 1; fi
    printf '%s  %s\n' "$EXPECTED" "$NODE_STAGING/node.tar.xz" | sha256sum -c -
    mkdir "$NODE_STAGING/node"
    tar -xJf "$NODE_STAGING/node.tar.xz" --strip-components=1 -C "$NODE_STAGING/node"
    mv -T "$NODE_STAGING/node" "$ROOT/.cache/node"
fi
source "$ROOT/tools/env.sh"
if [[ $(node --version) != "v$NODE_VERSION" ]]; then printf 'Node cache does not match versions.env; no cache was replaced.\n' >&2; exit 1; fi
if [[ "$NATIVE" == true ]]; then bash "$ROOT/tools/bootstrap.sh"; source "$ROOT/tools/env.sh"; fi
npm ci --no-audit --no-fund
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$ROOT/.cache/playwright}"
if [[ "$BROWSER" == true ]]; then
    PLAYWRIGHT_HOST_PLATFORM_OVERRIDE="${PLAYWRIGHT_HOST_PLATFORM_OVERRIDE:-ubuntu24.04-x64}" npm exec -- playwright install chromium
fi
if [[ "$MODELS" == true ]]; then bash "$ROOT/tools/build-qemu.sh"; fi
if [[ "$FIXTURES" == true ]]; then
    bash "$ROOT/tools/build-firmware.sh"
    bash "$ROOT/tools/build-gpio-fixture.sh"
    bash "$ROOT/tools/build-framework-fixtures.sh"
    bash "$ROOT/tools/build-ws2812-fixture.sh"
fi
if [[ -n "${GITHUB_PATH:-}" && -n "${GITHUB_ENV:-}" ]]; then
    printf '%s\n' "$ROOT/.cache/node/bin" "$ROOT/.cache/bin" "$ROOT/.cache/build-env/bin" >> "$GITHUB_PATH"
    printf 'PLAYWRIGHT_BROWSERS_PATH=%s\nIDF_PATH=%s\nIDF_TOOLS_PATH=%s\nIDF_PYTHON_CHECK_CONSTRAINTS=no\n' "$PLAYWRIGHT_BROWSERS_PATH" "$IDF_PATH" "$IDF_TOOLS_PATH" >> "$GITHUB_ENV"
fi
printf '\nSetup complete. Source tools/env.sh in each fresh shell; no simulator was launched.\n'
