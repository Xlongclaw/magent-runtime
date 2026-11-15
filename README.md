# Magent Runtime Agent

The Runtime Agent runs inside a user's VM and initiates all control-plane communication over HTTPS. It enrolls with a one-time registration token, stores the resulting bearer token in an owner-only file, sends heartbeats every 30 seconds, and polls for authorized commands every five seconds. It does not expose a management port or execute arbitrary host shell commands.

## Build and test

Requires Node.js 22+ and rootless Podman 4+ on the VM. The API tests mock provider HTTP calls and the agent tests use a fake Podman process; no live provider keys or container images are needed for tests.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @magent/runtime-agent... build
pnpm --filter @magent/runtime-agent test
```

The runtime repository includes the MAP and runtime protocol workspace packages required to build the agent independently of the Magent application monorepo.

## Enroll and run

Build the agent, configure `MAGENT_API_URL` to the Magent API origin, and set `MAGENT_AGENT_TOKEN_FILE` to a path writable only by the agent service account. Issue an enrollment token from the authenticated `/runtimes/enrollment-tokens` endpoint, then run:

```sh
MAGENT_API_URL=https://magent.example.test \
MAGENT_AGENT_TOKEN_FILE=/var/lib/magent-agent/agent-token \
MAGENT_ENROLLMENT_TOKEN='<one-time-token>' \
node dist/main.js enroll

MAGENT_API_URL=https://magent.example.test \
MAGENT_AGENT_TOKEN_FILE=/var/lib/magent-agent/agent-token \
node dist/main.js run
```

The enrollment token is single-use. The resulting runtime token is written with owner-only permissions and is never printed. The token file must not already exist before enrollment; choose a fresh path or remove the old token file after revoking the runtime. Production URLs must use HTTPS. HTTP is accepted only for loopback development. Rotate the agent credential by revoking/removing the runtime and enrolling it again.

## Local management (Linux)

`scripts/manage.sh` builds and enrolls one or more local agents. When a systemd user manager is available and Node.js is not installed from Snap, agents run as user services. Without a systemd user manager, or with Snap-based Node.js (whose confinement may prevent systemd from launching it), the script starts a managed background process instead, recording its PID and logs under `~/.local/state/magent-agent/<name>/`; this fallback does not restart automatically after reboot. Run setup as the regular user that owns rootless Podman (not with `sudo`). The `list`, `start`, `stop`, and `delete` commands can also be run with `sudo`; they operate on the invoking user's agents. The script requires Node.js 22+, pnpm, and rootless Podman 4+. If Podman is missing, setup installs it using the distribution package manager (`apt`, `dnf`/`yum`, `zypper`, or `pacman`) via `sudo`; unsupported distributions must install Podman manually. The script verifies that Podman supports rootless mode before continuing.

Clone this standalone repository to the VM and set up an agent using the API origin and the one-time token generated in the Magent web UI:

```sh
git clone https://github.com/Xlongclaw/magent-runtime.git ~/apps/magent-runtime
cd ~/apps/magent-runtime
bash scripts/manage.sh setup workstation https://magent.example.test
```

The script installs workspace dependencies, builds the agent, prompts for the enrollment token without echoing it, and starts `magent-agent@workstation.service`. The long-lived token is stored under `~/.local/state/magent-agent/workstation/agent-token` with owner-only permissions. Each setup requires a distinct name and enrollment token.

The Personal Runtime page can generate an SSH login command and the corresponding setup/reconnect commands. SSH is opened by the user from their own terminal; Magent does not receive or store the SSH private key or connect to the VM. The page remembers only the SSH host, user, port, agent name, and API URL in that browser. After generating a one-time enrollment token in the page, run the setup command in the VM's SSH session and enter the token at the hidden prompt.

```sh
bash scripts/manage.sh list
bash scripts/manage.sh start workstation
bash scripts/manage.sh stop workstation
bash scripts/manage.sh delete workstation
```

`start` and `stop` operate on the selected installed agent; when using systemd, `start` refreshes its generated unit before starting it. `stop` leaves its configuration and token installed. These commands work without a systemd user manager by using the background-process fallback. `delete` asks for confirmation, then removes that local agent and token only. It does **not** revoke or remove the server-side runtime, so remove the runtime in the Magent web UI to revoke its credential. Removing it in the UI also clears the runtime's associated control-plane records.

The Magent web UI's **Disconnect agent** action revokes the agent's server-side credential and any unused enrollment token while keeping the runtime configuration and installed app records. It does not remove the local agent files; use `manage.sh stop <name>` to stop the local service or process. Re-enroll the agent to connect it again.

User services normally run while the user is logged in. To keep them running after logout and start them at boot, enable systemd lingering for that user:

```sh
sudo loginctl enable-linger "$USER"
```

The control plane supports an allowlist of `runtime.inspect` and application lifecycle operations. Queue `runtime.inspect` to collect host CPU, memory, and disk usage and managed-container status/CPU/memory for the runtime dashboard. Install an app using an OCI image reference and the authenticated `/runtimes/applications` API. Rootless Podman launches containers with no network, read-only root filesystems, dropped Linux capabilities, no-new-privileges, CPU/memory/PID limits, a per-app persistent `/data` volume, and a small writable `/tmp`. App configuration uses bounded environment variables; never put secrets in these values. Explicitly granted credentials are retrieved over the authenticated agent connection and mounted as Podman secrets at `/run/secrets/<credential-id>`. Use the app `configure` action to change configuration or grants; it replaces the container while preserving app data. Update keeps the previous image available for rollback; uninstall removes the app's data volume and mounted secrets. No arbitrary command, host path mount, port publishing, or container network access is implemented.
