#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)
usage() {
    printf '%s\n' \
        'Usage: espemu COMMAND [ARGUMENTS]' \
        '' \
        '  new                      Create a project with guided prompts.' \
        '  new --web                Create a project in the browser, choosing its name and location.' \
        '  new DIRECTORY [OPTIONS]  Create a project; see espemu new --help.' \
        '  demo                     Run the bundled all-device demo.' \
        '' \
        'Project commands (default: the current directory; same as make COMMAND):' \
        '  build|run|web|test|clean|rebuild|configure|validate|doctor|docs|editor|add_component [DIRECTORY]' \
        '' \
        '  version                  Print the ESPEmu version.'
}
COMMAND=${1:-help}
if [[ $# -gt 0 ]]; then shift; fi
case "$COMMAND" in
    new) exec bash "$ROOT/tools/setup-project.sh" "$@" ;;
    demo) exec bash "$ROOT/tools/demo.sh" "$@" ;;
    build|run|web|test|clean|rebuild|configure|validate|doctor|docs|editor|add_component)
        if [[ $# -gt 1 ]]; then usage >&2; exit 2; fi
        exec bash "$ROOT/tools/project-command.sh" "$COMMAND" "${1:-$PWD}"
        ;;
    version|--version|-V)
        if [[ -f "$ROOT/install.env" ]]; then source "$ROOT/install.env"; fi
        printf 'ESPEmu %s\n' "${ESPEMU_VERSION:-source checkout at $ROOT}"
        ;;
    help|--help|-h) usage ;;
    *) printf 'Unknown command: %s\n\n' "$COMMAND" >&2; usage >&2; exit 2 ;;
esac
