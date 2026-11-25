# Sensor Dossier Template

Copy the structure into ignored task/checkpoint state for the selected part.
This template is a thinking and evidence aid, not a new user-facing API or a
requirement to add a permanent dossier file for every tiny change. Product
documentation should retain the verified support facts, sources and limitations.

## Identity And Scope

```text
Task / PR / revision:
Manufacturer / exact part / variant:
Stable registry type:
Intended bus / supported ESP32 route:
Valid 7-bit addresses / selection pins:
Intended packaged driver / version / license:
Supported subset:
Explicit exclusions:
Protected application paths:
```

## Source Ledger

| Source ID | Official URL | Document/version/date | Section/table/page | Fact and confidence |
| --- | --- | --- | --- | --- |
| DS-01 | Manufacturer source | Fill actual metadata | Fill exact anchor | Identification and interface |
| DS-02 | Manufacturer source | Fill actual metadata | Fill exact anchor | Measurement format and timing |
| ER-01 | Errata, if present | Fill actual metadata | Fill exact anchor | Applicable revision behavior |
| DR-01 | Licensed reference driver | Version + immutable commit | Function/file | Transaction/compensation cross-check |

Separate verified facts, design choices, and unresolved assumptions. A proposed
emulation simplification is not a manufacturer fact. Preserve links instead of
redistributing unlicensed PDFs or large copied tables.

## Register Or Command Map

Use only the rows required by the supported subset, including commands sent by
the packaged driver during initialization.

| Address/opcode | Name | Width/order | Reset/default | Read/write and mask | Pointer/transaction rule | Source |
| --- | --- | --- | --- | --- | --- | --- |
| Fill actual value | Identity/config/data | Bits and byte order | Documented value | RO/RW/W1C/reserved | Increment, wrap, STOP effects | DS-ID |

Check these edge conditions explicitly:

- Master write callback versus slave read callback direction.
- First byte is a command versus a register pointer; multibyte pointer order.
- Repeated START does or does not preserve pointer/data phase.
- STOP resets transaction state, not necessarily the persistent pointer.
- Reads beyond a register burst wrap, saturate, return a defined value, or NACK
  according to documented/supported behavior.
- Configuration writes mask reserved bits and preserve unrelated fields.
- Read-only registers are not accidentally writable through a generic array.
- Latched bursts cannot mix bytes from different conversions.

## Channel Contract

| Channel | Unit/range/step/default | Host raw key/scale | Device encoding/formula | State key | SDK field/unit | Tolerance/source |
| --- | --- | --- | --- | --- | --- | --- |
| Stable named field | Physical engineering units | Integer wire input | Actual register bits | Converted readout | Public C/C++ result | Resolution-derived |

For every channel, list test vectors in physical units, host integer units,
device bytes, and decoded SDK units. Include zero, nominal, endpoints, negative
where meaningful, and quantization/sign boundaries. Do not leave only a prose
formula without at least one independent numeric vector.

## Conversion State Machine

```text
Reset state:
Idle / powered down / sleep behavior:
Command/config that starts conversion:
Virtual time duration and formula:
Input sampling/latching boundary:
Busy / ready representation:
Before-ready register contents:
Conversion completion and continuous rescheduling:
Effect of config writes during conversion:
Effect of disconnection / invalid injection:
System/software reset cancellation and restored defaults:
Per-instance state and timer isolation:
```

Use QEMU virtual time for modeled timing. Do not turn a real sleep into the
hardware clock or update output instantly merely because a physical slider moved.

## Calibration And Integrity

```text
Calibration storage/read layout:
Coefficient signedness, packing and byte order:
Per-instance coefficient lifetime:
Reference compensation function/version:
Intermediate widths and fixed/floating precision:
Zero/division/overflow guard behavior:
CRC parameters and coverage, if applicable:
Independent valid/corrupted vectors:
Unsupported calibration/FIFO/interrupt behavior:
```

If calibration or CRC is not part of this device, mark it not applicable with
the source that supports that determination. Do not invent calibration memory
merely to make an unrelated driver initialize.

## File And Script Update Inventory

Use this table to decide edits, not to touch every file mechanically.

