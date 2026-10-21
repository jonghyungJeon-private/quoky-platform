#!/bin/bash
# run-gates.sh — the Quoky D12 / S2 model-in-the-loop eval gate runner (quoky-ship §2.5).
#
#   run-gates.sh start  <worktree> <name> [modes...]   build, plan digest + run per mode, detached in tmux "gates-<name>"
#   run-gates.sh run    <worktree> <name> [modes...]   the same in the foreground (what the tmux session executes)
#   run-gates.sh status [<name>]                       summary of an archive (no name: the 10 most recent archives)
#
# Modes: intent action read-regression r2 (eval:nl), agent-plan (eval:agent-plan), r2-redteam (eval:r2-redteam).
# Default modes: action read-regression r2.
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
# Environment: GATES_MODEL (haiku), GATES_RUNS (3), GATES_CONCURRENCY (4), GATES_REDTEAM_MODEL (unset: the Claude CLI
# default summariser), QUOKY_USAGE_LIMIT_USD (218), GATES_USAGE_PCT (95), GATES_RETRY_WAIT_SEC (900, used when no
# active usage block is reported), GATES_RESET_MARGIN_SEC (60, slack after a block end), GATES_NO_RETRY,
# QUOKY_EVAL_ARCHIVE (archive root).
#
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
ALL_MODES="intent action read-regression r2 agent-plan r2-redteam"

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
'
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
    intent|action|read-regression|r2) echo eval:nl ;;
    agent-plan) echo eval:agent-plan ;;
    r2-redteam) echo eval:r2-redteam ;;
    *) return 1 ;;
  esac
}

# The options shared by the plan and the run (the digest binds them, so both must be identical).
common_args() {
  case "$1" in
    r2-redteam) printf -- '--runs %s' "$RUNS"; [ -n "${GATES_REDTEAM_MODEL:-}" ] && printf -- ' --model %s' "$GATES_REDTEAM_MODEL" ;;
    *) printf -- '--model %s --runs %s --concurrency %s' "$MODEL" "$RUNS" "$CONC" ;;
  esac
  return 0
}
plan_mode() { case "$1" in intent|agent-plan|r2-redteam) echo plan ;; *) echo "$1" ;; esac; }
run_mode_name() { case "$1" in intent|agent-plan|r2-redteam) echo run ;; *) echo "$1" ;; esac; }

# Plan (digest) then run one mode; returns the run's exit status.
run_one() {
  local m=$1 cli digest rc report
  cli=$(cli_of "$m")
  # shellcheck disable=SC2046
  pnpm -s "$cli" -- --mode "$(plan_mode "$m")" $(common_args "$m") > "$A/$m.plan.log" 2>&1
  digest=$(grep 'plan digest' "$A/$m.plan.log" | awk '{print $NF}' | tail -1)
  if [ -z "$digest" ]; then
    log "$m: no plan digest (see $m.plan.log)"
    return 2
  fi
  echo "$m $digest" >> "$A/digests.txt"
  log "$m: running ($cli, digest ${digest:0:12})"
  # shellcheck disable=SC2046
  pnpm -s "$cli" -- --mode "$(run_mode_name "$m")" $(common_args "$m") --approved-plan-digest "$digest" > "$A/$m.log" 2>&1
  rc=$?
  report=$(grep -o 'results written to .*' "$A/$m.log" | tail -1 | sed 's/^results written to //')
  if [ -n "$report" ] && [ -f "$report" ]; then cp "$report" "$A/$m.report.json"; fi
  log "$m: exit=$rc $(status_word "$rc") | $(grep -E 'gate.*: (PASSED|FAILED|INVALID|NON-GATING)' "$A/$m.log" | tail -1)"
  return "$rc"
}

