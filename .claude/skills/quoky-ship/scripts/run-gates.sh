#!/bin/bash
# run-gates.sh — the Quoky D12 / S2 model-in-the-loop eval gate runner (quoky-ship §2.5).
#
#   run-gates.sh start  <worktree> <name> [modes...]   build, plan digest + run per mode, detached in tmux "gates-<name>"
#   run-gates.sh run    <worktree> <name> [modes...]   the same in the foreground (what the tmux session executes)
#   run-gates.sh status [<name>]                       summary of an archive (no name: the 10 most recent archives)
#
# Modes: intent action read-regression r2 help-scope (eval:nl), agent-plan (eval:agent-plan), r2-redteam (eval:r2-redteam).
# Default modes: action read-regression r2 (help-scope, the D4 classifier gate, is run on request).
#
# Archive: ~/Library/Application Support/Quoky/eval-archive/<name>/ holds head.txt, build.log, usage.log, run.log,
# digests.txt, <mode>.plan.log, <mode>.log, <mode>.report.json (copied from the worktree's data/eval), RUNNING while it
# runs and DONE at the end (one "<mode> exit=<n> status=<word>" line per mode, then the finish time).
#
# Usage pre-check: before the build and before every mode, `npx ccusage@<pinned> blocks --active --json` (20 s timeout);
# when the active block's cost is >= GATES_USAGE_PCT (95) % of QUOKY_USAGE_LIMIT_USD (218, the calibrated 5 h limit, with
# the pinned ccusage version) it waits until the block ends.
# INVALID (exit 5: the provider was unavailable, e.g. a usage/session limit mid-run): ONE automatic retry PER MODE after
# the current usage block resets (GATES_NO_RETRY=1 disables it); a second INVALID of the same mode stops the whole run.
# An INVALID whose reason (or whose canary failure) is provider-auth_required or timeout-streak is not a usage limit: no wait, no retry, the run
# stops at once and prints the reason.
# A killed run (TERM / INT / HUP) writes a terminal DONE marker; `status` also checks that the RUNNING pid is alive.
#
# Quota guards (2026-11-04, after one sonnet planner eval took the shared 5 h window from 0 % to 81 % in 12 min):
#  1. Pre-start estimate. After the build, every requested mode is planned (no model call). Its call cap is read from the plan
#     output ("model calls this plan authorises: at most N", or "real summarisation calls ...: at most N"; else the plan JSON's
#     `"caseIds": "<n> cases"` x `"runs"`, which is the guard's maxCalls). No parseable cap = unknown = BLOCK. est % of the 5 h
#     window = calls x a per-call rate per model (sonnet 0.06 measured; haiku 0.03 and opus 0.15 are PLACEHOLDERS; an unknown
#     model has no rate and blocks unless GATES_RATE_PCT_PER_CALL or GATES_OWNER_OK is set). Written to <archive>/estimate.txt and shown by `status`. The run is refused (DONE, exit 2, no
#     run) when the sum over the modes exceeds GATES_MAX_EST_PCT (30), or current 5 h usage + estimate exceeds GATES_USAGE_PCT
#     (95), or any cap is unknown, or the model is unknown, or the current usage is unknown (ccusage failed at start),
#     unless GATES_OWNER_OK=<yyyymmdd-short-reason> is set (recorded verbatim in estimate.txt). An invalid numeric setting
#     (rates, GATES_MAX_EST_PCT, GATES_STOP_PCT, GATES_USAGE_PCT, GATES_WATCH_SEC, GATES_STOP_GRACE_SEC) always blocks, owner-ok or not.
#  2. In-run brake. While a mode runs, a watchdog polls ccusage every GATES_WATCH_SEC (60) s with the same pinned command and
#     limit. At >= GATES_STOP_PCT (85) % of the limit it TERMs the eval's own process group, only after verifying it (still has members, not our own / tmux's group, leader
#     start time matches the recorded one; never a bare PID), then KILLs the group by pgid after GATES_STOP_GRACE_SEC,
#     15), writes `<mode> exit=6 status=USAGE-STOP pct=<n>` into DONE, never retries and runs no further mode. The partial
#     report is neither PASSED nor FAILED. ccusage failures are tolerated: the poll interval backs off (x2, max 300 s), the
#     last known value is kept, nothing is stopped for an unreadable meter (the failure count is logged to usage.log).
#
# Environment: GATES_MODEL (haiku), GATES_RUNS (3), GATES_CONCURRENCY (4), GATES_REDTEAM_MODEL (unset: the Claude CLI
# default summariser), GATES_HELP_SCOPE_MODEL (unset: the classifier's production stronger tier), QUOKY_USAGE_LIMIT_USD (218), GATES_USAGE_PCT (95), GATES_RETRY_WAIT_SEC (900, used when no
# active usage block is reported), GATES_RESET_MARGIN_SEC (60, slack after a block end), GATES_NO_RETRY,
# QUOKY_EVAL_ARCHIVE (archive root), GATES_MAX_EST_PCT (30), GATES_OWNER_OK, GATES_RATE_PCT_PER_CALL (overrides every rate) /
# GATES_RATE_PCT_HAIKU / _SONNET / _OPUS, GATES_STOP_PCT (85), GATES_WATCH_SEC (60), GATES_STOP_GRACE_SEC (15).
#
# Exit status of `run` (foreground; start's tmux window shows it): 0 all modes PASSED/NON-GATING, 1 any FAILED, 2 any
# blocked/usage/skipped mode, a build failure or a refused estimate, 5 only INVALID remained, 6 USAGE-STOP (the in-run brake
# stopped a mode). Precedence 1 > 6 > 2 > 5.
# Exit statuses of the eval CLIs: 0 PASSED, 1 FAILED, 2 USAGE, 3 BLOCKED, 4 NON-GATING, 5 INVALID.
set -u

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
# GATES_PATH_PREFIX: tests only (stub pnpm / npx ahead of the real ones).
export PATH="${GATES_PATH_PREFIX:+$GATES_PATH_PREFIX:}/opt/homebrew/bin:/usr/local/bin:$PATH"
# The ccusage version the $218 limit was calibrated with (pinned: an unpinned npx would run whatever is newest).
CCUSAGE_VERSION="${GATES_CCUSAGE_VERSION:-20.0.37}"
CCUSAGE_TIMEOUT_SEC=20
ARCHIVE_ROOT="${QUOKY_EVAL_ARCHIVE:-$HOME/Library/Application Support/Quoky/eval-archive}"
LIMIT_USD="${QUOKY_USAGE_LIMIT_USD:-218}"
USAGE_PCT="${GATES_USAGE_PCT:-95}"
MODEL="${GATES_MODEL:-haiku}"
RUNS="${GATES_RUNS:-3}"
CONC="${GATES_CONCURRENCY:-4}"
RETRY_WAIT_SEC="${GATES_RETRY_WAIT_SEC:-900}"
MARGIN="${GATES_RESET_MARGIN_SEC:-60}"
DEFAULT_MODES="action read-regression r2"
EXIT_INVALID=5
EXIT_USAGE_STOP=6
MAX_EST_PCT="${GATES_MAX_EST_PCT:-30}"
STOP_PCT="${GATES_STOP_PCT:-85}"
WATCH_SEC="${GATES_WATCH_SEC:-60}"
STOP_GRACE_SEC="${GATES_STOP_GRACE_SEC:-15}"
# Per-call cost in % of the 5 h window. sonnet: measured 2026-11-03 (~1,300 calls = 81 %). haiku / opus: PLACEHOLDERS, not
# measured; replace them when measured.
RATE_SONNET="${GATES_RATE_PCT_SONNET:-0.06}"
RATE_HAIKU="${GATES_RATE_PCT_HAIKU:-0.03}"
RATE_OPUS="${GATES_RATE_PCT_OPUS:-0.15}"
CHILD_PID=""
CHILD_PGID=""
CHILD_LSTART=""
WATCH_PID=""
ALL_MODES="intent action read-regression r2 help-scope agent-plan r2-redteam"

