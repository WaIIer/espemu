#!/usr/bin/env bash
# Runs build-tree.sh in the pinned Ubuntu 24.04 image with only the declared emulator -dev packages,
# so the packaged QEMU links a known library set and a 24.04 glibc baseline.
set -euo pipefail
SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [[ $# -ne 3 ]]; then
    printf 'Usage: bash packaging/build-in-container.sh EMPTY_TREE_DIRECTORY VERSION OUTPUT_DIRECTORY\n' >&2
    exit 2
fi
TREE=$(realpath -e -- "$1") VERSION=$2 OUT=$(realpath -m -- "$3")
source "$SOURCE/versions.env"
mkdir -p -- "$OUT"
docker run --rm -v "$SOURCE:/src:ro" -v "$TREE:/usr/lib/espemu" -v "$OUT:/out" \
    -e VERSION="$VERSION" -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -e BUILD_JOBS="${BUILD_JOBS:-$(nproc)}" \
    "$UBUNTU_IMAGE" bash -euo pipefail -c '
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates curl git xz-utils \
            build-essential pkg-config libglib2.0-dev libpixman-1-dev libgcrypt20-dev libslirp-dev zlib1g-dev \
            libusb-1.0-0 libudev1 >/dev/null
        groupadd -o -g "$HOST_GID" builder
        useradd -o -m -u "$HOST_UID" -g "$HOST_GID" builder
        runuser -u builder -- env ESPEMU_SYSTEM_LIBS=1 BUILD_JOBS="$BUILD_JOBS" GIT_OPTIONAL_LOCKS=0 \
            bash /src/packaging/build-tree.sh /usr/lib/espemu "$VERSION" /out'
