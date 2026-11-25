#!/usr/bin/env bash
# Installs a built package in a clean Ubuntu or Arch container, then runs packaging/smoke-test.sh
# as an ordinary user with networking disabled, proving nothing is downloaded on first use.
set -euo pipefail
SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [[ $# -ne 2 || ( $1 != ubuntu && $1 != arch ) ]]; then
    printf 'Usage: bash packaging/test-install.sh ubuntu|arch PACKAGE_DIRECTORY\n' >&2
    exit 2
fi
OUT=$(realpath -e -- "$2")
source "$SOURCE/versions.env"
source "$SOURCE/packaging/images.env"
if [[ $1 == ubuntu ]]; then
    IMAGE=$UBUNTU_IMAGE
    INSTALL='apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /packages/espemu_*_amd64.deb'
else
    IMAGE=$ARCH_TEST_IMAGE
    INSTALL='pacman -Syu --noconfirm && pacman -U --noconfirm /packages/espemu-*-x86_64.pkg.tar.zst'
fi
NAME=espemu-install-$1-$$
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker rmi -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --name "$NAME" -v "$OUT:/packages:ro" "$IMAGE" bash -euo pipefail -c "$INSTALL >/dev/null && useradd -m tester"
docker commit "$NAME" "$NAME" >/dev/null
docker rm "$NAME" >/dev/null
docker run --rm --network none -v "$SOURCE/packaging/smoke-test.sh:/smoke-test.sh:ro" "$NAME" runuser -u tester -- bash /smoke-test.sh
