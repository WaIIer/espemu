# Projects and device models

## Project manifest

Each project describes its circuit in `espemu.json`. `shared/manifest.ts` validates the file, and `shared/registry.ts` defines each device type. The registry entry for a type lists its configuration fields, I2C addresses, input channels with units, ranges and defaults, and the workbench panel that shows it.

A manifest has these top-level fields: `v`, `target`, `buses`, `devices`, `inputs`, `gpioInputs` and `scenarios`. A normalized manifest is at most 256 KiB, so long recorded scenarios have to be shortened. The workbench keeps up to 600 points of application history. When there are many channels, it keeps a shorter window so each message still fits the transport limit.

The only target is `esp32`. The I2C bus must be controller 0 on SDA GPIO21 and SCL GPIO22. `frequencyHz` records the speed the firmware is expected to use. The real bus timing comes from the controller registers that the firmware writes. ESPEmu rejects other controllers and other pins.

Every device has a unique `id` and a registry `type`. A `label` is optional.

- I2C devices declare a `bus` and an integer `address`.
- GPIO loads and inputs declare a `pin`. RGB LEDs declare three `pins`.
- MAX7219 chains declare `din`, `clk`, `load` and a `length` of 1 to 16 modules.
- GPIO indicators accept `activeLow`.

GPIO6 to GPIO11 are reserved for flash. GPIO34 to GPIO39 are input-only. Two devices other than logic probes cannot share a pin. A logic probe can watch a pin that another device uses.

`inputs` holds the initial physical values for each sensor, keyed by device id. `gpioInputs` lists the initial drive of each button or switch as 0, 1 or `null` for released. A scenario targets a `deviceId` and one of its registry channels. Its mode is manual, ramp, sine, noise or playback. GPIO inputs use the press and toggle controls, not scenarios.

A project without a manifest has no devices. ESPEmu never adds a manifest to an existing project or changes one without your action. Edits in the workbench change only the running circuit. To keep them, export the circuit and save it as `espemu.json`.

## Create projects

`espemu new` creates projects in three ways.

The guided creator runs with no arguments or with `--guided`. It asks one question at a time and validates each answer against the registry. It covers the starter application, devices and wiring, initial inputs and scenarios. It writes nothing until you confirm the summary, and it asks again before building or running. An empty starter stays empty. The blinky starter adds GPIO code only because you chose it.

The browser creator runs with `--web`. Its **New project** card at the top asks for the project name and a location. The location defaults to the current folder, and **Browse…** opens a folder picker. A live check shows the folder that will be created and refuses a folder that is not empty. After the starter and the devices, the **Create project** card at the end of the page creates the project. It uses the same validation and file generation as a configuration file. A directory argument fills in the name and location. The command prints a URL with a session token. The token protects folder browsing and creation, and it stops working when the command exits.

The workbench's **Create project** link opens the same page without a session. That version cannot create files. It saves a draft in the browser and can download or copy the project configuration. Pass that file to `espemu new`:

```sh
espemu new my_project --config project-config.json
espemu new my_project --config-json '{"v":1,"starter":"empty","language":"c","manifest":{"v":1,"target":"esp32"}}'
```

`--config -` reads the configuration from standard input. `shared/project-creator.ts` validates it. The configuration has these fields:

- `v`, which is 1.
- `starter`, which is `empty`, `blinky` or `demo`.
- `language`, which is `c` or `cpp` and defaults to `c`.
- `manifest`, the complete circuit.
- `blink`, which only the blinky starter accepts and requires. It has the form `{"deviceId": "status", "intervalMs": 500}` and must name a declared LED.

The destination folder is a command argument and never part of the configuration. Every way of creating a project writes files only and refuses a folder that is not empty. `--no-run` also builds the firmware, and `--run` builds it and starts the workbench. A configuration cannot be combined with `--template` or `--makefile-only`.

## VS Code and dev containers

Open the generated project folder in VS Code. If Docker and the Dev Containers extension are installed, run **Dev Containers: Reopen in Container**. The container uses the pinned ESP-IDF toolchain and installs the Microsoft C/C++ extension. Creating a project does not start Docker or build anything.

