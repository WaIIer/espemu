#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMMAND=${1:-help}
PROJECT_DIR=$(realpath -e "${2:-$PWD}")
if [[ ! -f "$PROJECT_DIR/CMakeLists.txt" ]]; then
    printf 'Not an ESP-IDF project: %s\n' "$PROJECT_DIR" >&2
    exit 2
fi
prepare() {
    source "$ROOT/tools/env.sh"
    if ! espemu_have_node || { [[ ${1:-web} == native ]] && ! espemu_have_idf; }; then
        bash "$ROOT/tools/bootstrap.sh"
    fi
    source "$ROOT/tools/env.sh"
}
case "$COMMAND" in
    add_component)
        if [[ -n ${DEVICE:-} ]]; then
            exec bash "$ROOT/tools/create-project.sh" --add-component "$PROJECT_DIR" --device "$DEVICE"
        fi
        exec bash "$ROOT/tools/create-project.sh" --add-component "$PROJECT_DIR"
        ;;
    docs|editor)
        exec bash "$ROOT/tools/generate-project-artifacts.sh" "$PROJECT_DIR"
        ;;
    kicad)
        exec bash "$ROOT/tools/generate-project-artifacts.sh" "$PROJECT_DIR" --kicad
        ;;
    build)
        prepare native
        exec bash "$ROOT/tools/build-firmware.sh" "$PROJECT_DIR"
        ;;
    run)
        exec bash "$ROOT/tools/demo.sh" "$PROJECT_DIR"
        ;;
    web)
        exec bash "$ROOT/tools/demo.sh" "$PROJECT_DIR" --no-build
        ;;
    test)
        shopt -s nullglob
        tests=("$PROJECT_DIR"/test/*.test.{mjs,js,mts})
        if (( ${#tests[@]} == 0 )); then
            printf 'No project tests found in %s/test (*.test.mjs, *.test.js or *.test.mts).\nSee "Regression Tests" in ESPEMU-DEVICES.md for a starter.\n' "$PROJECT_DIR" >&2
            exit 2
        fi
        bash "$ROOT/tools/project-command.sh" build "$PROJECT_DIR"
        source "$ROOT/tools/env.sh"
        espemu_prepare_web
        cd "$PROJECT_DIR"
        ESPEMU_PROJECT="$PROJECT_DIR" exec node --import "$ROOT/node_modules/tsx/dist/loader.mjs" --import "$ROOT/tools/regression-loader.mjs" --test "${tests[@]}"
        ;;
    clean)
        if [[ "$PROJECT_DIR" == "$ROOT" ]]; then
            printf 'Refusing to clean the framework workspace. Run this from your project.\n' >&2
            exit 2
        fi
        rm -rf -- "$PROJECT_DIR/build"
        printf 'Removed build output for %s. Firmware, sdkconfig and espemu.json were preserved.\n' "$PROJECT_DIR"
        ;;
    rebuild)
        bash "$ROOT/tools/project-command.sh" clean "$PROJECT_DIR"
        exec bash "$ROOT/tools/project-command.sh" build "$PROJECT_DIR"
        ;;
    configure)
        prepare native
        source "$IDF_PATH/export.sh" >/dev/null
        cd "$PROJECT_DIR"
        exec idf.py menuconfig
        ;;
    validate)
        source "$ROOT/tools/env.sh"
        espemu_prepare_web
        export ESPEMU_PROJECT="$PROJECT_DIR"
        export ESPEMU_FRAMEWORK="$ROOT"
        node --import "$ROOT/node_modules/tsx/dist/loader.mjs" --input-type=module -e '
import { pathToFileURL } from "node:url";
const root = process.env.ESPEMU_FRAMEWORK;
const { loadProject } = await import(pathToFileURL(root + "/server/project.ts").href);
const project = loadProject(root);
console.log(`Valid ${project.manifest.target} circuit: ${project.manifest.devices.length} peripheral(s).`);
if (!project.filename) console.log("No espemu.json: this project uses an empty circuit.");
'
        ;;
    doctor)
        status=0
        source "$ROOT/tools/env.sh"
        if [[ -n ${ESPEMU_INSTALLED:-} ]]; then
            if espemu_have_node && espemu_have_idf && "$ESPEMU_QEMU" --version >/dev/null; then
                printf 'ESPEmu %s package tools are ready: Node %s, ESP-IDF %s, QEMU %s.\n' "$ESPEMU_VERSION" "$NODE_VERSION" "$IDF_TAG" "$QEMU_TAG"
            else
                bash "$ROOT/tools/bootstrap.sh" || status=$?
            fi
        else
            bash "$ROOT/.github/skills/espemu-environment/scripts/doctor.sh" ${ESPEMU_DOCTOR_PROFILE:+"$ESPEMU_DOCTOR_PROFILE"} || status=$?
            bash "$ROOT/tools/artifact-provenance.sh" check qemu || true
        fi
        bash "$ROOT/tools/artifact-provenance.sh" check firmware "$PROJECT_DIR" || true
        exit "$status"
        ;;
    tools)
        exec bash "$ROOT/tools/bootstrap.sh"
        ;;
    *)
        printf 'Unknown project command: %s\n' "$COMMAND" >&2
        exit 2
        ;;
esac
