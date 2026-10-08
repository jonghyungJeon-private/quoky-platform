#!/usr/bin/env bash
# UNC-1 network-fault UAT driver (Docker / OrbStack). Subcommands:
#   build                 build the harness image (allowlist COPY; /.dockerignore drops env files, .git, node_modules)
#   up                    create the networks and start the fault proxy
#   preflight             prove the harness container has no direct route out, and only the proxy reaches slack.com
#   case <case1|case1b|case2|case3> <runId> --approved-channel-id <id> [--offline-placeholder]
#                         run one harness case (writes $UNC1_LOGS/<case>.json and .stderr.log); non-zero on any failure
#   down                  remove the containers and networks (logs are kept)
#
# Required env: UNC1_ENV_FILE (mode-600 file with QUOKY_CONNECTOR_WRITE_SLACK_TOKEN and
# QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS=quoky-test:<id>), UNC1_LOGS (a log directory). Nothing secret is printed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
IMAGE=unc1-harness:local
PROXY=unc1-proxy
NET_INT=unc1-int
NET_EXT=unc1-ext
PROXY_IMAGE=node:22-bookworm-slim

need_env() {
  : "${UNC1_ENV_FILE:?set UNC1_ENV_FILE}"
  : "${UNC1_LOGS:?set UNC1_LOGS}"
  [ "$(stat -f '%Lp' "$UNC1_ENV_FILE" 2>/dev/null || stat -c '%a' "$UNC1_ENV_FILE")" = "600" ] || { echo "env file must be mode 600" >&2; exit 2; }
  mkdir -p "$UNC1_LOGS"
}

