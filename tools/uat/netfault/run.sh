#!/usr/bin/env bash
# UNC-1 network-fault UAT driver (Docker / OrbStack). Subcommands:
#   build                 build the harness image from this worktree (bind-mounted read-only in the build)
#   up                    create the networks and start the fault proxy
#   preflight             prove the harness container has no direct route out, and only the proxy reaches slack.com
#   case <case1|case1b|case2|case3> <runId>   run one harness case (writes $UNC1_LOGS/<case>.json and .stderr.log)
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
    proxy_url="http://$PROXY:3128"
    # case1b: a proxy port nothing listens on, so the connect itself is refused.
    [ "$which_case" = "case1b" ] && proxy_url="http://$PROXY:3999"
    docker run --rm --name "unc1-harness-$which_case" --network "$NET_INT" \
      --env-file "$UNC1_ENV_FILE" \
      -e HTTPS_PROXY="$proxy_url" -e NODE_USE_ENV_PROXY=1 -e NO_PROXY="$PROXY" \
      -e UNC1_PROXY_CONTROL="http://$PROXY:8081" \
      "$IMAGE" node tools/uat/netfault/harness.mjs "$which_case" "$run_id" \
      > "$UNC1_LOGS/$which_case.stdout.log" 2> "$UNC1_LOGS/$which_case.stderr.log" || echo "harness exit=$?"
    sed -n '/===UNC1-RESULT-BEGIN===/,/===UNC1-RESULT-END===/p' "$UNC1_LOGS/$which_case.stdout.log" | sed '1d;$d' > "$UNC1_LOGS/$which_case.json"
    echo "wrote $UNC1_LOGS/$which_case.json"
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
