#!/usr/bin/env bash
# shellcheck shell=bash
# Quoky network self-check (ADR-0121 S0, design section 5.5, MSIT items 1-2, 4-4, 4-5, 5-3).
#
#   ops/security/quoky-net-selfcheck.sh [--json] [--since 24h]
#
# Read-only, no sudo, macOS first (bash 3.2 safe). It prints a one-page report the owner can hand to the security
# team: the Quoky process tree, its live TCP/UDP connections against the expected host allowlist, its listening
# sockets, remote-access / tunnel / VPN software, and a summary of the traffic ledger when one exists.
# It never prints an environment value, a token, a header or a file content (only names, addresses and counts).
# Exit 0 = every check passed; 1 = at least one finding (each is printed with its reason); 2 = usage.
#
# Environment (optional): QUOKY_LAUNCHD_LABEL (default com.quoky.personal), QUOKY_SELFCHECK_EXTRA_HOSTS (space
# separated host suffixes to add to the allowlist), QUOKY_OPS_UI_PORT (default 47613), QUOKY_LEDGER_DIR.
#
# Sourcing this file defines the parsing functions only (used by quoky-net-selfcheck.test.sh); it runs when executed.

SC_LABEL="${QUOKY_LAUNCHD_LABEL:-com.quoky.personal}"
SC_OPS_PORT="${QUOKY_OPS_UI_PORT:-47613}"

# Allowed destination host suffixes (design 5.1). An IP is allowed when its reverse name, or the forward address of an
# allowlisted host, matches. Cloudflare (Discord), Telegram and Anthropic ranges are listed because their reverse
# names are generic or absent.
SC_ALLOWED_SUFFIXES="telegram.org discord.gg discord.com discordapp.com discordapp.net anthropic.com googleapis.com \
atlassian.net slack.com github.com githubusercontent.com openai.com"
SC_ALLOWED_HOSTS="api.telegram.org gateway.discord.gg discord.com cdn.discordapp.com api.anthropic.com www.googleapis.com \
gmail.googleapis.com oauth2.googleapis.com slack.com api.github.com github.com"
# "label:cidr" pairs: networks that host allowlisted services behind generic reverse DNS.
SC_KNOWN_RANGES="telegram:149.154.160.0/20 telegram:91.108.4.0/22 telegram:91.108.8.0/22 telegram:91.108.12.0/22 \
telegram:91.108.16.0/22 telegram:91.108.56.0/22 cloudflare:162.159.128.0/17 cloudflare:104.16.0.0/13 \
cloudflare:172.64.0.0/13 cloudflare:173.245.48.0/20 cloudflare:188.114.96.0/20 cloudflare:198.41.128.0/17 \
anthropic:160.79.104.0/23"

# ---------------------------------------------------------------- parsing helpers (pure, unit-tested)

# sc_json_escape STRING -> JSON string body (no surrounding quotes).
sc_json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# sc_ip_to_int A.B.C.D -> integer; fails on anything else.
sc_ip_to_int() {
  local ip="$1" a b c d rest n
  case "$ip" in *[!0-9.]* | "") return 1 ;; esac
  IFS=. read -r a b c d rest <<<"$ip"
  { [ -z "$rest" ] && [ -n "$d" ]; } || return 1
  for n in "$a" "$b" "$c" "$d"; do [ "$n" -le 255 ] 2>/dev/null || return 1; done
  echo $(((a << 24) | (b << 16) | (c << 8) | d))
}

# sc_ip_in_cidr IP A.B.C.D/N -> success when inside.
sc_ip_in_cidr() {
  local ip="$1" net bits ipi neti mask
  net="${2%/*}"
  bits="${2#*/}"
  ipi="$(sc_ip_to_int "$ip")" || return 1
  neti="$(sc_ip_to_int "$net")" || return 1
  mask=$(((0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF))
  [ $((ipi & mask)) -eq $((neti & mask)) ]
}

# sc_is_loopback ADDRESS -> success for 127.0.0.0/8, ::1 and localhost.
sc_is_loopback() {
  case "$1" in
    127.* | "::1" | "[::1]" | localhost) return 0 ;;
  esac
  return 1
}

# sc_split_endpoint ENDPOINT -> "host port" ("*" host for wildcard); handles [v6]:port and v4:port.
sc_split_endpoint() {
  local ep="$1" host port
  case "$ep" in
    \[*\]:*) host="${ep%\]:*}"; host="${host#\[}"; port="${ep##*:}" ;;
    *:*) host="${ep%:*}"; port="${ep##*:}" ;;
    *) host="$ep"; port="" ;;
  esac
  printf '%s %s\n' "$host" "$port"
}

