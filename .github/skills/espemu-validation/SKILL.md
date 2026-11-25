---
name: "espemu-validation"
description: "Use when choosing or running focused ESPEmu tests, verifying a new sensor/SDK/QEMU patch end to end, repairing native or Docker CI, checking browser/mobile/Three.js behavior, preventing stale firmware/cache evidence, testing bounded runtime/transport behavior, or running required long-duration streaming and final acceptance gates."
---

# Risk-Scoped Verification And CI Acceptance

## Rules Before Running Anything

Establish the touched owner and cheapest check that could show the change is
wrong. Run it immediately after the first substantive edit, then broaden only
for actual risks and required gates. Use
[environment recovery](../espemu-environment/SKILL.md) if a prerequisite is
missing or the environment blocks verification.

Do not install/build/run every environment for a docs-only change. Conversely,
do not deliver a new hardware model with only a typecheck or mocked test. Record
the revision/build inputs for every important result, including skipped/unavailable
checks. A previous successful binary/test is not evidence for changed source.

## Correct Commands And Common Mistakes

```bash
source tools/env.sh
node --import tsx --test tests/FILE.test.ts
node --import tsx --test --test-name-pattern='ACTUAL_TEST_NAME' tests/FILE.test.ts
npm run typecheck
npm run build
npm run test:ci
npm run test:skills
npm run test:gate
npm test
```

`FILE` and `ACTUAL_TEST_NAME` are placeholders. Read the current test to choose
them. Bare `node --test tests/*.test.ts` is not the established TypeScript runner.
`npm run gate` and `npm run e2e` do not exist; use `test:gate` and `test:e2e`.
`npm test -- file.ts` appends to the existing wildcard command and is not reliable
file scoping. Do not run `tsc single-file.ts` and assume it used project config;
use `npm run typecheck` for the configured project.

## Test Surface Map

| Changed area | Focused existing files | Important risks |
| --- | --- | --- |
| CI/Docker configuration | [ci.test.mjs](../../../tools/ci.test.mjs) | Exporter shell, preinstalled tool paths, browser dependency/startup checks, duplicate triggers, full acceptance and capability restrictions |
| Agent skills/setup | [agent-skills.test.mjs](../../../tools/agent-skills.test.mjs) | Metadata, links, tracking, shell syntax, workflow/CLI safety |
| Manifest/registry | [manifest.test.ts](../../../tests/manifest.test.ts), [project-manifest.test.ts](../../../tests/project-manifest.test.ts) | Defaults, strict fields, addresses/pins/IDs, limits/raw scales |
| Optional telemetry | [application.test.ts](../../../tests/application.test.ts), [protocol.test.ts](../../../tests/protocol.test.ts) | Finite/null channels, compatibility, sequence/payload bounds |
| Creator/artifacts | [project-creator.test.ts](../../../tests/project-creator.test.ts), [project-artifacts.test.ts](../../../tests/project-artifacts.test.ts) | New device questions/examples, preservation, macros, source/header/license copying |
| Setup/Make | [project-setup.test.ts](../../../tests/project-setup.test.ts), [project-makefile.test.ts](../../../tests/project-makefile.test.ts) | Create-only defaults, recognized migration, quoting/symlinks, no hidden builds |
| Runtime/control | [project-runtime.test.ts](../../../tests/project-runtime.test.ts), [backend-control.test.ts](../../../tests/backend-control.test.ts) | Per-instance state, actual firmware, reset/epoch, atomic commands/faults |
| HTTP/WS/backpressure | [backend-http.test.ts](../../../tests/backend-http.test.ts), [backend-transport.test.ts](../../../tests/backend-transport.test.ts), [runtime-bounds.test.ts](../../../tests/runtime-bounds.test.ts) | Reconnect, malformed commands, frame/memory bounds, slow clients |
| Scenarios | [backend-scenarios.test.ts](../../../tests/backend-scenarios.test.ts) plus runtime cases | Virtual time, seeded behavior, clamping/manual cancellation |
| Direct emulator | [qemu-models.test.ts](../../../tests/qemu-models.test.ts) | Exact registers, virtual timing, ranges, IRQ/reset/NACK, instances |
| GPIO | [gpio-protocol.test.ts](../../../tests/gpio-protocol.test.ts), [gpio-integration.test.ts](../../../tests/gpio-integration.test.ts) | Real register levels/direction/pulls/interrupts and both banks |
| WS2812 | [ws2812-integration.test.ts](../../../tests/ws2812-integration.test.ts) plus direct model cases | RMT symbols, GRB order, completion, multiple strips/pixel limits |
| Generated firmware | [project-creator-integration.test.ts](../../../tests/project-creator-integration.test.ts) | Fresh C/C++ builds with automatic SDK headers/dependencies/linking |
| Baseline legacy demo | [gate.test.mjs](../../../tools/gate.test.mjs), [integration.test.ts](../../../tests/integration.test.ts) | Real compiled demo reads/faults/reset and compatibility |
| Browser project/demo | [project.spec.ts](../../../e2e/project.spec.ts), [demo.spec.ts](../../../e2e/demo.spec.ts) | Actual controls/state, fixed topology, mobile/layout/canvas behavior |
| Long-running stream | [streaming.spec.ts](../../../soak/streaming.spec.ts) | Bounded history/memory, no drops/page errors, resource/latency behavior |

