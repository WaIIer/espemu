---
name: "espemu-device-contracts"
description: "Use when registering a new ESPEmu sensor/peripheral or changing manifest validation, channel units/raw scales, multi-instance QOM/runtime mapping, scenarios, reset epochs, GPIO/RMT wiring, physical-input controls, device readouts, or a specialized frontend visualization. Preserves the modern registry-driven extension boundary."
---

# Device Contracts, Runtime, And Workbench

## Follow The Modern Path

```text
registry config/input/channel definitions
  -> normalized project manifest and qemuCircuit()
  -> QEMU per-instance physical inputs and converted device registers/state
  -> ProjectRuntime QOM polling and command acknowledgments
  -> useProjectSession and the project workbench

ordinary firmware UART (optional)
  -> parseApplicationLine()
  -> application observations/history, separate from device state
```

Primary owners:
[registry](../../../shared/registry.ts),
[manifest](../../../shared/manifest.ts),
[runtime schemas](../../../shared/runtime.ts),
[application parser](../../../shared/application.ts),
[project runtime](../../../server/project-runtime.ts),
[QEMU process](../../../server/qemu.ts),
[session hook](../../../frontend/src/useProjectSession.ts),
[project UI](../../../frontend/src/project-main.tsx).

Do not implement a new modern I2C sensor by editing only legacy
`DeviceIdSchema`, `InputsSchema`, `TOPOLOGY`, telemetry parsers, or the old demo
UI/backend. GPIO peripheral schemas still live partly in `shared/protocol.ts`;
distinguish that shared GPIO contract from the legacy fixed-sensor enums.

## 1. Add One Coherent Registry Entry

Inspect `PERIPHERAL_REGISTRY` and the closest existing sensor. Its channel helper
signature is:

```ts
channel(label, unit, minimum, maximum, step, initial, rawKey, scale = 1)
```

For an I2C entry, supply:

- Stable lowercase type key and matching `z.literal(...)` in strict config.
- Human label, `kind: 'i2c'`, appropriate UI metadata and actual QOM model type.
- Documented supported integer 7-bit addresses, without adding arbitrary free
  addresses just to permit many instances.
- Honest capabilities matching implemented/tested model behavior.
- Every public channel's label/unit/bounds/step/default/raw key/scale.
- Strict input schema containing corresponding finite/bounded physical fields
  and established `connected`/`invalid` flags/defaults.
- Strict device config using existing ID/label validation, bus ID and the exact
  supported address range or discrete values.

`DeviceType`/`CircuitDevice` derive from the registry; do not manually duplicate a
new union in every module. `controls`, `isSensor`, `normalizeInputs`, and
`rawInstance` should work generically for an ordinary added I2C type.

Never confuse channel `minimum`/`maximum` with invented `min`/`max` properties.
Model raw keys/scales and input limits must match these definitions exactly.
Defaults in channel metadata and input schema must agree. Avoid type assertions
that conceal a mismatched config/input shape.

## 2. Preserve Manifest Invariants

`ProjectManifestSchema` dynamically selects a registry config, so adding a
supported I2C type usually needs tests rather than editing the validator.

| Invariant | Current contract |
| --- | --- |
| Version/target | `v: 1`, classic `esp32` |
| Bus | At most one named I2C0 bus, SDA21/SCL22, 10-400 kHz metadata |
| Devices | At most 32, unique instance IDs |
| I2C address | Valid per type; no collision on the same bus, including across different types |
| Pins | GPIO6-11 excluded; GPIO34-39 input-only; GPIO21/22 reserved when I2C is declared |
| Wiring | No duplicate non-probe pin wiring; probes may observe an assigned pin |
| GPIO drives | Only declared button/switch pins; 0/1/null; no duplicate drives |
| WS2812 | At most 8 instances, 1-1024 pixels each, at most 2048 pixels total |
| Scenarios | At most 64; valid device/channel; no duplicate channel target |
| Playback | Strictly increasing timestamps, bounded frames/finite values |
| Total manifest | Normalized serialized size at most 256 KiB |

Do not relax global limits or expose unsupported matrix/bus routing for a new
device. Manufacturer address limits apply even if the overall circuit has free
slots. A missing/empty manifest means zero devices, not an implicit demo.

`normalizeInputs` rejects unknown instance IDs, validates each sensor's fields,
and supplies missing defaults. Preserve reserved/prototype ID protection. Test
strictness, invalid/out-of-range inputs, omitted defaults, unknown keys, address
conflicts and multiple instances with distinct labels/IDs.

## 3. Keep Host And Model Units Round-Trippable

`rawInstance(type, physical)` multiplies by `scale` and rounds to integers.
`qemuCircuit()` emits sensor ID/type/address plus those raw inputs. QEMU must
validate and serialize exactly the same raw keys/ranges. Runtime decoding divides
by the scale and normalizes again.

Use independent vectors for fractional, negative and endpoint values. A normal
host raw integer round trip does not prove the model's register conversion.
`state.channels` holds converted values in public channel keys/units, not raw
input names. Unavailable values are null, not a previous value presented as valid
or a zero that pretends the sensor measured nothing.

## 4. Reuse ProjectRuntime Instead Of Per-Device Glue

Inspect these controlling methods in `ProjectRuntime`:

| Method | Contract |
| --- | --- |
| `launch` | Creates bridge, establishes circuit/baseline, applies initial physical/GPIO inputs |
| `readCircuit` | Reads `/machine/soc` `espemu-circuit`, validates exact count/ID/type/address, decodes inputs and stores model state |
| `setInputs` | Validates physical snapshot, converts via `qemuCircuit`, writes atomic `espemu-circuit-inputs`, then confirms state |
| `poll` | Reads real status/circuit/GPIO/RMT/trace, bounds history/events, applies running scenarios |
| `command` | Validates actions/epochs, serializes controls, rejects unknown devices/channels, returns ack |
| `epoch` | Clears observations/sequences/state on reset/relaunch boundaries |
| `replace` | Restarts QEMU for changed sensor/RMT topology or buses; updates GPIO-only topology without a restart where supported |
| `exportFile` | Exports current confirmed inputs/scenarios/declared wiring |
| `close` | Stops owned timer/bridge safely and waits for queued controls |

An ordinary new I2C type should not require a new `if (type === ...)` in these
methods. Add generic runtime changes only for a genuinely new contract shape.
Do not copy QOM input/state conversion into frontend code or a new backend.

Keep command queue limits, payload limits, one-poll-at-a-time behavior, and
bounded history/events/console intact. Extended channel sets must remain within
transport bounds rather than grow memory indefinitely.

## 5. Commands, Scenarios, And Reset Safety

- Use `input` for a single physical channel/flag and `input-fields` for coherent
  multichannel motion/pose updates. The latter accepts 1-32 fields currently.
- Validate all fields before applying an update. Unknown fields, nonfinite values,
  or a stale reset epoch must reject without changing any device.
- Manual changes remove scenarios for the changed channel(s), not unrelated
  instances/channels. Bulk inputs/scenario changes must preserve that behavior.
- Scenario values use virtual time and clamp to registry bounds. Pausing freezes
  modeled progress; frontend wall-clock animation is not the sensor clock.
- Reset changes the epoch and clears stale samples/sequences. In-flight commands
  from the old epoch must not mutate the restarted device.
- Physical inputs, device configuration/register state and application history
  have different reset lifetimes. Preserve/test the existing contract deliberately.
- Connection flags must yield real bus errors through the model/SDK, not just
  display a red label while returning a fabricated valid firmware sample.

## 6. Generic Versus Specialized UI

The modern workbench already renders registry-driven physical numeric inputs,
connection/invalid checkboxes, scenario targets and converted device readouts.
An ordinary sensor usually requires no new component. Verify generic labels,
units, bounds, confirmation state and null/error representation.

Current specialized gyro rendering is explicitly selected for `mpu6050` in
`project-main.tsx` and uses [Gyroscope.tsx](../../../frontend/src/Gyroscope.tsx).
The registry's `ui` field alone does not dispatch a new specialized renderer.
Add a visual family only when it genuinely improves that device's workflow, and
implement the actual dispatch once in framework code rather than in every app.

Preserve existing design and behavior:

- Active-run topology is fixed: do not restore add/remove/import editors without
  a separate request. Export/programmatic manifest/import contracts remain useful.
- Numeric inputs must permit editing a draft without polling replacing typed
  text. Confirm/reject updates through the session ack and error state.
- Tools use existing lucide icons with accessible labels/tooltips; booleans use
  checkboxes/toggles; numeric values use suitable inputs/sliders/steppers.
- Match current typography, palette, tabs, density and responsive structure.
  Do not turn a workbench panel into a marketing hero or unrelated theme redesign.
- Device identity, instance label, address/wiring, polarity and strip length must
  stay readable. Long labels and many channels must not overlap or resize boards.
- For orientation/motion, show real QEMU/firmware-confirmed state where claimed;
  distinguish commanded physical pose from converted observations.
- Three.js scene work needs actual desktop/mobile screenshots, nonblank canvas
  pixel checks, framing, interaction/motion and asset verification. Do not accept
  a mounted empty canvas or a passing frontend build as visual evidence.
- Honor offline/starting/paused/error/stopped states and disabled controls. Do
  not let stale UI commands cross the reset epoch.

## 7. Focused Checks

```bash
source tools/env.sh
node --import tsx --test tests/manifest.test.ts tests/project-manifest.test.ts \
  tests/application.test.ts tests/runtime-bounds.test.ts
npm run typecheck
```

For compiled runtime behavior, first rebuild the affected model/fixtures, then:

```bash
node --import tsx --test tests/project-runtime.test.ts
PORT=4120 npm run test:e2e -- --config playwright.project.config.ts
```

Use an unused port; preserve unrelated listeners. Extend nearby tests for
multiple instances, defaults/invalid inputs, atomic rejection, manual/scenario
coexistence, pause/reset/stale epoch, no implicit sensors, transport bounds and
reconnect/fault recovery. For new visualization behavior, inspect actual browser
screenshots at desktop and 375/320-pixel mobile widths.

## Completion

Registry/config/model/raw/SDK/public-state channel names and units agree;
instance IDs/address conflicts and strict bounds are tested; generic UI and
scenarios work without per-project glue; reset/fault/epoch behavior is preserved;
and actual firmware demonstrates the device instead of echoed host values.
Finish with [the completion gate](../espemu-completion-gate/SKILL.md).