usage() {
  sed -n '2,8p' "$SELF" | sed 's/^# \{0,1\}//'
  exit 2
}

status_word() {
  case "$1" in
    0) echo PASSED ;; 1) echo FAILED ;; 2) echo USAGE ;; 3) echo BLOCKED ;; 4) echo NON-GATING ;; 5) echo INVALID ;;
    *) echo ERROR ;;
  esac
}

session_name() { printf 'gates-%s' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '-')"; }

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$A/run.log"; }

# Run a command with a time limit: `timeout` / `gtimeout` when present (macOS has neither by default), else a background kill.
with_timeout() {
  local secs=$1; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"; return $?; fi
  "$@" &
  local pid=$! rc
  ( sleep "$secs"; kill "$pid" 2>/dev/null; sleep 2; kill -9 "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  local killer=$!
  wait "$pid"; rc=$?
  kill "$killer" 2>/dev/null; wait "$killer" 2>/dev/null
  return "$rc"
}

# "<cost USD> <block end epoch>" of the active ccusage block, or nothing when ccusage reports none or is unavailable.
# With USAGE_IDLE_AS_ZERO=1 (the pre-start estimate only): a valid ccusage answer with no active block is an idle window,
# printed as "0.00 0"; only a failed / unparseable ccusage stays empty (unknown, fail-closed).
usage_state() {
  (mkdir -p "$ARCHIVE_ROOT" && cd "$ARCHIVE_ROOT" && with_timeout "$CCUSAGE_TIMEOUT_SEC" npx -y "ccusage@$CCUSAGE_VERSION" blocks --active --json 2>/dev/null) | python3 -c '
import json, sys, datetime
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for block in data.get("blocks", []):
    if block.get("isActive") and not block.get("isGap"):
        end = datetime.datetime.fromisoformat(block["endTime"].replace("Z", "+00:00")).timestamp()
        print("%.2f %d" % (block.get("costUSD", 0), int(end)))
        break
else:
    if isinstance(data, dict) and isinstance(data.get("blocks"), list) and sys.argv[1] == "1":
        print("0.00 0")
' "${USAGE_IDLE_AS_ZERO:-0}"
}

# Wait while the active usage block is at or above the threshold.
wait_for_usage() {
  local state cost end threshold now
  threshold=$(python3 -c "import sys; print('%.2f' % (float(sys.argv[1]) * float(sys.argv[2]) / 100))" "$LIMIT_USD" "$USAGE_PCT")
  while :; do
    state=$(usage_state)
    if [ -z "$state" ]; then
      log "usage check: no active block reported (or ccusage unavailable); continuing"
      return 0
    fi
    cost=${state% *}; end=${state#* }
    if python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) < float(sys.argv[2]) else 1)" "$cost" "$threshold"; then
      log "usage check: block cost \$$cost < \$$threshold ($USAGE_PCT% of \$$LIMIT_USD); continuing"
      echo "$(date '+%F %T') ok cost=$cost threshold=$threshold" >> "$A/usage.log"
      return 0
    fi
    now=$(date +%s)
    log "usage check: block cost \$$cost >= \$$threshold; waiting until the block ends ($(date -r "$end" '+%T'))"
    echo "$(date '+%F %T') wait cost=$cost threshold=$threshold until=$end" >> "$A/usage.log"
    sleep $(( end > now ? end - now + MARGIN : MARGIN ))
  done
}

# Before an INVALID retry: wait until the current usage block resets (the CLI's limit window), else a fixed wait.
wait_block_reset() {
  local state end now
  state=$(usage_state)
  now=$(date +%s)
  if [ -n "$state" ]; then
    end=${state#* }
    log "INVALID retry: waiting for the usage block to reset at $(date -r "$end" '+%T')"
    sleep $(( end > now ? end - now + 2 * MARGIN : 2 * MARGIN ))
  else
    log "INVALID retry: no active usage block reported; waiting ${RETRY_WAIT_SEC}s"
    sleep "$RETRY_WAIT_SEC"
  fi
}

cli_of() {
  case "$1" in
    intent|action|read-regression|r2|help-scope) echo eval:nl ;;
    agent-plan) echo eval:agent-plan ;;
    r2-redteam) echo eval:r2-redteam ;;
    *) return 1 ;;
  esac
}

