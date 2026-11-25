# ESPEmu

ESPEmu runs ordinary ESP-IDF firmware for the classic ESP32 in a patched Espressif QEMU. You declare a circuit of sensors, LEDs, buttons, displays, a camera and a speaker in `espemu.json`. A browser workbench then shows what the firmware does to those devices and lets you change their physical inputs.

The firmware uses the normal ESP-IDF GPIO, I2C, RMT and I2S drivers. ESPEmu does not need special telemetry, a hardware abstraction shim or values faked by the browser. Each simulated device is a QEMU model that answers real register and bus transactions.

ESPEmu is not affiliated with or endorsed by Espressif Systems. ESP32 and ESP-IDF are Espressif trademarks.

## Install

Each release has a Debian package for Ubuntu 24.04 or newer and a package for Arch Linux. Both are for x86_64 only. Download them from the [releases page](../../releases). The `latest` release always has the newest build under fixed file names.

```sh
sudo apt install ./espemu_amd64.deb             # Ubuntu 24.04 or newer
sudo pacman -U espemu-x86_64.pkg.tar.zst        # Arch Linux
```

The package installs everything into `/usr/lib/espemu` and adds the `espemu` command. It includes the patched QEMU, ESP-IDF v5.4.2 with its xtensa toolchain, Node.js and the built workbench. Nothing is downloaded the first time you use it. The one exception is an ESP-IDF managed component that a project declares, such as the WS2812 LED strip driver. ESP-IDF downloads that component during the project's first build.

## Quick start

```sh
espemu new --web      # design a project in the browser and create it
cd my_project
make run              # build the firmware and open the workbench
```

`espemu demo` runs the bundled demo, which uses every supported device type. Inside a project, `espemu build`, `espemu run` and the other project commands do the same as `make build`, `make run` and so on.

## Create a project

There are three ways to create a project. Each one creates files only and returns to the shell. Building and running are separate steps.

- `espemu new --web` opens a browser page that works like a new-project dialog. You enter the project name, choose a folder, add devices and press **Create project**. Press Ctrl+C in the terminal to cancel without creating anything.
- `espemu new` asks one question at a time in the terminal. It covers the starter application, the devices and their wiring, initial inputs and scenarios.
- `espemu new my_project` creates an empty ESP-IDF project with no devices.

The starter application is **Empty** by default. **Blinky** generates a blink loop for an LED you choose. **All-device demo** copies the bundled demo firmware. ESPEmu never adds demo code to a project unless you select it.

Inside a project, `make add_component` adds one device. It picks free pins and addresses, updates the generated header and documentation, and leaves your source files alone. For scripts, pass the device in the `DEVICE` variable:

```sh
DEVICE=bme280 make add_component
DEVICE='{"type":"led","id":"fan","pin":25}' make add_component
```

## Write firmware

Each project has a generated `main/device_pins.h`. Include it to get pin macros for every declared device. For sensors and displays, ESPEmu also installs a small driver library into the project. The library's functions need only a few lines:

```c
#include "device_pins.h"

void app_main(void)
{
    gpio_reset_pin(STATUS_PIN);
    gpio_set_direction(STATUS_PIN, GPIO_MODE_OUTPUT);
    for (;;) {
        gpio_set_level(STATUS_PIN, 1);
        vTaskDelay(pdMS_TO_TICKS(500));
        gpio_set_level(STATUS_PIN, 0);
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}
```

The generated `ESPEMU-DEVICES.md` in each project lists the wiring and the driver calls for its devices. `make docs` refreshes it after you change the circuit.

## Declare a circuit

`espemu.json` sits next to the project's `CMakeLists.txt`. The project creator writes it, and you can also edit it by hand:

```json
{
  "v": 1,
  "target": "esp32",
  "buses": [{"id": "i2c0", "type": "i2c", "controller": 0, "sda": 21, "scl": 22}],
  "devices": [
    {"id": "status", "type": "led", "pin": 2, "color": "green"},
    {"id": "button", "type": "button", "pin": 27, "activeLow": true},
    {"id": "room", "type": "tmp105", "bus": "i2c0", "address": 72}
  ],
  "inputs": {"room": {"temperatureC": 20}},
  "gpioInputs": [],
  "scenarios": []
}
```

ESPEmu validates the whole file before QEMU starts. It rejects unknown devices, address conflicts, pins that are already used and inputs outside a device's range. I2C addresses are decimal integers, so 72 is 0x48. Only the declared devices exist in the emulator. [docs/PROJECTS.md](docs/PROJECTS.md) describes every field.

## Use the workbench

The workbench shows each declared device. LEDs follow the real GPIO pin levels. Sensor panels show both the physical value you set and the register state of the QEMU model. Displays show what the firmware wrote to them. The workbench also shows the UART console, I2C and GPIO events, and charts of values that the firmware reports.

