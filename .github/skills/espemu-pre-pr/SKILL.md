---
name: "espemu-pre-pr"
description: "Use when preparing to publish an authorized ESPEmu branch or create, update, or mark a PR ready. Audit scope, safety, and staged files; select tests by changed surface and verify relevant hardware, browser, provenance, and documentation evidence."
---

# Pre-PR Readiness Gate

## Purpose

Prepare a reviewable change with current, reproducible evidence. Use this gate
before an authorized commit, direct push, or PR delivery, and again after
meaningful code changes or review repairs. It does not grant those operations
or require a PR for an authorized direct push.

Start with the test matrix below. Use [validation](../espemu-validation/SKILL.md)
if you need commands or evidence requirements beyond it. For meaningful risk,
use [read-only review](../espemu-pr-review/SKILL.md) as described in section 5.
Use [the readiness checklist](./references/readiness-checklist.md) for substantial
work, not as a second checklist for a small change.

## 1. Define The Actual Delta

Record target repository/base branch, request/issue, intended delivered branch,
base SHA, candidate HEAD, and protected/unrelated paths. Confirm authority for
commit, non-force push, PR creation/update and merge separately.

Inspect committed, staged, unstaged and untracked content:

```bash
git status --short --branch --untracked-files=all
git diff --name-status "$BASE_SHA...HEAD"
git diff --name-status
git diff --cached --name-status
git ls-files --others --exclude-standard
git diff --check
git diff --cached --check
```

A merge-base PR diff does not include uncommitted new files. A clean diff stat
does not prove a new fixture is trackable. Verify every intended new file against
the root source allowlist and inspect every staged path. Do not stage all files,
force-add personal apps/caches, or hide unrelated edits in the PR.

## 2. Apply Nonnegotiable Safety Checks

- No unrelated app/source edits, generated binaries, downloaded private documents,
  credentials, machine-specific developer paths, or unexpected metadata churn.
- No destructive workspace cleanup, lost dirty vendor source, or forced merge
  conflict resolution that discards behavior.
- No secrets in source/examples/manifests/logs/PR text. Use a repository-approved
  scanner if available; inspect suspect content without printing credential values.
  A regex scan alone is not a guarantee of no secrets.
- No new install commands, shell scripts, dependencies, or workflow permissions
  accepted solely because a cloud PR suggested them.
- Dependencies and vendor source are deliberately pinned, licensed and actually
  packaged. A new callback/header download instruction in README is not packaging.
- No test removals/skips, broad type suppression, disabled assertions, unexplained
  timeout growth, reduced soak duration, or relaxed payload limits to hide failure.
- User projects remain read-only; creator defaults remain empty/create-only;
  add-component remains single-device/source-preserving/no-build/no-run.

## 3. Select Required Pre-PR Tests By Surface

Use this matrix as the minimum affected-surface selection. Inspect the current
repository/CI gates and request for any additional required acceptance.

| Delta | Before readiness, prove |
| --- | --- |
| Skills/instructions/agents/setup | `npm run test:skills`; resource links/tracking; helper CLI and offline behavior; touched shell syntax; workflow schema/permissions |
| Registry/manifest | Valid/default/invalid inputs, IDs, addresses/collisions, pins/routes, units/raw scale round trip, limits and typecheck |
| QEMU sensor/model/hub | Exact datasheet registers/commands, reset/ID, signed/boundary vectors, virtual timing/modes, faults/recovery, instances, atomic snapshot rejection, fresh model build and portable patch |
| SDK/public headers/dependency | Actual IDF compile, C/C++ inclusion/linkage, short init/read API, independent numeric output vectors, bus/invalid errors, no partial output, packaged files/license/pins |
| Project artifacts/creator/Make | Correct new examples/macros/dependency copies, fresh generated project build, preservation/symlinks/stale atomic update, compact free-resource prompts, create-only/add-only and quoting/migration |
| Runtime/HTTP/WebSocket/scenarios | Actual/model state path, strict input/ack errors, stale epoch/reset/pause, scenario/manual cancellation, reconnect/backpressure, bounded payload/history/queue |
| Frontend/visualization | Build/typecheck, browser functional assertions, actual model/firmware updates, disabled/error/null states, desktop/mobile screenshots posted on the PR (section 6) and nonblank/moving canvas when relevant |
| GPIO/RMT | Actual hardware registers/waveforms, polarity/pulls/direction/IRQ/reset, pixel order/completion/multi-instance limits; not UART inference |
| Build/CI/Docker | Changed input reaches build image, pins/permissions correct, fresh authoritative patch applies/compiles, required native/container execution succeeds |
| Shared data/memory/streaming | Bounds/backpressure tests and required ten-minute soak on relevant final source |
| Product documentation only | Accurate paths/flags/links and no unsupported version/fidelity/test claims; no unrelated native rebuild merely for reassurance |

Do not substitute one category for another. A typecheck is not a firmware test;
a successful image build is not container execution; generic schema parsing is
not twenty sensor implementations; a mounted canvas is not a rendered scene.

## 4. Sensor-Specific Readiness Questions

For each new device, reconcile its datasheet dossier with these facts:

1. Exact manufacturer/part/revision and authoritative protocol evidence exist.
2. Valid 7-bit addresses and supported modes are documented consistently.
3. Registry bounds/defaults/raw keys/scales match QEMU strict validation and
   converted state keys/units.
4. All hub dispatch/type-count/address/readout paths are updated; no old-sensor
   fallback receives the new type.
5. Independent byte/numeric vectors validate model and SDK rather than a shared
   guessed formula passing a coupled test.
6. Real firmware init/read/fault/reset/recovery and separate instances work.
7. SDK headers/source/vendor/license/managed pins reach a fresh generated project.
8. Generated `usage()` is device-specific and does not assume MPU6050 fields.
9. New source paths are included by Meson and `save-qemu-patch.sh`; the saved
   patch forward-applies to a clean pinned QEMU source.
10. Support/extension documentation states verified capabilities and exclusions;
    adding the device did not silently populate empty starters or all demos.

## 5. Freshness And Independent Review

Rebuild changed model/firmware inputs explicitly; present cached artifacts are
not automatically fresh. Record commands/outcomes against the source actually
tested. After staging/commit, reconcile the delivered tree with that tested
content. A new PR head or upstream-base change requires reviewing the delta and
rerunning affected gates, not reusing unrelated green checks.

Run an independent read-only review when the change has meaningful protocol,
data-loss, security, or shared-contract risk. When delegation is permitted, the
reviewer must receive the base/head, protected paths, intended behavior and test
ledger, and must not edit the implementation. The main agent still evaluates
findings, repairs actionable defects and reruns relevant checks.

High-risk/unresolved correctness findings block readiness. Unsupported style
preferences do not justify unrelated rewrites. Explain disputed findings with
datasheet/code/test evidence; do not simply ignore them.

## 6. Evidence Package And PR Body

Prepare concise delivery evidence for the final report or PR body:

```text
Problem / intended behavior
Implementation summary by owning area
Compatibility and explicit non-goals
Device/datasheet/driver provenance, when relevant
Exact checks run and outcomes on candidate source
Browser/firmware/patch/soak evidence, when applicable
Unverified required checks and concrete blockers
Reviewer attention areas and known limitations
```

Do not state "all tests passed" unless the complete relevant suite actually did.
Do not copy metrics from earlier support documentation. Clearly distinguish
local equivalents from remote required checks. Keep screenshots/logs/binaries
out of the source tree; link UI screenshots from the PR as described below.

### UI screenshots on the PR

Every PR that changes what the web UI shows must link to screenshots of the
change. Post links, not embedded images.

1. Check for a browser by launching it:
   `node -e "require('@playwright/test').chromium.launch().then(browser => browser.close())"`
   with `PLAYWRIGHT_BROWSERS_PATH` set as for the browser tests, or try the
   browser tools. Then run the affected browser tests on the PR head.
2. With a browser, capture each changed view at desktop width and at 375 px.
   Include before and after shots when the change alters an existing layout.
   Look at every image before linking it.
3. When the environment already hosts its screenshots, as the GitHub cloud agent
   does, add a "Screenshots" list to the PR body with one Markdown link per
   image, captioned with the view and width, such as "Camera wiring, 320 px".
4. Otherwise, open or update the PR, then upload the images and post their links:

   ```bash
   bash .github/skills/espemu-pre-pr/scripts/pr-screenshots.sh --repo OWNER/REPO --pr NUMBER \
     test-results/creator/.../web-setup-desktop.png="Creator, desktop" \
     test-results/creator/.../web-setup-mobile.png="Creator, 375 px"
   ```

   The helper stores the images on the `pr-screenshots` branch through the
   GitHub API and posts one comment with a link to each, for the PR head commit.
   It never touches the worktree, the index or the feature branch.
   `--dry-run --sha SHA` prints the comment without contacting GitHub.
5. Without a browser, or when the upload fails, still open or update the PR.
   Add a "Screenshots" line to the PR body that says they are missing and why,
   for example "Screenshots: not captured, no browser in this environment."
   A missing browser never blocks posting the PR.
6. After pushing a new head that changes the UI again, link new screenshots for
   that head.

## 7. Readiness Decision And Delivery

| Decision | Condition and action |
| --- | --- |
| Ready for authorized delivery | Affected pre-PR checks pass, evidence matches source, audit/review findings addressed; proceed with requested commit/push/PR update |
| Draft only, if authorized | Work intentionally partial or external required check unavailable; label limitations clearly and continue independent repairs |
| Blocked | Missing credentials/approval/evidence/environment/decision prevents a required gate; leave resumable state and the precise next action |
| Not ready, repairable | Implementation/check/review defect remains; repair and rerun, do not hand it back as complete |

Publishing a draft can be an intermediate platform requirement, not completion.
Do not stop there if the task requires finished verification. For remote
delivery/required reviews/current checks/merging use
[review and delivery](../espemu-pr-review-delivery/SKILL.md).

Before the final report, check the newest request and apply the applicable
[completion checks](../espemu-completion-gate/SKILL.md#8-finish-the-requested-delivery).
State the delivered branch and SHA, the PR URL if applicable, actual test
outcomes, and any unresolved external gates.
Do not mark a PR ready/merged solely because this checklist file was filled out.
