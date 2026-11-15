#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
AGENT_MAIN="$REPO_ROOT/dist/main.js"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
INSTANCE_CONFIG_DIR="$CONFIG_HOME/magent-agent/instances"
INSTANCE_STATE_DIR="$STATE_HOME/magent-agent"
SYSTEMD_USER_DIR="$CONFIG_HOME/systemd/user"

usage() {
  cat <<'EOF'
Usage:
  manage.sh setup <name> <api-url>   Build, enroll, and start a local agent
  manage.sh list                     List agents installed by this script
  manage.sh start <name>             Start an installed agent
  manage.sh stop <name>              Stop an agent (leave it installed)
  manage.sh delete <name>            Remove one local agent and its token
  manage.sh help

Names may contain letters, numbers, underscores, and hyphens.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

validate_name() {
  [[ "${1:-}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$ ]] ||
    fail "Agent name must start with a letter or number and contain at most 32 letters, numbers, underscores, or hyphens."
}

systemd_user_available() {
  command -v systemctl >/dev/null &&
    systemctl --user show-environment >/dev/null 2>&1
}

systemd_can_run_agent() {
  local node_bin
  systemd_user_available || return 1
  node_bin="$(command -v node)" || return 1
  [[ "$node_bin" != /snap/* ]]
}

service_unit() {
  printf 'magent-agent@%s.service' "$1"
}

instance_config() {
  printf '%s/%s.env' "$INSTANCE_CONFIG_DIR" "$1"
}

instance_token() {
  printf '%s/%s/agent-token' "$INSTANCE_STATE_DIR" "$1"
}

instance_pid() {
  printf '%s/%s/agent.pid' "$INSTANCE_STATE_DIR" "$1"
}

instance_log() {
  printf '%s/%s/agent.log' "$INSTANCE_STATE_DIR" "$1"
}

instance_unit_file() {
  printf '%s/%s' "$SYSTEMD_USER_DIR" "$(service_unit "$1")"
}

ensure_installed() {
  local name="$1"
  [[ -f "$(instance_config "$name")" && -f "$(instance_unit_file "$name")" ]] ||
    fail "Agent '$name' is not installed."
}

manual_agent_running() {
  local pid_file pid
  pid_file="${2:-$(instance_pid "$1")}"
  [[ -f "$pid_file" ]] || return 1
  IFS= read -r pid < "$pid_file" || return 1
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/cmdline" ]] || return 1
  tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | grep -Fqx -- "$AGENT_MAIN"
}

list_systemctl() {
  if [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]]; then
    local user_id
    command -v runuser >/dev/null || return 1
    user_id="$(id -u "$SUDO_USER")" || return 1
    runuser -u "$SUDO_USER" -- env \
      XDG_RUNTIME_DIR="/run/user/$user_id" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$user_id/bus" \
      systemctl --user "$@"
  else
    systemctl --user "$@"
  fi
}

user_directory_or_default() {
  local candidate="$1" fallback="$2" user_id="$3" owner
  if [[ -n "$candidate" && -d "$candidate" ]]; then
    owner="$(stat -c '%u' -- "$candidate")" || return 1
    if [[ "$owner" == "$user_id" ]]; then
      printf '%s' "$candidate"
      return
    fi
  fi
  printf '%s' "$fallback"
}

run_as_invoking_user() {
  local user="${SUDO_USER:-}" passwd_entry user_id user_home config_home state_home
  [[ "$(id -u)" -eq 0 && -n "$user" && "$user" != root ]] ||
    fail "This command must be run as the regular user that installed the agent."
  command -v runuser >/dev/null || fail "Cannot switch to the invoking user: runuser is unavailable."
  passwd_entry="$(getent passwd "$user")" ||
    fail "Could not determine the home directory for the invoking user '$user'."
  IFS=: read -r _ _ user_id _ _ user_home _ <<< "$passwd_entry"
  [[ -n "$user_id" && -n "$user_home" ]] ||
    fail "Could not determine the home directory for the invoking user '$user'."
  config_home="$(user_directory_or_default "${XDG_CONFIG_HOME:-}" "$user_home/.config" "$user_id")" ||
    fail "Could not determine the configuration directory for '$user'."
  state_home="$(user_directory_or_default "${XDG_STATE_HOME:-}" "$user_home/.local/state" "$user_id")" ||
    fail "Could not determine the state directory for '$user'."

  runuser -u "$user" -- env -u SUDO_USER \
    HOME="$user_home" \
    XDG_CONFIG_HOME="$config_home" \
    XDG_STATE_HOME="$state_home" \
    XDG_RUNTIME_DIR="/run/user/$user_id" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$user_id/bus" \
    "$SCRIPT_DIR/manage.sh" "$@"
}

list_systemd_user_available() {
  command -v systemctl >/dev/null && list_systemctl show-environment >/dev/null 2>&1
}

stop_manual_agent() {
  local name="$1" pid_file pid attempt
  pid_file="$(instance_pid "$name")"
  [[ -f "$pid_file" ]] || return 0
  IFS= read -r pid < "$pid_file" || pid=""
  if [[ ! "$pid" =~ ^[0-9]+$ ]] || ! manual_agent_running "$name"; then
    rm -f -- "$pid_file"
    return 0
  fi

  kill -TERM "$pid"
  for ((attempt = 0; attempt < 50; attempt++)); do
    if ! manual_agent_running "$name"; then
      rm -f -- "$pid_file"
      return 0
    fi
    sleep 0.2
  done
  fail "Agent '$name' did not stop after SIGTERM. Check $(instance_log "$name") before retrying."
}

start_manual_agent() {
  local name="$1" config_file token_file pid_file log_file api_url node_bin pid attempt
  config_file="$(instance_config "$name")"
  token_file="$(instance_token "$name")"
  pid_file="$(instance_pid "$name")"
  log_file="$(instance_log "$name")"
  [[ -f "$config_file" && -f "$token_file" && ! -L "$token_file" ]] ||
    fail "Agent '$name' is missing its configuration or token file."
  if manual_agent_running "$name"; then
    printf "Agent '%s' is already running.\n" "$name"
    return
  fi

  api_url="$(sed -n 's/^MAGENT_API_URL=//p' "$config_file")"
  [[ -n "$api_url" ]] || fail "Agent '$name' has no API URL in its configuration."
  node_bin="$(command -v node)" || fail "Node.js is required to start the Runtime Agent."
  mkdir -p "$(dirname -- "$pid_file")"
  nohup env MAGENT_API_URL="$api_url" MAGENT_AGENT_TOKEN_FILE="$token_file" \
    "$node_bin" "$AGENT_MAIN" run >> "$log_file" 2>&1 < /dev/null &
  pid=$!
  printf '%s\n' "$pid" > "$pid_file"
  chmod 600 "$pid_file" "$log_file"
  for ((attempt = 0; attempt < 50; attempt++)); do
    manual_agent_running "$name" && break
    [[ -r "/proc/$pid/cmdline" ]] || break
    sleep 0.2
  done
  if ! manual_agent_running "$name"; then
    rm -f -- "$pid_file"
    printf "Agent '%s' failed to start. Recent log output:\n" "$name" >&2
    if [[ -s "$log_file" ]]; then
      tail -n 20 "$log_file" >&2
    else
      printf '(No output was written to the agent log.)\n' >&2
    fi
    fail "Runtime Agent startup failed."
  fi
  printf "Agent '%s' started in the background. Logs: %s\n" "$name" "$log_file"
}

unit_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

unit_path_escape() {
  local value="$1"
  value="${value//\\/\\x5c}"
  value="${value// /\\x20}"
  value="${value//%/%%}"
  printf '%s' "$value"
}

write_systemd_unit() {
  local name="$1" config_file="$2" unit_file="$3" node_bin
  node_bin="$(command -v node)" || fail "Node.js is required to configure the Runtime Agent service."
  cat > "$unit_file" <<EOF
[Unit]
Description=Magent Runtime Agent ($name)
After=network-online.target

[Service]
Type=simple
EnvironmentFile=$(unit_path_escape "$config_file")
WorkingDirectory=$(unit_path_escape "$REPO_ROOT")
ExecStart=$(unit_escape "$node_bin") $(unit_escape "$AGENT_MAIN") run
Restart=on-failure
RestartSec=5
NoNewPrivileges=false
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=default.target
EOF
  chmod 644 "$unit_file"
}

normalize_api_url() {
  node --input-type=module - "$REPO_ROOT/dist/client.js" "$1" <<'NODE'
import { pathToFileURL } from "node:url";
const [clientPath, apiUrl] = process.argv.slice(2);
const { normalizeApiBaseUrl } = await import(pathToFileURL(clientPath));
try {
  console.log(normalizeApiBaseUrl(apiUrl));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid API URL.");
  process.exitCode = 1;
}
NODE
}

env_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

install_podman() {
  local os_id os_like package_manager=""
  [[ "$(uname -s)" == "Linux" ]] || fail "Podman installation is supported only on Linux."
  [[ -r /etc/os-release ]] || fail "Cannot identify this Linux distribution to install Podman."
  . /etc/os-release
  os_id="${ID:-}"
  os_like="${ID_LIKE:-}"

  case " $os_id $os_like " in
    *" ubuntu "*|*" debian "*|*" linuxmint "*)
      package_manager="apt-get"
      ;;
    *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*)
      if command -v dnf >/dev/null; then
        package_manager="dnf"
      elif command -v yum >/dev/null; then
        package_manager="yum"
      fi
      ;;
    *" opensuse "*|*" opensuse-leap "*|*" opensuse-tumbleweed "*|*" suse "*)
      package_manager="zypper"
      ;;
    *" arch "*|*" manjaro "*)
      package_manager="pacman"
      ;;
  esac

  [[ -n "$package_manager" ]] ||
    fail "Podman is missing and automatic installation is unsupported for this distribution. Install Podman 4+ with your system package manager, then retry."
  command -v sudo >/dev/null ||
    fail "Podman is missing. Install Podman 4+ with your system package manager (sudo is required), then retry."

  printf "Podman is not installed. Installing it with %s; sudo may prompt for your password.\n" "$package_manager"
  case "$package_manager" in
    apt-get)
      sudo apt-get update
      sudo apt-get install -y podman
      ;;
    dnf)
      sudo dnf install -y podman
      ;;
    yum)
      sudo yum install -y podman
      ;;
    zypper)
      sudo zypper --non-interactive install podman
      ;;
    pacman)
      sudo pacman --sync --refresh --noconfirm podman
      ;;
  esac

  command -v podman >/dev/null ||
    fail "Podman installation completed but the podman command is still unavailable. Check your package manager output."
}

check_local_requirements() {
  [[ "$(uname -s)" == "Linux" ]] || fail "This script currently supports Linux with systemd."
  [[ "$(id -u)" -ne 0 ]] || fail "Run this script as the regular user that should own the rootless Podman containers, not as root."
  command -v node >/dev/null || fail "Node.js 22 or newer is required."
  command -v pnpm >/dev/null || fail "pnpm is required."
  command -v podman >/dev/null || install_podman
  node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' ||
    fail "Node.js 22 or newer is required."
  local podman_version podman_major
  podman_version="$(podman version --format '{{.Client.Version}}')" ||
    fail "Could not determine the Podman version."
  podman_major="${podman_version%%.*}"
  [[ "$podman_major" =~ ^[0-9]+$ && "$podman_major" -ge 4 ]] ||
    fail "Rootless Podman 4 or newer is required."
  local rootless_status
  if ! rootless_status="$(podman info --format '{{.Host.Security.Rootless}}' 2>&1)"; then
    printf 'Podman rootless preflight failed:\n%s\n' "$rootless_status" >&2
    if [[ "$rootless_status" == *newuidmap* || "$rootless_status" == *newgidmap* ||
      "$rootless_status" == *uid_map* || "$rootless_status" == *gid_map* ]]; then
      printf '%s\n' \
        "Podman could not configure the rootless UID/GID mapping." \
        "On Ubuntu, check that the uidmap package is installed and /usr/bin/newuidmap and /usr/bin/newgidmap are root-owned setuid helpers (mode -rwsr-xr-x)." \
        "Verify this user's ranges in /etc/subuid and /etc/subgid. If the helpers are missing or have incorrect permissions, an administrator can run 'sudo apt-get install --reinstall uidmap'." \
        "If the helpers and ranges are correct, ask the VM administrator to check for a nosuid mount or a kernel/AppArmor policy blocking the mapping." >&2
    else
      printf '%s\n' \
        "Rootless Podman needs unprivileged user namespaces enabled by the VM host." \
        "If Podman reports a stale pause-process state, and no containers are running for this user, try 'podman system migrate' as this same user." \
        "If it still reports 'cannot clone: Operation not permitted', ask the VM provider/admin to enable rootless Podman/user namespaces; this cannot be fixed inside Magent without host support." >&2
    fi
    fail "Rootless Podman is not available on this VM."
  fi
  [[ "$rootless_status" == "true" ]] ||
    fail "Podman is running rootful, but Magent requires rootless Podman. Run setup as the regular VM user, not with sudo."
}

setup_agent() {
  local name="${1:-}"
  local api_url="${2:-}"
  validate_name "$name"
  [[ -n "$api_url" ]] || fail "API URL is required."
  check_local_requirements

  local config_file token_file unit_file unit node_bin registration_token
  config_file="$(instance_config "$name")"
  token_file="$(instance_token "$name")"
  unit="$(service_unit "$name")"
  unit_file="$(instance_unit_file "$name")"
  [[ ! -e "$config_file" && ! -L "$config_file" &&
    ! -e "$token_file" && ! -L "$token_file" &&
    ! -e "$unit_file" && ! -L "$unit_file" &&
    ! -e "$INSTANCE_STATE_DIR/$name" && ! -L "$INSTANCE_STATE_DIR/$name" ]] ||
    fail "Agent '$name' already has local files. Use list or delete it before setting it up again."

  printf 'Installing dependencies and building the Runtime Agent...\n'
  (
    cd "$REPO_ROOT"
    pnpm install --frozen-lockfile
    pnpm --filter @magent/runtime-agent... build
  )

  [[ -f "$AGENT_MAIN" ]] || fail "Runtime Agent build did not produce $AGENT_MAIN."
  api_url="$(normalize_api_url "$api_url")" || fail "API URL validation failed."
  node_bin="$(command -v node)"

  printf 'Enter the one-time enrollment token from Magent (input is hidden): '
  IFS= read -r -s registration_token
  printf '\n'
  [[ -n "$registration_token" ]] || fail "Enrollment token cannot be empty."

  mkdir -p "$INSTANCE_CONFIG_DIR" "$SYSTEMD_USER_DIR" "$(dirname -- "$token_file")"
  chmod 700 "$CONFIG_HOME/magent-agent" "$INSTANCE_CONFIG_DIR" "$INSTANCE_STATE_DIR" \
    "$INSTANCE_STATE_DIR/$name"
  umask 077
  printf 'MAGENT_API_URL=%s\nMAGENT_AGENT_TOKEN_FILE=%s\n' \
    "$api_url" "$(env_escape "$token_file")" > "$config_file"
  chmod 600 "$config_file"

  write_systemd_unit "$name" "$config_file" "$unit_file"

  if ! MAGENT_API_URL="$api_url" \
    MAGENT_AGENT_TOKEN_FILE="$token_file" \
    MAGENT_ENROLLMENT_TOKEN="$registration_token" \
    "$node_bin" "$AGENT_MAIN" enroll; then
    rm -f -- "$config_file" "$unit_file" "$token_file"
    rmdir -- "$INSTANCE_STATE_DIR/$name" 2>/dev/null || true
    unset registration_token
    fail "Enrollment failed. Generate a new one-time token in Magent and try again."
  fi
  unset registration_token

  if systemd_can_run_agent; then
    systemctl --user daemon-reload
    systemctl --user enable --now "$unit"
    printf "Agent '%s' installed and started as a systemd user service.\n" "$name"
  else
    if systemd_user_available; then
      systemctl --user disable --now "$unit" 2>/dev/null || true
    fi
    start_manual_agent "$name"
    printf "Agent '%s' installed using the background-process fallback.\n" "$name"
    printf 'This background process will not start automatically after reboot.\n'
  fi
  printf 'Check status with: %s list\n' "$0"
  if systemd_can_run_agent; then
    printf 'For operation after logout, enable lingering for this user: sudo loginctl enable-linger %s\n' "$(id -un)"
  fi
}

list_agents() {
  local found=0 config name unit state
  local config_dir="$INSTANCE_CONFIG_DIR"
  local state_dir="$INSTANCE_STATE_DIR"
  local has_systemd=0
  if [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]]; then
    local passwd_entry user_home
    passwd_entry="$(getent passwd "$SUDO_USER")" ||
      fail "Could not determine the home directory for the invoking user '$SUDO_USER'."
    IFS=: read -r _ _ _ _ _ user_home _ <<< "$passwd_entry"
    [[ -n "$user_home" ]] || fail "Could not determine the home directory for the invoking user '$SUDO_USER'."
    config_dir="${XDG_CONFIG_HOME:-$user_home/.config}/magent-agent/instances"
    state_dir="${XDG_STATE_HOME:-$user_home/.local/state}/magent-agent"
  fi
  list_systemd_user_available && has_systemd=1
  printf '%-20s %-12s %s\n' "NAME" "STATUS" "SERVICE"
  for config in "$config_dir"/*.env; do
    [[ -f "$config" ]] || continue
    found=1
    name="${config##*/}"
    name="${name%.env}"
    unit="$(service_unit "$name")"
    if manual_agent_running "$name" "$state_dir/$name/agent.pid"; then
      state="running"
    elif [[ "$has_systemd" -eq 1 ]] && list_systemctl is-active --quiet "$unit"; then
      state="running"
    elif [[ "$has_systemd" -eq 1 ]] && list_systemctl is-failed --quiet "$unit"; then
      state="failed"
    else
      state="stopped"
    fi
    printf '%-20s %-12s %s\n' "$name" "$state" "$unit"
  done
  if [[ "$found" -eq 0 ]]; then
    printf 'No Runtime Agents installed by this script.\n'
  fi
}

stop_agent() {
  local name="${1:-}"
  validate_name "$name"
  ensure_installed "$name"
  if manual_agent_running "$name"; then
    stop_manual_agent "$name"
  elif systemd_user_available; then
    systemctl --user stop "$(service_unit "$name")"
  else
    fail "Agent '$name' is not running."
  fi
  printf "Agent '%s' stopped. Its service and credentials remain installed.\n" "$name"
}

start_agent() {
  local name="${1:-}"
  validate_name "$name"
  ensure_installed "$name"
  if systemd_can_run_agent; then
    write_systemd_unit "$name" "$(instance_config "$name")" "$(instance_unit_file "$name")"
    if manual_agent_running "$name"; then
      stop_manual_agent "$name"
    fi
    systemctl --user daemon-reload
    systemctl --user start "$(service_unit "$name")"
    printf "Agent '%s' started as a systemd user service.\n" "$name"
  else
    if systemd_user_available; then
      systemctl --user disable --now "$(service_unit "$name")" 2>/dev/null || true
    fi
    start_manual_agent "$name"
  fi
}

delete_agent() {
  local name="${1:-}"
  validate_name "$name"
  ensure_installed "$name"

  printf "This removes the local service and token for '%s'. The Magent runtime configuration is not deleted or revoked.\n" "$name"
  printf "Type '%s' to confirm: " "$name"
  local confirmation
  IFS= read -r confirmation
  [[ "$confirmation" == "$name" ]] || fail "Confirmation did not match; nothing was deleted."

  local unit
  unit="$(service_unit "$name")"
  stop_manual_agent "$name"
  if systemd_user_available; then
    systemctl --user disable --now "$unit" 2>/dev/null || systemctl --user stop "$unit"
    systemctl --user daemon-reload
  fi
  rm -f -- "$(instance_unit_file "$name")" "$(instance_config "$name")" \
    "$(instance_token "$name")" "$(instance_pid "$name")" "$(instance_log "$name")"
  rmdir -- "$INSTANCE_STATE_DIR/$name" 2>/dev/null || true
  printf "Local files for agent '%s' removed.\n" "$name"
  printf 'To revoke its server credential, remove the runtime in the Magent web UI.\n'
}

command="${1:-help}"
case "$command" in
  setup)
    [[ "$#" -eq 3 ]] || fail "Usage: manage.sh setup <name> <api-url>"
    setup_agent "$2" "$3"
    ;;
  list)
    [[ "$#" -eq 1 ]] || fail "Usage: manage.sh list"
    list_agents
    ;;
  start)
    [[ "$#" -eq 2 ]] || fail "Usage: manage.sh start <name>"
    if [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]]; then
      run_as_invoking_user "$@"
    else
      start_agent "$2"
    fi
    ;;
  stop)
    [[ "$#" -eq 2 ]] || fail "Usage: manage.sh stop <name>"
    if [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]]; then
      run_as_invoking_user "$@"
    else
      stop_agent "$2"
    fi
    ;;
  delete)
    [[ "$#" -eq 2 ]] || fail "Usage: manage.sh delete <name>"
    if [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]]; then
      run_as_invoking_user "$@"
    else
      delete_agent "$2"
    fi
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage >&2
    fail "Unknown command '$command'."
    ;;
esac
