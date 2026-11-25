#!/usr/bin/env bash
# Packages an install tree from build-tree.sh as espemu_VERSION_amd64.deb.
set -euo pipefail
if [[ $# -ne 3 ]]; then
    printf 'Usage: bash packaging/build-deb.sh TREE VERSION OUTPUT_DIRECTORY\n' >&2
    exit 2
fi
TREE=$(realpath -e -- "$1") VERSION=$2 OUT=$(realpath -m -- "$3")
MAINTAINER=${ESPEMU_MAINTAINER:-ESPEmu maintainers <${GITHUB_REPOSITORY_OWNER:-espemu}@users.noreply.github.com>}
URL=${ESPEMU_URL:-https://github.com/${GITHUB_REPOSITORY:-WaIIer/espemu}}
mkdir -p -- "$OUT"
STAGE=$(mktemp -d "$OUT/.deb-stage.XXXXXXXX")
trap 'rm -rf -- "$STAGE"' EXIT
mkdir -p "$STAGE/DEBIAN" "$STAGE/usr/lib" "$STAGE/usr/bin" "$STAGE/usr/share/doc/espemu"
# Hard links avoid a second multi-gigabyte copy when the tree is on the same filesystem.
cp -al -- "$TREE" "$STAGE/usr/lib/espemu" 2>/dev/null || cp -a -- "$TREE" "$STAGE/usr/lib/espemu"
ln -s ../lib/espemu/tools/espemu.sh "$STAGE/usr/bin/espemu"
{
    printf 'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/\nUpstream-Name: espemu\nSource: %s\n\n' "$URL"
    printf 'Files: *\nLicense: MIT\n See /usr/lib/espemu/LICENSE.\n\n'
    printf 'Files: usr/lib/espemu/toolchain/qemu/*\nLicense: GPL-2.0-only\n Patched Espressif QEMU; see /usr/lib/espemu/toolchain/licenses/qemu. The\n complete corresponding source is published with each release.\n\n'
    printf 'Files: usr/lib/espemu/toolchain/esp-idf/*\nLicense: Apache-2.0\n ESP-IDF; components carry their own licenses.\n\n'
    printf 'Files: usr/lib/espemu/toolchain/idf-tools/*\nLicense: GPL-3.0-or-later and GPL-2.0-or-later and LGPL and BSD\n Espressif GCC, binutils, GDB, newlib, OpenOCD and ULP tools.\n\n'
    printf 'Files: usr/lib/espemu/toolchain/node/* usr/lib/espemu/toolchain/python/* usr/lib/espemu/node_modules/*\nLicense: MIT and PSF-2.0 and others\n See each component license file.\n\n'
    printf 'Files: usr/lib/espemu/firmware/components/bme280/vendor/*\nLicense: BSD-3-Clause\n\n'
    printf 'Comment: Versions and source locations are listed in\n /usr/lib/espemu/THIRD-PARTY-NOTICES.\n'
} > "$STAGE/usr/share/doc/espemu/copyright"
cat > "$STAGE/DEBIAN/control" <<EOF
Package: espemu
Version: $VERSION
Architecture: amd64
Maintainer: $MAINTAINER
Installed-Size: $(du -sk --apparent-size "$STAGE/usr" | cut -f1)
Depends: bash, make, libc6 (>= 2.39), libstdc++6, libgcc-s1, libatomic1, libglib2.0-0t64 | libglib2.0-0, libpixman-1-0, libgcrypt20, libslirp0, zlib1g, libusb-1.0-0, libudev1
Recommends: git
Section: devel
Priority: optional
Homepage: $URL
Description: ESP32 emulator workbench with simulated peripherals
 Build ordinary ESP-IDF firmware and run it in a patched Espressif QEMU with
 simulated sensors, displays, LEDs, camera and audio in a local web workbench.
 Includes the pinned ESP-IDF, xtensa toolchain, Node.js runtime and emulator.
EOF
dpkg-deb --root-owner-group -Zzstd -z"${ESPEMU_ZSTD_LEVEL:-15}" --threads-max="$(nproc)" --build "$STAGE" "$OUT/espemu_${VERSION}_amd64.deb"
