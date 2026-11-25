#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [[ $# -eq 0 || ${1:-} == --guided ]]; then
    if [[ $# -gt 0 ]]; then shift; fi
    exec bash "$ROOT/tools/create-project.sh" "$@"
fi
usage() {
    printf 'Usage: espemu new PROJECT_DIRECTORY [--template empty|demo | --web | --config FILE | --config-json JSON] [--init-only|--no-run|--run|--makefile-only]\n'
    printf '       espemu new --web [--init-only|--no-run|--run]\n'
    printf 'Default: create an empty ESP-IDF app and return to the shell.\n'
    printf '  --template demo  Opt in to the all-device firmware example.\n'
    printf '  --web        Design the project, its name and location in the browser creator; files are created when you press Create project.\n'
    printf '  --config FILE  Create from web creator JSON; use - to read stdin.\n'
    printf '  --config-json JSON  Create from a quoted web creator JSON string.\n'
    printf '  --init-only  Create without building or running (default).\n'
    printf '  --no-run     Create and build everything without starting the server.\n'
    printf '  --run        Create, build and start the simulator.\n'
    printf '  --makefile-only  Add missing make commands to an existing ESP-IDF project; do not build or change its source.\n'
    printf '  No arguments, or --guided: open the interactive project creator.\n'
}
if [[ ${1:-} == --help || ${1:-} == -h ]]; then usage; exit 0; fi
web_creator() {
    exec bash "$ROOT/tools/create-project.sh" "$@"
}
WEB=false
if [[ ${1:-} == --web ]]; then
    shift
    if [[ $# -eq 0 || ( $# -eq 1 && ( $1 == --init-only || $1 == --no-run || $1 == --run ) ) ]]; then
        web_creator --web "$@"
    fi
    WEB=true
fi
if [[ $# -lt 1 || $1 == --* ]]; then usage >&2; exit 2; fi
PROJECT_ARGUMENT=$1
shift
TEMPLATE=empty
TEMPLATE_SELECTED=false
CONFIG_OPTION=
CONFIG_VALUE=
MODE=--init-only
MODE_SELECTED=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --template)
            if [[ $# -lt 2 || ( "$2" != empty && "$2" != demo ) ]]; then usage >&2; exit 2; fi
            TEMPLATE=$2
            TEMPLATE_SELECTED=true
            shift 2
            ;;
        --web)
            WEB=true
            shift
            ;;
        --config|--config-json)
            if [[ $# -lt 2 || -n "$CONFIG_OPTION" ]]; then usage >&2; exit 2; fi
            CONFIG_OPTION=$1
            CONFIG_VALUE=$2
            shift 2
            ;;
        --init-only|--no-run|--run|--makefile-only)
            if [[ "$MODE_SELECTED" == true ]]; then usage >&2; exit 2; fi
            MODE=$1
            MODE_SELECTED=true
            shift
            ;;
        *) usage >&2; exit 2 ;;
    esac
done
if [[ "$WEB" == true ]]; then
    if [[ -n "$CONFIG_OPTION" || "$TEMPLATE_SELECTED" == true || "$MODE" == --makefile-only ]]; then usage >&2; exit 2; fi
    web_creator "$PROJECT_ARGUMENT" --web "$MODE"
fi
if [[ -n "$CONFIG_OPTION" ]]; then
    if [[ "$TEMPLATE_SELECTED" == true || "$MODE" == --makefile-only ]]; then usage >&2; exit 2; fi
    exec bash "$ROOT/tools/create-project.sh" "$PROJECT_ARGUMENT" "$CONFIG_OPTION" "$CONFIG_VALUE" "$MODE"
fi
if [[ -L "$PROJECT_ARGUMENT" ]]; then
    printf 'Refusing to initialize a symlink: %s\n' "$PROJECT_ARGUMENT" >&2
    exit 2
fi
PROJECT_DIR=$(realpath -m -- "$PROJECT_ARGUMENT")
case "$PROJECT_DIR" in
    "$ROOT"|"$ROOT/firmware"|"$ROOT/firmware/"*|"$ROOT/.cache"|"$ROOT/.cache/"*)
        printf 'Choose a separate project directory, not framework sources or caches.\n' >&2
        exit 2
        ;;
esac
if [[ -e "$PROJECT_DIR" && ! -d "$PROJECT_DIR" ]]; then
    printf 'Project path is not a directory: %s\n' "$PROJECT_DIR" >&2
    exit 2
fi
install_makefile() {
    if [[ -e "$PROJECT_DIR/Makefile" || -L "$PROJECT_DIR/Makefile" ]]; then
        previous='/make kicad /d; s/ test kicad/ test/g; /make test /d; /DEVICE=TYPE/d; s/ add_component doctor test/ add_component doctor/g'
        if [[ ! -L "$PROJECT_DIR/Makefile" && -f "$PROJECT_DIR/.espemu-framework" ]] && {
            cmp -s <(printf '%s\n' "$(< "$PROJECT_DIR/Makefile")") <(sed '/make kicad /d; s/ test kicad/ test/g' "$ROOT/templates/project.Makefile") ||
            cmp -s <(printf '%s\n' "$(< "$PROJECT_DIR/Makefile")") <(sed "$previous" "$ROOT/templates/project.Makefile") ||
            cmp -s <(printf '%s\n' "$(< "$PROJECT_DIR/Makefile")") <(sed "$previous"'; /make doctor /d; s/ doctor//g' "$ROOT/templates/project.Makefile") ||
            cmp -s <(printf '%s\n' "$(< "$PROJECT_DIR/Makefile")") <(sed "$previous"'; /make add_component/d; /make doctor /d; s/ add_component doctor//g' "$ROOT/templates/project.Makefile") ||
            cmp -s <(printf '%s\n' "$(< "$PROJECT_DIR/Makefile")") <(sed "$previous"'; /make add_component/d; /make doctor /d; /make docs /d; /make editor /d; s/ docs editor add_component doctor//g' "$ROOT/templates/project.Makefile")
        }; then
            cp -- "$ROOT/templates/project.Makefile" "$PROJECT_DIR/Makefile"
            printf 'Framework project commands updated: %s/Makefile\n' "$PROJECT_DIR"
            return
        fi
        printf 'Existing Makefile preserved: %s/Makefile\n' "$PROJECT_DIR"
        return
    fi
    cp --update=none -- "$ROOT/templates/project.Makefile" "$PROJECT_DIR/Makefile"
    if [[ ! -e "$PROJECT_DIR/.espemu-framework" && ! -L "$PROJECT_DIR/.espemu-framework" ]]; then
        printf '%s\n' "$ROOT" > "$PROJECT_DIR/.espemu-framework"
    fi
    printf 'Project make commands added: %s/Makefile\n' "$PROJECT_DIR"
}
if [[ "$MODE" == --makefile-only ]]; then
    if [[ ! -f "$PROJECT_DIR/CMakeLists.txt" ]]; then
        printf 'Not an existing ESP-IDF project: %s\n' "$PROJECT_DIR" >&2
        exit 2
    fi
    install_makefile
    exit 0
fi
MARKER="$PROJECT_DIR/.espemu-project"
if [[ -e "$MARKER" ]]; then
    if [[ -L "$MARKER" || "$(< "$MARKER")" != espemu-project-v1 || ! -f "$PROJECT_DIR/CMakeLists.txt" ]]; then
        printf 'Invalid or incomplete ESPEmu project; existing files were not changed.\n' >&2
        exit 2
    fi
    printf 'Using existing project without replacing files: %s\n' "$PROJECT_DIR"
else
    if [[ -d "$PROJECT_DIR" && -n "$(find "$PROJECT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
        printf 'Directory is not empty; refusing to overwrite it: %s\n' "$PROJECT_DIR" >&2
        printf 'For an existing ESP-IDF project, use: espemu run "%s"\n' "$PROJECT_DIR" >&2
        exit 2
    fi
    source "$ROOT/tools/env.sh"
    espemu_prepare_web
    mkdir -p -- "$PROJECT_DIR"
    cp -- "$ROOT/firmware/CMakeLists.txt" "$ROOT/firmware/sdkconfig.defaults" "$PROJECT_DIR/"
    if [[ "$TEMPLATE" == demo ]]; then
        cp -R -- "$ROOT/firmware/main" "$ROOT/firmware/components" "$PROJECT_DIR/"
        rm -f -- "$PROJECT_DIR/main/device_pins.h"
        cp -- "$ROOT/firmware/espemu.json" "$PROJECT_DIR/espemu.json"
    else
        cp -R -- "$ROOT/templates/empty/main" "$PROJECT_DIR/"
        cp -- "$ROOT/templates/empty/espemu.json" "$PROJECT_DIR/espemu.json"
    fi
    cp -- "$ROOT/templates/project.gitignore" "$PROJECT_DIR/.gitignore"
    install_makefile
    printf 'espemu-project-v1\n' > "$MARKER"
    bash "$ROOT/tools/generate-project-artifacts.sh" "$PROJECT_DIR"
    printf 'Created %s ESP-IDF simulation project: %s\n' "$TEMPLATE" "$PROJECT_DIR"
fi
case "$MODE" in
    --init-only) printf 'From the project directory: make build or make run\n'; exit 0 ;;
    --no-run) exec bash "$ROOT/tools/demo.sh" "$PROJECT_DIR" --build-only ;;
    --run) exec bash "$ROOT/tools/demo.sh" "$PROJECT_DIR" ;;
esac
