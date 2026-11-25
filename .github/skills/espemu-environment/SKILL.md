---
name: "espemu-environment"
description: "Use when preparing ESPEmu locally or in a GitHub Copilot cloud agent, diagnosing missing Node/npm/ESP-IDF/QEMU/Chromium, choosing native versus Docker verification, handling pinned dependencies, resource limits, firewall restrictions, or recovering a failed setup. Includes noninteractive setup and read-only diagnostics."
---

# ESPEmu Environment And Recovery

## Scope And First Action

Use [the diagnostic helper](./scripts/doctor.sh) before installing or rebuilding
anything. All commands below run from the repository root unless stated otherwise.
Do not start a simulator merely to check whether tools are installed.

```bash
bash .github/skills/espemu-environment/scripts/doctor.sh
bash .github/skills/espemu-environment/scripts/doctor.sh --native
source tools/env.sh
```

The default diagnostic checks JavaScript tools and prints optional artifact
availability. `--native` additionally requires the local build/IDF/QEMU toolchain.
It does not download packages, write projects, build, authenticate, or launch QEMU.
Exit 1 means a selected profile has a missing requirement; diagnose that profile,
not every optional feature.

## Authoritative Inputs

| Input | Ownership and use |
| --- | --- |
| [versions.env](../../../versions.env) | Node, uv, Python, ESP-IDF and Espressif QEMU tags/commits |
| [package-lock.json](../../../package-lock.json) | Exact JS dependency graph; use `npm ci`, not opportunistic upgrades |
| [native-packages.lock](../../../tools/native-packages.lock) | Exact distro-specific native `.deb` versions for rootless sysroot |
| [idf-python.lock](../../../tools/idf-python.lock) | IDF Python environment packages |
| [Dockerfile](../../../Dockerfile) | Digest-pinned container images and authoritative container build stages |
| [env.sh](../../../tools/env.sh) | Workspace-local PATH, IDF variables, npm cache, sysroot/pkg-config setup |
| [bootstrap.sh](../../../tools/bootstrap.sh) | Complete rootless native download/install procedure |
| [CI](../../../.github/workflows/ci.yml) | Actual acceptance environment and required commands |

At the time this workflow was authored, pins are Node 22.16.0, uv 0.7.13,
Python 3.11.12, ESP-IDF v5.4.2, and QEMU esp-develop-9.2.2-20261109. Read the
files again before using these values; do not duplicate or silently change pins.
Build Python packages in bootstrap are CMake 3.30.5, Ninja 1.11.1.4, Meson 1.7.0.
Version changes require an intentional task and all affected locks/image inputs.

## Select The Smallest Useful Profile

```bash
# Lightweight JS preparation; no IDF, native packages, QEMU build, or simulator.
bash .github/skills/espemu-environment/scripts/setup.sh --web

# Also download the Playwright Chromium distribution, not privileged OS packages.
bash .github/skills/espemu-environment/scripts/setup.sh --web --browser

# Diagnose only; these commands perform no installation.
bash .github/skills/espemu-environment/scripts/setup.sh --check
bash .github/skills/espemu-environment/scripts/setup.sh --check --native

# Explicitly prepare the full native toolchain using the repository bootstrap.
bash .github/skills/espemu-environment/scripts/setup.sh --native

# Native setup plus model build, or all framework-owned firmware fixtures.
bash .github/skills/espemu-environment/scripts/setup.sh --models
bash .github/skills/espemu-environment/scripts/setup.sh --fixtures --browser
```

With no flags, setup selects `--web`. `--native` implies JS setup. `--models`
implies native setup and builds QEMU. `--fixtures` additionally builds bundled
firmware, GPIO/framework/WS2812 fixtures. None of these options launches a web
server or emulator session. Unknown flags fail before installation.

The helper uses the repository's checksum-verified Node download on Linux x64,
checks its exact version, then `npm ci --no-audit --no-fund`. It refuses to replace
an incomplete or differently pinned Node cache automatically. It does not run
`sudo`, replace native pins, edit user applications, or install global npm tools.
Review a partial cache before moving only agent-owned failed download state aside.

## Fresh Shell And Native Setup Rules

1. Run `source tools/env.sh` in every fresh shell or worktree command. A system
   `node` may not exist even when `.cache/node/bin/node` does. Shell activation is
   process-local; do not assume another terminal or agent activated your shell.
2. For IDF commands, also source `"$IDF_PATH/export.sh"`. Existing build scripts
   do this themselves. Do not replace the active IDF environment with the host's
   arbitrary Python installation.
3. Native bootstrap needs existing Bash, git, curl, tar/xz, sha256sum, apt-get,
   dpkg-deb, and a compatible native compiler/standard build utilities. It cannot
   manufacture a working compiler or compatible distro package repository.
