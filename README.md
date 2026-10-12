# Baker Link Env for VS Code

Version **0.2.0** adds Copilot Agent build, debug, and breakpoint tools.
The extension version is independent of the desktop app and upstream probe-rs
extension versions; the `version: "0.2.0"` field in launch.json is VS Code's
configuration schema version, not the installed extension version.

Build and debug embedded Rust applications in a Dev Container using
[Baker Link Env](https://github.com/Baker-link-Lab/baker-link-env) on the host.
The extension uploads the built ELF before debugging and on restart, then
connects to the host's probe-rs DAP server.

This is a fork of the [probe-rs VS Code extension](https://github.com/probe-rs/vscode)
(upstream 0.32.0), not the official extension.

## Installation

Install [Baker Link Env from the Marketplace](https://marketplace.visualstudio.com/items?itemName=baker-link-lab.baker-link-env)
**inside the Dev Container**. The
[Baker Link template](https://github.com/Baker-link-Lab/bakerlink_tutorial_template)
installs it automatically.

Requires VS Code >= 1.116.0 and a trusted, non-virtual workspace.

## Configuration

Configure `.vscode/launch.json` (replace `my-project` with your Cargo binary name):

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "baker-link-debug",
            "request": "launch",
            "name": "Baker Link: Debug",
            "preLaunchTask": "cargo: build",
            "remoteServerMode": false,
            "chip": "RP2040",
            "flashingConfig": {
                "flashingEnabled": true,
                "haltAfterReset": true
            },
            "bakerLink": {
                "dapServer": "host.docker.internal:50001",
                "uploadUrl": "http://host.docker.internal:50002",
                "elf": "${workspaceFolder}/target/thumbv6m-none-eabi/debug/my-project"
            },
            "coreConfigs": [
                {
                    "coreIndex": 0,
                    "programBinary": "bakerlink://my-project/debug",
                    "rttEnabled": true
                }
            ]
        }
    ]
}
```

Add a `cargo: build` task to `.vscode/tasks.json`, start Baker Link Env with
**Run** on the host, then press **F5**. The template already supplies the task.

- Keep `remoteServerMode: false` for `bakerlink://` artifacts.
- `bakerLink.dapServer` takes priority over `server`; the default is
  `host.docker.internal:50001`. The upload URL defaults to
  `http://host.docker.internal:50002`.
- Relative ELF paths resolve against the workspace folder. For release or example
  builds, change the build task, ELF path, and artifact URI together.
- Project/profile identifiers accept 1-80 ASCII letters, digits, `-` or `_`.
  One ELF is uploaded per session, with SHA-256 verification, a 128 MiB limit,
  and a 30-second timeout. Upload failures block launch or restart.

For projects using version 0.1.0, move endpoints from `.bakerlink/connection.json`
into `bakerLink`, replace shell-upload tasks with build-only tasks, and delete
`.bakerlink`. The extension no longer reads that directory.

## Copilot Agent tools

In VS Code Chat Agent mode, Baker Link Env provides tools to run the configured
debug build, release build, or `cargo check` task; start, inspect, or stop a
Baker Link debug session; and set, list, or remove source-line breakpoints.
For example, ask the Agent to build the project, set a breakpoint in
`src/main.rs` at line 42, or start the existing Baker Link debug configuration.
Breakpoints are supported for Rust, C, C++, and Assembly files.
Tool results are returned as JSON text, not file attachments, so the Agent can
read build results, artifact IDs, and debug session status directly. Debug Status
reports session presence, not RTT samples or Debug Console output; reading those
logs through an Agent tool is not currently supported.

Build tools only run the named tasks from `.vscode/tasks.json`; they do not
accept arbitrary commands. Debug start uses an existing `baker-link-debug`
launch configuration, including its `preLaunchTask` and ELF upload settings.
Set and remove breakpoint tools only affect the specified file and line inside
the workspace. In multi-root workspaces, provide the workspace folder name or
absolute path.

VS Code asks for confirmation before running a build, changing breakpoints, or
starting/stopping debugging. Starting a session can build firmware, upload an
ELF, and program or reset a physical target. Tools require a trusted workspace.

### Cargo targets and launch modes

Use `#bakerInspectProject` to discover Cargo packages, binary/example/test
targets, the host target triple, and saved Baker Link launch configurations.
Saved `launch.json` is read as JSONC (comments and trailing commas supported);
invalid settings are reported rather than silently replaced. The selected
configuration is passed to VS Code as an in-memory snapshot so a freshly saved
configuration does not depend on a stale configuration cache.

`#bakerBuildArtifact` builds a selected target without creating tasks or editing
launch settings. It accepts `package`, `kind` (`bin`, `example`, `test`, or
`lib`), `name` (except for `lib`), `profile` (`debug` or `release`), `features`,
`noDefaultFeatures`, and optional `targetTriple`. Cargo is run from the selected
workspace folder, using its `Cargo.toml` and normal `.cargo/config.toml`
resolution, including linker flags and environment settings. Omit
`targetTriple` to respect the configured embedded target.

For an Embassy example, use:

```json
{
    "kind": "example",
    "name": "embassy_adc_audio",
    "features": ["embassy"],
    "noDefaultFeatures": true
}
```

The tool reads the actual executable from Cargo JSON output and returns
`artifact.artifactId`. Multiple executables are rejected rather than guessed;
specify a package when needed. Compiler failures return `success: false` and
diagnostics. Artifact IDs are local to the extension session, retain the most
recent 64 successful builds, and must be rebuilt after reload, eviction, or a
change to the executable. Debugging requires an ELF, not a host Windows binary.

`#bakerStartDebugging` supports three modes:

| Mode | Inputs | Behavior |
| --- | --- | --- |
| `launch` (default) | Existing `configuration` name | Uses the existing launch configuration and preserves `preLaunchTask`, just like normal VS Code debugging. |
| `launchWithArtifact` | `configuration` and `artifactId` | Clones the launch configuration, inherits hardware settings, substitutes the built ELF and its artifact URI, and skips `preLaunchTask` to avoid rebuilding the wrong target. |
| `direct` | `artifactId`, `chip`, `dapServer`, `uploadUrl` | Creates an in-memory launch configuration. Optional `flash`, `haltAfterReset`, and `rttEnabled` default to `true`. |

For example, after building the example above:

```json
{
    "mode": "launchWithArtifact",
    "configuration": "Baker Link: Debug",
    "artifactId": "<artifact.artifactId from the build>"
}
```

Neither artifact mode writes `launch.json` or `tasks.json`. Substitution requires
exactly one core and does not support `remoteServerMode: true`. Platform-specific
launch overrides are applied before replacing the ELF. Direct mode requires
explicit literal endpoints; it does not silently switch from a missing launch
configuration or guess which device to program.

`#bakerRunTests` accepts `mode: "host"` to run lib/bin/integration tests using an
explicit `targetTriple` equal to the host triple from Inspect Project. This
overrides an embedded Cargo default. An optional `testFilter` selects test names.
The configured Cargo environment, build scripts, and runners still apply.
`mode: "embedded-build"` builds a `lib` or integration `test` harness with
`--no-run`, respecting Cargo's configured target, and returns an artifact ID
that can be debugged using either artifact mode. **Building or debugging a test
ELF does not establish hardware test pass/fail.** Harness-specific result
collection (for example `defmt-test`) is not implemented.

Cargo tools accept structured arguments, not shell commands. They allow only
one concurrent Cargo operation per workspace, terminate Cargo on cancellation,
and enforce a 10-minute timeout and 16 MiB output limit. Standard launch mode
continues to use VS Code tasks, not this Cargo process runner.

## Troubleshooting

- **Baker Link: Check Host Connection** checks the selected configuration's TCP
  ports, not USB probe readiness or host identity. Use literal endpoint strings
  for this check; the status bar shows the last result, not continuous monitoring.
- **Baker Link: Open Connection Settings** opens `.vscode/launch.json`.
  Transfer errors appear in the **Baker Link Env** output channel.
- Start the host services manually and use a container-reachable bind address,
  not host loopback. Linux Docker requires
  `host.docker.internal:host-gateway`.
- `No client was connected` means the Agent could not dispatch a VS Code tool.
  Reconnect the VS Code client to the Dev Container before retrying. It does not
  indicate that the host DAP port or USB probe is unavailable. These tools use
  VS Code's Language Model Tool API, not a standalone MCP server.

**Host DAP and upload services are unauthenticated. Use trusted networks and
firewall rules; do not expose these ports to untrusted networks.**

See [probe-rs debugger documentation](https://probe.rs/docs/tools/debugger/)
for chip, probe, and debugger options.
