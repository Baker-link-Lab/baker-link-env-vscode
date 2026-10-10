# Baker Link Env for VS Code

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

## Troubleshooting

- **Baker Link: Check Host Connection** checks the selected configuration's TCP
  ports, not USB probe readiness or host identity. Use literal endpoint strings
  for this check; the status bar shows the last result, not continuous monitoring.
- **Baker Link: Open Connection Settings** opens `.vscode/launch.json`.
  Transfer errors appear in the **Baker Link Env** output channel.
- Start the host services manually and use a container-reachable bind address,
  not host loopback. Linux Docker requires
  `host.docker.internal:host-gateway`.

**Host DAP and upload services are unauthenticated. Use trusted networks and
firewall rules; do not expose these ports to untrusted networks.**

See [probe-rs debugger documentation](https://probe.rs/docs/tools/debugger/)
for chip, probe, and debugger options.