# sc_parse_lsof_conns < lsof -nP -i text
# -> TSV: pid<TAB>command<TAB>proto<TAB>state<TAB>local<TAB>remote   (remote empty for listeners / unconnected UDP)
sc_parse_lsof_conns() {
  awk '
    NR == 1 && $1 == "COMMAND" { next }
    {
      proto = ""; name = ""; state = ""
      for (i = 1; i <= NF; i++) if ($i == "TCP" || $i == "UDP") { proto = $i; name = $(i + 1); if (i + 2 <= NF) state = $(i + 2); break }
      if (proto == "") next
      gsub(/[()]/, "", state)
      loc = name; rem = ""
      idx = index(name, "->")
      if (idx > 0) { loc = substr(name, 1, idx - 1); rem = substr(name, idx + 2) }
      if (proto == "UDP") state = (rem == "" ? "BOUND" : "CONNECTED")
      printf "%s\t%s\t%s\t%s\t%s\t%s\n", $2, $1, proto, state, loc, rem
    }'
}

# sc_parse_listen_netstat < netstat -an -p tcp text -> "port<TAB>local" per LISTEN socket.
sc_parse_listen_netstat() {
  awk '$NF == "LISTEN" && ($1 ~ /^tcp/) { n = split($4, p, "."); print p[n] "\t" $4 }'
}

# sc_parse_utun_cgnat < ifconfig text -> names of utun interfaces whose inet address is in 100.64.0.0/10.
sc_parse_utun_cgnat() {
  awk '
    /^[a-z0-9]+:/ { iface = $1; sub(":", "", iface) }
    $1 == "inet" && iface ~ /^utun/ {
      split($2, o, ".")
      if (o[1] == 100 && o[2] >= 64 && o[2] <= 127) print iface
    }' | sort -u
}

# sc_match_tunnel_process NAME -> prints a label when the executable/process name is remote-access software.
sc_match_tunnel_process() {
  local lower
  lower="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    *tailscaled* | *ipnextension* | */tailscale | tailscale | *tailscale.app*) echo Tailscale ;;
    *zerotier*) echo ZeroTier ;;
    ngrok | */ngrok) echo ngrok ;;
    cloudflared | */cloudflared) echo cloudflared ;;
    frpc | frps | */frpc | */frps) echo frp ;;
    *anydesk*) echo AnyDesk ;;
    *teamviewer*) echo TeamViewer ;;
    *) return 1 ;;
  esac
}

# sc_host_allowed NAME -> success when NAME equals or is a subdomain of an allowlisted suffix.
sc_host_allowed() {
  local name suffix
  name="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  name="${name%.}"
  for suffix in $SC_ALLOWED_SUFFIXES ${QUOKY_SELFCHECK_EXTRA_HOSTS:-}; do
    case "$name" in "$suffix" | *."$suffix") return 0 ;; esac
  done
  return 1
}

# sc_known_range IP -> prints the label of a known provider range containing IP.
sc_known_range() {
  local pair
  for pair in $SC_KNOWN_RANGES; do
    if sc_ip_in_cidr "$1" "${pair#*:}"; then echo "${pair%%:*}"; return 0; fi
  done
  return 1
}

# sc_classify_remote IP [REVERSE_NAME] [FORWARD_HOST]
# -> "ok<TAB>label" or "unexpected<TAB>reason". Reverse name, forward-resolved allowlisted host and known range all count.
sc_classify_remote() {
  local ip="$1" rname="${2:-}" fwd="${3:-}" label
  if sc_is_loopback "$ip"; then printf 'ok\tloopback\n'; return 0; fi
  if [ -n "$fwd" ]; then printf 'ok\t%s\n' "$fwd"; return 0; fi
  if [ -n "$rname" ] && sc_host_allowed "$rname"; then printf 'ok\t%s\n' "$rname"; return 0; fi
  if label="$(sc_known_range "$ip")"; then printf 'ok\t%s range\n' "$label"; return 0; fi
  if [ -n "$rname" ]; then
    printf 'unexpected\t%s (%s) is not in the allowlist\n' "$ip" "$rname"
  else
    printf 'unexpected\t%s (no hostname) is not in the allowlist\n' "$ip"
  fi
  return 0
}