cmd_run() {
  local W=$1 N=$2; shift 2
  local MODES="${*:-$DEFAULT_MODES}" m rc retried=0 stopped="" reason cfail nodev
  for m in $MODES; do
    case " $ALL_MODES " in *" $m "*) ;; *) echo "unknown mode: $m (one of: $ALL_MODES)" >&2; exit 2 ;; esac
  done
  cd "$W" || { echo "no worktree $W" >&2; exit 1; }
  # Node version of the worktree (.nvmrc), else whatever node is on the PATH.
  nodev=$(sed 's/^v//' "$W/.nvmrc" 2>/dev/null | head -1)
  if [ -n "$nodev" ] && [ -d "$HOME/.nvm/versions/node/v$nodev/bin" ]; then export PATH="$HOME/.nvm/versions/node/v$nodev/bin:$PATH"; fi
  A="$ARCHIVE_ROOT/$N"
  mkdir -p "$A"
  rm -f "$A/DONE" "$A/digests.txt" "$A/modes.txt"
  # A terminated run (TERM / INT / HUP, or any exit with the RUNNING marker still there) leaves a terminal marker. SIGKILL
  # cannot be trapped: `status` checks that the RUNNING pid is alive.
  trap 'exit 143' TERM INT HUP
  trap 'if [ -f "$A/RUNNING" ]; then { cat "$A/modes.txt" 2>/dev/null; echo "KILLED: the run was terminated before it finished"; date; } > "$A/DONE"; rm -f "$A/RUNNING"; fi' EXIT
  printf 'pid=%s session=%s worktree=%s modes=%s started=%s\n' "$$" "${TMUX_SESSION:-foreground}" "$W" "$MODES" "$(date '+%F %T')" > "$A/RUNNING"
  git -C "$W" log --oneline -1 > "$A/head.txt"
  log "gates $N: worktree $W, head $(cat "$A/head.txt"), modes: $MODES"
  wait_for_usage
  if ! pnpm build > "$A/build.log" 2>&1; then
    log "build failed (see build.log)"
    { echo "BUILD_FAIL"; date; } > "$A/DONE"
    rm -f "$A/RUNNING"
    exit 1
  fi
  for m in $MODES; do
    wait_for_usage
    retried=0
    run_one "$m"; rc=$?
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
          run_one "$m"; rc=$?
          reason=$(grep -o 'INVALID (provider unavailable: [^)]*)' "$A/$m.log" | tail -1 | sed 's/^INVALID (provider unavailable: //; s/)$//')
        fi
        ;;
    esac
    echo "$m exit=$rc status=$(status_word "$rc")" >> "$A/modes.txt"
    echo "$m exit=$rc" >> "$A/digests.txt"
    if [ "$rc" -eq "$EXIT_INVALID" ]; then
      stopped="stopped after $m: INVALID (provider unavailable: ${reason:-unknown})$([ "$retried" -eq 1 ] && echo ' after the one automatic retry for this mode'); remaining modes not run"
      log "$stopped"
      break
    fi
  done
  { cat "$A/modes.txt"; if [ -n "$stopped" ]; then echo "$stopped"; fi; date; } > "$A/DONE"
  rm -f "$A/RUNNING"
  log "gates $N: done"
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
WORD = {0: "PASSED", 1: "FAILED", 2: "USAGE", 3: "BLOCKED", 4: "NON-GATING", 5: "INVALID"}
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
exits = {}
for line in (read("DONE") + "\n" + read("digests.txt")).splitlines():
    m = re.match(r"^(\S+) exit=(\d+)", line)
    if m:
        exits[m.group(1)] = int(m.group(2))
order = []
for line in read("digests.txt").splitlines():
    parts = line.split()
    if parts and parts[0] not in order:
        order.append(parts[0])
for name in sorted(os.listdir(A)):
    m = re.match(r"^(intent|action|read-regression|r2|agent-plan|r2-redteam)\.log$", name)
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
        elif "overall" in s:
            extra = ["%s %s" % (k, s[k]) for k in ("wrongCaptures", "wrongTargets", "negativeCaptures", "actionCaptures") if k in s]
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
