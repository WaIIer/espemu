#!/usr/bin/env bash
# Packages an install tree from build-tree.sh with makepkg in a pinned Arch Linux container.
set -euo pipefail
SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [[ $# -ne 3 ]]; then
    printf 'Usage: bash packaging/build-arch.sh TREE VERSION OUTPUT_DIRECTORY\n' >&2
    exit 2
fi
TREE=$(realpath -e -- "$1") VERSION=$2 OUT=$(realpath -m -- "$3")
source "$SOURCE/packaging/images.env"
mkdir -p -- "$OUT"
docker run --rm -v "$TREE:/tree:ro" -v "$SOURCE/packaging/arch:/recipe:ro" -v "$OUT:/out" \
    -e ESPEMU_VERSION="$VERSION" -e ESPEMU_URL="https://github.com/${GITHUB_REPOSITORY:-WaIIer/espemu}" -e HOST_UID="$(id -u)" \
    "$ARCH_IMAGE" bash -euo pipefail -c '
        useradd -m -u "$HOST_UID" builder
        install -d -o builder /build
        cp /recipe/PKGBUILD /build/
        { cat /etc/makepkg.conf; printf "COMPRESSZST=(zstd -c -T0 -15 -)\n"; } > /build/makepkg.conf
        cd /build
        runuser -u builder -- env ESPEMU_TREE=/tree ESPEMU_VERSION="$ESPEMU_VERSION" ESPEMU_URL="$ESPEMU_URL" PKGDEST=/out \
            makepkg --config /build/makepkg.conf --nodeps --noconfirm'