# sc_summarize_ledger < JSON lines -> "lines=N up=B down=B", then host and initiator rows.
# Reads only the fields host, initiator, bytesUp, bytesDown (design 5.4); anything else is ignored.
sc_summarize_ledger() {
  awk '
    function field(s, key,   re, m) {
      re = "\"" key "\"[ ]*:[ ]*(\"[^\"]*\"|[0-9]+)"
      if (match(s, re)) { m = substr(s, RSTART, RLENGTH); sub(/^[^:]*:[ ]*/, "", m); gsub(/"/, "", m); return m }
      return ""
    }
    { n++; h = field($0, "host"); i = field($0, "initiator"); u = field($0, "bytesUp") + 0; d = field($0, "bytesDown") + 0
      up += u; down += d
      if (h != "") { hc[h]++; hb[h] += u + d }
      if (i != "") ic[i]++ }
    END {
      printf "lines=%d up=%d down=%d\n", n, up, down
      for (h in hc) printf "host\t%s\t%d\t%d\n", h, hc[h], hb[h]
      for (i in ic) printf "initiator\t%s\t%d\n", i, ic[i]
    }' | sort
}

# ---------------------------------------------------------------- collection (host-dependent)

sc_descendants() { # PID -> PID and all descendants
  local pid="$1" kid
  echo "$pid"
  for kid in $(pgrep -P "$pid" 2>/dev/null); do sc_descendants "$kid"; done
}

sc_quoky_pids() {
  local pid
  pid="$(launchctl list "$SC_LABEL" 2>/dev/null | awk -F'[=;]' '/"PID"/ { gsub(/ /, "", $2); print $2 }')"
  [ -n "$pid" ] || return 1
  sc_descendants "$pid" | sort -un
}

sc_ledger_dir() {
  local d
  for d in "${QUOKY_LEDGER_DIR:-}" "${QUOKY_DATA_DIR:+$QUOKY_DATA_DIR/audit}" "${QUOKY_DATA_DIR:+$QUOKY_DATA_DIR/data/audit}" \
    "$HOME/Library/Application Support/Quoky/audit" "$HOME/Library/Application Support/Quoky/data/audit" \
    "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)/data/audit"; do
    if [ -n "$d" ] && [ -d "$d" ] && ls "$d"/egress-*.jsonl >/dev/null 2>&1; then echo "$d"; return 0; fi
  done
  return 1
}

sc_since_files() { # DIR SINCE(24h, 7d) -> ledger files modified inside the window
  local dir="$1" since="$2" n unit days
  n="${since%[hd]}"
  unit="${since#"$n"}"
  case "$unit" in h) days=$(((n + 23) / 24)) ;; d) days="$n" ;; *) days=1 ;; esac
  [ "$days" -ge 1 ] || days=1
  find "$dir" -name 'egress-*.jsonl' -mtime "-$days" 2>/dev/null | sort
}

sc_resolve_forward() { # prints "IP host" for each allowlisted host (macOS dscacheutil)
  local h
  for h in $SC_ALLOWED_HOSTS; do
    dscacheutil -q host -a name "$h" 2>/dev/null | awk -v h="$h" '$1 == "ip_address:" { print $2, h }'
  done
  return 0
}

sc_reverse() { # IP -> name or empty (2 s bound)
  host -W 2 "$1" 2>/dev/null | awk '/domain name pointer/ { sub(/\.$/, "", $NF); print $NF; exit }'
}

SC_FAILS=()
SC_WARNS=()
sc_fail() { SC_FAILS+=("$1"); }
sc_warn() { SC_WARNS+=("$1"); }

# sc_json_array_lines TEXT -> JSON array body of the non-empty lines.
sc_json_array_lines() {
  printf '%s' "$1" | awk 'NF { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); printf "%s\"%s\"", (c++ ? "," : ""), $0 }'
}

