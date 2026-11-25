---
name: "espemu-project-tooling"
description: "Use when extending ESPEmu project creation or make add_component, updating ESPEMU-DEVICES.md/device_pins.h/SDK/editor files, working on shell/Make wrappers, suggesting free GPIOs/addresses, preserving source, writing manifests atomically, or changing create-only/build/run defaults."
---

# Project Creation, Artifacts, And Command Tooling

## Preserve The User's Workflow

- Creation returns without building/running unless explicitly selected.
- The default starter is a minimal empty app. Blinky and demo are opt-in.
- Add-component adds exactly one configured device, preserves existing firmware,
  and returns without build/run.
- Prompts are compact, one question at a time, with sensible free pin/address
  defaults. Full GPIO restrictions/help appear only when requested with `?`.
- Configured devices get automatically packaged SDK/header/dependency/build
  links and short examples. No manual callback/CMake wiring is assigned to users.
- Framework development keeps actual user project directories read-only.

## Owning Path And Script Update Matrix

| Surface | Owner | When to edit |
| --- | --- | --- |
| `npm run wizard` | [create-project.sh](../../../tools/create-project.sh) -> creator | Wrapper changes only, not one edit per I2C sensor |
| `npm run project -- DIR` / setup | [setup-project.sh](../../../tools/setup-project.sh) | Modes/templates/path checks/metadata setup |
| Interactive plan | [project-creator.ts](../../../tools/project-creator.ts) `interview` | New question/transport/config family not handled generically |
| Existing project add | Same file `interviewComponent` / `addComponent` | Single-device append, stale/symlink/atomic preservation |
| New project materialization | Same file `createProject` / `blinkySource` | Starter or language generation changes |
| Generated artifacts | [project-artifacts.ts](../../../tools/project-artifacts.ts) | Correct new SDK files, includes, usage examples, metadata |
| Artifact shell wrapper | [generate-project-artifacts.sh](../../../tools/generate-project-artifacts.sh) | Invocation/environment changes, usually not a new sensor |
| Make targets | [project-command.sh](../../../tools/project-command.sh) | New command behavior or routing |
| Portable project commands | [project.Makefile](../../../templates/project.Makefile) | Target/API changes, preservation-aware migrations |
| Generated project tracking | [project.gitignore](../../../templates/project.gitignore) | User-project ignore behavior, not root source allowlist |
| Build/launch | [build-firmware.sh](../../../tools/build-firmware.sh), [demo.sh](../../../tools/demo.sh) | New build/launch contract, not per-sensor snippets |
| Framework Git tracking | [.gitignore](../../../.gitignore) | New owned sources/components/customizations must be permitted |

For an ordinary new registry I2C sensor, type choice, addresses, numeric inputs
and scenarios are already registry-driven. Test those paths before adding
unnecessary per-type branching. New generation examples and file packaging still
need explicit inspection, even when the wizard itself needs no code change.

## 1. Test The Creator Without Asking The User Questions

Cloud/framework tests should call exported creator functions with injected
`Ask`/prompt implementations, as existing creator tests do. Do not run a TTY
wizard against the user's app and ask them to supply pins just to test a registry
addition. Do not invent an unsupported `--non-interactive` CLI flag.

For a new sensor verify:

1. Type is discoverable by human label and stable registry key.
2. First I2C device adds/reuses the supported named bus only when valid.
3. Suggested address is a supported unoccupied address, including conflicts
   with another sensor type at the same address.
4. All occupied addresses produce an explicit error, not an unsupported address.
5. Inputs/defaults/bounds and numeric scenarios come from `controls(type)` and
   the strict registry schema.
6. Instance IDs/labels stay unique and macro-name collisions are rejected before
   producing ambiguous headers.
7. Cancellation/declined confirmation produces no files or manifest mutation.
8. Default mode is create-only; run requires explicit selection.

If a new GPIO family needs questions, reuse available/free-pin logic, honor
output versus input-only pins, I2C reserved pins and other declared wiring.
Do not dump an entire pin map or turn warnings into repeated prompts.

## 2. Preserve Setup Modes And Existing Project Files

Current setup modes:

```bash
bash tools/setup-project.sh NEW_DIR --template empty --init-only
bash tools/setup-project.sh NEW_DIR --template demo --init-only
bash tools/setup-project.sh NEW_DIR --no-run
bash tools/setup-project.sh NEW_DIR --run
bash tools/setup-project.sh EXISTING_IDF_DIR --makefile-only
```

These are examples for authorized project creation or test-owned temporary
folders, not permission to run them in an unrelated application.

| Mode | Expected behavior |
| --- | --- |
| Default / `--init-only` | Create metadata/scaffold, no build/server |
| `--no-run` | Explicit create/build, no server |
| `--run` | Explicit create/build/start |
| `--makefile-only` | Add/recognized-upgrade command metadata; preserve app/source and do not build |

