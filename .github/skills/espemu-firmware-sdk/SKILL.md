---
name: "espemu-firmware-sdk"
description: "Use when adding an ESPEmu sensor driver or short C/C++ init/read API, packaging vendor source/licenses/managed dependencies, updating espemu_devices and generated device_pins.h/CMake linkage, compiling ordinary ESP-IDF fixtures, or diagnosing SDK values that disagree with actual QEMU register transactions."
---

# Packaged Firmware Device SDK

## User-Facing Contract

A configured sensor must be usable with a generated `device_pins.h`, one shared
bus initialization, and short `espemu_<type>_init/read` calls. Package dependency
source/headers/licenses and CMake integration automatically. Do not hand the user
callback scaffolding, raw register boilerplate, framework absolute paths, or
instructions to manually edit CMake for an ordinary supported device.

Use [datasheet development](../espemu-datasheet-sensor/SKILL.md) for protocol facts
and [model development](../espemu-qemu-model/SKILL.md) for matching hardware
behavior. Firmware must call normal ESP-IDF I2C/GPIO/RMT APIs. Custom UART messages
can report test observations, but cannot stand in for the peripheral transaction.

## Ownership Map

| File | Responsibility |
| --- | --- |
| [espemu_devices.h](../../../components/espemu_devices/include/espemu_devices.h) | Public C/C++ types, reading fields, init/read APIs |
| [espemu_devices.c](../../../components/espemu_devices/espemu_devices.c) | Bus setup, IDF I/O, device initialization, response validation/decoding |
| [SDK CMakeLists.txt](../../../components/espemu_devices/CMakeLists.txt) | Source compilation and driver/component requirements |
| [idf_component.yml](../../../components/espemu_devices/idf_component.yml) | Exact managed component dependencies |
| [vendor component](../../../firmware/components/bme280) | Established licensed vendor-source/component packaging pattern |
| [project-artifacts.ts](../../../tools/project-artifacts.ts) | Copies SDK/vendor files, emits includes/macros/examples and automatic CMake hook |
| [framework fixtures](../../../tests/fixtures) | Ordinary firmware coverage, including C++ SDK integration |
| [fixture builder](../../../tools/build-framework-fixtures.sh) | IDF builds into ignored `.cache` paths and merged flash output |

## 1. Choose A Minimal Stable API

Follow nearby conventions:

```c
esp_err_t espemu_PART_init(espemu_PART_t *sensor, i2c_port_t port, uint8_t address);
esp_err_t espemu_PART_read(espemu_PART_t *sensor, espemu_PART_reading_t *reading);
```

`PART` is a placeholder to replace with the stable device key, not a literal
public symbol. Existing single-channel TMP105/BH1750 reads use a `float *`;
multichannel BME280/MPU6050 use named reading structs. Choose the smallest API
that fits the actual part and established style.

- Public fields name units explicitly: `_temperature_c`, `_pressure_pa`,
  `_humidity_pct`, `_gyro_x_dps`, `_accel_x_g`, or the corresponding clear unit.
- Return `esp_err_t` consistently; preserve underlying bus errors and report
  invalid arguments/responses with named IDF constants, not guessed numeric codes.
- Validate null pointers and supported addresses before bus operations.
- Keep per-instance port/address/driver state. Shared mutable contexts must not
  make a second instance overwrite the first one's calibration or connection.
- Keep `extern "C"` guards in the public header and the C entry ABI for C++
  `app_main`. Do not force every caller to compile the SDK as C++.
- Add advanced configuration only when required by the requested supported
  subset; avoid a complicated options object around fixed defaults.
- Initialize the shared bus once. Do not reinstall/delete the I2C driver on each
  sensor read or embed bus ownership into every device helper.

## 2. Implement Actual ESP-IDF Transactions

Use existing `sensor_write`, `sensor_read`, and signed-word helpers when their
semantics match this part. A command-only sensor may use direct read commands
rather than a register pointer; do not force every part through the same helper.

1. Verify identity/reset/defaults when the datasheet exposes them.
2. Send documented configuration/measurement commands in the required order.
3. Respect power-up/conversion delays required by the selected initialization
   mode. IDF delays belong in the driver; model conversion timers remain virtual.
4. Read coherent register bursts with the correct repeated-START/STOP sequence.
5. Decode signed width/endianness/sensitivity/offset using verified vectors.
6. Validate documented status/CRC/invalid patterns without rejecting a legitimate
   endpoint, zero, or negative measurement.
7. Only publish caller output after a complete successful read/validation, so a
   failure does not leave a partly updated reading struct presented as valid.
8. Surface disconnection/timeouts/invalid responses and support reinit/recovery.

Bound I/O buffers and timeouts. Check length before copying register/address
bytes into a local frame. Avoid shifting signed bytes or narrowing before sign
extension. Do not widen test tolerances to mask an SDK/model unit mismatch.

## 3. Wrap Vendor Drivers Inside The SDK