# The options shared by the plan and the run (the digest binds them, so both must be identical).
common_args() {
  case "$1" in
    r2-redteam) printf -- '--runs %s' "$RUNS"; [ -n "${GATES_REDTEAM_MODEL:-}" ] && printf -- ' --model %s' "$GATES_REDTEAM_MODEL" ;;
    # help-scope: --model / --effort override the classifier's STRONGER tier, so GATES_MODEL (the selector's haiku) must
    # not reach it; the gate measures the production default (sonnet / low) unless GATES_HELP_SCOPE_MODEL is set.
    help-scope) printf -- '--runs %s --concurrency %s' "$RUNS" "$CONC"; [ -n "${GATES_HELP_SCOPE_MODEL:-}" ] && printf -- ' --model %s' "$GATES_HELP_SCOPE_MODEL" ;;
    *) printf -- '--model %s --runs %s --concurrency %s' "$MODEL" "$RUNS" "$CONC" ;;
  esac
  return 0
}
plan_mode() { case "$1" in intent|agent-plan|r2-redteam) echo plan ;; *) echo "$1" ;; esac; }
run_mode_name() { case "$1" in intent|agent-plan|r2-redteam) echo run ;; *) echo "$1" ;; esac; }

# --- Quota guards -----------------------------------------------------------------------------------------------------------

# Process-group identity. A PID / PGID number alone proves nothing (reuse), so a group is signalled only after it is verified:
# it still has at least one member (POSIX: a pgid is never reused while its group exists), it is not this script's own group
# nor the tmux server's, and, while its leader is alive, the leader's start time (lstart) equals the one recorded at launch.
# Signals go to the group only (`kill -- -PGID`); there is NO fallback to signalling a bare PID.
lstart_of() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//; s/  */ /g'; }
pgid_of() { ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '; }
group_has_members() { ps -axo pgid= 2>/dev/null | awk -v g="$1" '$1 == g { f = 1 } END { exit !f }'; }

# 0 verified, 2 the group no longer exists (nothing to signal), 1 refused (logged).
group_verified() {
  local pgid=$1 want=$2 tpid="" snap verdict
  case "$pgid" in ''|*[!0-9]*) log "group signal refused: no valid pgid recorded"; return 1 ;; esac
  [ "$pgid" -gt 1 ] || { log "group signal refused: pgid $pgid"; return 1; }
  [ -z "${TMUX:-}" ] || tpid=$(printf '%s' "$TMUX" | cut -d, -f2)
  case "$tpid" in *[!0-9]*) tpid="" ;; esac
  if [ -n "${TMUX:-}" ] && [ -z "$tpid" ]; then log "group signal refused: TMUX is set but its server pid is unreadable"; return 1; fi
  # One consistent process snapshot decides (no separate lookups that can disagree or fail silently):
  # ps failing or printing nothing -> refused; no member with this pgid -> 2 (nothing to signal); a live process with the
  # leader's pid inside this group must carry the recorded start time (unreadable/empty/different -> refused). The holder
  # leader outlives every member (exec_one), so members without a leader cannot be proven ours -> refused.
  snap=$(ps -axo pid=,pgid=,lstart= 2>/dev/null) || { log "group signal refused: process snapshot failed"; return 1; }
  [ -n "$snap" ] || { log "group signal refused: empty process snapshot"; return 1; }
  # The script's own group and the tmux server's group are read from the same snapshot; unreadable -> refused.
  verdict=$(printf '%s\n' "$snap" | awk -v g="$pgid" -v want="$want" -v me="$$" -v tp="$tpid" '
    { pid = $1; grp = $2; $1 = ""; $2 = ""; sub(/^ +/, ""); gsub(/ +/, " "); ls = $0
      if (pid !~ /^[0-9]+$/ || grp !~ /^[0-9]+$/) { bad = 1; next }
      if (grp == g) members++
      if (pid == g && grp == g) { leader = 1; lstart = ls }
      if (pid == me) owngrp = grp
      if (tp != "" && pid == tp) tgrp = grp }
    END {
      if (bad) { print "refuse unparseable snapshot line"; exit }
      if (owngrp == "") { print "refuse own process group unreadable"; exit }
      if (g == owngrp) { print "refuse pgid is this script own group"; exit }
      if (tp != "" && tgrp == "") { print "refuse tmux server pid not in the snapshot"; exit }
      if (tp != "" && (g == tp || g == tgrp)) { print "refuse pgid is the tmux server group"; exit }
      if (members == 0) { print "gone"; exit }
      if (!leader) { print "refuse group has members but its holder leader is gone (identity unprovable)"; exit }
      if (leader && (lstart == "" || want == "" || lstart != want)) { print "refuse leader start time [" lstart "] != recorded [" want "] (pid reuse?)"; exit }
      print "ok" }')
  case "$verdict" in
    ok) return 0 ;;
    gone) return 2 ;;
    *) log "group signal refused: ${verdict#refuse }"; return 1 ;;
  esac
}

# Terminate a verified process group by membership: TERM, wait up to STOP_GRACE_SEC while members remain, then KILL the group.
kill_group() {
  local pgid=$1 want=$2 i=0 rc
  [ -n "$pgid" ] || return 0
  group_verified "$pgid" "$want"; rc=$?
  [ "$rc" -eq 0 ] || return 0
  kill -TERM -- "-$pgid" 2>/dev/null
  while [ "$i" -lt "$STOP_GRACE_SEC" ] && group_has_members "$pgid"; do sleep 1; i=$((i + 1)); done
  if group_has_members "$pgid"; then
    group_verified "$pgid" "$want"; rc=$?
    if [ "$rc" -eq 0 ]; then kill -KILL -- "-$pgid" 2>/dev/null; log "process group $pgid still alive after ${STOP_GRACE_SEC}s: KILL"; fi
  fi
  return 0
}

# Background watchdog for one running eval child. Polls ccusage; at >= STOP_PCT % of the limit it writes $A/USAGE-STOP and stops
# the child's process group. Exits by itself when the child is gone.
start_watch() {
  local pid=$1 pgid=$2 want=$3 m=$4
  (
    trap - EXIT TERM INT HUP
    waited=0; fails=0; interval=$WATCH_SEC
    while kill -0 "$pid" 2>/dev/null; do
      sleep 1; waited=$((waited + 1))
      [ "$waited" -ge "$interval" ] || continue
      waited=0
      state=$(usage_state)
      if [ -z "$state" ]; then
        fails=$((fails + 1))
        interval=$(( WATCH_SEC * (1 << (fails < 3 ? fails : 3)) )); [ "$interval" -gt 300 ] && interval=300
        echo "$(date '+%F %T') watch $m ccusage-unreadable consecutive=$fails next-poll=${interval}s (keeping the last known value; not stopping)" >> "$A/usage.log"
        continue
      fi
      fails=0; interval=$WATCH_SEC
      cost=${state% *}
      pct=$(awk -v c="$cost" -v l="$LIMIT_USD" 'BEGIN { printf "%.1f", c * 100 / l }')
      echo "$(date '+%F %T') watch $m cost=$cost pct=$pct stop-at=$STOP_PCT" >> "$A/usage.log"
      if awk -v p="$pct" -v s="$STOP_PCT" 'BEGIN { exit !(p + 0 >= s + 0) }'; then
        if kill -0 "$pid" 2>/dev/null; then
          echo "$pct" > "$A/USAGE-STOP"
          log "$m: USAGE-STOP at $pct% of the 5 h limit (stop threshold $STOP_PCT%): stopping the eval process group $pgid"
          kill_group "$pgid" "$want"
        fi
        exit 0
      fi
    done
  ) &
  WATCH_PID=$!
}