Inspect each selected test's imports/preconditions before running. Some named
"unit" files launch real QEMU or build firmware; filenames alone do not determine
cost. Reuse existing helpers and extend test cases instead of creating a file
per sensor, a fake production transport, or an unrelated framework.

## 1. Lightweight Contract And Tooling Checks

Example for registry/SDK-generation changes without model execution yet:

```bash
source tools/env.sh
node --import tsx --test tests/manifest.test.ts tests/project-manifest.test.ts \
  tests/project-creator.test.ts tests/project-artifacts.test.ts
npm run typecheck
```

For shell helpers, immediately run `bash -n` on the edited scripts and their
focused tests. Auto-corrected patches can still leave a control-flow block open.
For customizations, `npm run test:skills` validates the deliberately flat,
JSON-compatible YAML metadata form and JSON-compatible YAML setup workflow.
It is not a general YAML parser or a network check of external documentation.

## 2. Build Fresh Model And Firmware Inputs

```bash
source tools/env.sh
bash tools/build-qemu.sh
bash tools/build-firmware.sh
bash tools/build-gpio-fixture.sh
bash tools/build-framework-fixtures.sh
bash tools/build-ws2812-fixture.sh
```

Run only affected builds for focused work, then the required broader set for
acceptance. Framework builders write to ignored `.cache` or framework firmware
build output. Do not invoke build scripts on the user's app without authority.

Current fixture mapping:

| Fixture source | Merged image |
| --- | --- |
| `tests/fixtures/empty-firmware` | `.cache/empty-firmware/qemu_flash.bin` |
| `tests/fixtures/multi-sensor` | `.cache/multi-sensor/qemu_flash.bin` |
| `tests/fixtures/gyro-firmware` | `.cache/gyro-firmware/qemu_flash.bin` |
| `tests/fixtures/device-sdk` | `.cache/device-sdk/qemu_flash.bin` |
| `tests/fixtures/gpio-firmware` | `.cache/gpio-firmware/qemu_flash.bin` |
| `tests/fixtures/ws2812` | `.cache/ws2812/qemu_flash.bin` |
| Bundled `firmware` | `firmware/build/qemu_flash.bin` |

Check the actual builder/source path before relying on this mapping; add new
fixtures to the existing builder when required. Models use the tracked patch
against `QEMU_COMMIT`; IDF flash merge uses the build's own `flash_args` and fills
4 MB. Do not mix artifacts from different manifests, worktrees or source revisions.

`tools/verify.sh` builds missing baseline artifacts and checks recorded
fingerprints. It rejects known stale artifacts instead of rebuilding them.
Unrecorded artifacts do not prove freshness and are allowed only when
`ESPEMU_REQUIRE_PROVENANCE` is not `1`. Rebuild changed models, firmware, or
fixtures before using them as evidence for the current source.

## 3. Prove Sensor Behavior At Two Levels

```bash
node --import tsx --test tests/qemu-models.test.ts
node --import tsx --test tests/project-runtime.test.ts
node --import tsx --test tests/project-creator-integration.test.ts
```

Direct tests prove independent datasheet bytes, masks, sign/endianness, timing,
faults/reset/recovery and instance isolation. Actual compiled firmware proves
SDK initialization/reads and automatic generated packaging/linkage. Both are
needed: SDK and model can share the same wrong formula and pass a coupled test.

Optional UART packets are observation evidence only. Prove real I2C trace/model
register traffic; no firmware shim may fabricate physical inputs. GPIO/WS2812
visualization must come from actual hardware registers/transmissions.

For many sensors, use a per-device evidence table. A single "all catalog entries
parse" check or one demo sample cannot prove twenty independent protocols.

## 4. Browser And Responsive Verification

```bash
source tools/env.sh
npm run build
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.cache/playwright"
PORT=4100 npm run test:e2e
PORT=4120 npm run test:e2e -- --config playwright.project.config.ts
```

Use unused ports and inspect
[demo config](../../../playwright.config.ts) and
[project config](../../../playwright.project.config.ts). Keep tests sequential
when fixed ports/artifacts overlap. Tests own their servers; do not kill an
unrelated listener or leave an extra simulation running after testing.

For a new control/readout/scene check:

1. No page/console/network errors and a successful online/ready handshake.
2. Device label/address/wiring/units and unavailable/fault state are readable.
3. Editing a physical input sends an acknowledged command and reaches the actual
   firmware/model within the relevant conversion timing.