BME280 provides the existing pattern: SDK-owned read/write/delay callbacks,
embedded per-instance vendor driver, and short application init/read calls.
The application never supplies those callbacks.

For a new licensed driver:

- Pin a version/immutable commit and keep source provenance/license evidence.
- Copy only required source/headers and the supplied license into a
  framework-owned component. Preserve upstream notices; do not strip headers.
- Use component-owned CMake include paths and `REQUIRES` dependencies.
- Put managed dependency pins in the component manifest rather than relying on
  a global installation or an unversioned downloaded header.
- Extend the artifact copier for all source/header/license/dependency files.
- Extend the root Git allowlist only for the new framework component if needed;
  generated user-project ignore rules are a separate file/template.
- Check C/C++ inclusion and ABI compatibility against the pinned IDF version.

Embedded vendor callback context may point at the sensor struct itself. Such
instances need stable storage and must not be copied/moved after initialization
unless the wrapper repairs its context pointer. Do not expose vendor callback
ownership details to ordinary users; keep this lifetime rule inside the SDK or
succinct API documentation when relevant.

Do not replace a tested licensed compensation engine with an approximate formula
merely to avoid packaging it. Conversely, do not add a large third-party library
for a trivial register decode that already has a clear existing local helper.

## 4. Extend Automatic Project Packaging

Read these owners in `tools/project-artifacts.ts`:

| Owner | Required check/change |
| --- | --- |
| `usesDeviceSdk` | New ordinary I2C sensors already select the SDK; new kinds may need deliberate handling |
| `devicePinsHeader` | Emits instance address/port and bus GPIO macros; includes SDK and configured APIs |
| `deviceSdkFiles` | Explicit file-copy list: every new SDK source/header/vendor/license must be added |
| `usage` | Device-specific init/read snippet and correct reading fields/units |
| `projectReadme` | Shared bus init, short device examples, documented boundaries |
| `generateProjectArtifacts` | Hash ledger, preservation, symlink guards and one-time optional SDK hook |

The current copier lists SDK `CMakeLists.txt`, `idf_component.yml`,
`espemu_devices.c`, and `include/espemu_devices.h`, plus Bosch component files.
If a new driver is split into another source file, adding it to SDK CMake alone
is insufficient: generated projects need that file copied too.

The generated `.espemu-device-sdk.cmake` links `main` PUBLIC to
`idf::espemu_devices`. The project root includes that hook optionally. Reuse
this mechanism; do not require the application to add SDK dependencies manually.
Preserve existing custom component requirements and root CMake contents.

The current `usage()` handles TMP105/BH1750 explicitly, BME280 fields explicitly,
and otherwise assumes MPU6050 reading fields/units. A new sensor MUST receive a
correct usage path; an automatically named `espemu_NEW_reading_t` with gyro fields
is not valid documentation or a usable generated project.

## 5. Fresh-Project C/C++ Proof

Use [device-sdk fixture](../../../tests/fixtures/device-sdk) and
[creator integration tests](../../../tests/project-creator-integration.test.ts)
as the established packaging proof. Extend them or create one narrowly scoped
fixture only if existing fixtures cannot express the device.

The proof must show:

1. A generated temporary project has only normal application dependencies and
   includes `device_pins.h`, not an absolute SDK path.
2. The copied SDK/vendor files and managed pins are present.
3. Root/main CMake linkage is automatic and preserves custom existing content.
4. C and/or C++ builds work according to the affected public API surface.
5. The built firmware boots and initializes/reads the new part through actual
   peripheral transactions with correct physical output units.
6. Fault/reconnect/read errors are observed through that public API.
7. Regeneration preserves user-edited SDK/generated docs/settings and does not
   follow file/ancestor symlinks or silently overwrite application source.

Never use a real user application directory as the fixture. Temporary generated
application edits are test-owned, not permission to edit the user's projects.

## 6. Focused Checks And Builds

For generator/header/example changes, start with:

```bash
source tools/env.sh
node --import tsx --test tests/project-artifacts.test.ts tests/project-creator.test.ts
```

For SDK C changes, use a focused IDF build of the affected existing fixture
before broad testing. The current framework builder loops four fixture folders;
it does not provide an invented `--fixture` option. Repeat its actual build/merge
stanza for one fixture when narrowing, or run the established builder:

```bash
bash tools/build-framework-fixtures.sh
node --import tsx --test tests/project-runtime.test.ts
node --import tsx --test tests/project-creator-integration.test.ts
```

Build the QEMU model first if its sources/patch changed. A firmware read failing
against an old binary does not prove the SDK wrong. Preserve the merged
`qemu_flash.bin`/flash-args relationship and use `-snapshot` for emulator sessions.

## Completion

Public API/units, model transactions, vendor dependencies, generated headers,
copied file inventory, CMake hook, correct examples, and fresh C/C++ firmware
evidence all agree. No callback/CMake wiring is handed off to the user, no app
source changed, and fault/recovery paths are tested. Apply
[the completion gate](../espemu-completion-gate/SKILL.md) before delivery.
