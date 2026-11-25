#!/usr/bin/env bash
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$ROOT/versions.env"
# Packages record their prebuilt tool location here; checkouts keep tools in .cache.
if [[ -f "$ROOT/install.env" ]]; then source "$ROOT/install.env"
# An inherited location applies only to the checkout it was chosen for, never to another one.
elif [[ ${ESPEMU_TOOLS_ROOT:-} != "$ROOT" ]]; then ESPEMU_TOOLS=$ROOT/.cache; fi
export ESPEMU_TOOLS ESPEMU_TOOLS_ROOT=$ROOT
export IDF_PATH="${IDF_PATH:-$ESPEMU_TOOLS/esp-idf}"
export IDF_TOOLS_PATH="${IDF_TOOLS_PATH:-$ESPEMU_TOOLS/idf-tools}"
export IDF_PYTHON_CHECK_CONSTRAINTS=no
export npm_config_cache="$ESPEMU_TOOLS/npm"
export PATH="$ESPEMU_TOOLS/node/bin:$ESPEMU_TOOLS/bin:$ESPEMU_TOOLS/build-env/bin:$PATH"
espemu_have_node() {
    command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && [[ $(node --version) == "v$NODE_VERSION" ]]
}
espemu_dependencies_match() {
    [[ -f "$ROOT/node_modules/tsx/dist/loader.mjs" ]] || return 1
    [[ -f "$ROOT/package-lock.json" ]] || return 0
    node --input-type=module - "$ROOT" <<'JS'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
try {
    const packages = filename => JSON.parse(readFileSync(join(root, filename), 'utf8')).packages;
    const expected = packages('package-lock.json'), installed = packages('node_modules/.package-lock.json');
    const fields = ['version', 'resolved', 'integrity', 'link'];
    const match = Object.entries(expected).every(([name, entry]) => !name ||
        (entry.optional && !installed[name]) || (installed[name] && fields.every(field => entry[field] === installed[name][field])));
    process.exitCode = match ? 0 : 1;
} catch { process.exitCode = 1; }
JS
}
espemu_prepare_web() {
    if ! espemu_have_node; then
        bash "$ROOT/.github/skills/espemu-environment/scripts/setup.sh" --web || return
        source "$ROOT/tools/env.sh"
    fi
    if ! espemu_dependencies_match; then
        npm --prefix "$ROOT" ci --no-audit --no-fund
    fi
}
# Rebuilds the web bundle when frontend or shared sources differ from the ones it was built from.
espemu_ensure_web_bundle() {
    (
        cd "$ROOT" || exit
        if [[ -d frontend && -f package-lock.json ]]; then
            local fingerprint
            fingerprint=$( { find frontend shared -type f -not -path '*/node_modules/*' -print0; printf '%s\0' package.json package-lock.json tsconfig.json versions.env; } |
                sort -z | xargs -0 sha256sum | sha256sum | cut -d ' ' -f 1)
            if [[ ! -f dist/index.html || ! -f dist/.espemu-source || $(< dist/.espemu-source) != "$fingerprint" ]]; then
                npm run build >&2 || exit
                printf '%s\n' "$fingerprint" > dist/.espemu-source
            fi
        elif [[ ! -f dist/index.html ]]; then
            printf 'Frontend sources and prepared assets are unavailable. Run npm run build from the full framework checkout.\n' >&2
            exit 2
        fi
    )
}
espemu_have_idf() {
    [[ -f "$IDF_PATH/export.sh" && -d "$IDF_TOOLS_PATH/python_env" && -d "$IDF_TOOLS_PATH/tools/xtensa-esp-elf" ]] &&
    [[ $(git -C "$IDF_PATH" rev-parse HEAD 2>/dev/null || cat "$IDF_PATH/.espemu-idf-commit" 2>/dev/null) == "$IDF_COMMIT" ]]
}
if [[ -d "$ESPEMU_TOOLS/sysroot/usr/lib/x86_64-linux-gnu" ]]; then
    export LD_LIBRARY_PATH="$ESPEMU_TOOLS/sysroot/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    export PKG_CONFIG="$ESPEMU_TOOLS/sysroot/usr/bin/pkgconf"
    export PKG_CONFIG_PATH="$ESPEMU_TOOLS/sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:$ESPEMU_TOOLS/sysroot/usr/share/pkgconfig"
    export PKG_CONFIG_SYSROOT_DIR="$ESPEMU_TOOLS/sysroot"
fi