stop_watch() {
  [ -n "$WATCH_PID" ] || return 0
  kill "$WATCH_PID" 2>/dev/null
  wait "$WATCH_PID" 2>/dev/null
  WATCH_PID=""
  return 0
}

# "<calls> <source> <model>" read from a plan log; nothing when no cap can be read (= unknown).
parse_plan() {
  python3 - "$1" "$2" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
env_model = sys.argv[2]
model = env_model
m = re.search(r'"model"\s*:\s*"([^"]+)"', text)
if m:
    model = m.group(1)
caps = [int(x.replace(",", "")) for x in re.findall(r"calls this plan authorises: at most (\d[\d,]*)", text)]
if caps:
    print("%d authorises-line %s" % (max(caps), model))
    sys.exit(0)
cases = re.search(r'"caseIds"\s*:\s*"(\d+) cases', text)
runs = re.search(r'"runs"\s*:\s*(\d+)', text)
if cases and runs:
    print("%d cases-x-runs %s" % (int(cases.group(1)) * int(runs.group(1)), model))
PY
}

mode_env_model() {
  case "$1" in
    r2-redteam) echo "${GATES_REDTEAM_MODEL:-sonnet}" ;;
    help-scope) echo "${GATES_HELP_SCOPE_MODEL:-sonnet}" ;;
    *) echo "$MODEL" ;;
  esac
}

# Per-call rate (% of the 5 h window) for a model name. An unknown / unparseable model has NO rate (prints UNKNOWN, returns 1)
# unless GATES_RATE_PCT_PER_CALL is set: the estimate guard blocks it (owner-ok may allow it).
rate_for() {
  if [ -n "${GATES_RATE_PCT_PER_CALL:-}" ]; then echo "$GATES_RATE_PCT_PER_CALL"; return 0; fi
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
    *haiku*) echo "$RATE_HAIKU" ;;
    *sonnet*) echo "$RATE_SONNET" ;;
    *opus*) echo "$RATE_OPUS" ;;
    *) echo UNKNOWN; return 1 ;;
  esac
}

# Numeric validation (fail-closed). pos_decimal: > 0; pct: 0 < x <= 100; pos_int: integer > 0. Echo nothing, return 0 when valid.
is_pos_decimal() { [[ "$1" =~ ^[0-9]+(\.[0-9]+)?$ ]] && awk -v v="$1" 'BEGIN { exit !(v + 0 > 0) }'; }
is_pct() { is_pos_decimal "$1" && awk -v v="$1" 'BEGIN { exit !(v + 0 <= 100) }'; }
is_pos_int() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }          # no leading zero: bash 3.2 arithmetic reads 08 as bad octal
is_nonneg_int() { [[ "$1" =~ ^(0|[1-9][0-9]*)$ ]]; }

# Space-separated "NAME=value (what is wrong)" for every invalid numeric setting; empty when all are valid.
config_problems() {
  local out="" v
  chk() { # kind name value
    [ -n "$3" ] || { out="$out $2 is empty;"; return; }
    "is_$1" "$3" || out="$out $2='$3' is not a valid $1;"
  }
  [ -z "${GATES_RATE_PCT_PER_CALL+x}" ] || chk pos_decimal GATES_RATE_PCT_PER_CALL "$GATES_RATE_PCT_PER_CALL"
  chk pos_decimal GATES_RATE_PCT_SONNET "$RATE_SONNET"
  chk pos_decimal GATES_RATE_PCT_HAIKU "$RATE_HAIKU"
  chk pos_decimal GATES_RATE_PCT_OPUS "$RATE_OPUS"
  chk pos_decimal GATES_MAX_EST_PCT "$MAX_EST_PCT"
  chk pct GATES_STOP_PCT "$STOP_PCT"
  chk pct GATES_USAGE_PCT "$USAGE_PCT"
  chk pos_decimal QUOKY_USAGE_LIMIT_USD "$LIMIT_USD"
  chk pos_int GATES_WATCH_SEC "$WATCH_SEC"
  chk pos_int GATES_STOP_GRACE_SEC "$STOP_GRACE_SEC"
  chk pos_int GATES_RUNS "$RUNS"
  chk pos_int GATES_CONCURRENCY "$CONC"
  chk pos_int GATES_RETRY_WAIT_SEC "$RETRY_WAIT_SEC"
  chk nonneg_int GATES_RESET_MARGIN_SEC "$MARGIN"
  printf '%s' "$out"
}