Reject conflicting modes and unsafe destination/symlink paths. Existing project
markers support repeat operations, not authority to overwrite application files.
Preserve custom Makefiles; only migrate exact recognized generated legacy forms
under the existing preservation rules. Do not broadly replace root/main CMake.

## 3. Correct Generated Artifact Owners

In `project-artifacts.ts`:

- `deviceMacroName` normalizes instance IDs to C macros; detect collisions after
  normalization, not only raw-ID duplicates.
- `devicePinsHeader` creates bus SDA/SCL/port and per-device address/port or pin,
  polarity, RGB channel and strip-count macros. Include common and configured
  APIs according to current packaging conventions.
- `blockDiagram` produces logical wiring, not an electrical schematic. Sanitize
  labels and preserve instance/bus identity.
- `usage` must match the actual SDK result type/fields and units. Its existing
  final sensor fallback assumes MPU6050; add a deliberate path for new sensors.
- `projectReadme` contains short shared initialization and device examples,
  command semantics, physical inputs and supported limits, not auto-inserted app
  code or paths to the developer's framework checkout.
- `editorFiles` uses the compile database and selected IDF/tool metadata. Generated
  absolute editor paths are local metadata, not tracked portable examples.
- `deviceSdkFiles` explicitly copies source/header/CMake/managed pins/vendor
  licenses. Every new split driver file must be included.
- `generateProjectArtifacts` controls preservation/ledger/symlink handling and
  the one-time optional SDK hook.

Use [the SDK skill](../espemu-firmware-sdk/SKILL.md) for packaging specifics.
Do not add a user-facing feature until the generated example compiles in a fresh
project with only `device_pins.h` and automatic dependency linkage.

## 4. Regeneration Must Not Destroy Edits

The `.espemu-generated.json` ledger stores hashes of generated content. Existing
edited files are preserved when their current bytes do not match known generated
content. Root CMake gets the optional SDK hook only when needed and not already
present. The force option is explicit and must not become the default recovery.

Generate wiring and SDK examples in `ESPEMU-DEVICES.md`. The initial `README.md`
links to that reference and is available for user notes. Test that adding a
device refreshes the unmodified reference and preserves an edited README.
Continue to protect edited generated files, copied SDK/vendor source, editor
settings and custom CMake/Make content. Test dangling file symlinks and symlink
ancestors; do not follow them into unrelated destinations. A symlink ledger or
CMake file can be a preflight failure, not a reason to unlink user files.

For `addComponent`:

1. Read/validate the existing manifest and capture its original bytes.
2. Collect exactly one device using the existing circuit's free resources.
3. Build/validate the complete new manifest and generated macro names before
   overwriting anything.
4. Recheck the original manifest to detect concurrent/stale changes.
5. Write the temporary manifest exclusively, preserve appropriate permissions,
   and atomically rename only after successful validation.
6. Regenerate only permitted artifacts, preserving edited files/source.
7. Return without building/running, even if a previous project command ran a
   simulator. No implicit source starter insertion or demo dependencies.

Do not resolve stale state with last-writer-wins or bypass symlink checks to make
the wizard finish unattended. This is a real correctness blocker; fresh planning
can resume after the conflicting source is understood.

## 5. Make Command Semantics

Preserve `build`, `run`, `web`, `clean`, `validate`, `docs`, and `add_component`.
`web` reuses a built image instead of implicitly compiling; `run` explicitly
builds/starts; `clean` must be limited to generated build output, not app source,
manifest, dependencies chosen by the user, or the entire framework cache.

Commands resolve the framework/project through the existing marker/Makefile
contract and quote paths with spaces. Failure/cancellation codes must propagate.
Do not assume the command runs from the framework root or a hardcoded home path.
Root `.gitignore` protects personal projects; generated project ignore rules must
still allow that user's firmware to be tracked normally.

## 6. Focused Verification

```bash
source tools/env.sh
node --import tsx --test tests/project-creator.test.ts tests/project-artifacts.test.ts \
  tests/project-setup.test.ts tests/project-makefile.test.ts
```

For shell edits, immediately run `bash -n` on the touched wrappers. Prefer the
existing tests for byte preservation, exact recognized migrations, path quoting,
create-only/run opt-in, Ctrl-C/decline, free pins/addresses, stale manifests,
symlinks and one-component mode.

For packaging/linkage/build behavior, run the generated-project integration test
with the pinned native environment and fresh affected artifacts:

```bash
node --import tsx --test tests/project-creator-integration.test.ts
```

Inspect that test's fixed ports/process lifecycle before running concurrently.
Do not weaken source-preservation assertions or test by changing user projects.

## Completion

New device selection, correct generated APIs/files, safe incremental updates,
unchanged create-only/default starter behavior, compact prompts and preservation
tests all pass. No build/run/source mutation happens as a hidden consequence of
configuration. Finish with [the completion gate](../espemu-completion-gate/SKILL.md).
