#!/bin/bash
# Quoky launchd service control (ADR-0102 D1, SUB-1). macOS only.
#
#   quokyctl.sh install   --dry-run | --apply   render the user agent plist and (re)load it; idempotent
#   quokyctl.sh uninstall --dry-run | --apply   unload the agent and remove its plist (data and logs are kept)
#   quokyctl.sh restart   --dry-run | --apply   clear the configuration-exit stop and restart the agent
#   quokyctl.sh status                          read-only: plist, launchd state, configuration exits, paths
#   quokyctl.sh render                          read-only: print the plist install would write
#   quokyctl.sh backup   [--dry-run] | --apply  take a verified DB copy + vector snapshot now (kind manual, 5 kept)
#   quokyctl.sh backup   --verify NAME          read-only: re-verify a retained copy and its vector snapshot
#
# Options: --repo DIR (default: this checkout)  --env-file FILE (default: <repo>/.env.local)
#          --label LABEL (default: com.quoky.personal)  --node FILE (default: the node on PATH)
#
# install, uninstall and restart change the owner's login session (launchctl bootstrap/bootout/kickstart in
# gui/<uid>): they are Strict owner-host actions. --dry-run prints the exact plan and changes nothing; --apply runs
# the same plan. There is no default mode for them. backup defaults to --dry-run; --apply writes only into the backup
# directory and runs while the service keeps running (no restart). Never prints the env file's content.

set -u
set -o pipefail
if shopt -q patsub_replacement 2>/dev/null; then shopt -u patsub_replacement; fi

CTL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=quoky-ops-lib.sh
. "$CTL_DIR/quoky-ops-lib.sh"

LAUNCHCTL=${QUOKY_LAUNCHCTL:-/bin/launchctl}
TEMPLATE="$CTL_DIR/com.quoky.personal.plist"
LAUNCHER="$CTL_DIR/quoky-launch.sh"
SYSTEM_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//' >&2
}

fail() {
  echo "quokyctl: $*" >&2
  exit 1
}

COMMAND=${1:-}
[ $# -gt 0 ] && shift
MODE="" REPO="" ENV_FILE="" LABEL="$QUOKY_DEFAULT_LABEL" NODE_BIN="" VERIFY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dry-run; shift; continue ;;
    --apply) MODE=apply; shift; continue ;;
    --verify) VERIFY=${2:-} ;;
    --repo) REPO=${2:-} ;;
    --env-file) ENV_FILE=${2:-} ;;
    --label) LABEL=${2:-} ;;
    --node) NODE_BIN=${2:-} ;;
    *) usage; fail "unknown option: $1" ;;
  esac
  shift 2 || fail "missing value for $1"
done

case "$COMMAND" in
  install | uninstall | restart)
    [ -n "$MODE" ] || { usage; fail "$COMMAND needs --dry-run (show the plan) or --apply (run it)"; }
    ;;
  status | render)
    [ -z "$MODE" ] || fail "$COMMAND is read-only; it takes no --dry-run/--apply"
    ;;
  backup)
    if [ -n "$VERIFY" ]; then
      [ -z "$MODE" ] || fail "backup --verify is read-only; it takes no --dry-run/--apply"
    else
      [ -n "$MODE" ] || MODE=dry-run
    fi
    ;;
  *) usage; exit 2 ;;
esac
[ -z "$VERIFY" ] || [ "$COMMAND" = backup ] || fail "--verify belongs to the backup command"


if ! quoky_is_darwin; then
  fail "the Quoky launchd service supports macOS only (this host: $(quoky_os_name)). Run 'pnpm dev' instead."
fi

case "$LABEL" in
  '' | *[!A-Za-z0-9.-]*) fail "--label must contain only letters, digits, '.' and '-'" ;;
esac

[ -n "$REPO" ] || REPO=$(cd "$CTL_DIR/../.." && pwd)
[ -n "$ENV_FILE" ] || ENV_FILE="$REPO/.env.local"
quoky_is_safe_abs_path "${HOME:-}" || fail "HOME must be an absolute path"
quoky_is_safe_abs_path "$REPO" || fail "--repo must be an absolute path"
quoky_is_safe_abs_path "$ENV_FILE" || fail "--env-file must be an absolute path"

UID_NUM=$(id -u)
DOMAIN="gui/$UID_NUM"
SERVICE="$DOMAIN/$LABEL"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$AGENTS_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Quoky"
DATA_DIR="$HOME/Library/Application Support/Quoky"
CONFIG_EXITS_FILE="$DATA_DIR/launcher/config-exits"
BACKUP_TOOL="$REPO/apps/quoky/dist/tools/backup-now.js"