# Estimate every planned mode, write estimate.txt, refuse (return 1) when over a limit without a valid GATES_OWNER_OK.
estimate_guard() {
  local m parsed calls src model rate pct total=0 unknown="" unkmodel="" reasons="" state cost cur="unknown" ok="none" verdict
  local f="$A/estimate.txt"
  { echo "estimate $(date '+%F %T')  (per-call rates in % of the 5 h window: sonnet $RATE_SONNET measured; haiku $RATE_HAIKU and opus $RATE_OPUS are PLACEHOLDERS)"; } > "$f"
  for m in "$@"; do
    parsed=$(parse_plan "$A/$m.plan.log" "$(mode_env_model "$m")")
    if [ -z "$parsed" ]; then
      unknown="$unknown $m"
      echo "mode=$m calls=UNKNOWN (no call cap in $m.plan.log)" >> "$f"
      continue
    fi
    calls=${parsed%% *}; src=$(echo "$parsed" | awk '{print $2}'); model=$(echo "$parsed" | awk '{print $3}')
    rate=$(rate_for "$model") || { unkmodel="$unkmodel $m($model)"; rate=$RATE_OPUS; echo "mode=$m model=$model has no known rate (UNKNOWN MODEL); the opus rate is shown only to size the estimate" >> "$f"; }
    pct=$(awk -v c="$calls" -v r="$rate" 'BEGIN { printf "%.1f", c * r }')
    total=$(awk -v a="$total" -v b="$pct" 'BEGIN { printf "%.1f", a + b }')
    echo "mode=$m model=$model calls=$calls rate_pct_per_call=$rate est_pct_5h=$pct cap_source=$src" >> "$f"
  done
  state=$(USAGE_IDLE_AS_ZERO=1 usage_state)
  if [ -n "$state" ]; then
    cost=${state% *}
    cur=$(awk -v c="$cost" -v l="$LIMIT_USD" 'BEGIN { printf "%.1f", c * 100 / l }')
  fi
  [ -n "$state" ] || echo "current usage UNKNOWN: ccusage failed or its output was unreadable (fail-closed)" >> "$f"
  echo "total_est_pct_5h=$total current_5h_usage_pct=$cur max_est_pct=$MAX_EST_PCT pause_pct=$USAGE_PCT" >> "$f"
  [ -z "$unknown" ] || reasons="$reasons call cap unknown for:$unknown;"
  [ -z "$unkmodel" ] || reasons="$reasons unknown model (no rate; set GATES_RATE_PCT_PER_CALL) for:$unkmodel;"
  awk -v t="$total" -v m="$MAX_EST_PCT" 'BEGIN { exit !(t + 0 > m + 0) }' && reasons="$reasons estimate $total% > GATES_MAX_EST_PCT $MAX_EST_PCT%;"
  if [ "$cur" != unknown ]; then
    awk -v t="$total" -v c="$cur" -v p="$USAGE_PCT" 'BEGIN { exit !(t + c > p + 0) }' && reasons="$reasons current $cur% + estimate $total% > $USAGE_PCT%;"
  else
    reasons="$reasons current usage unknown (ccusage failed or unreadable);"
  fi
  if [ -z "$reasons" ]; then
    echo "owner_ok=$( [ -n "${GATES_OWNER_OK:-}" ] && printf '%s' "$GATES_OWNER_OK" || echo none)" >> "$f"
    echo "verdict=OK" >> "$f"
    log "estimate: total $total% of the 5 h window (current $cur%): within limits (estimate.txt)"
    return 0
  fi
  if [[ "${GATES_OWNER_OK:-}" =~ ^[0-9]{8}-.+ ]]; then
    ok=$GATES_OWNER_OK
    echo "owner_ok=$ok" >> "$f"
    echo "verdict=ALLOWED-BY-OWNER-OK ($reasons)" >> "$f"
    log "estimate: total $total% (current $cur%) over a limit ($reasons) but GATES_OWNER_OK=$ok; continuing"
    return 0
  fi
  echo "owner_ok=none${GATES_OWNER_OK:+ (GATES_OWNER_OK is set but not in the form yyyymmdd-short-reason: ignored)}" >> "$f"
  echo "verdict=BLOCKED ($reasons)" >> "$f"
  log "estimate: BLOCKED ($reasons) total $total%, current $cur%. Ask the owner (purpose, calls, model, est % of 5 h/7d, current usage, a cheaper compromise); with a yes set GATES_OWNER_OK=<yyyymmdd-short-reason>. See estimate.txt"
  return 1
}

# Plan one mode (a digest, no model call); 0 when the digest was read.
plan_one() {
  local m=$1 cli digest
  cli=$(cli_of "$m")
  # shellcheck disable=SC2046
  pnpm -s "$cli" -- --mode "$(plan_mode "$m")" $(common_args "$m") > "$A/$m.plan.log" 2>&1
  digest=$(grep 'plan digest' "$A/$m.plan.log" | awk '{print $NF}' | tail -1)
  if [ -z "$digest" ]; then
    log "$m: no plan digest (see $m.plan.log)"
    return 2
  fi
  echo "$digest" > "$A/$m.digest"
  echo "$m $digest" >> "$A/digests.txt"
  return 0
}

# Run one planned mode with the stored digest under the watchdog; returns the eval's exit status, or 6 on USAGE-STOP.
exec_one() {
  local m=$1 cli digest rc report pid pgid lstart pct
  cli=$(cli_of "$m")
  digest=$(cat "$A/$m.digest")
  rm -f "$A/USAGE-STOP"
  log "$m: running ($cli, digest ${digest:0:12})"
  set -m
  # The group leader is a small holder shell that outlives the eval and every descendant still in its group (it leaves
  # only when no other member remains, or when the group is KILLed). So whenever the group has members, its leader is
  # alive and its recorded start time proves the group's identity; "members but no leader" is refused (group_verified).
  # TERM is caught by the holder only (the eval gets the default action) so it keeps holding while descendants exit.
  # shellcheck disable=SC2046
  bash -c '
    trap ":" TERM INT HUP
    "$@" & c=$!
    while :; do wait "$c"; rc=$?; kill -0 "$c" 2>/dev/null || break; done
    if [ "$rc" -gt 128 ]; then wait "$c" 2>/dev/null; r2=$?; [ "$r2" -eq 127 ] || rc=$r2; fi
    # Release only on a valid snapshot that shows no other member; a failed/empty snapshot keeps holding (bounded:
    # after 60 consecutive failures the holder leaves and the leftover, if any, is refused and logged, never guessed).
    n=0
    while :; do
      snap=$(exec ps -axo pid=,ppid=,pgid= 2>/dev/null) || snap=""   # exec: ps is a direct child of the holder, excluded
      if [ -z "$snap" ]; then n=$((n + 1)); [ "$n" -ge 60 ] && break; sleep 1; continue; fi
      n=0
      printf "%s\n" "$snap" | awk -v me="$$" "\$3 == me && \$1 != me && \$2 != me { f = 1 } END { exit !f }" || break
      sleep 1
    done
    exit "$rc"
  ' gates-holder pnpm -s "$cli" -- --mode "$(run_mode_name "$m")" $(common_args "$m") --approved-plan-digest "$digest" > "$A/$m.log" 2>&1 &
  pid=$!
  set +m
  pgid=$(pgid_of "$pid"); lstart=$(lstart_of "$pid")
  # Only an own process group (leader = the child, not our group) is ever signalled; otherwise nothing is recorded.
  if [ "$pgid" != "$pid" ] || [ -z "$lstart" ]; then
    log "$m: eval child $pid has no own process group (pgid '${pgid:-?}'): it will not be signalled by the guards"
    pgid=""; lstart=""
  fi
  CHILD_PID=$pid; CHILD_PGID=$pgid; CHILD_LSTART=$lstart
  start_watch "$pid" "$pgid" "$lstart" "$m"
  wait "$pid" 2>/dev/null; rc=$?
  if [ -f "$A/USAGE-STOP" ]; then
    wait "$WATCH_PID" 2>/dev/null; WATCH_PID=""   # let the watchdog finish its TERM / KILL sequence
  fi
  # Leftover descendants of the eval group first (by membership), only then the watchdog.
  [ -z "$pgid" ] || kill_group "$pgid" "$lstart"
  stop_watch
  CHILD_PID=""; CHILD_PGID=""; CHILD_LSTART=""
  if [ -f "$A/USAGE-STOP" ]; then
    pct=$(cat "$A/USAGE-STOP")
    log "$m: USAGE-STOP at $pct%: partial run, neither PASSED nor FAILED; no retry"
    return "$EXIT_USAGE_STOP"
  fi
  report=$(grep -o 'results written to .*' "$A/$m.log" | tail -1 | sed 's/^results written to //')
  if [ -n "$report" ] && [ -f "$report" ]; then cp "$report" "$A/$m.report.json"; fi
  log "$m: exit=$rc $(status_word "$rc") | $(grep -E 'gate.*: (PASSED|FAILED|INVALID|NON-GATING)' "$A/$m.log" | tail -1)"
  return "$rc"
}

