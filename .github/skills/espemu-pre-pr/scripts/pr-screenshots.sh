#!/usr/bin/env bash
# Posts links to UI screenshots on a pull request. Images go to the orphan pr-screenshots branch through
# the GitHub API, so no worktree, index or feature branch changes; one comment then lists the links.
set -euo pipefail
BRANCH=pr-screenshots MAX_FILES=12 MAX_BYTES=$((5 * 1024 * 1024))
usage() {
    printf '%s\n' \
        'Usage: pr-screenshots.sh --repo OWNER/REPO --pr NUMBER [--sha HEAD_SHA] [--dry-run] IMAGE[=CAPTION]...' \
        'Uploads PNG, JPEG or WebP screenshots for the PR head commit and comments links to them on the PR.' \
        '--dry-run validates the images and prints the comment without contacting GitHub (needs --sha).'
}
REPO= PR= SHA= DRY=false IMAGES=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo) REPO=${2:-}; shift 2 ;;
        --pr) PR=${2:-}; shift 2 ;;
        --sha) SHA=${2:-}; shift 2 ;;
        --dry-run) DRY=true; shift ;;
        -h|--help) usage; exit 0 ;;
        -*) usage >&2; exit 2 ;;
        *) IMAGES+=("$1"); shift ;;
    esac
done
if [[ ! $REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ || ! $PR =~ ^[1-9][0-9]*$ || ${#IMAGES[@]} -eq 0 ]]; then usage >&2; exit 2; fi
if (( ${#IMAGES[@]} > MAX_FILES )); then printf 'At most %d screenshots per comment.\n' "$MAX_FILES" >&2; exit 2; fi
for image in "${IMAGES[@]}"; do
    file=${image%%=*}
    if [[ ! -f $file ]]; then printf 'Not a file: %s\n' "$file" >&2; exit 2; fi
    if [[ ! ${file,,} =~ \.(png|jpe?g|webp)$ ]]; then printf 'Not a PNG, JPEG or WebP image: %s\n' "$file" >&2; exit 2; fi
    if (( $(stat -c %s "$file") > MAX_BYTES )); then printf 'Larger than 5 MiB: %s\n' "$file" >&2; exit 2; fi
done
if [[ -z $SHA ]]; then
    if $DRY; then printf -- '--dry-run needs --sha.\n' >&2; exit 2; fi
    SHA=$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)
fi
if [[ ! $SHA =~ ^[0-9a-f]{7,40}$ ]]; then printf 'Invalid head commit: %s\n' "$SHA" >&2; exit 2; fi
DIRECTORY=pr-$PR/${SHA:0:12}

# gh prints the error body on stdout for a missing object, so only a successful lookup counts.
exists() { gh api "$1" >/dev/null 2>&1; }
ensure_branch() {
    exists "repos/$REPO/git/ref/heads/$BRANCH" && return
    local blob tree commit
    blob=$(gh api "repos/$REPO/git/blobs" -f content=$'# PR screenshots\n\nImages posted on pull requests. Not part of the source tree.\n' -f encoding=utf-8 --jq .sha)
    tree=$(gh api "repos/$REPO/git/trees" --input - --jq .sha <<<"{\"tree\":[{\"path\":\"README.md\",\"mode\":\"100644\",\"type\":\"blob\",\"sha\":\"$blob\"}]}")
    commit=$(gh api "repos/$REPO/git/commits" -f message='Start PR screenshot storage' -f tree="$tree" --jq .sha)
    gh api "repos/$REPO/git/refs" -f ref="refs/heads/$BRANCH" -f sha="$commit" >/dev/null
}
upload() {
    local file=$1 path=$2 existing= sha body
    body=$(mktemp)
    if sha=$(gh api "repos/$REPO/contents/$path?ref=$BRANCH" --jq .sha 2>/dev/null); then existing=$sha; fi
    { printf '{"message":"Screenshot for PR #%s","branch":"%s","content":"' "$PR" "$BRANCH"; base64 -w0 "$file"
      [[ -n $existing ]] && printf '","sha":"%s' "$existing"; printf '"}'; } > "$body"
    gh api -X PUT "repos/$REPO/contents/$path" --input "$body" >/dev/null || { rm -f -- "$body"; return 1; }
    rm -f -- "$body"
}

COMMENT=$(mktemp)
trap 'rm -f -- "$COMMENT"' EXIT
printf '### Screenshots for %s\n\n' "${SHA:0:12}" > "$COMMENT"
$DRY || ensure_branch
index=0
for image in "${IMAGES[@]}"; do
    file=${image%%=*} caption=${image#*=}
    [[ $image == *=* ]] || caption=$(basename "${file%.*}")
    index=$((index + 1))
    name=$(printf '%02d-%s' "$index" "$(basename "$file" | tr -c 'A-Za-z0-9._\n-' '_')")
    $DRY || upload "$file" "$DIRECTORY/$name"
    printf -- '- [%s](https://github.com/%s/blob/%s/%s/%s)\n' "$caption" "$REPO" "$BRANCH" "$DIRECTORY" "$name" >> "$COMMENT"
done
if $DRY; then cat "$COMMENT"; exit 0; fi
gh pr comment "$PR" --repo "$REPO" --body-file "$COMMENT"
