#!/bin/bash
# Offline tests for run-gates.sh (quota guards). No model call: pnpm and npx are stubs on GATES_PATH_PREFIX.
#   bash .claude/skills/quoky-ship/scripts/run-gates.test.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
GATES="$HERE/run-gates.sh"
T=$(mktemp -d); [ -n "${KEEP:-}" ] && echo "tmp: $T"
trap 'pkill -f "$T/" 2>/dev/null; [ -n "${KEEP:-}" ] || rm -rf "$T"' EXIT
STUB="$T/stub"; mkdir -p "$STUB" "$T/wt"
git -C "$T/wt" init -q 2>/dev/null; git -C "$T/wt" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init 2>/dev/null

# fake ccusage: cost from $FAKE_COST_FILE (absent file = ccusage fails)
cat > "$STUB/npx" <<'SH'
#!/bin/bash
[ -f "${FAKE_COST_FILE:-/nonexistent}" ] || exit 1
end=$(python3 -c 'import datetime; print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z"))')
echo "{\"blocks\":[{\"isActive\":true,\"isGap\":false,\"endTime\":\"$end\",\"costUSD\":$(cat "$FAKE_COST_FILE")}]}"
SH
# fake pnpm: build ok; eval plan prints FAKE_CAP_<mode> style output; run either passes or hangs (with a grandchild)
cat > "$STUB/pnpm" <<'SH'
#!/bin/bash
[ "${1:-}" = build ] && exit 0
shift; cli=$1; shift; shift   # -s <cli> --
mode=""; digest=""
while [ $# -gt 0 ]; do case "$1" in --mode) mode=$2; shift ;; --approved-plan-digest) digest=$2; shift ;; esac; shift; done
if [ -z "$digest" ]; then
  case "${FAKE_PLAN_STYLE:-line}" in
    line) echo "model calls this plan authorises: at most ${FAKE_CALLS:-100} (x cases)" ;;
    json) printf '{\n  "model": "%s",\n  "runs": 3,\n  "caseIds": "%s cases"\n}\n' "${FAKE_MODEL:-sonnet}" "${FAKE_CASES:-10}" ;;
    none) echo "something else" ;;
  esac
  echo "plan digest (sha256): $(printf '%064d' 7)"
  exit 0
fi
echo "$mode started" >> "$FAKE_LOG"
if [ -n "${FAKE_HANG:-}" ]; then
  if [ -n "${FAKE_STUBBORN:-}" ]; then ( trap '' TERM; exec sleep 300 ) & else sleep 300 & fi
  echo $! > "$FAKE_LOG.grandchild"
  wait
fi
echo "gate ($mode): PASSED"
exit 0
SH
chmod +x "$STUB/npx" "$STUB/pnpm"

pass=0; failn=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "ok   $1"; else failn=$((failn + 1)); echo "FAIL $1: want '$3' got '$2'"; fi; }
count() { if [ -f "$2" ]; then grep -c -- "$1" "$2"; else echo 0; fi; }
has() { if grep -q -- "$3" "$2" 2>/dev/null; then pass=$((pass + 1)); echo "ok   $1"; else failn=$((failn + 1)); echo "FAIL $1: '$3' not in $2"; fi; }

gates() { # name, then modes; env from caller
  local n=$1; shift
  FAKE_LOG="$T/$n.fake.log" GATES_PATH_PREFIX="$STUB" QUOKY_EVAL_ARCHIVE="$T/arch" GATES_WATCH_SEC="${GATES_WATCH_SEC:-1}" GATES_STOP_GRACE_SEC="${GATES_STOP_GRACE_SEC:-2}" \
    bash "$GATES" run "$T/wt" "$n" "$@" > "$T/$n.out" 2>&1
  echo $? > "$T/$n.rc"; cat "$T/$n.rc"
}
export FAKE_COST_FILE="$T/cost"; echo 10 > "$T/cost"

# 1. estimate parsing: authorises line, sonnet 0.06 x 100 = 6.0
export GATES_MODEL=sonnet FAKE_CALLS=100
rc=$(gates e1 action); check "within limits exits 0" "$rc" 0
has "estimate.txt has calls/model/rate/est" "$T/arch/e1/estimate.txt" "mode=action model=sonnet calls=100 rate_pct_per_call=0.06 est_pct_5h=6.0 cap_source=authorises-line"
has "estimate.txt has current usage" "$T/arch/e1/estimate.txt" "current_5h_usage_pct=4.6"
has "verdict OK" "$T/arch/e1/estimate.txt" "verdict=OK"
GATES_PATH_PREFIX="$STUB" QUOKY_EVAL_ARCHIVE="$T/arch" bash "$GATES" status e1 > "$T/e1.status" 2>&1
has "status prints the estimate" "$T/e1.status" "est_pct_5h=6.0"