4. Bootstrap installs tools under `.cache`, verifies QEMU/IDF HEAD pins, installs
   the ESP32 IDF tools and Python environment, and extracts locked `.deb` packages
   into `.cache/sysroot`. It does not require sudo, but it requires matching apt
   repositories. Allocate several GB of free disk and sufficient RAM; measure
   available resources instead of promising fixed build times or cache sizes.
5. `tools/native-packages.lock` currently contains newer host-specific package
   versions, including split GLib/GIO/sysprof/pkgconf dependencies. Do NOT assume
   Ubuntu 24.04 on GitHub can download those exact versions. If `apt-get download`
   fails, inspect `apt-cache policy` for the failing packages. Do not remove pins,
   point the host at a different distro's repositories, or upgrade the host.
6. When native packages are unavailable, use the pinned Docker verification path
   if a daemon is available. Otherwise finish JS/static work and report the
   concrete native gate blocker. Updating native package portability is a separate
   authorized implementation, not a reason to weaken sensor acceptance.

## WSL Memory Limits

- Check `free -h`, `df -h . /mnt/c`, and the running workloads before starting a
  heavy build. Run one native build or browser suite at a time across worktrees
  on a memory-constrained host. Use focused checks instead of cold rebuilds
  when the inputs are unchanged. Do not stop other agents' work to free memory.
- Keep generated build and cache trees out of the C/C++ index. In an agent-only
  workspace, set `"C_Cpp.intelliSenseEngine": "disabled"` in workspace settings.
  This disables editor language features, not compiler builds. The extension's
  `intelliSenseMemoryLimit` is per worker, not a limit on the whole extension.
- Use `BUILD_JOBS=2` for `tools/build-qemu.sh`. `tools/build-firmware.sh` caps
  native firmware builds at two jobs by default and honors `BUILD_JOBS`.
  Direct `idf.py build` still invokes Ninja without this cap. On WSL with a
  working systemd user manager, use a cgroup budget for heavy commands. For
  example:

  ```bash
  BUILD_JOBS=2 systemd-run --user --scope -p CPUQuota=200% \
    -p MemoryHigh=3G -p MemoryMax=4G -p MemorySwapMax=1G \
    bash tools/build-qemu.sh
  ```

  The scope limits the command and its children; the CPU quota is not a job
  count. Adjust the budget only after measuring headroom. If the scope is not
  available, use the bounded development container or defer the heavy check
  instead of starting it unbounded during memory pressure.
- A WSL 2 VM ceiling and swap belong under `[wsl2]` in Windows' `%USERPROFILE%\.wslconfig`,
  not in this repository or `/etc/wsl.conf`. Size them for the Windows host and
  verify the swap drive has room. Changes apply after the WSL VM restarts.
  Never run `wsl --shutdown` from an agent session: it stops all WSL distributions
  and their running work. After a user-controlled restart, confirm with `free -h`
  and `swapon --show`.

## GitHub Cloud Setup

[copilot-setup-steps.yml](../../../.github/workflows/copilot-setup-steps.yml)
contains the single correctly named `copilot-setup-steps` job, a pinned checkout,
read-only repository permission, and lightweight JS/Chromium setup. It intentionally
does not eagerly bootstrap host-specific native packages or build every fixture.
It has no automatic push/PR trigger. Manual setup and Copilot's own Actions-based
environment preparation remain available; assigning an agent session can still
run its platform-managed setup independently of ordinary repository updates.
The workflow is JSON-compatible YAML so Node's built-in JSON parser can validate
its full structure without installing a YAML parser.

Important platform boundaries:

- The workflow must be present on the default branch for future Actions-based
  cloud sessions to use it. Local edits do not configure GitHub until delivered.
- GitHub Actions setup does not configure cloud sandbox sessions. In those
  sessions, use the helper directly if permitted, or an organization-managed
  compatible environment. Personal `~/.copilot/skills` are not a substitute for
  repository skills in an Actions session.
- Setup may fail and the agent may still start with a partially prepared
  environment. Read setup logs, rerun diagnostics, and recover the actual missing
  dependency. Do not trust a setup-job name as proof of tool availability.
- The helper exposes selected nonsecret PATH/browser/IDF variables through
  `GITHUB_PATH`/`GITHUB_ENV` when those files exist. Still source `tools/env.sh`
  in each shell for native library/pkg-config state.
- Built-in GitHub MCP access may be read-only and repository-scoped. Installing
  `gh` or declaring a tool does not grant write permission or authentication.
- Do not disable firewalls. Typical download endpoints include nodejs.org,
  registry.npmjs.org, github.com/api.github.com, uv/Python release asset hosts,
  PyPI/files.pythonhosted.org, Espressif tool servers, apt mirrors, and Playwright
  browser CDNs. Request only the required host through approved configuration.
  Verify redirects from the actual failed download; do not add broad wildcards.
- Private driver dependencies require preconfigured scoped credentials. Never
  put tokens in command arguments, source, manifests, or task reports.

