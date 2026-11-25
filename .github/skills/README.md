# ESPEmu Copilot Workflow Library

Detailed, repository-grounded workflows for autonomous cloud PR work and
datasheet-driven device development. The library includes twelve discoverable
skills, two agent profiles, reusable evidence/checklist resources, noninteractive
setup/diagnostics, and an offline customization validator wired into CI.

## Discovery And Locations

Repository skills live in `.github/skills/<name>/SKILL.md`, the shared discovery
location supported by GitHub Copilot and compatible IDE/CLI surfaces. Each
description contains task triggers; agents load detailed procedures when relevant
rather than adding this whole manual to every chat.

`~/.copilot/skills` is a personal skill location, not the repository location.
Personal cloud-sandbox/dotfiles support is surface-specific; a repository-local
`.copilot` folder is not a substitute for these shared files. No duplicate copies
are maintained because they would drift.

[Repository instructions](../copilot-instructions.md) route common tasks.
In VS Code, type `/espemu-` to discover available skills; choose an agent profile
from the agent picker when useful. Compatible clients also select skills from
their descriptions. Product/version support and user settings can vary.

## Skill Index

| Skill | Use it for | Main output/gate |
| --- | --- | --- |
| [espemu-completion-gate](./espemu-completion-gate/SKILL.md) | Substantial or high-risk work, blocked verification, authorized publication | Authorized acceptance, bounded repair, current evidence, real stop conditions |
| [espemu-environment](./espemu-environment/SKILL.md) | Local/cloud setup and recovery | Smallest tool profile, native/container decision, diagnostics |
| [espemu-cloud-pr-intake](./espemu-cloud-pr-intake/SKILL.md) | Fetch/import/integrate one or many cloud PRs | Exact-head inventory, owned worktree, ordered dependency queue |
| [espemu-datasheet-sensor](./espemu-datasheet-sensor/SKILL.md) | Add or audit a sensor from authoritative sources | Protocol/units/timing/calibration/fault dossier and end-to-end acceptance |
| [espemu-qemu-model](./espemu-qemu-model/SKILL.md) | Hardware model/hub/patch changes | Actual transactions, virtual timing, strict state and complete portable patch |
| [espemu-device-contracts](./espemu-device-contracts/SKILL.md) | Registry/manifest/runtime/scenarios/UI | Matching names/units/scales, isolated instances, truthful observations |
| [espemu-firmware-sdk](./espemu-firmware-sdk/SKILL.md) | Short C/C++ device APIs and dependencies | Automatically packaged driver/header/license/CMake and real firmware proof |
| [espemu-project-tooling](./espemu-project-tooling/SKILL.md) | Wizard/artifacts/Make/script extensions | Correct generated samples and source-preserving create/add workflows |
| [espemu-validation](./espemu-validation/SKILL.md) | Focused tests through full CI/soak | Scope-to-test matrix, fresh artifacts and accurate verification claims |
| [espemu-pre-pr](./espemu-pre-pr/SKILL.md) | Before commit/push/ready/publication | Scope/security/staged-file audit and concrete pre-PR readiness decision |
| [espemu-pr-review](./espemu-pr-review/SKILL.md) | Independent read-only review | Severity-ordered actionable findings, evidence and residual test gaps |
| [espemu-pr-review-delivery](./espemu-pr-review-delivery/SKILL.md) | Fix review comments/CI and deliver | Thread dispositions, verified updates and explicitly authorized exact-head merge |

## Agent Profiles

- [ESPEmu Maintainer](../agents/espemu-maintainer.agent.md) owns authorized
  implementation, PR queues, fixes, pre-PR checks and delivery. Tools/model use
  the host defaults, avoiding assumptions about client-specific capabilities.
- [ESPEmu Reviewer](../agents/espemu-reviewer.agent.md) is source-read-only and
  returns findings. It can inspect/run safe existing checks but never edits,
  stages, pushes, resolves threads or merges.

When permitted, the maintainer can delegate independent read-only research or
review. Missing delegation support is not a reason to stop; run the passes
sequentially. One agent owns each edited file/QEMU checkout/patch saver.

## Kickoff Examples

These are task examples, not standing permission to mutate remotes or user apps.
Supply actual repository/PR/device scope once. Routine tests/repairs/default
choices then proceed without repeated confirmation inside that scope.

### Repair Cloud PRs Without Merging

```text
Use ESPEmu Maintainer to process PRs 123 and 124 in this repository, in dependency
order. Repair each designated/assigned branch, address actionable review comments,
run affected pre-PR checks and required gates, and publish authorized non-force
updates. Do not merge, delete branches, force-push, or change user applications.
Keep working through routine failures; report only genuine external blockers and
leave every PR with current evidence and a clear disposition.
```

### Integrate A PR Queue Locally

