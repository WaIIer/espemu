# Architecture

ESPEmu has three parts. A patched Espressif QEMU runs the firmware and the device models. A Node.js backend starts QEMU, talks to it and serves the workbench. The browser workbench shows the devices and sends input changes.

## Data flow

1. The backend reads the project's `espemu.json`. `shared/manifest.ts` validates it against the device registry in `shared/registry.ts`.
2. The backend writes the normalized circuit to a private file and starts QEMU with that file. QEMU creates only the declared device instances.
3. The firmware talks to the devices through the ordinary ESP-IDF GPIO, I2C, RMT and I2S drivers.
4. The backend reads device state and pin levels from QEMU through QMP and sends them to the browser over a WebSocket.
5. When you change an input in the browser, the backend validates it and writes the complete new input snapshot to QEMU.
6. Lines that the firmware prints with the `ESP_EMU` prefix become named application values. Other UART output goes to the console.

QEMU owns register behavior and conversion timing. The backend owns the QEMU process, the QMP connection, reset epochs and scenarios. The browser never invents device or firmware values.

## Backend and QEMU

- QMP runs on a private Unix socket. QEMU runs headless, with the UART on standard output and the monitor turned off.
- The backend looks for the firmware at the project's `build/qemu_flash.bin`. It finds QEMU at `$ESPEMU_TOOLS/qemu/build/qemu-system-xtensa` and the ROM files in `$ESPEMU_TOOLS/qemu/pc-bios`. `ESPEMU_FLASH`, `ESPEMU_QEMU` and `ESPEMU_BIOS` override these paths. `ESPEMU_TOOLS` defaults to the checkout's `.cache` directory, and a package sets it to `/usr/lib/espemu/toolchain`.
- `server/project.ts` loads `espemu.json` from the directory in `ESPEMU_PROJECT`, or from the file in `ESPEMU_MANIFEST`. A project without a manifest has no devices. An invalid manifest stops the launch before QEMU starts.
- QEMU reads the circuit from the file in `ESPEMU_QEMU_CIRCUIT`. The file has the form `{v:1, devices:[{id, type, address, inputs}]}`. The default circuit is empty.
- The read-only QOM property `espemu-circuit` on `/machine/soc` returns `{v:1, virtualMs, devices}`. It includes each instance's physical inputs and its register and conversion state.
- The property `espemu-circuit-inputs` takes `{v:1, devices:{instanceId: rawInputs}}`. Every id must match a configured device. Every value is an integer in the registry's raw units. QEMU validates the whole snapshot before it changes anything.
- On `/machine/soc/gpio`, the property `espemu-state` reports pin levels and `espemu-inputs` sets external inputs to 0, 1 or released.
- MAX7219 chains are configured through the GPIO property `max7219-config` before the firmware starts. The read-only property `max7219-state` reports the display RAM, the control registers and the rendered rows. [MAX7219.md](MAX7219.md) has the details.
- HD44780 displays are device type `hd44780` in the circuit. Their state contains the raw DDRAM and CGRAM, the flags and busy counters. `shared/lcd.ts` turns it into characters.
- The circuit can declare one `speaker: {id, din, bclk, lrclk}`. The read-only property `espemu-speaker-state` reports the speaker's state. The property `espemu-speaker-audio` returns the queued samples as base64 16-bit mono and then clears the queue. Audio reaches the browser in separate `audio` WebSocket messages.
- The circuit can declare one `camera: {id, vsync}`. The OV2640 sits on I2C1 at 0x30. The property `espemu-camera-frame` takes a picture as `{v, seq, format, width, height, data}`. The read-only property `espemu-camera-state` reports the sensor output and the I2S0 DMA counters. Pictures reach guest memory only through I2S0 descriptor DMA. [CAMERA.md](CAMERA.md) has the details.
- The read-only property `espemu-trace` on `/machine/soc/i2c0` returns the last 128 I2C transactions as `{v:1, events:[{seq, virtualMs, address, read, length, status}]}`. The status is `ok` or `nack`. Sequence numbers restart at each reset.
- `shared/application.ts` validates the `ESP_EMU` lines. Each line holds named channels with values and units. No channel is required.

## Backend and browser

- The backend serves the built workbench from `dist`, plus `GET /live`, `GET /health`, `GET /api/state`, `GET /api/topology` and the WebSocket `/ws`. It listens on `127.0.0.1:4000` by default. `HOST` and `PORT` change the address.
- `/live` reports that the HTTP server is up. `/health` reports whether the firmware is running and whether the QMP bridge is connected. Pause and stop do not fail `/live`.
- HTTP and WebSocket requests must use a loopback host name. A request that sends an `Origin` header must come from that exact host. The backend ignores forwarded headers, so it does not support HTTPS proxies or remote browsers.
- `shared/runtime.ts` defines the commands and the state messages. `server/project-runtime.ts` owns the selected circuit, the model states, the GPIO wiring and the scenarios.
- Every snapshot and acknowledgement carries a `sessionId` for the backend's lifetime and an `epoch` that increases at each guest reset. Clients send both with each command. The backend applies commands one at a time.
- The backend forwards each firmware sample as it arrives. It also sends a snapshot up to 10 times a second while running and once a second while paused or stopped. It keeps at most 600 samples, 256 events and 200 console lines. Each socket buffers at most 1 MiB.
- The browser keeps your unsaved input edits apart from the confirmed inputs. Charts use virtual time. LED states come only from the reported pin levels.
- Scenarios start at a new virtual-time origin without resetting the guest. Pause freezes them. Reset, and stop followed by run, restart active scenarios in the new epoch.
- Physical inputs and GPIO drives survive resets. A held button belongs to its browser connection and never appears in an export.
- Export and import use the complete project manifest. A change to the I2C, WS2812 or MAX7219 topology restarts QEMU in a new epoch. GPIO wiring and input changes apply immediately. These edits change only the running circuit. To keep them, save the exported file as the project's `espemu.json`.

## Limits

ESPEmu emulates the classic ESP32 with one I2C bus on GPIO21 and GPIO22, plus the device instances the registry supports. It does not model the general signal matrix, PWM, bus arbitration, clock stretching, electrical behavior, Wi-Fi, Bluetooth, general-purpose SPI or the ADC. It is not cycle accurate, and it cannot migrate or replay a running virtual machine. A new device model needs a QEMU build. New instances of existing devices, new manifests and new scenarios do not. [PROJECTS.md](PROJECTS.md) explains how to add a model.