cmd="${1:-}"
case "$cmd" in
  build)
    docker build -f "$HERE/Dockerfile" -t "$IMAGE" "$ROOT"
    ;;
  up)
    docker network create "$NET_EXT" >/dev/null
    docker network create --internal "$NET_INT" >/dev/null
    docker run -d --name "$PROXY" --network "$NET_EXT" \
      -v "$HERE:/netfault:ro" -e ALLOW_HOSTS=slack.com \
      "$PROXY_IMAGE" node /netfault/proxy.mjs >/dev/null
    docker network connect "$NET_INT" "$PROXY"
    sleep 1
    docker logs "$PROXY"
    ;;
  preflight)
    need_env
    # 1) No proxy: the harness network has no route out (DNS for slack.com fails or the connect is unreachable).
    docker run --rm --network "$NET_INT" "$IMAGE" node -e '
      fetch("https://slack.com/api/api.test", { signal: AbortSignal.timeout(8000) })
        .then((r) => { console.log("DIRECT_REACHABLE status=" + r.status); process.exit(1); })
        .catch((e) => { console.log("DIRECT_BLOCKED " + (e.cause?.code ?? e.name)); });'
    # 2) Through the proxy with NODE_USE_ENV_PROXY=1: the platform fetch reaches slack.com (api.test needs no token).
    docker run --rm --network "$NET_INT" -e HTTPS_PROXY="http://$PROXY:3128" -e NODE_USE_ENV_PROXY=1 -e NO_PROXY="$PROXY" \
      "$IMAGE" node -e '
      fetch("https://slack.com/api/api.test", { signal: AbortSignal.timeout(8000) })
        .then(async (r) => console.log("VIA_PROXY status=" + r.status + " ok=" + (await r.json()).ok))
        .catch((e) => { console.log("VIA_PROXY_FAILED " + (e.cause?.code ?? e.name)); process.exit(1); });'
    # 3) Through the proxy, a host outside the allowlist is denied.
    docker run --rm --network "$NET_INT" -e HTTPS_PROXY="http://$PROXY:3128" -e NODE_USE_ENV_PROXY=1 -e NO_PROXY="$PROXY" \
      "$IMAGE" node -e '
      fetch("https://example.com/", { signal: AbortSignal.timeout(8000) })
        .then((r) => { console.log("OTHER_HOST_REACHABLE status=" + r.status); process.exit(1); })
        .catch((e) => console.log("OTHER_HOST_DENIED " + (e.cause?.code ?? e.cause?.message ?? e.name)));'
    ;;
  case)
    need_env
    which_case="${2:?case}"
    run_id="${3:?runId}"
    shift 3
    approved_channel_id=""
    extra=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --approved-channel-id) approved_channel_id="${2:-}"; shift 2 ;;
        --offline-placeholder) extra+=(--offline-placeholder); shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
      esac
    done
    [[ "$approved_channel_id" =~ ^[CG][A-Z0-9]{8,20}$ ]] || { echo "--approved-channel-id <id> is required" >&2; exit 2; }
    proxy_url="http://$PROXY:3128"
    # case1b: a proxy port nothing listens on, so the connect itself is refused.
    if [ "$which_case" = "case1b" ]; then proxy_url="http://$PROXY:3999"; fi
    out="$UNC1_LOGS/$which_case"
    rm -f "$out.json" "$out.stdout.log" "$out.stderr.log"
    status=0
    docker run --rm --name "unc1-harness-$which_case" --network "$NET_INT" \
      --env-file "$UNC1_ENV_FILE" \
      -e HTTPS_PROXY="$proxy_url" -e NODE_USE_ENV_PROXY=1 -e NO_PROXY="$PROXY" \
      -e UNC1_PROXY_CONTROL="http://$PROXY:8081" \
      "$IMAGE" node tools/uat/netfault/harness.mjs "$which_case" "$run_id" \
      --approved-channel-id "$approved_channel_id" ${extra[@]+"${extra[@]}"} \
      > "$out.stdout.log" 2> "$out.stderr.log" || status=$?
    if [ "$status" -ne 0 ]; then
      echo "harness $which_case failed (exit $status); see $out.stderr.log" >&2
      exit "$status"
    fi
    sed -n '/===UNC1-RESULT-BEGIN===/,/===UNC1-RESULT-END===/p' "$out.stdout.log" | sed '1d;$d' > "$out.json"
    # The result must exist and carry every expected field, or the run counts as failed.
    node -e '
      const fs = require("node:fs");
      const [file, expectedCase] = process.argv.slice(1);
      let d;
      try { d = JSON.parse(fs.readFileSync(file, "utf8")); } catch { console.error("result JSON missing or unreadable"); process.exit(1); }
      const problems = [];
      if (d.case !== expectedCase) problems.push("case");
      if (d.schemaVersion !== 15) problems.push("schemaVersion");
      if (typeof d.executeReply !== "string" || d.executeReply.length === 0) problems.push("executeReply");
      if (!d.targetGuard || (d.targetGuard.verified !== true && d.targetGuard.offlinePlaceholder !== true)) problems.push("targetGuard");
      for (const key of ["receiptAfterExecute", "receiptsAtEnd", "writerCalls", "steps", "proxyLog"]) {
        if (!Array.isArray(d[key])) problems.push(key);
      }
      if (!Array.isArray(d.receiptAfterExecute) || d.receiptAfterExecute.length !== 1) problems.push("receiptAfterExecute.length");
      if (!Array.isArray(d.steps) || !d.steps.some((s) => s.label === "execute")) problems.push("steps.execute");
      if (problems.length > 0) { console.error("result JSON incomplete: " + problems.join(", ")); process.exit(1); }
    ' "$out.json" "$which_case"
    echo "wrote $out.json"
    ;;
  down)
    if [ -n "${UNC1_LOGS:-}" ] && docker inspect "$PROXY" >/dev/null 2>&1; then docker logs "$PROXY" > "$UNC1_LOGS/proxy.log" 2>&1 || true; fi
    docker rm -f "$PROXY" >/dev/null 2>&1 || true
    for c in $(docker ps -aq --filter name=unc1-harness-); do docker rm -f "$c" >/dev/null; done
    docker network rm "$NET_INT" "$NET_EXT" >/dev/null 2>&1 || true
    ;;
  *)
    sed -n '2,10p' "$0"
    exit 2
    ;;
esac