| Surface | Usual requirement | Evidence to inspect |
| --- | --- | --- |
| `shared/registry.ts` | Required for a new device type | Config/input schemas, addresses, capabilities, raw units, UI family |
| `shared/manifest.ts` | Usually generic; tests required | Dynamic registry union, bus/address/pin/global limits |
| `shared/runtime.ts` | Conditional | New state/input transport shape versus existing generic sensor records |
| `shared/application.ts` | Usually generic; tests if telemetry changes | Optional application packet parser and bounded channel records |
| `server/project-runtime.ts` | Usually generic; tests required | Per-instance raw/QOM mapping, atomic commands, scenarios, reset/epoch |
| `server/qemu.ts` | Conditional | New transport/QOM/launch behavior, not per-instance bindings |
| `shared/protocol.ts`, `server/backend.ts`, `server/telemetry.ts` | Legacy-only or GPIO-family changes | Do not extend fixed-demo enums for an ordinary modern I2C addition |
| QEMU `hw/sensor/<part>.c` | New model or reuse existing faithful model | I2CSlave transactions, registers, conversion timer, reset/fault helpers |
| QEMU `hw/sensor/espemu.c` | Required for a new sensor type | Configuration/type/address dispatch, input validation/mutation, state output |
| QEMU `hw/sensor/meson.build` | Required for new compilation unit | Source compilation |
| QEMU headers/type registration | Conditional on integration/API | Model helper declarations and QOM type |
| QEMU controller/board files | Only for new bus/controller behavior | Existing I2C attachment should be reused |
| `tools/save-qemu-patch.sh` | Required if adding new source paths | Explicit `git add -N` inclusion and complete portable diff |
| `tools/build-qemu.sh` | Inspect; change only if needed | Local-source completeness guard/config flags/new integration detection |
| `qemu/espemu.patch` | Required for model/integration changes | Complete diff against the pinned upstream commit |
| `components/espemu_devices/include/espemu_devices.h` | Required for new public SDK API | Structs/init/read functions, C++ linkage, units |
| `components/espemu_devices/espemu_devices.c` | Required unless driver split is justified | Real IDF I2C calls, response validation, conversion decoding |
| SDK `CMakeLists.txt` and `idf_component.yml` | Conditional | Additional source files and exact managed dependencies |
| Licensed vendor component/source | Conditional | Immutable source pin, source/header/license, correct CMake |
| `tools/project-artifacts.ts` | Required inspection and usage update | `usage`, header includes, `deviceSdkFiles` whitelist, copied dependencies |
| `tools/project-creator.ts` | Usually generic; tests required | Registry discovery/free address/channel/scenario questions |
| Creator/setup/project-command shell wrappers | Usually no per-I2C edits | Preserve create-only/add-only behavior and option routing |
| `templates/project.Makefile`, `templates/project.gitignore` | Conditional | Only if new commands/portable project tracking are needed |
| `tools/build-framework-fixtures.sh` | Required for a new fixture directory | Exact fixture list and `.cache` output |
| GPIO/WS2812 fixture builders | Conditional | Only if their hardware/API paths change |
| `tools/build-firmware.sh` | Usually no per-device edits | IDF build + merged flash; dependencies should be component-owned |
| `tools/gate.test.mjs` | Conditional | Fixed legacy demo changes; not the only new-sensor acceptance test |
| `tools/verify.sh`, `.github/workflows/ci.yml`, `Dockerfile` | Inspect; conditional updates | New required fixture/test/build input or dependency reaches acceptance image |
| `frontend/src/project-main.tsx` | Usually generic | Registry-driven controls/readouts; specialized UI family only if needed |
| `frontend/src/Gyroscope.tsx`, device CSS/renderer | Conditional | Only for a justified visual family, no per-project code |
| `tests/qemu-models.test.ts` | Required | Direct exact register/timing/fault vectors |
| `tests/project-runtime.test.ts` | Required | Actual firmware/device states and instance isolation |
| `tests/project-artifacts.test.ts` | Required | Correct generated includes, samples and packaged file completeness |
| `tests/project-creator.test.ts` | Required relevant case | Generic new-type selection and free address/channel handling |
| `tests/project-creator-integration.test.ts` | Required packaging evidence | Fresh generated C/C++ build through `device_pins.h` |
| `tests/manifest.test.ts`, `tests/project-manifest.test.ts` | Required relevant contract cases | Valid/invalid configurations and bounds |
| `e2e/project.spec.ts`, `e2e/demo.spec.ts` | Conditional/relevant browser evidence | Controls and actual firmware/model readout with stable layout |
| `soak/streaming.spec.ts` | Risk/CI dependent | Memory/transport stability for expanded shared data shapes |
| `docs/SUPPORT.md`, `docs/PROJECTS.md` | Required | Honest datasheet-backed capabilities, addresses, limits and extension contract |
| Demo manifest/firmware/README | Only if demo changes are authorized | Consistent opt-in demo, not additions to empty user projects |

## Acceptance Evidence Ledger

| Requirement | Source | Owning code | Test/vector | Revision/command | Outcome |
| --- | --- | --- | --- | --- | --- |
| Exact identity/reset | DS-ID | Model/SDK symbol | Expected byte sequence | Actual revision | Pending/pass/blocker |
| Nominal/boundary conversion | DS-ID | Conversion function | Independent numeric vectors | Actual revision | Pending/pass/blocker |
| Virtual timing/modes | DS-ID | Timer/state machine | Before/after virtual-clock checks | Actual revision | Pending/pass/blocker |
| Fault/reset/recovery | Supported contract | Model + SDK | NACK/invalid/reconnect | Actual revision | Pending/pass/blocker |
| Instance isolation | Framework contract | Hub/runtime | Two free supported addresses | Actual revision | Pending/pass/blocker |
| Generated packaging | Framework contract | Artifact generator | Fresh C/C++ project build/read | Actual revision | Pending/pass/blocker |
| Portable patch/required CI | Repository gates | Saved patch/build scripts | Fresh pinned apply + compilation | Actual revision | Pending/pass/blocker |

## Final Support Statement

```text
Implemented device and exact datasheet/reference revision:
Valid address(es) and maximum supported instances:
Supported command/register/mode subset:
Public physical units and configuration ranges:
Verified timing, reset, fault and recovery behavior:
Packaged SDK/dependency/license:
Actual firmware and browser evidence:
Explicit unsupported features and approximation limits:
Required gates not run and exact reason, if any:
```

The statement must be derivable from the evidence rows. Do not write "all modes",
"hardware accurate", "Docker verified", or "all tests pass" without that evidence.
