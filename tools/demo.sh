#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
if [[ $# -gt 2 || ( $# -eq 2 && "$2" != --build-only && "$2" != --no-build ) ]]; then
  printf 'Usage: bash tools/demo.sh [PROJECT_DIRECTORY] [--build-only|--no-build]\n' >&2
  exit 2
fi
PROJECT_DIR=$(realpath -e "${1:-$ROOT/firmware}")
# Packages ship the bundled demo prebuilt and cannot rebuild inside their read-only install.
if [[ -n ${ESPEMU_INSTALLED:-} && $# -eq 0 ]]; then set -- "$PROJECT_DIR" --no-build; fi
if [[ ${2:-} == --no-build && ! -f "$PROJECT_DIR/build/qemu_flash.bin" ]]; then
  printf 'Firmware image missing for %s. Run make build or make run first.\n' "$PROJECT_DIR" >&2
  exit 2
fi
cd "$ROOT"
QEMU_BINARY=$ESPEMU_TOOLS/qemu/build/qemu-system-xtensa
if { [[ ${2:-} != --no-build ]] && ! espemu_have_idf; } || [[ -z ${ESPEMU_INSTALLED:-} && ! -x $QEMU_BINARY && ! -d $ESPEMU_TOOLS/qemu/.git ]]; then
    bash tools/bootstrap.sh
fi
source tools/env.sh
if [[ -z ${ESPEMU_INSTALLED:-} ]] && [[ ${2:-} != --no-build || ! -x $QEMU_BINARY ]]; then bash tools/build-qemu.sh; fi
if [[ ${2:-} != --no-build ]]; then bash tools/build-firmware.sh "$PROJECT_DIR"; fi
if [[ ${2:-} == --no-build && -f tools/artifact-provenance.sh ]]; then
  artifacts=(qemu firmware)
  if [[ -n ${ESPEMU_INSTALLED:-} ]]; then
    artifacts=()
    if [[ "$PROJECT_DIR" != "$ROOT/firmware" ]]; then artifacts=(firmware); fi
  fi
  for artifact in "${artifacts[@]}"; do
    status=0
    bash tools/artifact-provenance.sh check "$artifact" "$PROJECT_DIR" || status=$?
    if [[ "$status" != 0 && "$status" != 2 ]]; then exit "$status"; fi
  done
fi
espemu_prepare_web
ESPEMU_PROJECT="$PROJECT_DIR" node --import tsx --input-type=module -e '
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const { loadProject } = await import("./server/project.ts");
const { devicePinsHeader } = await import("./tools/project-artifacts.ts");
const project = loadProject(process.cwd());
const header = join(project.directory, "main/device_pins.h"), ledger = join(project.directory, ".espemu-generated.json");
const text = existsSync(header) ? readFileSync(header, "utf8") : null;
// Only a header still owned by the generator can drift; user-edited headers are preserved by make docs.
const generated = text !== null && existsSync(ledger) && JSON.parse(readFileSync(ledger, "utf8"))["main/device_pins.h"] === createHash("sha256").update(text).digest("hex");
if (project.filename && generated && text !== devicePinsHeader(project.manifest))
  console.error("Warning: main/device_pins.h does not match the wiring in espemu.json. Run make docs, then make build, so firmware uses the declared pins.");
' || true
espemu_ensure_web_bundle || exit
if [[ ${2:-} == --build-only ]]; then
  printf '\nProject ready: %s\nFlash image: %s/build/qemu_flash.bin\n' "$PROJECT_DIR" "$PROJECT_DIR"
  exit 0
fi
if [[ $# -gt 0 ]]; then
  export ESPEMU_FLASH="$PROJECT_DIR/build/qemu_flash.bin"
fi
PORT=$(node --input-type=module -e '
import net from "node:net";
const first = Number(process.env.PORT ?? 4000);
for (let port = first; port < first + 20; port++) {
  const available = await new Promise(done => {
    const server = net.createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
  if (available) { process.stdout.write(String(port) + "\n"); process.exit(0); }
}
process.exit(1);
')
if [[ ! "$PORT" =~ ^[0-9]+$ ]]; then
  printf 'Invalid port selection: %q\n' "$PORT" >&2
  exit 2
fi
export PORT
export ESPEMU_PROJECT="$PROJECT_DIR"
exec node --import tsx server/index.ts
