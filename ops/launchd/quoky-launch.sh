#!/bin/bash
# Quoky always-on launcher (ADR-0102 D1, D2, D5, D7, D8; SUB-1). launchd runs this as the user agent's program.
#
#   quoky-launch.sh run       --repo DIR --env-file FILE --node FILE --path PATHLIST --home DIR
#                             --data-dir DIR --log-dir DIR
#   quoky-launch.sh print-env (same options; prints the child environment and exits; changes nothing)
#
# run:
#   1. refuses on non-macOS;
#   2. rotates <log-dir>/quoky.log at start when it is above 10 MiB (keeps quoky.log.1 .. quoky.log.5) and sends
#      its own and the app's output there;
#   3. stops relaunching (exit 0, which launchd does not restart) after 3 consecutive configuration exits (78);
#      `quokyctl.sh restart --apply` or `install --apply` clears that stop;
#   4. refuses (exit 78, counted) unless the env file is a private (600) file you own, node is executable and the
#      app is built;
#   5. records this start (the count of starts in the last 10 minutes is passed to the app for the SUB-2 health
#      notice);
#   6. runs node apps/quoky/dist/main.js with an environment built from nothing (env -i): no shell variable is
#      inherited, so an exported DISCORD_* can never override the host .env.local;
#   7. forwards SIGTERM/SIGINT/SIGHUP to the app, waits for it, and exits with its status.
# Secrets: this script never reads, prints or logs the env file's content; it passes only its path.

set -u
set -o pipefail
if shopt -q patsub_replacement 2>/dev/null; then shopt -u patsub_replacement; fi

QUOKY_LAUNCH_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=quoky-ops-lib.sh
. "$QUOKY_LAUNCH_DIR/quoky-ops-lib.sh"

readonly MAX_CONSECUTIVE_CONFIG_EXITS=3
readonly LOG_ROTATE_BYTES=$((10 * 1024 * 1024))
readonly LOG_KEEP=5
readonly RESTART_WINDOW_SECONDS=600
readonly STARTS_KEEP=50

log() {
  printf '%s [quoky-launch] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' >&2
}

# Pure: prints the child environment, one NAME=VALUE per line, in a fixed order, from its arguments only.
# Args: home path env_file data_dir recent_starts user
quoky_child_env() {
  printf '%s\n' \
    "HOME=$1" \
    "PATH=$2" \
    "LANG=en_US.UTF-8" \
    "USER=$6" \
    "LOGNAME=$6" \
    "QUOKY_ENV_FILE=$3" \
    "QUOKY_RUNTIME_ENV=prod" \
    "QUOKY_DB_PATH=$(quoky_service_db_path "$4")" \
    "QUOKY_VECTOR_PATH=$(quoky_service_vector_path "$4")" \
    "QUOKY_LAUNCHER=launchd" \
    "QUOKY_LAUNCHER_RECENT_STARTS=$5"
}

# Rotates $1 when it is larger than $2 bytes, keeping $3 numbered files. Touches only <file> and <file>.N.
rotate_log() {
  local file=$1 max=$2 keep=$3 size i
  [ -f "$file" ] || return 0
  size=$(wc -c <"$file" | tr -d ' ')
  [ "${size:-0}" -gt "$max" ] || return 0
  rm -f "$file.$keep"
  i=$((keep - 1))
  while [ "$i" -ge 1 ]; do
    if [ -f "$file.$i" ]; then mv -f "$file.$i" "$file.$((i + 1))"; fi
    i=$((i - 1))
  done
  mv -f "$file" "$file.1"
}

# Appends $2 (epoch seconds) to the start history $1 (bounded) and prints how many starts fall in the window.
record_start() {
  local file=$1 now=$2 tmp count=0 t
  tmp="$file.tmp.$$"
  {
    if [ -f "$file" ]; then tail -n $((STARTS_KEEP - 1)) "$file"; fi
    echo "$now"
  } >"$tmp" && mv -f "$tmp" "$file"
  while IFS= read -r t; do
    case "$t" in '' | *[!0-9]*) continue ;; esac
    if [ $((now - t)) -le "$RESTART_WINDOW_SECONDS" ]; then count=$((count + 1)); fi
  done <"$file"
  echo "$count"
}

read_count() {
  local value=0
  if [ -f "$1" ]; then value=$(head -n 1 "$1" 2>/dev/null); fi
  case "$value" in '' | *[!0-9]*) value=0 ;; esac
  echo "$value"
}

COMMAND=${1:-}
[ $# -gt 0 ] && shift
REPO="" ENV_FILE="" NODE_BIN="" CHILD_PATH="" CHILD_HOME="" DATA_DIR="" LOG_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:-} ;;
    --env-file) ENV_FILE=${2:-} ;;
    --node) NODE_BIN=${2:-} ;;
    --path) CHILD_PATH=${2:-} ;;
    --home) CHILD_HOME=${2:-} ;;
    --data-dir) DATA_DIR=${2:-} ;;
    --log-dir) LOG_DIR=${2:-} ;;
    *)
      echo "quoky-launch: unknown option: $1" >&2
      usage
      exit "$QUOKY_EXIT_CONFIGURATION"
      ;;
  esac
  shift 2 || {
    echo "quoky-launch: missing value for $1" >&2
    exit "$QUOKY_EXIT_CONFIGURATION"
  }