sc_main() {
  local json=0 since="24h"
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) json=1 ;;
      --since)
        shift
        since="${1:-}"
        case "$since" in [0-9]*[hd]) ;; *) echo "usage: quoky-net-selfcheck.sh [--json] [--since 24h|7d]" >&2; return 2 ;; esac
        ;;
      -h | --help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; return 0 ;;
      *) echo "usage: quoky-net-selfcheck.sh [--json] [--since 24h|7d]" >&2; return 2 ;;
    esac
    shift
  done

  local now tz ntp
  now="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  tz="$(date '+%Z')"
  ntp="unknown"
  case "$(systemsetup -getusingnetworktime 2>/dev/null)" in *On*) ntp=on ;; *Off*) ntp=off ;; esac
  [ "$ntp" = off ] && sc_warn "automatic network time is off"

  # 1. process tree
  local pids pidlist="" tree="" children=""
  if pids="$(sc_quoky_pids)"; then
    pidlist="$(echo "$pids" | paste -sd, -)"
    tree="$(ps -o pid=,ppid=,comm= -p "$pidlist" 2>/dev/null | awk '{ n = split($3, p, "/"); print $1 "\t" $2 "\t" p[n] }')"
    children="$(printf '%s\n' "$tree" | awk -F'\t' 'NF >= 3 { print $3 }' | sort | uniq -c | awk '{ printf "%s%s x%s", (NR > 1 ? ", " : ""), $2, $1 }')"
  else
    sc_fail "Quoky service ($SC_LABEL) is not running, so its connections cannot be checked"
  fi

  # 2. connections and listeners
  local conns="" fwdmap rows="" listeners="" unexpected=0 ok_count=0
  local pid cmd proto state loc rem ip rname fwd verdict host port
  if [ -n "$pidlist" ]; then
    conns="$(lsof -nP -a -p "$pidlist" -i 2>/dev/null | sc_parse_lsof_conns)"
  fi
  fwdmap="$(sc_resolve_forward)"
  while IFS=$'\t' read -r pid cmd proto state loc rem; do
    [ -n "$pid" ] || continue
    if [ "$state" = "LISTEN" ] || [ "$state" = "BOUND" ]; then
      read -r host port <<<"$(sc_split_endpoint "$loc")"
      if sc_is_loopback "$host"; then
        listeners="${listeners}${proto} ${loc} (loopback, ok)"$'\n'
        if [ "$proto" = TCP ] && [ "$port" != "$SC_OPS_PORT" ]; then
          sc_warn "loopback listener $loc is not the ops UI port $SC_OPS_PORT"
        fi
      else
        listeners="${listeners}${proto} ${loc} (NOT loopback)"$'\n'
        sc_fail "non-loopback listener: $proto $loc (pid $pid $cmd)"
      fi
      continue
    fi
    [ -n "$rem" ] || continue
    read -r ip port <<<"$(sc_split_endpoint "$rem")"
    fwd="$(printf '%s\n' "$fwdmap" | awk -v ip="$ip" '$1 == ip { print $2; exit }')"
    rname=""
    if ! sc_is_loopback "$ip" && [ -z "$fwd" ]; then rname="$(sc_reverse "$ip")"; fi
    verdict="$(sc_classify_remote "$ip" "$rname" "$fwd")"
    case "$verdict" in
      ok*)
        ok_count=$((ok_count + 1))
        rows="${rows}${proto} ${state} -> ${rem}  ${verdict#ok$'\t'}  [expected]"$'\n'
        ;;
      *)
        unexpected=$((unexpected + 1))
        rows="${rows}${proto} ${state} -> ${rem}  ${verdict#unexpected$'\t'}  [UNEXPECTED]"$'\n'
        sc_fail "unexpected destination: ${verdict#unexpected$'\t'} (pid $pid $cmd)"
        ;;
    esac
  done <<<"$conns"

  # 3. remote-access, tunnel and VPN software
  local ra="" label name app procs cg nc ssh_state="off" vnc_state="off" tcp_listen
  for app in "Tailscale" "ZeroTier One" "AnyDesk" "TeamViewer"; do
    if [ -d "/Applications/$app.app" ]; then
      ra="${ra}installed: /Applications/$app.app"$'\n'
      sc_warn "$app is installed"
    fi
  done
  for name in tailscale zerotier-cli ngrok cloudflared frpc anydesk; do
    if command -v "$name" >/dev/null 2>&1; then
      ra="${ra}installed: CLI $name"$'\n'
      sc_warn "$name CLI is on PATH"
    fi
  done
  procs="$(ps -axo comm= 2>/dev/null)"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if label="$(sc_match_tunnel_process "$name")"; then
      ra="${ra}RUNNING: $label ($(basename "$name"))"$'\n'
      sc_fail "remote-access/tunnel software running: $label ($(basename "$name"))"
    fi
  done <<<"$procs"
  cg="$(ifconfig 2>/dev/null | sc_parse_utun_cgnat | paste -sd' ' -)"
  if [ -n "$cg" ]; then
    ra="${ra}RUNNING: utun interface with a 100.64.0.0/10 (Tailscale-range) address: $cg"$'\n'
    sc_fail "VPN-style interface with a CGNAT address: $cg"
  fi
  nc="$(scutil --nc list 2>/dev/null | grep -c 'Connected' || true)"
  if [ "${nc:-0}" -gt 0 ]; then
    ra="${ra}RUNNING: $nc connected VPN configuration(s) (scutil --nc list)"$'\n'
    sc_fail "a system VPN configuration is connected"
  fi
  tcp_listen="$(netstat -an -p tcp 2>/dev/null | sc_parse_listen_netstat)"
  if printf '%s\n' "$tcp_listen" | awk -F'\t' '$1 == 22 { f = 1 } END { exit !f }'; then ssh_state=on; fi
  if printf '%s\n' "$tcp_listen" | awk -F'\t' '$1 == 5900 { f = 1 } END { exit !f }'; then vnc_state=on; fi
  [ "$ssh_state" = on ] && sc_fail "Remote Login (ssh) is on: a listener exists on TCP 22"
  [ "$vnc_state" = on ] && sc_fail "Screen Sharing is on: a listener exists on TCP 5900"
  [ -n "$ra" ] || ra="none found"$'\n'

  # 4. ledger
  local ldir lfiles lsum="" ledger_state="ledger not yet available" f
  if ldir="$(sc_ledger_dir)"; then
    lfiles="$(sc_since_files "$ldir" "$since")"
    if [ -n "$lfiles" ]; then
      lsum="$(printf '%s\n' "$lfiles" | while IFS= read -r f; do cat "$f"; done | sc_summarize_ledger)"
      ledger_state="present"
    else
      ledger_state="present, no entries in the last $since"
    fi
  fi

  # 5. not Quoky: process names only, for transparency
  local other
  other="$(lsof -nP -iTCP -sTCP:ESTABLISHED 2>/dev/null | awk 'NR > 1 { print $1 }' | sort | uniq -c | sort -rn | head -8 | awk '{ printf "%s%s (%s)", (NR > 1 ? ", " : ""), $2, $1 }')"

  local status="PASS" code=0 i=0
  if [ ${#SC_FAILS[@]} -gt 0 ]; then status="FAIL"; code=1; fi

  if [ "$json" -eq 1 ]; then
    printf '{"time":"%s","status":"%s","ntp":"%s","service":"%s","pids":"%s","processes":"%s",' \
      "$now" "$status" "$ntp" "$(sc_json_escape "$SC_LABEL")" "$pidlist" "$(sc_json_escape "$children")"
    printf '"connections":[%s],"listeners":[%s],"remote_access":[%s],' \
      "$(sc_json_array_lines "$rows")" "$(sc_json_array_lines "$listeners")" "$(sc_json_array_lines "$ra")"
    printf '"remote_login":"%s","screen_sharing":"%s","ledger":"%s","ledger_summary":[%s],"failures":[' \
      "$ssh_state" "$vnc_state" "$ledger_state" "$(sc_json_array_lines "$lsum")"
    for f in ${SC_FAILS[@]+"${SC_FAILS[@]}"}; do
      [ "$i" -gt 0 ] && printf ','
      printf '"%s"' "$(sc_json_escape "$f")"
      i=$((i + 1))
    done
    printf '],"warnings":['
    i=0
    for f in ${SC_WARNS[@]+"${SC_WARNS[@]}"}; do
      [ "$i" -gt 0 ] && printf ','
      printf '"%s"' "$(sc_json_escape "$f")"
      i=$((i + 1))
    done
    printf ']}\n'
    return "$code"
  fi

  echo "Quoky network self-check"
  echo "========================"
  echo "Time:      $now ($tz); automatic network time: $ntp"
  echo "Service:   $SC_LABEL  pids: ${pidlist:-none}"
  echo "Processes: ${children:-none}"
  echo
  echo "Connections of the Quoky process tree ($ok_count expected, $unexpected unexpected)"
  if [ -n "$rows" ]; then printf '%s' "$rows" | sed 's/^/  /'; else echo "  none"; fi
  echo
  echo "Listening sockets (only loopback is expected)"
  if [ -n "$listeners" ]; then printf '%s' "$listeners" | sed 's/^/  /'; else echo "  none"; fi
  echo
  echo "Remote access, tunnel and VPN software"
  printf '%s' "$ra" | sed 's/^/  /'
  echo "  Remote Login (ssh): $ssh_state    Screen Sharing: $vnc_state"
  echo
  echo "Traffic ledger (last $since): $ledger_state"
  if [ -n "$lsum" ]; then printf '%s\n' "$lsum" | sed 's/^/  /'; fi
  echo
  echo "Not Quoky (established TCP by process name, for transparency): ${other:-none}"
  echo
  if [ ${#SC_WARNS[@]} -gt 0 ]; then
    echo "Warnings (these do not fail the check)"
    for f in "${SC_WARNS[@]}"; do echo "  - $f"; done
    echo
  fi
  if [ "$code" -eq 0 ]; then
    echo "RESULT: PASS (exit 0)"
  else
    echo "RESULT: FAIL (exit 1)"
    for f in "${SC_FAILS[@]}"; do echo "  - $f"; done
  fi
  return "$code"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  sc_main "$@"
  exit $?
fi