# ---------------------------------------------------------------- read-only helpers

is_loaded() {
  "$LAUNCHCTL" print "$SERVICE" >/dev/null 2>&1
}

# Directory of a command found on the caller's PATH (empty when absent).
command_dir() {
  local found
  found=$(command -v "$1" 2>/dev/null) || return 0
  case "$found" in /*) dirname "$found" ;; esac
}

# The fixed PATH given to the app: the node, claude and ollama directories, then the system directories.
child_path() {
  local result="" dir
  for dir in "$(dirname "$NODE_BIN")" "$(command_dir claude)" "$(command_dir ollama)" /usr/bin /bin /usr/sbin /sbin; do
    [ -n "$dir" ] || continue
    case ":$result:" in *":$dir:"*) continue ;; esac
    result="${result:+$result:}$dir"
  done
  echo "$result"
}

xml_escape() {
  local value=$1
  value=${value//&/&amp;}
  value=${value//</&lt;}
  value=${value//>/&gt;}
  printf '%s' "$value"
}

# Prints the plist: the template without its comment block, placeholders replaced by XML-escaped absolute values.
render_plist() {
  local line in_comment=0 out=""
  local label launcher repo env_file node child_path_value home data_dir log_dir
  label=$(xml_escape "$LABEL")
  launcher=$(xml_escape "$LAUNCHER")
  repo=$(xml_escape "$REPO")
  env_file=$(xml_escape "$ENV_FILE")
  node=$(xml_escape "$NODE_BIN")
  child_path_value=$(xml_escape "$CHILD_PATH")
  home=$(xml_escape "$HOME")
  data_dir=$(xml_escape "$DATA_DIR")
  log_dir=$(xml_escape "$LOG_DIR")
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$in_comment" -eq 1 ]; then
      case "$line" in *'-->'*) in_comment=0 ;; esac
      continue
    fi
    case "$line" in '<!--'*) in_comment=1; continue ;; esac
    line=${line//@@LABEL@@/$label}
    line=${line//@@LAUNCHER@@/$launcher}
    line=${line//@@REPO@@/$repo}
    line=${line//@@ENV_FILE@@/$env_file}
    line=${line//@@NODE@@/$node}
    line=${line//@@CHILD_PATH@@/$child_path_value}
    line=${line//@@HOME@@/$home}
    line=${line//@@DATA_DIR@@/$data_dir}
    line=${line//@@LOG_DIR@@/$log_dir}
    out="$out$line"$'\n'
  done <"$TEMPLATE"
  printf '%s' "$out"
}

resolve_node() {
  if [ -z "$NODE_BIN" ]; then NODE_BIN=$(command -v node 2>/dev/null || true); fi
  quoky_is_safe_abs_path "$NODE_BIN" || fail "node was not found on PATH; pass --node /absolute/path/to/node"
  [ -x "$NODE_BIN" ] || fail "--node is not executable"
  CHILD_PATH=$(child_path)
}

# ---------------------------------------------------------------- plan execution

PLAN_STEPS=0
# step "description" command... : prints the step; runs it only with --apply.
step() {
  local description=$1
  shift
  PLAN_STEPS=$((PLAN_STEPS + 1))
  if [ "$MODE" = apply ]; then
    echo "apply: $description"
    "$@" || fail "step failed: $description"
  else
    echo "plan:  $description"
  fi
}

note() {
  echo "note:  $*"
}

write_plist() {
  local tmp="$PLIST_PATH.tmp.$$"
  printf '%s\n' "$RENDERED" >"$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$PLIST_PATH"
}

wait_until_unloaded() {
  local i=0
  while is_loaded; do
    i=$((i + 1))
    [ "$i" -le 95 ] || return 1
    sleep 1
  done
}

bootout_service() {
  "$LAUNCHCTL" bootout "$SERVICE" && wait_until_unloaded
}

private_dir() {
  mkdir -p "$1" && chmod 700 "$1"
}

clear_config_exits() {
  rm -f "$CONFIG_EXITS_FILE"
}

lint_rendered() {
  local tmp
  command -v plutil >/dev/null 2>&1 || return 0
  tmp=$(mktemp "${TMPDIR:-/tmp}/quoky-plist.XXXXXX") || return 1
  printf '%s' "$RENDERED" >"$tmp"
  plutil -lint -s "$tmp" >/dev/null 2>&1
  local rc=$?
  rm -f "$tmp"
  return $rc
}

# ---------------------------------------------------------------- commands

cmd_render() {
  resolve_node
  RENDERED=$(render_plist)
  printf '%s\n' "$RENDERED"
}

cmd_install() {
  resolve_node
  local blocked=0 reason
  [ -f "$TEMPLATE" ] && [ -f "$LAUNCHER" ] || fail "ops/launchd files are missing next to quokyctl.sh"
  if [ ! -f "$REPO/apps/quoky/dist/main.js" ]; then
    echo "blocked: the app is not built ($REPO/apps/quoky/dist/main.js missing); run 'pnpm build' first"
    blocked=1
  fi
  if ! reason=$(quoky_check_private_env_file "$ENV_FILE"); then
    echo "blocked: $reason: $(quoky_env_file_hint "$reason")"
    blocked=1
  fi
  for tool in claude ollama; do
    [ -n "$(command_dir "$tool")" ] || note "'$tool' is not on PATH now, so its directory is not in the service PATH; install it and re-run install"
  done
  RENDERED=$(render_plist)
  if ! lint_rendered; then
    echo "blocked: the rendered plist does not pass 'plutil -lint'"
    blocked=1
  fi
  [ "$blocked" -eq 0 ] || fail "install refused; nothing was changed"

  local existing="" changed=1 loaded=0
  if [ -f "$PLIST_PATH" ]; then existing=$(cat "$PLIST_PATH"); fi
  [ "$existing" = "$RENDERED" ] && changed=0
  is_loaded && loaded=1

  echo "service: $SERVICE"
  echo "plist:   $PLIST_PATH"
  echo "logs:    $LOG_DIR/quoky.log (rotated at start above 10 MiB, 5 kept)"
  echo "data:    $DATA_DIR (QUOKY_DB_PATH=quoky.db, QUOKY_VECTOR_PATH=vectors)"
  echo "env:     $ENV_FILE (mode 600; content never read by this script)"

  [ -d "$AGENTS_DIR" ] || step "create $AGENTS_DIR" mkdir -p "$AGENTS_DIR"
  step "ensure $LOG_DIR exists with mode 700" private_dir "$LOG_DIR"
  step "ensure $DATA_DIR exists with mode 700" private_dir "$DATA_DIR"
  if [ "$changed" -eq 1 ]; then
    step "write $PLIST_PATH (mode 644)" write_plist
  else
    note "plist is already up to date"
  fi
  if [ -f "$CONFIG_EXITS_FILE" ]; then step "clear the configuration-exit stop ($CONFIG_EXITS_FILE)" clear_config_exits; fi
  if [ "$loaded" -eq 1 ] && [ "$changed" -eq 1 ]; then
    step "unload the running agent: launchctl bootout $SERVICE (SIGTERM, up to 90 s)" bootout_service
    step "load the agent: launchctl bootstrap $DOMAIN $PLIST_PATH" "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST_PATH"
  elif [ "$loaded" -eq 0 ]; then
    step "load the agent: launchctl bootstrap $DOMAIN $PLIST_PATH" "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST_PATH"
  else
    note "agent is already loaded with this plist: no reload"
  fi
  [ "$MODE" = apply ] && echo "installed: $SERVICE" || echo "dry-run: nothing was changed"
}

cmd_uninstall() {
  local acted=0
  if is_loaded; then
    step "unload the agent: launchctl bootout $SERVICE (SIGTERM, up to 90 s)" bootout_service
    acted=1
  fi
  if [ -f "$PLIST_PATH" ]; then
    step "remove $PLIST_PATH" rm -f "$PLIST_PATH"
    acted=1
  fi
  [ "$acted" -eq 1 ] || note "not installed: nothing to do"
  note "kept: $DATA_DIR (database, launcher state) and $LOG_DIR"
  [ "$MODE" = apply ] && echo "uninstalled: $SERVICE" || echo "dry-run: nothing was changed"
}

cmd_restart() {
  if [ -f "$CONFIG_EXITS_FILE" ]; then step "clear the configuration-exit stop ($CONFIG_EXITS_FILE)" clear_config_exits; fi
  if is_loaded; then
    step "restart the agent: launchctl kickstart -k $SERVICE" "$LAUNCHCTL" kickstart -k "$SERVICE"
  elif [ -f "$PLIST_PATH" ]; then
    step "load the agent: launchctl bootstrap $DOMAIN $PLIST_PATH" "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST_PATH"
  else
    fail "not installed: run 'quokyctl.sh install --dry-run' first"
  fi
  [ "$MODE" = apply ] && echo "restarted: $SERVICE" || echo "dry-run: nothing was changed"
}

cmd_status() {
  echo "service: $SERVICE"
  if [ -f "$PLIST_PATH" ]; then echo "plist:   $PLIST_PATH (present)"; else echo "plist:   $PLIST_PATH (absent)"; fi
  if is_loaded; then
    echo "launchd: loaded"
    "$LAUNCHCTL" print "$SERVICE" 2>/dev/null | grep -E '^[[:space:]]*(state|pid|last exit code|runs) = ' | sed 's/^[[:space:]]*/  /'
  else
    echo "launchd: not loaded"
  fi
  local exits=0
  if [ -f "$CONFIG_EXITS_FILE" ]; then exits=$(head -n 1 "$CONFIG_EXITS_FILE" 2>/dev/null); fi
  echo "configuration exits in a row: ${exits:-0} (the launcher stops relaunching at 3; 'restart --apply' clears it)"
  # ADR-0102 D4: the lock is a directory of generations; the highest one is the current state (held or released).
  local lock_dir="$DATA_DIR/quoky.db.lock" latest=""
  if [ -d "$lock_dir" ]; then
    latest=$(ls "$lock_dir" 2>/dev/null | grep -E '^gen-[0-9]+$' | sed 's/^gen-//' | sort -n | tail -n 1)
  fi
  if [ -n "$latest" ]; then
    echo "instance lock: $lock_dir/gen-$latest $(tr -d '\n' < "$lock_dir/gen-$latest" 2>/dev/null | head -c 300)"
  else
    echo "instance lock: none"
  fi
  echo "logs:    $LOG_DIR/quoky.log"
}

