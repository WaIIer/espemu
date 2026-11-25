# ESPEmu PR Readiness Checklist

Use in task state or the authorized PR description; do not add a permanent
tracked checklist for every PR. Each selected requirement needs current evidence
or a precise blocker. Not-applicable rows need a reason, not a fabricated pass.

## Scope

- [ ] Request/issue, repository, target branch, base SHA and candidate source identified.
- [ ] Commit/push/PR-update/merge authorization recorded separately.
- [ ] Committed, staged, unstaged and untracked deltas inspected.
- [ ] Unrelated workspace changes and user application paths preserved.
- [ ] New framework files permitted by Git allowlist; generated/cached/personal files excluded.
- [ ] No unrelated refactor, formatting churn, hidden demo insertion or default change.

## Source And Security

- [ ] Diff/staged whitespace checks pass.
- [ ] Explicit staged paths reviewed; no blanket `git add .` or force-added caches.
- [ ] Credentials/private document content/machine paths absent from intended delivery.
- [ ] New scripts/dependencies/workflow changes inspected before execution.
- [ ] Dependency/vendor version and license/provenance retained.
- [ ] No weakened tests, skipped assertions, permission escalation or protection bypass.

## Datasheet And Model

- [ ] Exact part/revision/interface and supported subset established.
- [ ] Manufacturer/register-map/errata references cover controlling facts.
- [ ] Valid 7-bit addresses and instance/address conflict rules match registry/model.
- [ ] Independent ID/reset/default/config/byte-order/signed-boundary vectors pass.
- [ ] Conversion timing uses virtual time and before/after-ready behavior is tested.
- [ ] Supported continuous/one-shot/sleep/config/reset behavior tested where applicable.
- [ ] Calibration/CRC and invalid boundaries validated independently where applicable.
- [ ] Disconnection/NACK, invalid response, recovery and instance isolation tested.
- [ ] Hub type arrays/count/sentinel/input parse/apply/readout dispatch complete.
- [ ] Atomic multi-device snapshot rejection leaves prior state unchanged.
- [ ] Actual firmware transactions reach the model, not fabricated UART/browser values.

## SDK And Generated Projects

- [ ] Short public C/C++ init/read API uses clear physical units and named IDF errors.
- [ ] Null/invalid-argument/bus/response errors do not publish partial valid readings.
- [ ] Headers/source/vendor/license/managed dependencies copied automatically.
- [ ] Additional split driver files included by both SDK CMake and artifact copier.
- [ ] Generated `device_pins.h` macros are correct and normalization collisions rejected.
- [ ] New usage examples match actual types/fields, not an MPU6050 fallback.
- [ ] Fresh generated project compiles through automatic SDK linkage.
- [ ] Actual compiled init/read/fault/recovery evidence obtained.
- [ ] Edited generated files, app source and custom CMake/Make preserved.
- [ ] File/ancestor/ledger symlink and stale-manifest safety tests pass.
- [ ] Create-only empty defaults, explicit run/demo and one-component no-build behavior preserved.

## Runtime And UI

- [ ] Physical inputs/raw integer encodings/converted state/application observations remain separate.
- [ ] Channel names/units/scales/bounds/defaults round-trip and reject unknown/nonfinite inputs.
- [ ] Command ack/errors, pause/reset/stale epochs and scenario/manual behavior tested.
- [ ] Payload/history/events/console/queue/transport bounds retained.
- [ ] Reconnect/backpressure and source-owned process cleanup tested where touched.
- [ ] Browser controls reach actual model/firmware state and failure states remain truthful.
- [ ] Desktop and mobile screenshots show readable nonoverlapping labels/controls.
- [ ] The PR links UI screenshots for its head commit, or its body says why they are missing.
- [ ] Three.js/canvas scenes are nonblank, framed, interactive/moving, with loaded assets.
- [ ] Active-run topology remains fixed unless changing it was explicitly requested.

## Portable Build And Required Gates

- [ ] QEMU/IDF/tool/dependency pins remain intentional and verified.
- [ ] Fresh model and affected firmware artifacts built from the candidate source.
- [ ] New QEMU source/header paths added to Meson and saver inclusion list.
- [ ] Complete saved patch includes previous required integrations and new files.
- [ ] Patch reverse-checks edited source and forward-checks clean pinned source.
- [ ] Changed files/components reach Docker/CI build inputs where required.
- [ ] Focused affected tests and typecheck/build passed.
- [ ] Required full native/container/browser/soak gates passed or exact external blockers recorded.
- [ ] Remote required checks/reviews are current for delivered head before ready/merge claims.
- [ ] Docs list actual capabilities/addresses/limits/provenance and verified commands.

## Evidence Table

| Gate | Exact command/test/vector | Source revision/tree | Outcome | Artifact or blocker |
| --- | --- | --- | --- | --- |
| Focused behavior | Fill actual command | Fill actual revision | Pass/fail/not run | Evidence/reason |
| Type/build | Fill actual command | Fill actual revision | Pass/fail/not run | Evidence/reason |
| Model/firmware | Fill actual command | Fill actual revision | Pass/fail/not run | Evidence/reason |
| Browser/mobile | Fill actual command | Fill actual revision | Pass/fail/not run | Evidence/reason |
| Patch/portable build | Fill actual command | Fill actual revision | Pass/fail/not run | Evidence/reason |
| Full CI/soak | Fill actual command/run | Fill actual revision | Pass/fail/not run | Evidence/reason |
| Read-only review | Reviewer + scope | Fill actual revision | Findings/no findings | Dispositions |

## Delivery

- [ ] Independent review findings addressed or disputed with evidence.
- [ ] Tested content reconciled with final staged/committed tree.
- [ ] Authorized branch/PR operation completed; no force push/admin override/deletion inferred.
- [ ] PR body distinguishes local tests, remote checks, limitations and unverified gates.
- [ ] Final PR/head/state verified rather than assumed from a push exit code.
- [ ] Only agent-owned disposable processes/worktrees cleaned; blockers remain resumable.
- [ ] Task complete only when requested delivery and required evidence are genuinely satisfied.
