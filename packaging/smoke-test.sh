#!/usr/bin/env bash
# Runs as an ordinary user against an installed package: create, build and boot real firmware.
set -euo pipefail
NODE=/usr/lib/espemu/toolchain/node/bin/node
espemu version
if touch /usr/lib/espemu/.write-test 2>/dev/null; then
    printf 'The installed tree must not be writable by users.\n' >&2
    exit 1
fi
booted() {
    "$NODE" --input-type=module -e '
const deadline = Date.now() + 120000;
for (;;) {
  try {
    const health = await (await fetch(`http://127.0.0.1:${process.argv[1]}/health`)).json();
    if (health.firmwareBootObserved) { console.log(`Firmware booted: phase ${health.phase}, GPIO ready ${health.gpioReady}`); process.exit(0); }
  } catch {}
  if (Date.now() > deadline) { console.error("Firmware did not boot within two minutes."); process.exit(1); }
  await new Promise(resolve => setTimeout(resolve, 1000));
}' "$1"
}
serve() {
    local port=$1 log=$2 status=0
    shift 2
    PORT=$port "$@" > "$log" 2>&1 &
    local server=$!
    booted "$port" || status=$?
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
    if [[ $status != 0 ]]; then cat "$log" >&2; exit "$status"; fi
}
cd "$HOME"
espemu new smoke --config-json '{"v":1,"starter":"empty","language":"c","manifest":{"v":1,"target":"esp32","devices":[{"id":"status","type":"led","pin":2}]}}'
cd smoke
make validate
make build
grep -q '#define STATUS_PIN GPIO_NUM_2' main/device_pins.h
serve 4400 "$HOME/web.log" espemu web
serve 4410 "$HOME/demo.log" espemu demo
printf 'Packaged ESPEmu created, built and ran firmware as %s.\n' "$(id -un)"