# 2. JSON plan fallback (cases x runs), model from the plan, haiku placeholder rate
FAKE_PLAN_STYLE=json FAKE_MODEL=haiku FAKE_CASES=100 rc=$(FAKE_PLAN_STYLE=json FAKE_MODEL=haiku FAKE_CASES=100 gates e2 action); check "json plan exits 0" "$rc" 0
has "cases x runs = 300 at haiku 0.03 = 9.0" "$T/arch/e2/estimate.txt" "model=haiku calls=300 rate_pct_per_call=0.03 est_pct_5h=9.0 cap_source=cases-x-runs"

# 3. unknown cap blocks, no run happens
rc=$(FAKE_PLAN_STYLE=none gates e3 action); check "unknown cap blocked exit 2" "$rc" 2
has "unknown cap reason" "$T/arch/e3/estimate.txt" "calls=UNKNOWN"
has "blocked verdict" "$T/arch/e3/estimate.txt" "verdict=BLOCKED"
check "no eval ran" "$(count started "$T/e3.fake.log")" 0

# 4. over 30 % blocked; 500 x 0.06 = 30.0 is allowed (not exceeding), 600 blocked
rc=$(FAKE_CALLS=500 gates e4a action); check "exactly 30 not blocked" "$rc" 0
rc=$(FAKE_CALLS=600 gates e4 action); check ">30 blocked" "$rc" 2
has "DONE records the block" "$T/arch/e4/DONE" "BLOCKED-ESTIMATE"
check "no run after block" "$(count started "$T/e4.fake.log")" 0
# sum over modes: 2 x 300 calls = 36 % > 30
rc=$(FAKE_CALLS=300 gates e4s action r2); check "sum over modes blocked" "$rc" 2
has "sum is in the file" "$T/arch/e4s/estimate.txt" "total_est_pct_5h=36.0"

# 5. owner-ok allows and is archived verbatim; a malformed marker does not
rc=$(FAKE_CALLS=600 GATES_OWNER_OK=20261104-planner-gate gates e5 action); check "owner-ok allows" "$rc" 0
has "owner-ok archived" "$T/arch/e5/estimate.txt" "owner_ok=20261104-planner-gate"
has "allowed verdict" "$T/arch/e5/estimate.txt" "ALLOWED-BY-OWNER-OK"
rc=$(FAKE_CALLS=600 GATES_OWNER_OK=yes gates e5b action); check "malformed owner-ok blocked" "$rc" 2
rc=$(FAKE_PLAN_STYLE=none GATES_OWNER_OK=20261104-unknown-cap gates e5c action); check "owner-ok allows an unknown cap" "$rc" 0

# 6. current usage + estimate > 95 % blocked (cost 200/218 = 91.7 %, but the pre-run usage wait also trips at 95: use 90 %)
echo 196 > "$T/cost"   # 89.9 %
rc=$(FAKE_CALLS=100 gates e6 action); check "current+estimate > 95 blocked" "$rc" 2
has "pause reason" "$T/arch/e6/estimate.txt" "> 95"
echo 10 > "$T/cost"

# 7. rate overrides
rc=$(FAKE_CALLS=100 GATES_RATE_PCT_PER_CALL=0.5 gates e7 action); check "rate override pushes it over" "$rc" 2
has "override in file" "$T/arch/e7/estimate.txt" "rate_pct_per_call=0.5"

# 8. in-run brake: eval hangs with a grandchild; cost rises past 85 % (185.3/218) -> stopped, exit 6, group gone
echo 10 > "$T/cost"
( sleep 4; echo 190 > "$T/cost" ) &
rc=$(FAKE_CALLS=100 FAKE_HANG=1 gates e8 action r2); check "brake exit code 6" "$rc" 6
has "DONE has USAGE-STOP" "$T/arch/e8/DONE" "action exit=6 status=USAGE-STOP pct=87"
has "DONE says partial" "$T/arch/e8/DONE" "neither PASSED nor FAILED"
check "second mode not run" "$(grep -c 'r2 started' "$T/e8.fake.log")" 0
sleep 1
gc=$(cat "$T/e8.fake.log.grandchild" 2>/dev/null)
if [ -n "$gc" ] && kill -0 "$gc" 2>/dev/null; then check "grandchild killed" alive dead; else check "grandchild killed" dead dead; fi
check "no RUNNING marker left" "$(ls "$T/arch/e8/RUNNING" 2>/dev/null | wc -l | tr -d ' ')" 0
GATES_PATH_PREFIX="$STUB" QUOKY_EVAL_ARCHIVE="$T/arch" bash "$GATES" status e8 > "$T/e8.status" 2>&1
has "status shows partial" "$T/e8.status" "PARTIAL"
check "watchdog gone" "$(pgrep -f "run-gates.sh run $T/wt e8" | wc -l | tr -d ' ')" 0

