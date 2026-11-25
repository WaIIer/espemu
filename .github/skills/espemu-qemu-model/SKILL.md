---
name: "espemu-qemu-model"
description: "Use when adding or repairing an ESPEmu QEMU I2C/GPIO/RMT peripheral model, circuit hub dispatch, register/conversion/reset/fault behavior, QOM input/state mapping, direct QTest checks, model build integration, or saving and proving the complete portable qemu/espemu.patch against pinned Espressif source."
---

# QEMU Peripheral Models And Portable Patch

## Authoritative Source And Boundaries

[qemu/espemu.patch](../../../qemu/espemu.patch) is the tracked source artifact.
Native builds apply it to the pinned Espressif checkout in `.cache/qemu`; that
checkout and its build output are ignored generated/development state. Do not
commit the entire vendor tree or replace the patch from an incomplete cache.

Load [datasheet development](../espemu-datasheet-sensor/SKILL.md) for wire facts
and [environment recovery](../espemu-environment/SKILL.md) for pinned tooling.
The current controller is real ESP32 I2C0; normal firmware register/IRQ traffic
must reach I2CSlave models. GPIO reads use the GPIO QOM device; WS2812 state comes
from decoded RMT transmissions. UART is not a substitute for hardware state.

## 1. Inspect Checkout Ownership And Patch State

```bash
source tools/env.sh
source versions.env
git -C .cache/qemu rev-parse HEAD
git -C .cache/qemu status --short
git -C .cache/qemu diff --stat
git -C .cache/qemu apply --reverse --check "$ROOT/qemu/espemu.patch"
```

The HEAD must equal `QEMU_COMMIT`. A successful reverse check means the exact
tracked patch is applied. A failed reverse check can mean a clean upstream
checkout, a locally modified applied patch, or an incompatible tree; it is not
permission to reset or reapply blindly.

- Clean pinned source with no integration: `tools/build-qemu.sh` can apply the
  tracked patch. Check before building if source is unexpectedly incomplete.
- Dirty source with existing ESPEmu integration: preserve edits and identify
  their owner. The builder has a local-integration guard, not proof of complete
  support for every new model.
- Wrong pin or unknown dirty tree: do not save over the authoritative patch.
  Use a separate owned checkout/worktree when needed and authorized.
- No source cache: prepare a compatible native environment, or use the pinned
  container path. Do not synthesize a patch from a guessed upstream version.

Do not have two agents edit/build/save the same QEMU checkout concurrently.

## 2. Choose The Nearest Existing Model

The tracked patch contains these implementation patterns:

| Source in vendor tree | Pattern |
| --- | --- |
| `hw/sensor/tmp105.c` | Existing upstream sensor extended for conversion/fault support |
| `hw/sensor/bh1750.c` | Command-oriented light measurement, measurement-time setting |
| `hw/sensor/bme280.c` | Register map, coefficients, environment conversion and reset |
| `hw/sensor/mpu6050.c` | Signed multichannel bursts, ranges, sample rate, sleep/reset |
| `hw/sensor/espemu.c` | Circuit instance creation, raw input validation, QOM readouts |
| `hw/i2c/esp32_i2c.c` | Actual master controller/FIFO/commands/IRQs and bounded traces |
| `hw/gpio/esp32_gpio.c` | Actual digital drive/pull/input/output QOM state |
| `hw/misc/esp32_rmt.c` | RMT TX symbol decoding and WS2812 frame observation |
| `include/hw/sensor/espemu.h` | Hub/model integration helper declarations |
| `hw/sensor/meson.build` | Sensor compilation-unit registration |
| `hw/xtensa/esp32.c` | Board attachment and QOM alias integration |

Read the closest protocol owner and existing direct test. Do not redesign the
master controller for a new ordinary I2C sensor. Reuse a proven upstream model
when its supported behavior matches the datasheet; avoid duplicate QOM types.

## 3. Implement The I2CSlave Contract Precisely

Follow nearby QEMU APIs and code style; check actual callback signatures.

- `send` consumes a byte written by the I2C master to the slave. It is the
  firmware write path despite the callback name.
- `recv` returns a byte read by the master from the slave. Its byte return is
  not a NACK/error channel. Returning 0xff does not model disconnection.