- **ESP-IDF: Prepare IntelliSense** configures the project without compiling it. Code completion reads the compiler, headers and flags from `build/compile_commands.json`. Outside the main component, include the headers you use and declare the component dependencies in CMake.
- **ESP-IDF: Build Firmware** is the default build task. It compiles with two jobs and writes `build/qemu_flash.bin`. These tasks do not need ESPEmu itself, and `make web` on the host can then run the image.
- To use a local toolchain, open VS Code from a shell where ESP-IDF is active. Delete `build/` before switching between the host and the container, because the CMake cache stores absolute paths.
- `make editor` refreshes the generated editor and container files and keeps your edits.

## Project commands

- `make build` compiles the firmware. `make run` builds and starts the workbench. `make web` starts the workbench with the existing image.
- ESPEmu records a fingerprint of the sources behind each firmware image. `make web` refuses an image whose recorded sources have changed. An image without a record is shown with its SHA-256 and a note that its freshness is unknown. Scenario, input and label changes in `espemu.json` do not need a rebuild. Wiring changes do, and the launch warns when `main/device_pins.h` no longer matches the manifest.
- `ESPEMU_REQUIRE_PROVENANCE=1 bash tools/verify.sh` also rejects images without a record. The fingerprint covers the inputs ESPEmu manages, not every external build dependency.
- Firmware builds use two compile jobs. `make build BUILD_JOBS=1` uses one, which helps on a host with little memory. With `make run`, the setting also applies to the QEMU build.
- `make doctor` checks the tools and reports the project's firmware and emulator. In a checkout, `ESPEMU_DOCTOR_PROFILE=--native make doctor` also checks the native build tools.
- `make add_component` adds one device without touching your source or edited documentation, and without building. `DEVICE=TYPE make add_component` or `DEVICE=JSON make add_component` skips the questions.
- `make docs` regenerates `ESPEMU-DEVICES.md` and the packaged drivers. It leaves a README you edited alone.
- `espemu new PROJECT --makefile-only` updates a Makefile that an older ESPEmu generated. It leaves custom Makefiles alone.

On a wide screen, the workbench's console dock shows Serial, Events or both next to the active view. On a narrow screen the dock sits below it. Both consoles follow new entries. Turn Follow off to scroll back while entries keep arriving.

## Regression tests

The [project regression client](../tools/project-regression.ts) runs a project in tests. Put `*.test.mjs`, `*.test.js` or `*.test.mts` files in the project's `test/` folder and run `make test`. The command builds the firmware and makes `espemu/regression` importable from the tests. `startProject()` starts a separate workbench on a free loopback port and talks to it through the public `/ws` protocol. Always call `stop()` at the end.

```js
import { startProject } from 'espemu/regression';

const project = await startProject();
try {
  await project.input('climate', { temperatureC: 31 });
  await project.waitFor(state => project.isOn('alarm', state) === true);
  await project.press('ack');
  await project.waitFor(state => project.channel('acknowledgements', state) === 1);
} finally {
  await project.stop();
}
```

- `isOn(id)` reads the real GPIO pin with the declared polarity. It returns `null` until the firmware enables the output.
- `setInput(id, asserted)` drives a switch-style input.
- `channel(name)` reads a value that the firmware reported with `espemu_telemetry_*`.
- `connectProject(url)` attaches to a workbench that is already running.

Keep physical inputs, model conversions, GPIO levels and firmware decisions in separate assertions. The [Roomguard integration test](../tests/roomguard-integration.test.ts) shows backend cleanup, real faults, virtual-time scenarios and firmware assertions. Set `ROOMGUARD_PROJECT` to the built fixture project to run it.

## Supported devices and addresses

Choosing devices, adding instances at free addresses and changing wiring, inputs or scenarios need no framework change and no QEMU build.