# Exit handler: stop the watchdog and the recorded eval child group only, then leave a terminal marker.
on_exit() {
  [ "${BASH_SUBSHELL:-0}" = 0 ] || return 0
  # The eval group is terminated (by pgid membership) BEFORE the watchdog is stopped.
  if [ -n "$CHILD_PGID" ]; then kill_group "$CHILD_PGID" "$CHILD_LSTART"; fi
  CHILD_PID=""; CHILD_PGID=""; CHILD_LSTART=""
  stop_watch
  if [ -f "$A/RUNNING" ]; then { cat "$A/modes.txt" 2>/dev/null; echo "KILLED: the run was terminated before it finished"; date; } > "$A/DONE"; rm -f "$A/RUNNING"; fi
  return 0
}

cmd_run() {
  local W=$1 N=$2; shift 2
  local MODES="${*:-$DEFAULT_MODES}" cfg m rc retried=0 stopped="" reason cfail nodev n_failed=0 n_invalid=0 n_other=0 n_ustop=0 final planned="" ustop_pct
  for m in $MODES; do
    case " $ALL_MODES " in *" $m "*) ;; *) echo "unknown mode: $m (one of: $ALL_MODES)" >&2; exit 2 ;; esac
  done
  cd "$W" || { echo "no worktree $W" >&2; exit 1; }
  # Node version of the worktree (.nvmrc), else whatever node is on the PATH.
  nodev=$(sed 's/^v//' "$W/.nvmrc" 2>/dev/null | head -1)
  if [ -n "$nodev" ] && [ -d "$HOME/.nvm/versions/node/v$nodev/bin" ]; then export PATH="$HOME/.nvm/versions/node/v$nodev/bin:$PATH"; fi
  A="$ARCHIVE_ROOT/$N"
  mkdir -p "$A"
  rm -f "$A/DONE" "$A/digests.txt" "$A/modes.txt" "$A/estimate.txt" "$A/USAGE-STOP" "$A"/*.digest
  # A terminated run (TERM / INT / HUP, or any exit with the RUNNING marker still there) leaves a terminal marker. SIGKILL
  # cannot be trapped: `status` checks that the RUNNING pid is alive.
  trap 'exit 143' TERM INT HUP
  trap on_exit EXIT
  printf 'pid=%s session=%s worktree=%s modes=%s started=%s\n' "$$" "${TMUX_SESSION:-foreground}" "$W" "$MODES" "$(date '+%F %T')" > "$A/RUNNING"
  git -C "$W" log --oneline -1 > "$A/head.txt"
  log "gates $N: worktree $W, head $(cat "$A/head.txt"), modes: $MODES"
  # Invalid numeric settings are a hard block (not bypassable by GATES_OWNER_OK): nothing is built or run.
  cfg=$(config_problems)
  if [ -n "$cfg" ]; then
    echo "estimate $(date '+%F %T')" > "$A/estimate.txt"
    echo "verdict=BLOCKED (invalid configuration:$cfg)" >> "$A/estimate.txt"
    log "BLOCKED: invalid configuration:$cfg"
    for m in $MODES; do echo "$m exit=2 status=BLOCKED-ESTIMATE" >> "$A/modes.txt"; done
    { cat "$A/modes.txt"; echo "stopped: invalid configuration ($cfg); nothing was run"; date; } > "$A/DONE"
    rm -f "$A/RUNNING"
    exit 2
  fi
  wait_for_usage
  if ! pnpm build > "$A/build.log" 2>&1; then
    log "build failed (see build.log)"
    { echo "BUILD_FAIL"; date; } > "$A/DONE"
    rm -f "$A/RUNNING"
    exit 2
  fi
  # Plan every mode first (digests, no model call), then estimate the whole start before any model call.
  for m in $MODES; do
    if plan_one "$m"; then planned="$planned $m"; fi
  done
  if [ -n "$planned" ] && ! estimate_guard $planned; then
    for m in $MODES; do echo "$m exit=2 status=BLOCKED-ESTIMATE" >> "$A/modes.txt"; done
    { cat "$A/modes.txt"; echo "stopped: the pre-start estimate guard refused the run (see estimate.txt); nothing was run"; date; } > "$A/DONE"
    rm -f "$A/RUNNING"
    exit 2
  fi
  for m in $MODES; do
    case " $planned " in
      *" $m "*) ;;
      *) echo "$m exit=2 status=$(status_word 2)" >> "$A/modes.txt"; echo "$m exit=2" >> "$A/digests.txt"; n_other=$((n_other + 1)); continue ;;
    esac
    wait_for_usage
    retried=0
    exec_one "$m"; rc=$?
    reason=""
    if [ "$rc" -eq "$EXIT_INVALID" ]; then
      reason=$(grep -o 'INVALID (provider unavailable: [^)]*)' "$A/$m.log" | tail -1 | sed 's/^INVALID (provider unavailable: //; s/)$//')
    fi
    cfail=""
    if [ "$rc" -eq "$EXIT_INVALID" ]; then cfail=$(grep -o 'canary failed: [A-Za-z_-]*' "$A/$m.log" | tail -1 | sed 's/^canary failed: //'); fi
    case "$reason|$cfail" in
      provider-auth_required\|*|timeout-streak\|*|*\|provider-auth_required)
        # Not a usage/session limit (the run itself or its canary says auth / timeouts): waiting for a block reset will not
        # help. Stop now.
        log "$m: INVALID (${cfail:-$reason}): not a usage limit; no wait, no retry"
        ;;
      *)
        if [ "$rc" -eq "$EXIT_INVALID" ] && [ -z "${GATES_NO_RETRY:-}" ]; then
          retried=1
          mv "$A/$m.log" "$A/$m.invalid-attempt1.log"
          if [ -f "$A/$m.report.json" ]; then mv "$A/$m.report.json" "$A/$m.invalid-attempt1.report.json"; fi
          wait_block_reset
          wait_for_usage
          exec_one "$m"; rc=$?
          reason=$(grep -o 'INVALID (provider unavailable: [^)]*)' "$A/$m.log" | tail -1 | sed 's/^INVALID (provider unavailable: //; s/)$//')
        fi
        ;;
    esac
    if [ "$rc" -eq "$EXIT_USAGE_STOP" ]; then
      ustop_pct=$(cat "$A/USAGE-STOP" 2>/dev/null)
      echo "$m exit=$rc status=USAGE-STOP pct=$ustop_pct" >> "$A/modes.txt"
    else
      echo "$m exit=$rc status=$(status_word "$rc")" >> "$A/modes.txt"
    fi
    echo "$m exit=$rc" >> "$A/digests.txt"
    case "$rc" in
      0|4) ;;
      "$EXIT_USAGE_STOP") n_ustop=$((n_ustop + 1)) ;;
      1) n_failed=$((n_failed + 1)) ;;
      "$EXIT_INVALID") n_invalid=$((n_invalid + 1)) ;;
      *) n_other=$((n_other + 1)) ;;
    esac
    if [ "$rc" -eq "$EXIT_USAGE_STOP" ]; then
      stopped="stopped after $m: USAGE-STOP at ${ustop_pct}% of the 5 h limit (threshold ${STOP_PCT}%); no retry; remaining modes not run; the partial $m report is neither PASSED nor FAILED"
      log "$stopped"
      break
    fi
    if [ "$rc" -eq "$EXIT_INVALID" ]; then
      stopped="stopped after $m: INVALID (provider unavailable: ${reason:-unknown})$([ "$retried" -eq 1 ] && echo ' after the one automatic retry for this mode'); remaining modes not run"
      log "$stopped"
      break
    fi
  done
  { cat "$A/modes.txt"; if [ -n "$stopped" ]; then echo "$stopped"; fi; date; } > "$A/DONE"
  rm -f "$A/RUNNING"
  # Overall exit: 0 every mode PASSED (or NON-GATING); 1 any FAILED; else 6 any USAGE-STOP; else 2 any mode blocked / usage error / skipped (no plan
  # digest) / not run; else 5 when only INVALID remained (a mode left unrun by the INVALID stop does not count). Build failure: 2.
  if [ "$n_failed" -gt 0 ]; then final=1
  elif [ "$n_ustop" -gt 0 ]; then final=$EXIT_USAGE_STOP
  elif [ "$n_other" -gt 0 ]; then final=2
  elif [ "$n_invalid" -gt 0 ]; then final=$EXIT_INVALID
  else final=0; fi
  log "gates $N: done (exit $final: failed $n_failed, usage-stop $n_ustop, blocked/skipped $n_other, invalid $n_invalid)"
  return "$final"
}

cmd_start() {
  [ $# -ge 2 ] || usage
  local W N S
  W=$(cd "$1" && pwd) || exit 1
  N=$2; shift 2
  S=$(session_name "$N")
  if tmux has-session -t "=$S" 2>/dev/null; then
    echo "tmux session $S already exists (tmux attach -t $S)" >&2
    exit 1
  fi
  mkdir -p "$ARCHIVE_ROOT/$N"
  # A running tmux server does not inherit this shell's environment: hand the settings over explicitly.
  local envs="" v
  for v in $(compgen -e | grep -E '^(GATES_[A-Z_]+|QUOKY_USAGE_LIMIT_USD|QUOKY_EVAL_ARCHIVE)$'); do
    envs="$envs $v=$(printf '%q' "${!v}")"
  done
  tmux new-session -d -s "$S" "env TMUX_SESSION='$S'$envs bash '$SELF' run '$W' '$N' $*; echo; echo '[run-gates] finished; this window closes in 1 h'; sleep 3600"
  echo "started tmux session $S"
  echo "  archive: $ARCHIVE_ROOT/$N"
  echo "  watch:   tmux attach -t $S   (detach: C-b d)"
  echo "  status:  bash '$SELF' status '$N'"
}

cmd_status() {
  local n st
  if [ $# -eq 0 ]; then
    ls -1t "$ARCHIVE_ROOT" | grep -v '^scripts$' | head -10 | while read -r n; do
      if [ -f "$ARCHIVE_ROOT/$n/RUNNING" ]; then st=RUNNING
      elif grep -q '^KILLED' "$ARCHIVE_ROOT/$n/DONE" 2>/dev/null; then st="KILLED (terminated before it finished)"
      elif [ -f "$ARCHIVE_ROOT/$n/DONE" ]; then st="DONE $(grep -o 'status=[A-Z-]*' "$ARCHIVE_ROOT/$n/DONE" 2>/dev/null | sed 's/status=//' | sort | uniq -c | awk '{printf "%s %s ", $1, $2}')"
      else st="-"; fi
      printf '%-45s %s\n' "$n" "$st"
    done
    return 0
  fi
  A="$ARCHIVE_ROOT/$1"
  [ -d "$A" ] || { echo "no archive $A" >&2; exit 1; }
  python3 - "$A" <<'PY'
import json, os, re, sys
A = sys.argv[1]
def read(name):
    try:
        with open(os.path.join(A, name), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""
pct = lambda r: "%.1f%%" % (r * 100)
WRONG = {"wrong-capture", "wrong-target", "negative-capture", "action-capture", "wrong"}
WORD = {0: "PASSED", 1: "FAILED", 2: "USAGE", 3: "BLOCKED", 4: "NON-GATING", 5: "INVALID", 6: "USAGE-STOP"}
print("archive: " + A)
head = read("head.txt").strip()
if head:
    print("head:    " + head)
if os.path.exists(os.path.join(A, "RUNNING")):
    running = read("RUNNING").strip()
    pid_match = re.match(r"pid=(\d+)", running)
    alive = True
    if pid_match:
        try:
            os.kill(int(pid_match.group(1)), 0)
        except ProcessLookupError:
            alive = False
        except OSError:
            alive = True
    if alive:
        print("state:   RUNNING  " + running)
    else:
        print("state:   DEAD (the RUNNING marker is there but its pid is gone: the run was killed)  " + running)
elif read("DONE").strip():
    done = read("DONE").strip().splitlines()
    killed = any(line.startswith("KILLED") for line in done)
    print("state:   %s  %s" % ("KILLED" if killed else "DONE", done[-1]))
    for line in done[:-1]:
        if line.startswith("stopped") or line.startswith("KILLED") or line == "BUILD_FAIL":
            print("         " + line)
else:
    print("state:   (no RUNNING / DONE marker)")
estimate = read("estimate.txt").strip()
if estimate:
    print("estimate (pre-start, % of the 5 h window):")
    for line in estimate.splitlines():
        print("   " + line)
exits = {}
words = {}
for line in (read("DONE") + "\n" + read("digests.txt")).splitlines():
    m = re.match(r"^(\S+) exit=(\d+)(?: status=(\S+)(?: pct=([\d.]+))?)?", line)
    if m:
        exits[m.group(1)] = int(m.group(2))
        if m.group(3):
            words[m.group(1)] = (m.group(3), m.group(4))
order = []
for line in read("digests.txt").splitlines():
    parts = line.split()
    if parts and parts[0] not in order:
        order.append(parts[0])
for name in sorted(os.listdir(A)):
    m = re.match(r"^(intent|action|read-regression|r2|help-scope|agent-plan|r2-redteam)\.log$", name)
    if m and m.group(1) not in order:
        order.append(m.group(1))

def load_report(mode, log):
    path = os.path.join(A, mode + ".report.json")
    if not os.path.exists(path):
        found = re.findall(r"results written to (.+)", log)
        path = found[-1].strip() if found else ""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None

def summaries_from_log(log):
    out = []
    for line in log.splitlines():
        m = re.match(r"^run \d+/\d+: (\{.*\})\s*$", line)
        if m:
            try:
                out.append(json.loads(m.group(1)))
            except ValueError:
                pass
    return out

for mode in order:
    log = read(mode + ".log")
    code = exits.get(mode)
    print()
    print("== %s  exit=%s %s" % (mode, "?" if code is None else code, "(running or not recorded)" if code is None else WORD.get(code, "")))
    if words.get(mode, ("", None))[0] == "USAGE-STOP":
        print("   USAGE-STOP at %s%% of the 5 h limit: the run was stopped, this report is PARTIAL (neither PASSED nor FAILED)" % (words[mode][1] or "?"))
        continue
    gate = [l for l in log.splitlines() if re.search(r"gate.*: (PASSED|FAILED|INVALID|NON-GATING)", l)]
    if gate:
        print("   gate: " + gate[-1].strip())
    outcomes = [l for l in log.splitlines() if l.startswith("provider outcomes:")]
    if outcomes:
        print("   " + outcomes[-1].strip())
    report = load_report(mode, log)
    if report and report.get("verdict"):
        print("   verdict: " + report["verdict"])
        continue
    summaries = (report or {}).get("summaries") or summaries_from_log(log)
    if not summaries:
        for l in log.splitlines():
            if re.match(r"^(overall|multi-step exact|exact plans|run \d+/\d+)", l):
                print("   " + l.strip()[:200])
        continue
    low = {}
    for index, s in enumerate(summaries, 1):
        if "groups" in s:
            g = s["groups"]
            line = "run %d: multi-step %s, one-step %s, wrong on negatives %s" % (index, pct(g["multiStep"]["rate"]), pct(g["oneStep"]["rate"]), s.get("wrongOnNegatives", 0))
        elif "perFamily" in s and "total" in s:
            line = "run %d: successful attacks %s, errored cases %s" % (index, s["total"], s.get("errors", 0))
        elif "answers" in s and "nonAnswers" in s:
            line = "run %d: answers %d/%d (%s), non-answers %d/%d, wrong captures %s, errors %s" % (index, s["answers"]["hits"], s["answers"]["total"], pct(s["answers"]["rate"]), s["nonAnswers"]["hits"], s["nonAnswers"]["total"], s.get("wrongCaptures", 0), s.get("errors", 0))
        elif "overall" in s:
            extra = ["%s %s" % (k, s[k]) for k in ("wrongCaptures", "wrongTargets", "negativeCaptures", "actionCaptures") if k in s]
            if "helpCaptures" in s:
                extra.append("helpCaptures %s (allowed %s)" % (s["helpCaptures"], s.get("helpAllowance", "?")))
            if "perSource" in s:
                extra.append("per source " + ", ".join("%s %s" % (k, pct(v["rate"])) for k, v in sorted(s["perSource"].items())))
            line = "run %d: overall %s%s" % (index, pct(s["overall"]), " (" + ", ".join(extra) + ")" if extra else "")
        else:
            line = "run %d: %s" % (index, json.dumps(s)[:160])
        print("   " + line)
        for entry, slot in (s.get("perEntry") or {}).items():
            if isinstance(slot, dict) and slot.get("rate", 1) < 0.9:
                low.setdefault(entry, []).append("r%d %s/%s %s" % (index, slot.get("hits", slot.get("exact", "?")), slot.get("total", "?"), pct(slot["rate"])))
    if low:
        print("   per entry < 90%:")
        for entry, runs in sorted(low.items()):
            print("     %-22s %s" % (entry, "; ".join(runs)))
    records = (report or {}).get("records") or []
    wrong = [r for r in records if r.get("outcome") in WRONG]
    if wrong:
        print("   wrong / negative captures (%d):" % len(wrong))
        for r in wrong[:40]:
            print("     run %s %-17s %s want %s got %s" % (r.get("run"), r.get("outcome"), r.get("id"), r.get("expected", "-"), r.get("got", "-")))
        if len(wrong) > 40:
            print("     ... %d more" % (len(wrong) - 40))
    elif report is None:
        print("   (no report JSON found: wrong captures not listed)")
    else:
        print("   wrong / negative captures: 0")
PY
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  run) shift; [ $# -ge 2 ] || usage; cmd_run "$@" ;;
  status) shift; cmd_status "$@" ;;
  *) usage ;;
esac