- `event` controls START/read/write/STOP phases and appropriate connection/ACK
  behavior. Use the surrounding controller's actual I2C event semantics.
- Register pointer/command state is per instance. Repeated START and STOP
  behavior must match the selected datasheet subset.
- Device register/data byte order, writable masks, read-only behavior, pointer
  increment and wrap must be specified and directly tested.
- Burst reads need coherent sample latching. Do not mix bytes from measurements
  updated midway through a burst unless that behavior is documented.
- Initialize defaults in the appropriate QOM/device reset lifecycle. Register
  the type with the correct parent, instance size, class callbacks and Meson
  source list. Preserve supplied upstream/vendor license notices.

Keep custom state per device. Avoid global static mutable register/data arrays
that make one address affect another. Constant conversion tables may be shared.

## 4. Model Time, Configuration, And Faults

Use QEMU timers and `QEMU_CLOCK_VIRTUAL` for conversion/sample timing. Direct
QTest checks advance virtual time deterministically. Do not use host sleep,
`Date.now`, frontend animation frames, or immediate QOM input mutation as the
conversion clock.

Define and test:

1. What starts a conversion and when physical input is sampled/latching occurs.
2. Old/not-ready data before completion and the exact update boundary.
3. Continuous scheduling, one-shot completion, and shutdown/sleep behavior.
4. Configuration/range changes during or between conversions.
5. Reset cancellation of timers, pointers, mode/busy bits and converted data.
6. External physical-input/fault persistence separately from device reset state.
7. Disconnection produces actual address/transaction NACKs observed by firmware.
8. Invalid injection yields the supported malformed register response, without
   reserving a measurement value that can legitimately occur.
9. Reconnect/clear fault/reinitialize works without destroying other instances.

The SDK's real delays are separate from modeled virtual timing. A firmware test
may wait asynchronously for a boot/sample; that does not justify host-clock
timers inside the hardware model.

## 5. Update Every Circuit Hub Dispatch Point

The current hub uses numerical sensor types and several explicit arrays/switches
in `hw/sensor/espemu.c`. Adding one type requires inspecting all of these owners:

| Owner/symbol | Update required for a new sensor |
| --- | --- |
| `SensorInput` | Storage for new physical raw fields, with safe integer widths |
| `espemu_parse_sensor` | Exact expected keys, integer bounds and fault flags |
| `espemu_apply_instance` | Dispatch validated input to the correct model helper |
| `espemu_instance_input` | Serialize every input field with exact registry raw keys |
| `espemu_get_circuit` | Type name lookup and actual model status/channel readout |
| `espemu_set_circuit_inputs` | Preserve whole-snapshot validation before any mutation |
| `espemu_attach` | Type/model arrays, selected-count/sentinel, address rules and instance creation |
| Model helpers/header | Matching input/state declarations and definitions |
| `hw/sensor/meson.build` | Compile new source under the established config condition |

In particular, `espemu_get_circuit` currently has a final MPU6050-specific
fallback. A new type must not accidentally route there. The attach loop's
hardcoded count/sentinel and both type arrays must remain consistent.

Prefer the smallest coherent change. A shared descriptor table is justified only
if it removes actual dispatch/count duplication for the requested work; do not
invent a general plugin system for one sensor.

Strict input/config validation must occur before side effects. Parse the entire
new multi-device snapshot into temporary state; if any instance ID, field, type,
range, version, or connection flag is invalid, no instance may change. Reject
unknown fields/IDs and conflicts. Test that the previous state remains identical.

Configuration parsing must reject unsupported addresses and duplicate IDs/bus
addresses. Reuse the existing board attachment; only edit controller/board files
when new behavior genuinely belongs there.

## 6. Keep QOM Contracts Separate

Modern host surfaces:

| QOM path/property | Meaning |
| --- | --- |
| `/machine/soc` / `espemu-circuit` | JSON-string circuit snapshot: version, virtual time, instance ID/type/address, raw inputs, converted state |
| `/machine/soc` / `espemu-circuit-inputs` | Atomic per-instance raw physical-input snapshot |
| `/machine/soc/i2c0` / `espemu-trace` | Actual bounded I2C master trace events |
| `/machine/soc/gpio` / `espemu-state` | GPIO direction, levels, pulls, inputs and observed digital state |
| `/machine/soc/gpio` / `espemu-inputs` | Validated declared external GPIO drives |
| `/machine/soc/rmt` / `ws2812-state` | Observed RMT/WS2812 frames/pixels |