Official references:
[development environment](https://docs.github.com/en/copilot/customizing-copilot/customizing-the-development-environment-for-copilot-coding-agent),
[agent skill locations](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills),
[custom agent configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration).

## Native Versus Container Verification

```bash
# Native, only with the full compatible toolchain available.
source tools/env.sh
bash tools/build-qemu.sh
bash tools/build-firmware.sh
bash tools/build-gpio-fixture.sh
bash tools/build-framework-fixtures.sh
bash tools/build-ws2812-fixture.sh

# Container acceptance, only when a working Docker daemon is available.
docker version
docker build --target verification -t espemu-verification .
docker run --rm --init --cap-drop=ALL --security-opt=no-new-privileges \
  -e CI=true -e SOAK=1 espemu-verification
```

Docker targets are `emulator-build`, `firmware-build`, `web-build`, `verification`,
`runtime-dependencies`, and `runtime`. Do not invent a `qemu`, `tools`, or `test`
target. A successful image build does not prove the verification container ran.

Both IDF build stages use Bash for the sourced exporter. The verification image
maps `/usr/local`, `/opt/esp/idf`, and `/opt/esp` to the framework's Node/IDF cache
paths and selects those IDF paths explicitly. Keep these mappings intact: without
them, project commands may download tools again and try incompatible native
package pins or ownership changes under `--cap-drop=ALL`. Check `npm run test:ci`
after Docker/workflow edits, then obtain actual container/CI execution evidence.

Forward Playwright options with `npm exec -- playwright install --with-deps chromium`
when building the verification image. Without the `--` separator, npm can consume
`--with-deps` instead of installing browser system libraries. Keep the image's
Chromium launch/close smoke check so missing libraries fail before the full suite.

Do not claim Docker works merely because the CLI is installed. Native and
container artifacts can differ; never mix incompatible binaries/libraries or
use a cached image built from an older patch as current model evidence.

## QEMU And Fixture Freshness

- A present QEMU binary can be stale after editing model sources or the tracked
  patch. `tools/verify.sh` prepares missing baseline artifacts and rejects known
  stale artifacts. It allows unrecorded artifacts by default, but their source
  freshness is unknown. Rebuild after relevant source changes; set
  `ESPEMU_REQUIRE_PROVENANCE=1` to reject unrecorded artifacts too.
- `.cache/qemu` is a git checkout at the pinned upstream commit plus local model
  edits. Do not delete or reset it to recover an apply conflict. Inspect source
  completeness and ownership before using the QEMU-model workflow.
- `.cache/esp-idf` and `.cache/idf-tools` are not interchangeable with a different
  worktree's mutable QEMU source/build tree. Never share a QEMU build tree between
  concurrently editing agents. Native absolute-path build caches are not portable
  just because their directory names match.
- Fixture builds are `empty-firmware`, `multi-sensor`, `gyro-firmware`, and
  `device-sdk` from `tools/build-framework-fixtures.sh`, plus the separate GPIO
  and WS2812 builders. Check the current builder list when adding fixtures.
- Preserve `.cache` in Git's ignore rules. Cache downloads can improve speed;
  cache hits do not prove pins, patch contents, or firmware freshness.

## Failure Recovery Table

| Symptom | Discriminating check | Recovery |
| --- | --- | --- |
| `node: command not found` | `.cache/node/bin/node --version` | Source env; use JS setup only if missing |
| `ERR_MODULE_NOT_FOUND` for tsx | `npm ls tsx --depth=0` | Correct worktree/cwd; use locked `npm ci` if authorized |
| TS test not recognized | Inspect exact invocation | Use `node --import tsx --test`, not bare `node --test` |
| Wrong IDF/target | Check `IDF_PATH`, pinned HEAD, sdkconfig/defaults | Activate pinned environment; keep target `esp32` |
| QEMU patch apply fails | Upstream HEAD, reverse check, local diff | Preserve edits and follow model patch procedure |
| Native apt version absent | `apt-cache policy PACKAGE` | Compatible environment or Docker; no unpinned fallback |
| Meson/pkg-config missing GIO | Inspect sysroot `.pc` files and env | Activate full locked sysroot; no arbitrary global flags |
| Compiler killed/OOM | RAM/disk and build logs | Reduce `BUILD_JOBS`; do not remove model tests |
| Chromium missing | Browser directory and Playwright version | Download matching browser; diagnose OS libraries separately |
| Browser shared libraries absent | Actual launch error | Container or approved OS dependency provisioning, not interactive sudo |
| Port already bound | Identify listener | Choose unused `TEST_PORT`/`PROJECT_TEST_PORT`; preserve unrelated server |
| Docker daemon inaccessible | `docker version` server result | Native compatible environment or report unavailable gate |
| Firewall/credentials block | Failed URL/permission without secrets | Preconfigured approved access or precise blocker |

After recovery, rerun the same focused check that failed. Apply
[the completion gate](../espemu-completion-gate/SKILL.md); do not stop at a tool
installation or a background build that has not finished.