- TMP105 at 0x48 to 0x4f, up to eight instances.
- BH1750 at 0x23 or 0x5c, up to two instances.
- BME280 at 0x76 or 0x77, up to two instances.
- SHT30, SHT31 or SHT35 at 0x44 or 0x45, up to two instances. The model supports single-shot measurements with CRC-checked words. It does not support periodic mode or alerts.
- MPU6050 at 0x68 or 0x69.
- LED, RGB LED, button, switch and logic probe on any pin outside the flash range.
- WS2812 single pixels and strips.
- MAX7219 single or chained 8x8 matrices on three separate output pins. [MAX7219.md](MAX7219.md) describes the protocol and the driver.
- HD44780 16x2 or 20x4 character LCD on a PCF8574 I2C backpack at 0x20 to 0x27 or 0x38 to 0x3f, 0x27 by default. The driver has `espemu_hd44780_init`, `print`, `printf`, `set_cursor` and `create_char`.
- MAX98357A I2S speaker on three output pins. Use `espemu_max98357a_init` and `espemu_max98357a_tone`, or your own `i2s_std` code with the default PLL_D2 clock in Philips or MSB standard mode. APLL, PDM and TDM are not supported. The workbench plays the audio, and tests read it with `speakerAudio(id)`.
- One OV2640 camera on ESP32-CAM wiring, fed from the browser webcam or a test pattern. [CAMERA.md](CAMERA.md) has the details.
- Twenty digital modules: HC-SR501, HC-SR505, RCWL-0516, TTP223, A3144, SS451A, SW-520D, SW-420, KY-032, KY-026, FC-37, YL-69, MQ-2, MQ-135, KY-038, ST188 DOUT, Littelfuse 59170, SN04-N, LJ12A3-4-Z/BX and E18-D80NK.

The LCD and speaker browser test runs against the `tests/fixtures/speaker-lcd` project. Build that project with `espemu new DIR --config tests/fixtures/speaker-lcd/project-config.json`, copy in its `main.c`, then run `SPEAKER_LCD_PROJECT=DIR npx playwright test --config playwright.speaker-lcd.config.ts`.

### Digital modules

A digital module preset models the logic level on the module's digital output pin. It does not model analog readings, comparator calibration, warm-up, pulse timing or the sensing itself.

PIR, microwave and touch modules drive their output both high and low. Open-collector outputs pull the pin low when active and release it otherwise, so they need a pull-up on the module, in the firmware or on the board. GPIO34 to GPIO39 have no internal pull resistors. Set `"pullUp": true` on an open-collector or contact device to add the module's or the board's pull-up, so a released input reads high. Without it, a released input on GPIO34 to GPIO39 floats, and the workbench shows FLOATING. A contact sensor releases the pin when it is open. `activeLow` sets which level counts as asserted. It does not change the output type.

A3144 and KY-032 are active-low by default, and KY-038 is active-high. Comparator modules expose only their DOUT pin, without AOUT or a threshold. KY-032 assumes its enable jumper is fitted, and its EN pin is not modeled. ST188 DOUT replaced the analog-only KY-018.

References: [A3144](https://sensorkit.joy-it.net/en/sensors/ky-003), [PIR](https://learn.adafruit.com/pir-passive-infrared-proximity-motion-sensor/testing-a-pir), [KY-032](https://sensorkit.joy-it.net/en/sensors/ky-032), [KY-038](https://sensorkit.joy-it.net/en/sensors/ky-038), [KY-018](https://sensorkit.joy-it.net/en/sensors/ky-018) and the [ST188 module](https://www.waveshare.com/wiki/Infrared_Reflective_Sensor).

## Add a new model

1. Write or reuse a QEMU `I2CSlave` model with register behavior, reset, conversion timing on the virtual clock and faults. Keep the license notices of any code you reuse.
2. Register the model in the QEMU build and add it to the circuit hub in `hw/sensor/espemu.c`. Validate the configuration before creating devices and the full input snapshot before changing anything. Report the model's `state.channels` and status separately from the physical inputs.
3. Add one entry to `PERIPHERAL_REGISTRY` with its schema, addresses, channels, raw scales and workbench panel. The generic forms, readouts and scenarios need no further changes. A new kind of panel needs one renderer in the workbench.
4. Add an ESP-IDF driver example as a fixture under `tests/fixtures`. Test the real bus transactions, not values set by the browser.
5. Add QTest checks for registers, timing and faults, then firmware, runtime and browser tests. Cover several instances where the device allows them.
6. Run `bash tools/save-qemu-patch.sh` and rebuild QEMU. `qemu/espemu.patch` is the portable copy of all QEMU changes for the pinned commit.