4. Scenarios/manual overrides, pause/reset/stale epoch and reconnect behave
   correctly; failed commands do not leave a false confirmed UI value.
5. Desktop and 375/320-pixel widths have no incoherent overlap, horizontal escape,
   clipped long words/buttons, shifting board sizes, or hidden controls.
6. Actual screenshots show the expected visual state, not merely DOM assertions.
7. Three.js/canvas changes require nonblank pixel checks, proper framing,
   motion/interaction and loaded assets. Verify different input states render
   differently. A blank but mounted canvas is a failure.

Trace/screenshots are under the configured `test-results` outputs. Keep them
out of commits. Link the UI screenshots from the PR as
[the pre-PR skill](../espemu-pre-pr/SKILL.md#ui-screenshots-on-the-pr) describes.

## 5. Full Native And Container Acceptance

```bash
source tools/env.sh
TEST_PORT=4100 PROJECT_TEST_PORT=4120 bash tools/verify.sh
SOAK=1 TEST_PORT=4100 PROJECT_TEST_PORT=4120 bash tools/verify.sh
```

The current verification order is baseline artifact preparation if missing,
dependency installation if missing, all three fixture builders, frontend
build/typecheck, real firmware gate, all Node tests, browser download if missing,
demo/project browser checks, and optional soak when `SOAK=1`.

Current CI runs a pinned verification image and ten-minute soak:

```bash
docker build --target verification -t espemu-verification .
docker run --rm --init --cap-drop=ALL --security-opt=no-new-privileges \
  -e CI=true -e SOAK=1 espemu-verification
```

Use a working Docker daemon. A client, successful image build, parsed Dockerfile,
or old successful run is not current container acceptance. Source input additions
must be copied into the correct Docker stage. The separate `agent-customizations`
CI job validates repository skills; the verification image does not need to copy
all agent documentation into the runtime product.

Run `npm run test:ci` before publishing workflow or Docker changes. This is a
configuration regression check, not container execution. Automatic main/PR CI
runs only `npm run typecheck` and the explicit non-native `npm run test:fast`
suite under a three-minute job limit. Native builds, browsers and long-duration
checks remain opt-in: dispatch `full_verification` only when explicitly requested.
Its default is false. Do not add expensive checks to the automatic fast suite or
trigger repeated hosted runs to diagnose issues that can be reproduced locally.
The verification image maps its preinstalled Node/IDF tools into `.cache` so
project commands do not bootstrap host-specific packages in the restricted container.

The full hosted job has a 60-minute budget for the measured cold image/firmware
work plus complete ten-minute streaming verification. Keep that test at 600
seconds. For RMT circuits, retain fixed `shift=3` instruction timing with
`sleep=off` idle fast-forwarding; adaptive instruction timing failed exact
WS2812 output checks. Virtual time may advance faster than wall time. Verify
both real waveform bytes and the existing wall-clock throughput/resource gates.

For new models/SDK/shared transport/UI workflows, the repository's required CI
must pass on the delivered head. For docs/customization-only work, run the focused
metadata/link/script checks and disclose cloud/container checks not executed
locally rather than doing unnecessary model/firmware builds for reassurance.

## 6. Endurance And Bounded Resource Evidence

Run [the soak config](../../../playwright.soak.config.ts) when required by CI or
the affected risk. The normal full gate uses `SOAK=1`; read the current spec for
duration/configuration. A shortened smoke run is useful debugging evidence but
must not be described as the required ten-minute acceptance.

Check bounded sample history, device/channel payload limits, event/console
buffers, dropped frames, WebSocket backpressure, backend/QEMU/browser memory,
page errors and relevant latency. Navigate Inputs before scenario/device checks
and Application before chart checks; these panels are mounted on demand. Capture
page errors before navigation. Do not add new unbounded arrays or remove
snapshot/frame bounds to fit a large sensor catalog. Report actual metrics and
duration, not values copied from an earlier support report.

## 7. Diagnose And Disposition Failures

- Unit expectation mismatch: repair the same owner and rerun that check.
- Model/SDK mismatch: capture actual bus bytes; use an independent datasheet
  vector to decide which side is wrong.
- Time-sensitive failure: inspect virtual versus wall time, conversion/boot state,
  and process readiness before increasing a timeout.
- Port/socket conflict: use a unique test resource; remove only agent-owned stale
  sockets/processes after proving they are no longer active.
- Generator/source-preservation failure: fix preflight/atomic/ledger logic, not
  the preservation test or the user's files.
- Memory/payload failure: reduce retained/projected state within the contract,
  not transport safeguards or soak assertions.
- Environmental failure: follow the environment skill; no arbitrary pin changes.
- Existing unrelated failure: verify baseline, document it, and respect required
  remote gates. Do not claim the whole suite passed.

After a repair rerun the failing focused check first. After success run only
meaningful remaining risk/gate checks. Continue until verified/delivered or a
real blocker remains; leave exact resumable commands for unavailable gates.