The old `/machine/soc` `espemu-inputs`/`espemu-state` properties serve a separate
fixed-three-sensor compatibility path. Do not extend only that old snapshot and
assume the modern project runtime receives a new sensor.

`state.channels` must use public registry channel keys and physical units, with
null when unavailable. Raw QOM physical input fields use `rawKey`/scale integer
units. Readouts should represent converted/register state, not a direct echo of
the injected environment while the device is sleeping or still converting.

Inspect payload limits before adding many channels: circuit launch config,
circuit input snapshot, state snapshot, trace buffers and host frame limits are
separate bounds. Do not remove them to fit an unnecessarily large payload.

## 7. Direct Tests Before Full Firmware

Extend [qemu-models.test.ts](../../../tests/qemu-models.test.ts) and its existing
QTest fixture. Prove exact bytes/reset defaults, timing before/after conversion,
config masks/ranges, sign/endianness, NACK/invalid/recovery, and two-instance
isolation where addresses permit it. Test invalid snapshots atomically.

```bash
source tools/env.sh
bash tools/build-qemu.sh
node --import tsx --test tests/qemu-models.test.ts
```

When selecting one case, put Node test flags before the filename:

```bash
node --import tsx --test --test-name-pattern='ACTUAL_CASE_NAME' tests/qemu-models.test.ts
```

QTest does not replace compiled driver coverage. Rebuild the affected firmware
fixture and run the corresponding runtime test next. Trace/readouts and SDK
observations must agree on independent datasheet vectors.

## 8. Save A Complete Portable Patch

Inspect [save-qemu-patch.sh](../../../tools/save-qemu-patch.sh) before invoking
it. It currently uses an explicit `git add -N` list for new integration files,
then generates the tracked diff. New source/header files must join that list or
they can be omitted from the delivered patch.

1. Confirm pinned HEAD, correct source owner, and complete previous integration.
2. Inventory `git status --short` and `git ls-files --others --exclude-standard`
   in the vendor checkout. Every required new model file must be included in the
   intended diff; no builds/downloads or unrelated vendor edits should be included.
3. Update the saver file list for each new source/header. Inspect
   [build-qemu.sh](../../../tools/build-qemu.sh)'s applied/local-source guard;
   extend its completeness check only when necessary for the new integration.
4. Check `git diff --check`, generate/save the complete patch, and inspect its
   `diff --git` path inventory. Never save from a clean/incomplete cache merely
   because the saver command exists.
5. Run reverse-apply validation against the edited source and forward-apply
   validation against a separate clean pinned source checkout/worktree.
6. Rebuild the edited model and rerun direct tests. The authoritative CI Docker
   path also applies the tracked patch to freshly cloned pinned source.
7. Keep the previous tracked patch intact if generating/validating a candidate
   fails. If improving the saver, stage/validate candidate output before replacing
   the file; do not weaken guards to recover a missing-source failure.

Example clean apply check using an unused agent-owned worktree path:

```bash
source tools/env.sh
source versions.env
CHECK_TREE="$ROOT/.cache/qemu-apply-check"
git -C .cache/qemu worktree add --detach "$CHECK_TREE" "$QEMU_COMMIT"
git -C "$CHECK_TREE" apply --check "$ROOT/qemu/espemu.patch"
git -C .cache/qemu worktree remove "$CHECK_TREE"
```

Check path ownership/cleanliness first. Forward `--check` does not apply/build
the patch; report it accurately. Do not remove a dirty check tree with force.

## Completion

Required evidence: datasheet-backed direct protocol behavior, compiled firmware
read/fault/reset behavior, matching runtime units/state, new file build inclusion,
complete saved patch, clean pinned forward apply, and required acceptance gates.
Unrelated existing models must retain their reset/IRQ/timing behavior. Use
[the completion gate](../espemu-completion-gate/SKILL.md) before delivery.