# 9. ccusage failing: unknown current usage blocks at start (fail-closed); owner-ok allows it, and a mid-run outage is then tolerated
rc=$(FAKE_CALLS=100 FAKE_COST_FILE=/nonexistent gates e9 action); check "usage unknown blocks exit 2" "$rc" 2
has "usage unknown reason" "$T/arch/e9/estimate.txt" "current usage unknown"
has "usage UNKNOWN recorded" "$T/arch/e9/estimate.txt" "current usage UNKNOWN"
check "no eval after unknown usage" "$(count started "$T/e9.fake.log")" 0
rc=$(FAKE_CALLS=100 FAKE_COST_FILE=/nonexistent GATES_OWNER_OK=20261104-ccusage-down gates e9b action); check "usage unknown + owner-ok: no stop, exit 0" "$rc" 0

# 11. numeric validation (hard block, even with owner-ok)
for kv in GATES_RATE_PCT_PER_CALL=garbage GATES_RATE_PCT_SONNET=0 GATES_MAX_EST_PCT=abc GATES_STOP_PCT=101 GATES_STOP_PCT=0 GATES_WATCH_SEC=1.5 GATES_STOP_GRACE_SEC=x GATES_RATE_PCT_PER_CALL=; do
  n="e11-$(printf '%s' "$kv" | tr -c 'A-Za-z0-9\n' '-')"
  rc=$(export "$kv" GATES_OWNER_OK=20261104-try; gates "$n" action); check "invalid $kv blocked" "$rc" 2
  has "reason for $kv" "$T/arch/$n/estimate.txt" "invalid configuration"
  check "no eval for $kv" "$(count started "$T/$n.fake.log")" 0
done
echo 10 > "$T/cost"

# 12. unknown model: blocked unless a rate override or owner-ok
rc=$(FAKE_PLAN_STYLE=json FAKE_MODEL=gpt-9 gates e12 action); check "unknown model blocked" "$rc" 2
has "unknown model reason" "$T/arch/e12/estimate.txt" "unknown model"
rc=$(FAKE_PLAN_STYLE=json FAKE_MODEL=gpt-9 GATES_RATE_PCT_PER_CALL=0.01 gates e12b action); check "unknown model + rate override allowed" "$rc" 0
rc=$(FAKE_PLAN_STYLE=json FAKE_MODEL=gpt-9 GATES_OWNER_OK=20261104-gpt gates e12c action); check "unknown model + owner-ok allowed" "$rc" 0

# 10. trap cleanup: TERM the runner while the eval hangs -> group killed, KILLED marker, no stray watchdog
echo 10 > "$T/cost"
FAKE_LOG="$T/e10.fake.log" FAKE_CALLS=100 FAKE_HANG=1 GATES_PATH_PREFIX="$STUB" QUOKY_EVAL_ARCHIVE="$T/arch" GATES_WATCH_SEC=1 GATES_STOP_GRACE_SEC=2 \
  bash "$GATES" run "$T/wt" e10 action > "$T/e10.out" 2>&1 &
rp=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$T/e10.fake.log.grandchild" ] && break; sleep 1; done
kill -TERM "$rp"; wait "$rp" 2>/dev/null; rc=$?
check "TERM exit 143" "$rc" 143
has "KILLED marker" "$T/arch/e10/DONE" "KILLED"
sleep 1
gc=$(cat "$T/e10.fake.log.grandchild" 2>/dev/null)
if [ -n "$gc" ] && kill -0 "$gc" 2>/dev/null; then check "child group killed on TERM" alive dead; else check "child group killed on TERM" dead dead; fi

# 13. TERM-ignoring grandchild whose leader exits on TERM: after cleanup no member of the group remains
FAKE_LOG="$T/e13.fake.log" FAKE_CALLS=100 FAKE_HANG=1 FAKE_STUBBORN=1 GATES_PATH_PREFIX="$STUB" QUOKY_EVAL_ARCHIVE="$T/arch" GATES_WATCH_SEC=1 GATES_STOP_GRACE_SEC=2 \
  bash "$GATES" run "$T/wt" e13 action > "$T/e13.out" 2>&1 &
rp=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$T/e13.fake.log.grandchild" ] && break; sleep 1; done
gc=$(cat "$T/e13.fake.log.grandchild"); gpg=$(ps -o pgid= -p "$gc" | tr -d ' ')
check "grandchild has its own group before cleanup" "$([ -n "$gpg" ] && [ "$gpg" != "$(ps -o pgid= -p $$ | tr -d ' ')" ] && echo yes)" yes
kill -TERM "$rp"; wait "$rp" 2>/dev/null
check "group members after cleanup" "$(ps -axo pgid= | awk -v g="$gpg" '$1 == g' | wc -l | tr -d ' ')" 0
if kill -0 "$gc" 2>/dev/null; then check "TERM-resistant grandchild killed" alive dead; else check "TERM-resistant grandchild killed" dead dead; fi

echo; echo "passed $pass, failed $failn"
[ "$failn" -eq 0 ]