done

case "$COMMAND" in
  run | print-env) ;;
  *)
    usage
    exit "$QUOKY_EXIT_CONFIGURATION"
    ;;
esac

for pair in "repo:$REPO" "env-file:$ENV_FILE" "node:$NODE_BIN" "home:$CHILD_HOME" "data-dir:$DATA_DIR" "log-dir:$LOG_DIR"; do
  if ! quoky_is_safe_abs_path "${pair#*:}"; then
    echo "quoky-launch: --${pair%%:*} must be an absolute path" >&2
    exit "$QUOKY_EXIT_CONFIGURATION"
  fi
done
case "$CHILD_PATH" in
  '' | *$'\n'*)
    echo "quoky-launch: --path must be a non-empty PATH list" >&2
    exit "$QUOKY_EXIT_CONFIGURATION"
    ;;
esac

CHILD_USER=$(id -un)

if [ "$COMMAND" = "print-env" ]; then
  quoky_child_env "$CHILD_HOME" "$CHILD_PATH" "$ENV_FILE" "$DATA_DIR" 0 "$CHILD_USER"
  exit 0
fi

# ---- run ----
if ! quoky_is_darwin; then
  echo "quoky-launch: the launchd runtime supports macOS only (this host: $(quoky_os_name))." >&2
  exit "$QUOKY_EXIT_CONFIGURATION"
fi

umask 077
if mkdir -p "$LOG_DIR" 2>/dev/null; then
  chmod 700 "$LOG_DIR" 2>/dev/null
  rotate_log "$LOG_DIR/quoky.log" "$LOG_ROTATE_BYTES" "$LOG_KEEP"
  exec >>"$LOG_DIR/quoky.log" 2>&1
else
  log "log directory unavailable; writing to the launchd fallback log"
fi

STATE_DIR="$DATA_DIR/launcher"
mkdir -p "$STATE_DIR" && chmod 700 "$DATA_DIR" "$STATE_DIR" || {
  log "refusing to start: cannot create the state directory under --data-dir"
  exit "$QUOKY_EXIT_CONFIGURATION"
}
CONFIG_EXITS_FILE="$STATE_DIR/config-exits"
STARTS_FILE="$STATE_DIR/starts"

config_exits=$(read_count "$CONFIG_EXITS_FILE")
if [ "$config_exits" -ge "$MAX_CONSECUTIVE_CONFIG_EXITS" ]; then
  log "not starting: $config_exits consecutive configuration exits. Fix the configuration (see quoky.log), then run 'ops/launchd/quokyctl.sh restart --apply'."
  exit 0
fi

refuse_config() {
  echo $((config_exits + 1)) >"$CONFIG_EXITS_FILE"
  log "refusing to start: $* (configuration exit $((config_exits + 1)) of $MAX_CONSECUTIVE_CONFIG_EXITS)"
  exit "$QUOKY_EXIT_CONFIGURATION"
}

if ! reason=$(quoky_check_private_env_file "$ENV_FILE"); then
  refuse_config "$reason: $(quoky_env_file_hint "$reason")"
fi
[ -x "$NODE_BIN" ] || refuse_config "node is not executable at --node; re-run 'ops/launchd/quokyctl.sh install --apply'"
MAIN_JS="$REPO/apps/quoky/dist/main.js"
[ -f "$MAIN_JS" ] || refuse_config "the app is not built ($MAIN_JS missing); run 'pnpm build' in the repository"

recent_starts=$(record_start "$STARTS_FILE" "$(date +%s)")

child_env=()
while IFS= read -r line; do
  child_env+=("$line")
done < <(quoky_child_env "$CHILD_HOME" "$CHILD_PATH" "$ENV_FILE" "$DATA_DIR" "$recent_starts" "$CHILD_USER")

names=""
for entry in "${child_env[@]}"; do names="$names ${entry%%=*}"; done
log "starting (starts in the last 10 minutes: $recent_starts); environment:$names"

cd "$REPO" || refuse_config "cannot enter --repo"
child_pid=""
forward_signal() {
  if [ -n "$child_pid" ]; then kill -s "$1" "$child_pid" 2>/dev/null; fi
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT
trap 'forward_signal TERM' HUP

# The launcher's own files (logs, state) are private (umask 077); the app keeps the usual 022 so files it writes in
# workspaces look like any other process's. Its data stays private through the mode-700 data directory.
umask 022
/usr/bin/env -i "${child_env[@]}" "$NODE_BIN" "$MAIN_JS" &
child_pid=$!

# wait returns early when a trapped signal arrives, so keep waiting while the app runs; bash keeps the exit status
# of a finished background child, so the final wait reports the app's own status.
while kill -0 "$child_pid" 2>/dev/null; do
  wait "$child_pid"
done
wait "$child_pid"
status=$?

if [ "$status" -eq "$QUOKY_EXIT_CONFIGURATION" ]; then
  echo $((config_exits + 1)) >"$CONFIG_EXITS_FILE"
  log "app exited with the configuration code ($((config_exits + 1)) of $MAX_CONSECUTIVE_CONFIG_EXITS consecutive)"
else
  rm -f "$CONFIG_EXITS_FILE"
  log "app exited with status $status"
fi
exit "$status"
