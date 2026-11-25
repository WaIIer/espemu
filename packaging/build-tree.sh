#!/usr/bin/env bash
# Builds the complete ESPEmu install tree at its final location (normally /usr/lib/espemu), so the
# bundled Python environments and tool paths are already correct when a package installs it.
set -euo pipefail
SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [[ $# -ne 3 ]]; then
    printf 'Usage: bash packaging/build-tree.sh PREFIX VERSION OUTPUT_DIRECTORY\n' >&2
    exit 2
fi
PREFIX=$(realpath -m -- "$1") VERSION=$2 OUT=$(realpath -m -- "$3")
if [[ ! $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then printf 'VERSION must look like 0.1.42.\n' >&2; exit 2; fi
# An interrupted build may leave only toolchain/, which bootstrap resumes.
if [[ ! -d $PREFIX || ! -w $PREFIX || -n $(find "$PREFIX" -mindepth 1 -maxdepth 1 ! -name toolchain -print -quit) ]]; then
    printf 'PREFIX must be an existing, writable directory that is empty or holds only toolchain/: %s\n' "$PREFIX" >&2
    exit 2
fi
if [[ -e $PREFIX/toolchain/.espemu-pruned ]]; then
    printf 'PREFIX/toolchain was already pruned for packaging and cannot be resumed; empty PREFIX.\n' >&2
    exit 2
fi
mkdir -p -- "$OUT"
unset IDF_PATH IDF_TOOLS_PATH ESPEMU_QEMU ESPEMU_BIOS ESPEMU_INSTALLED
export ESPEMU_TOOLS="$PREFIX/toolchain" ESPEMU_TOOLS_ROOT="$PREFIX" BUILD_JOBS=${BUILD_JOBS:-$(nproc)}
source "$SOURCE/versions.env"

printf '== Framework files\n'
cd "$SOURCE"
while IFS= read -r -d '' file; do
    if [[ -f $file && $file != *.test.mjs ]]; then cp --parents -- "$file" "$PREFIX/"; fi
done < <(git ls-files -z --cached --others --exclude-standard --deduplicate -- \
    README.md LICENSE package.json package-lock.json tsconfig.json versions.env \
    server shared tools templates components firmware frontend docs qemu/espemu.patch)

printf '== Toolchain\n'
bash "$PREFIX/tools/bootstrap.sh"
bash "$PREFIX/tools/build-qemu.sh"
source "$PREFIX/tools/env.sh"
# Package dependencies are declared for exactly these libraries; fail if the emulator links others.
unexpected=$(readelf -d "$ESPEMU_TOOLS/qemu/build/qemu-system-xtensa" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' |
    grep -vxE 'lib(c|m|z|atomic|pixman-1|gcrypt|gpg-error|slirp|glib-2\.0|gmodule-2\.0|gio-2\.0|gobject-2\.0)\.so\.[0-9]+' || true)
if [[ -n $unexpected ]]; then
    printf 'qemu-system-xtensa links libraries the packages do not declare:\n%s\n' "$unexpected" >&2
    exit 1
fi

printf '== Web interface\n'
(cd "$PREFIX" && npm ci --no-audit --no-fund && npx vite build --config frontend/vite.config.ts && npm prune --omit=dev --no-audit --no-fund)

printf '== Bundled demo firmware\n'
bash "$PREFIX/tools/build-firmware.sh"

printf '== Emulator source for the GPL\n'
cp "$PREFIX/tools/build-qemu.sh" "$ESPEMU_TOOLS/qemu/espemu-build-qemu.sh"
tar -C "$ESPEMU_TOOLS" --exclude=qemu/build --exclude=.git -cf - qemu | xz -T0 -6 > "$OUT/espemu-qemu-source-$VERSION.tar.xz"

printf '== Pruning build-only files\n'
cd "$PREFIX"
mv firmware/build/qemu_flash.bin firmware/qemu_flash.bin
rm -rf -- frontend package-lock.json firmware/build firmware/managed_components firmware/sdkconfig firmware/sdkconfig.old firmware/dependencies.lock
mkdir firmware/build && mv firmware/qemu_flash.bin firmware/build/
cd "$ESPEMU_TOOLS"
touch .espemu-pruned
mkdir -p qemu-install/pc-bios licenses/qemu
cp qemu/build/qemu-system-xtensa qemu-install/
strip --strip-unneeded qemu-install/qemu-system-xtensa
cp qemu/pc-bios/esp32-v3-rom.bin qemu/pc-bios/esp32-v3-rom-app.bin qemu-install/pc-bios/
cp qemu/COPYING qemu/COPYING.LIB qemu/LICENSE licenses/qemu/
rm -rf -- qemu downloads uv-cache pip npm bin sysroot idf-tools/dist esp-idf/docs esp-idf/examples
mv qemu-install qemu
find esp-idf -name .git -prune -exec rm -rf {} +
printf '%s\n' "$IDF_COMMIT" > esp-idf/.espemu-idf-commit
printf '%s\n' "$IDF_TAG" > esp-idf/version.txt

sed "s/@VERSION@/$VERSION/g" "$SOURCE/packaging/install.env.in" > "$PREFIX/install.env"
TOOL_VERSIONS=$(cd "$ESPEMU_TOOLS/idf-tools/tools" && for tool in */*/; do printf '  %s\n' "${tool%/}"; done)
cat > "$PREFIX/THIRD-PARTY-NOTICES" <<EOF
ESPEmu $VERSION is MIT licensed (see LICENSE). This package also contains:

- Espressif QEMU $QEMU_TAG ($QEMU_COMMIT), GPL-2.0-only with GPL-2.0-or-later,
  LGPL-2.1 and BSD parts (toolchain/licenses/qemu), modified by qemu/espemu.patch.
  Complete corresponding source, including the build script, is published with
  each release as espemu-qemu-source-$VERSION.tar.xz.
- ESP-IDF $IDF_TAG ($IDF_COMMIT), Apache-2.0 with bundled component licenses
  (toolchain/esp-idf), and the ESP-IDF Python environment packages.
- Espressif prebuilt tools installed by ESP-IDF's idf_tools.py for the esp32 target:
$TOOL_VERSIONS
  GCC, binutils and GDB are GPL-3.0-or-later (libgcc with the GCC Runtime Library
  Exception), newlib is BSD-style, OpenOCD is GPL-2.0-or-later. Their source for
  these exact versions is published by Espressif: https://github.com/espressif/crosstool-NG,
  https://github.com/espressif/binutils-gdb, https://github.com/espressif/openocd-esp32
  and https://github.com/espressif/binutils-esp32ulp (release tags match the versions above).
- Node.js $NODE_VERSION (toolchain/node/LICENSE) and Python $PYTHON_VERSION
  (python-build-standalone, PSF-2.0; toolchain/python), CMake and Ninja (toolchain/build-env).
- npm packages in node_modules, each with its own license file.
- Bosch Sensortec BME280 driver, BSD-3-Clause (firmware/components/bme280/vendor).
- Selected KiCad community symbols 7.0.11, CC-BY-SA-4.0 with the electronic-design
  exception (tools/kicad/LICENSE.kicad-symbols).
EOF
chmod -R u+rwX,go+rX,go-w "$PREFIX"

printf '== Checking the tree\n'
unset ESPEMU_TOOLS ESPEMU_TOOLS_ROOT
source "$PREFIX/tools/env.sh"
espemu_have_node && espemu_have_idf
"$ESPEMU_QEMU" --version | sed -n 1p
du -sh "$PREFIX"