```text
Import PRs 123, 124 and 130 into an owned integration worktree based on the current
target branch. Inspect exact heads, preserve all unrelated workspace changes,
resolve semantic conflicts and verify the combined device/SDK contracts. Local
integration is authorized; do not push or merge remotely. Finish the requested
checks or report the precise unavailable gate after independent work is complete.
```

### Add A Sensor From Its Datasheet

```text
Add PART as a supported ESPEmu device using the manufacturer's datasheet at URL.
Implement the documented supported protocol, QEMU model/hub/portable patch,
registry, packaged C/C++ init/read SDK, generated examples and framework fixtures.
Test independent register vectors, timing, faults/reset/recovery, multiple
instances when supported, fresh generated-project linkage and affected browser
behavior. Keep user apps read-only, defaults empty/create-only, and document
unsupported features. Run pre-PR review/checks; do not stop at a registry entry.
```

### Pre-PR Review Only

```text
Use ESPEmu Reviewer to review this candidate against the target branch. Perform
the pre-PR checks appropriate to the delta, identify actionable bugs/regressions/
unsupported sensor claims/missing tests with file-line evidence, and report what
was tested. Do not edit, commit, push, resolve threads or merge.
```

## Reusable Resources

- [Sensor dossier and full file/script update inventory](./espemu-datasheet-sensor/references/sensor-dossier.md).
- [Pre-PR readiness checklist](./espemu-pre-pr/references/readiness-checklist.md).
- [PR queue example](./espemu-cloud-pr-intake/references/pr-queue.json).

Use resources in ignored task/checkpoint state as needed. Do not create a tracked
progress document or new user-project files just to fill a template. Record
current source/check outcomes and actual remaining gates; do not copy old metrics.

## Setup And Checks

From the repository root:

```bash
# Read-only; no installation, build, or simulator.
bash .github/skills/espemu-environment/scripts/doctor.sh
bash .github/skills/espemu-environment/scripts/setup.sh --check

# Explicit lightweight preparation, never a simulator launch.
bash .github/skills/espemu-environment/scripts/setup.sh --web --browser

# Validate the library and offline helper behavior.
source tools/env.sh
npm run test:skills
```

Native setup/build profiles are explicit; read the environment skill first.
Native package locks target Ubuntu 26.04 packages, not the Ubuntu 24.04
GitHub runner. Use compatible native tooling or the pinned
Docker verification path when required and available. No helper elevates
privileges or removes pins to make an incompatible environment appear ready.

## GitHub Cloud Activation And Limits

[Copilot setup workflow](../workflows/copilot-setup-steps.yml) prepares pinned
Node/dependencies and Chromium before Actions-based sessions. It must reach the
default branch to affect future sessions. It does not provision cloud sandboxes;
those use the helper or an approved managed environment. Setup uses read-only
permissions, a pinned checkout and no secrets or eager full native builds.

[CI](../workflows/ci.yml) has a separate customization job running the validator;
the existing real emulator/firmware/browser/endurance acceptance remains intact.
Merged pull requests run only typecheck and the explicit non-native
`test:fast` suite, capped at three minutes. Unmerged PRs and direct pushes
start no workflow. Full container/firmware/browser
verification requires manual dispatch with `full_verification` selected; its
default is false. The Copilot setup workflow has no push/PR trigger.
Copilot can still use its setup job when starting an Actions-based agent session.
The setup workflow uses JSON-compatible YAML for full dependency-free structural
validation. Skill/profile frontmatter uses flat JSON-compatible YAML values.

This library does not create a background PR watcher, auto-assign tasks, change
repository permissions, provide credentials, auto-approve fork workflows or
merge arbitrary future PRs. A task must be started/assigned through the chosen
Copilot surface, with the intended operation and preconfigured access. Skills
then drive the repeatable work. Local file creation alone is not remote activation.

"Keep working" means verified authorized implementation and delivery, not an
infinite session or a bypass of safety gates. Host session/tool limits still
apply. Genuine missing permissions, credentials, source evidence or compatible
tooling must be reported honestly after independent work is completed.

## Maintaining The Library

- Use keyword-rich descriptions with `Use when...`, matching lowercase hyphenated
  folder/name values. Keep metadata strings quoted and booleans explicit when used.
- Keep SKILL.md below 500 lines; put detailed resources one level below it and
  link them relatively. Keep the always-on instruction file short.
- New sensor work should update relevant file/script/test maps if architecture
  changes; do not let precise command knowledge drift.
- Add tests for helper behavior changes, not only strings/metadata. Existing
  offline tests simulate downloads/build commands without network or app edits.
- Run `npm run test:skills` after each customization edit. It checks required
  skills, discovery metadata, links, Git allowlisting, shell syntax, supported
  agent/setup structure and helper safety. External URL reachability, remote
  GitHub execution and actual native hardware acceptance are separate checks.
- Do not add competing AGENTS.md instruction copies, hardcoded model selections,
  hidden unlimited permissions, stop hooks that conceal blockers, or unsafe
  automatic code execution from PR/document text.