# The on-demand backup tool, in the service's own environment shape: built from nothing (env -i), the launcher's DB and
# vector paths, and only the env file's path (the tool reads just the backup-related names from it).
run_backup_tool() {
  /usr/bin/env -i \
    "HOME=$HOME" \
    "PATH=$SYSTEM_PATH" \
    "LANG=en_US.UTF-8" \
    "QUOKY_ENV_FILE=$ENV_FILE" \
    "QUOKY_DB_PATH=$DATA_DIR/quoky.db" \
    "QUOKY_VECTOR_PATH=$DATA_DIR/vectors" \
    "QUOKY_LAUNCHER=launchd" \
    "$NODE_BIN" "$BACKUP_TOOL" "$@"
}

cmd_backup() {
  local reason state="not loaded"
  resolve_node
  [ -f "$BACKUP_TOOL" ] || fail "backup refused: the app is not built ($BACKUP_TOOL missing); run 'pnpm build' first"
  if ! reason=$(quoky_check_private_env_file "$ENV_FILE"); then
    fail "backup refused: $reason: $(quoky_env_file_hint "$reason")"
  fi
  if [ -n "$VERIFY" ]; then
    # A restore drill must work with no live database (disaster recovery): no source-DB check on this branch.
    case "$VERIFY" in
      quoky-*Z-daily.db | quoky-*Z-pre-migration.db | quoky-*Z-manual.db) ;;
      *) fail "--verify takes a copy name such as quoky-20261007T190000Z-daily.db" ;;
    esac
    run_backup_tool --verify "$VERIFY"
    exit $?
  fi
  [ -f "$DATA_DIR/quoky.db" ] || fail "backup refused: no service database at $DATA_DIR/quoky.db; nothing to back up"
  is_loaded && state="loaded"
  echo "service: $SERVICE ($state); no restart: the copy only reads the database and the vector store"
  if [ "$MODE" = apply ]; then
    echo "apply: take a manual backup (verified DB copy + vector snapshot)"
    run_backup_tool --apply
    local rc=$?
    [ "$rc" -eq 0 ] || fail "backup did not fully verify (exit $rc, see above); the service was not touched"
    echo "backed up: see backups/backup-status.json (lastManual)"
  else
    run_backup_tool --dry-run || fail "backup dry-run failed (see above); nothing was changed"
    echo "dry-run: nothing was changed (run 'quokyctl.sh backup --apply' to take the copy)"
  fi
}

case "$COMMAND" in
  backup) cmd_backup ;;
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  render) cmd_render ;;
esac
