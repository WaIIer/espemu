#!/usr/bin/env bash
# Publishes VERSION as a GitHub prerelease and, if this commit is still main's head, moves 'latest' to it.
set -euo pipefail
if [[ $# -ne 2 ]]; then
    printf 'Usage: bash packaging/publish.sh VERSION PACKAGE_DIRECTORY\n' >&2
    exit 2
fi
VERSION=$1
export GH_REPO=${GITHUB_REPOSITORY:?}
# The merged commit; GITHUB_SHA can already be a later main commit.
SHA=${RELEASE_SHA:-${GITHUB_SHA:?}}
cd -- "$2"
DEB=espemu_${VERSION}_amd64.deb PKG=espemu-${VERSION}-1-x86_64.pkg.tar.zst QEMU=espemu-qemu-source-${VERSION}.tar.xz
notes() {
    printf 'Prerelease built from %s.\n\n' "$SHA"
    printf -- '- Ubuntu 24.04 or newer: `sudo apt install ./%s`\n' "$1"
    printf -- '- Arch Linux: `sudo pacman -U %s`\n' "$2"
    printf -- '- Then create a project: `espemu new --web`\n\n'
    printf '%s contains the complete patched QEMU source for the bundled emulator (GPL-2.0).\n' "$3"
}
# gh prints the error body on stdout for a missing tag, so only a successful lookup is a commit.
tag_commit() { local sha; if sha=$(gh api "repos/$GH_REPO/git/ref/tags/$1" --jq .object.sha 2>/dev/null); then printf '%s\n' "$sha"; fi; }

existing=$(tag_commit "v$VERSION")
if [[ -z $existing ]]; then
    gh release create "v$VERSION" "$DEB" "$PKG" "$QEMU" SHA256SUMS --target "$SHA" --prerelease \
        --title "ESPEmu $VERSION" --notes "$(notes "$DEB" "$PKG" "$QEMU")"
elif [[ $existing == "$SHA" ]]; then
    gh release upload "v$VERSION" "$DEB" "$PKG" "$QEMU" SHA256SUMS --clobber
else
    printf 'v%s already belongs to %s, not %s; refusing to replace a published version.\n' "$VERSION" "$existing" "$SHA" >&2
    exit 1
fi

head=$(gh api "repos/$GH_REPO/commits/main" --jq .sha)
if [[ $head != "$SHA" ]]; then
    printf 'main has moved on to %s; latest stays with the newer build.\n' "$head"
    exit 0
fi
# 'latest' uses version-free file names so its download links never change.
STABLE=$(mktemp -d -p .)
trap 'rm -rf -- "$STABLE"' EXIT
ln -- "$DEB" "$STABLE/espemu_amd64.deb"
ln -- "$PKG" "$STABLE/espemu-x86_64.pkg.tar.zst"
ln -- "$QEMU" "$STABLE/espemu-qemu-source.tar.xz"
(cd "$STABLE" && sha256sum espemu* > SHA256SUMS)
title="ESPEmu latest ($VERSION)" body=$(notes espemu_amd64.deb espemu-x86_64.pkg.tar.zst espemu-qemu-source.tar.xz)
if [[ -z $(tag_commit latest) ]]; then
    gh release create latest "$STABLE"/* --target "$SHA" --prerelease --title "$title" --notes "$body"
else
    gh release upload latest "$STABLE"/* --clobber
    gh api -X PATCH "repos/$GH_REPO/git/refs/tags/latest" -f sha="$SHA" -F force=true >/dev/null
    gh release edit latest --title "$title" --notes "$body"
fi