You can press buttons, flip switches and change sensor inputs while the firmware runs. Scenarios change an input over time with ramps, sine waves, seeded noise or recorded frames, timed in QEMU virtual time. Fault controls make a sensor NACK or return invalid data, so you can test error handling.

The camera panel feeds your webcam or a test pattern into an emulated OV2640. The speaker panel plays I2S audio from a MAX98357A through the browser.

The **Circuit wiring** diagram draws the GPIO connections and shared I2C buses declared in `espemu.json`. **Trace signal** selects a net and shows its endpoints. Click a device name to inspect it. Zoom and scroll to view larger circuits. Open the wiring reference for device labels, addresses, polarity and signal mappings.

## Test a project

Put Node tests in the project's `test/` folder and run `make test`. The command builds the firmware and starts a separate workbench for each test. Tests address devices by id:

```js
import { startProject } from 'espemu/regression';

const project = await startProject();
try {
  await project.input('climate', { temperatureC: 31 });
  await project.waitFor(state => project.isOn('alarm', state) === true);
} finally {
  await project.stop();
}
```

The generated `ESPEMU-DEVICES.md` contains a starter test.

## Supported devices

| Kind | Devices |
| --- | --- |
| GPIO | LED, RGB LED, button, switch, logic probe |
| I2C sensors | TMP105, BH1750, BME280, SHT30, SHT31, SHT35 |
| Motion | MPU6050 |
| Displays | MAX7219 dot matrix, HD44780 character LCD on a PCF8574 backpack, WS2812 LEDs and strips |
| Camera | OV2640 on ESP32-CAM wiring, through I2S0 DMA |
| Audio | MAX98357A speaker, through I2S DMA |
| Digital modules | 20 presets, including HC-SR501, RCWL-0516, TTP223, A3144 and KY-038 |

[docs/SUPPORT.md](docs/SUPPORT.md) lists what each model implements and what it leaves out. The guides for the [camera](docs/CAMERA.md) and the [MAX7219](docs/MAX7219.md) cover those devices in detail.

## Limitations

- ESPEmu supports only the classic ESP32. Other Espressif chips are not emulated.
- The packages are for x86_64 Linux. Other hosts can run from source or use the container.
- Device models reproduce register behavior and logic levels. They do not model voltage, current, analog signals or sensing physics.
- The emulator does not support Wi-Fi, Bluetooth, PWM, the ADC or general-purpose SPI.
- Timing follows QEMU virtual time. ESPEmu is not cycle accurate and cannot replay a run exactly.
- The digital module presets model only the module's digital output pin.

## Run from source

Running from source needs x86_64 Linux with Git, curl, a C compiler and the usual build tools. The rootless bootstrap reads native library versions from `tools/native-packages.lock`, which targets Ubuntu 26.04 packages. On other distributions, use the container instead.

```sh
bash tools/demo.sh
```

The first run downloads the pinned toolchains into `.cache`. It then builds QEMU, the demo firmware and the workbench, and starts the server. The command prints the workbench URL, normally `http://127.0.0.1:4000`. Ctrl+C stops the server and QEMU.

From a checkout, `bash tools/setup-project.sh` takes the same arguments as `espemu new`. Generated projects record the checkout's path, so `make build` and `make run` work the same way.

The container needs a running Docker daemon:

```sh
docker compose up --build
```

Set `PORT=4001` when port 4000 is taken.

## Development

```sh
source tools/env.sh
npm run typecheck
npm run test:fast           # unit, manifest and generator tests; no QEMU needed
bash tools/verify.sh        # firmware, QEMU model and browser tests
```

`SOAK=1 bash tools/verify.sh` adds a ten-minute streaming test that checks memory growth and dropped samples.

QEMU changes live in `qemu/espemu.patch`, which applies to the pinned Espressif QEMU commit in `versions.env`. After editing the QEMU source in `.cache/qemu`, run `bash tools/save-qemu-patch.sh`. [docs/PROJECTS.md](docs/PROJECTS.md#add-a-new-model) explains how to add a device model, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes how the backend, QEMU and the workbench talk to each other.

The [packaging/](packaging/) scripts build the release packages. The [release workflow](.github/workflows/release.yml) runs after a pull request is merged into `main`. It builds both packages and installs each one in a clean container, where it builds and boots firmware without network access. After the repository owner approves the release in GitHub, the workflow publishes it.

## License

ESPEmu is released under the [MIT license](LICENSE). The packages also contain third-party software under its own licenses, including the GPL-2.0 Espressif QEMU. `THIRD-PARTY-NOTICES` in the install lists each component. Every release includes the complete patched QEMU source.
