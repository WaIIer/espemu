#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$ROOT/tools/env.sh"
if [[ -n ${ESPEMU_INSTALLED:-} ]]; then
    if espemu_have_node && espemu_have_idf; then
        printf 'ESPEmu %s was installed by your package manager; its tools are ready.\n' "$ESPEMU_VERSION"
        exit 0
    fi
    printf 'The packaged ESPEmu tools in %s are incomplete.%s Reinstall the espemu package.\n' "$ESPEMU_TOOLS" \
        "$([[ $IDF_PATH != "$ESPEMU_TOOLS/esp-idf" ]] && printf ' IDF_PATH is %s; unset it to use the packaged ESP-IDF.' "$IDF_PATH")" >&2
    exit 1
fi
TOOLS=$ESPEMU_TOOLS
export UV_CACHE_DIR="$TOOLS/uv-cache"
export UV_PYTHON_INSTALL_DIR="$TOOLS/python"
export IDF_TOOLS_PATH="$TOOLS/idf-tools"
export PIP_CACHE_DIR="$TOOLS/pip"
mkdir -p "$TOOLS/downloads" "$TOOLS/bin" "$TOOLS/sysroot"
cd "$TOOLS/downloads"

if [[ ! -x "$TOOLS/node/bin/node" ]]; then
    curl -fL --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o node.tar.xz
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | awk -v name="node-v${NODE_VERSION}-linux-x64.tar.xz" '$2 == name {print $1 "  node.tar.xz"}' | sha256sum -c -
    mkdir -p "$TOOLS/node"
    tar -xJf node.tar.xz --strip-components=1 -C "$TOOLS/node"
fi
export PATH="$TOOLS/node/bin:$TOOLS/bin:$PATH"

if [[ ! -x "$TOOLS/bin/uv" ]]; then
    curl -fL --retry 3 "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" -o uv.tar.gz
    tar -xzf uv.tar.gz --strip-components=1 -C "$TOOLS/bin"
fi
uv python install "$PYTHON_VERSION"
PYTHON=$(uv python find "$PYTHON_VERSION")
if [[ ! -x "$TOOLS/build-env/bin/cmake" ]]; then
    uv venv --python "$PYTHON" "$TOOLS/build-env"
    uv pip install --python "$TOOLS/build-env/bin/python" cmake==3.30.5 ninja==1.11.1.4 meson==1.7.0
fi

# ESPEMU_SYSTEM_LIBS=1 builds QEMU against installed -dev packages, as release packages do.
if [[ -z ${ESPEMU_SYSTEM_LIBS:-} ]] && [[ ! -f "$TOOLS/sysroot/usr/include/glib-2.0/glib.h" || ! -f "$TOOLS/sysroot/usr/lib/x86_64-linux-gnu/pkgconfig/sysprof-capture-4.pc" ]]; then
    mapfile -t packages < "$ROOT/tools/native-packages.lock"
    apt-get download "${packages[@]}"
    for package in ./*.deb; do
        dpkg-deb -x "$package" "$TOOLS/sysroot"
    done
fi

cd "$TOOLS"
if [[ ! -d qemu/.git ]]; then
    git clone --depth 1 --branch "$QEMU_TAG" https://github.com/espressif/qemu.git qemu
fi
[[ $(git -C qemu rev-parse HEAD) == "$QEMU_COMMIT" ]]
if [[ ! -d esp-idf/.git ]]; then
    git clone --depth 1 --branch "$IDF_TAG" --shallow-submodules --recursive https://github.com/espressif/esp-idf.git esp-idf
fi
[[ $(git -C esp-idf rev-parse HEAD) == "$IDF_COMMIT" ]]
"$PYTHON" esp-idf/tools/idf_tools.py --non-interactive install required --targets esp32
"$PYTHON" esp-idf/tools/idf_tools.py --non-interactive install-python-env
"$IDF_TOOLS_PATH/python_env/idf5.4_py3.11_env/bin/python" -m pip install --no-deps -r "$ROOT/tools/idf-python.lock"
printf '\nWorkspace tools ready. Node: %s. IDF: %s. QEMU: %s.\n' "$NODE_VERSION" "$IDF_COMMIT" "$QEMU_COMMIT"
