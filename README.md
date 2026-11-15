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

Clone this standalone repository to the VM and set up an agent using the API origin and the one-time token generated in the Magent web UI. The setup script requires Node.js 22+, pnpm, and rootless Podman 4+; on a fresh VM, install Node.js 22+ and pnpm before running it:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
sudo apt-get update
sudo apt-get install -y nodejs
sudo npm install --global pnpm@12.16.1

git clone https://github.com/Xlongclaw/magent-runtime.git ~/apps/magent-runtime
cd ~/apps/magent-runtime
bash scripts/manage.sh setup workstation https://magent.example.test
```

The script installs workspace dependencies, builds the agent, prompts for the enrollment token without echoing it, and starts `magent-agent@workstation.service`. The long-lived token is stored under `~/.local/state/magent-agent/workstation/agent-token` with owner-only permissions. Each setup requires a distinct name and enrollment token.

The Personal Runtime page can generate an SSH login command and the corresponding setup/reconnect commands. SSH is opened by the user from their own terminal; Magent does not receive or store the SSH private key or connect to the VM. The page remembers only the SSH host, user, port, agent name, and API URL in that browser. After generating a one-time enrollment token in the page, run the setup command in the VM's SSH session and enter the token at the hidden prompt.

### Rootless Podman troubleshooting

The Runtime Agent must run as the regular VM user, not as root, and requires the VM host to permit unprivileged user namespaces for rootless Podman. It uses the VM's local Podman engine, not a remote Podman connection, so secret data can be passed securely over stdin. Check as that same user:

```sh
podman info --format '{{.Host.Security.Rootless}}'
unshare -Ur true
grep "^$(id -un):" /etc/subuid /etc/subgid
```

The manager and Runtime Agent explicitly select local Podman and ignore remote-connection environment variables. A local `podman info` check should report rootless mode:

```sh
podman system connection list
printf 'CONTAINER_HOST=%s\nCONTAINER_CONNECTION=%s\nDOCKER_HOST=%s\n' \
  "${CONTAINER_HOST:+set}" "${CONTAINER_CONNECTION:+set}" "${DOCKER_HOST:+set}"
env -u CONTAINER_HOST -u CONTAINER_CONNECTION -u DOCKER_HOST \
  /usr/bin/podman --remote=false info --format '{{.Host.Security.Rootless}}'
```

The last command should print `true` for the local rootless engine. If it prints `false`, inspect the local Podman setup; do not use a remote or rootful connection as a workaround. If it fails, follow the error diagnostics below.

If Podman reports a stale pause-process state, and no containers are running for this user, try `podman system migrate` as the agent user, then retry `podman info`. This can stop that user's running containers. Do not use `podman system reset`; it removes Podman data.

On Ubuntu, if `kernel.apparmor_restrict_unprivileged_userns` is `1` and `unshare -Ur true` fails, AppArmor's unprivileged user-namespace restriction may be blocking rootless Podman. An administrator can test whether this is the cause with:

```sh
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

Then, as the regular agent user, verify `unshare -Ur true` and `podman info --format '{{.Host.Security.Rootless}}'`. Setting this sysctl to `0` disables this AppArmor restriction system-wide, reducing a security control for unprivileged user namespaces. Only make it persistent if that tradeoff is acceptable for the VM:

```sh
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/99-rootless-podman.conf
sudo sysctl --system
```

To undo the persistent setting, remove `/etc/sysctl.d/99-rootless-podman.conf` and restore the original value (commonly `1` on affected Ubuntu releases) with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1`. If the setting is unavailable or disabling it does not resolve `cannot clone: Operation not permitted`, the VM host/provider must allow unprivileged user namespaces and configure subordinate UID/GID ranges for this account. Without root or provider-admin assistance, host restrictions cannot be fixed from the Runtime Agent or Magent.

If namespace creation works but Podman fails with `newuidmap: write to uid_map failed` when run by the Runtime Agent, check the generated user service first. The agent service must not enable `NoNewPrivileges`; rootless Podman needs its `newuidmap` setuid helper to configure subordinate UID mappings. Update the standalone checkout, then regenerate and restart the service as the regular agent user:

```sh
git pull --ff-only
bash scripts/manage.sh stop workstation
bash scripts/manage.sh start workstation
```

The regenerated service explicitly sets `NoNewPrivileges=false` for the agent process, which still runs as the regular user. Managed application containers continue to use Podman's `no-new-privileges` security option.

If Podman still fails, check the mapping helpers and ranges:

```sh
dpkg-query -W uidmap
stat -c '%A %U:%G %n' /usr/bin/newuidmap /usr/bin/newgidmap
grep "^$(id -un):" /etc/subuid /etc/subgid
findmnt -no TARGET,OPTIONS --target /usr/bin/newuidmap
```

The helpers should be owned by `root:root` and have the setuid bit (typically mode `-rwsr-xr-x`); the user's `/etc/subuid` and `/etc/subgid` entries must each provide a subordinate range. If `uidmap` is missing or the helper permissions are incorrect, an administrator can restore the package with `sudo apt-get install --reinstall uidmap`. If the helper is correct but its filesystem is mounted with `nosuid`, or the mapping is still denied, an administrator should check the VM's security policy and kernel logs (for example, `sudo journalctl -k --since "10 minutes ago" | grep -i apparmor`). Do not change mount security options or run the agent as root as a workaround.

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
sudo loginctl enable-linger "$(id -un)"
loginctl show-user "$(id -un)" -p Linger
bash scripts/manage.sh start workstation
```

When rootless Podman warns that its cgroup v2 manager is `systemd` but there is no systemd user session, run `loginctl enable-linger` as an administrator for the account that owns Podman, then restart the agent as that regular user. For example, from an SSH login as `admin`:

```sh
sudo loginctl enable-linger admin
loginctl show-user admin -p Linger
bash scripts/manage.sh start <agent-name>
podman info --format '{{.Host.Security.Rootless}}'
```

`Linger=yes` confirms lingering is enabled. Restarting through `manage.sh` refreshes the generated unit when the systemd user manager is available, or uses the managed-process fallback otherwise. Keep the agent and Podman rootless; do not run either with `sudo`.

The cgroup messages are warnings and may not be the cause of an operation failure. The Runtime Agent forces local Podman because remote Podman connections may not forward stdin required by `podman secret create`. If an install fails, use the application's `lastError`; long Podman errors retain both the beginning and end of their output. A later “managed container does not exist” message means the container was never created or the install failed; resolve the original `app.install` error and retry installation before requesting logs or starting the app.

The control plane supports an allowlist of `runtime.inspect` and application lifecycle operations. Queue `runtime.inspect` to collect host CPU, memory, and disk usage and managed-container status/CPU/memory for the runtime dashboard. Install an app using an OCI image reference and the authenticated `/runtimes/applications` API. Rootless Podman launches containers with no network, read-only root filesystems, dropped Linux capabilities, no-new-privileges, CPU/memory/PID limits, a per-app persistent `/data` volume, and a small writable `/tmp`. App configuration uses bounded environment variables; never put secrets in these values. Explicitly granted credentials are retrieved over the authenticated agent connection and mounted as Podman secrets at `/run/secrets/<credential-id>`. Use the app `configure` action to change configuration or grants; it replaces the container while preserving app data. Update keeps the previous image available for rollback; uninstall removes the app's data volume and mounted secrets. No arbitrary command, host path mount, port publishing, or container network access is implemented.
