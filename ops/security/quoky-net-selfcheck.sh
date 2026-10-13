#!/usr/bin/env bash
# shellcheck shell=bash
# Quoky network self-check (ADR-0121 S0, design section 5.5, MSIT items 1-2, 4-4, 4-5, 5-3).
#
#   ops/security/quoky-net-selfcheck.sh [--json] [--since 24h|7d] [--expect-stopped]
#
# Read-only, no sudo, macOS first (bash 3.2 safe). It prints a one-page report the owner can hand to the security
# team: the Quoky process tree, its live TCP/UDP connections against the expected host allowlist, its listening
# sockets, remote-access / tunnel / VPN software, and a summary of the traffic ledger when one exists.
# It never prints an environment value, a token, a header or a file content (only names, addresses and counts).
# Exit 0 = every check passed; 1 = at least one finding (each is printed with its reason); 2 = usage.
# --expect-stopped: for the step before a restart (incident recovery): the service must NOT be running, and the rest
# (tunnel/VPN software, listeners on 22 and 5900, ledger findings) must still be clean.
#
# Environment (optional): QUOKY_LAUNCHD_LABEL (default com.quoky.personal), QUOKY_SELFCHECK_EXTRA_HOSTS (space
# separated EXACT host names to add to the static allowlist), QUOKY_OPS_UI_PORT (default 47613), QUOKY_LEDGER_DIR.
#
# Sourcing this file defines the parsing functions only (used by quoky-net-selfcheck.test.sh); it runs when executed.

SC_LABEL="${QUOKY_LAUNCHD_LABEL:-com.quoky.personal}"
SC_OPS_PORT="${QUOKY_OPS_UI_PORT:-47613}"

# Static allowlist of EXACT host names (design 5.1). A live remote address is verified by the traffic ledger's
# `connect` records (IP -> host, design 5.5.3). With no ledger mapping it is "unverified" (a warning); it is a failure
# only when its address is also not one of these hosts' own forward-resolved addresses. Reverse DNS (PTR) names and
# provider address ranges are never trusted.
SC_ALLOWED_HOSTS="api.telegram.org gateway.discord.gg discord.com cdn.discordapp.com media.discordapp.net api.anthropic.com \
www.googleapis.com gmail.googleapis.com oauth2.googleapis.com slack.com api.github.com github.com"
# Guard findings in the ledger window that fail the check; other guard events are warnings.
SC_FAIL_GUARD_EVENTS="new-destination denied-range budget-exceeded"

# ---------------------------------------------------------------- parsing helpers (pure, unit-tested)

# sc_json_escape STRING -> JSON string body (no quotes): escapes backslash, quote, tab and newline; other control
# characters become spaces.
sc_json_escape() {
  printf '%s' "$1" | LC_ALL=C tr '\000-\010\013-\037' ' ' | awk 'BEGIN { ORS = "" }
    { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); print sep $0; sep = "\\n" }'
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

# sc_host_allowed NAME -> success when NAME is exactly an allowlisted host (or an extra exact host).
sc_host_allowed() {
  local name host
  name="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  name="${name%.}"
  for host in $SC_ALLOWED_HOSTS ${QUOKY_SELFCHECK_EXTRA_HOSTS:-}; do
    [ "$name" = "$host" ] && return 0
  done
  return 1
}

# sc_normalize_ip IP -> lowercase, without brackets.
sc_normalize_ip() {
  local ip="$1"
  ip="${ip#\[}"
  ip="${ip%\]}"
  printf '%s' "$ip" | tr '[:upper:]' '[:lower:]'
}

# sc_classify_remote IP LEDGER_HOST STATIC_HOST
# -> "ok<TAB>host" (verified by a ledger connect record), "unverified<TAB>host" (no ledger mapping, but the address is a
#    static-allowlist host's), "unexpected<TAB>reason" (neither), or "ok<TAB>loopback".
sc_classify_remote() {
  local ip="$1" ledger_host="${2:-}" static_host="${3:-}"
  if sc_is_loopback "$ip"; then printf 'ok\tloopback\n'; return 0; fi
  if [ -n "$ledger_host" ]; then printf 'ok\t%s\n' "$ledger_host"; return 0; fi
  if [ -n "$static_host" ]; then printf 'unverified\t%s\n' "$static_host"; return 0; fi
  printf 'unexpected\t%s is not in the traffic ledger and not an allowlisted host address\n' "$ip"
  return 0
}

# sc_cutoff SINCE [NOW_EPOCH] -> epoch seconds of now minus SINCE (timezone-free). SINCE must match ^[0-9]+[hd]$.
sc_valid_since() {
  [[ "$1" =~ ^[0-9]{1,4}[hd]$ ]]
}
sc_cutoff() {
  local since="$1" now="${2:-}" n unit secs epoch
  sc_valid_since "$since" || return 1
  n="${since%[hd]}"
  unit="${since#"$n"}"
  n=$((10#$n))
  if [ "$unit" = h ]; then secs=$((n * 3600)); else secs=$((n * 86400)); fi
  [ -n "$now" ] || now="$(date +%s)"
  epoch=$((now - secs))
  echo "$epoch"
}

# sc_utc_date EPOCH -> UTC "YYYY-MM-DD".
sc_utc_date() {
  TZ=UTC date -r "$1" '+%Y-%m-%d' 2>/dev/null || TZ=UTC date -d "@$1" '+%Y-%m-%d'
}

# Ledger records (ADR-0121, branch egress): JSON lines with v:1 and kind request|connect|guard; ts is ISO-8601 with
# `Z` (UTC) or a +-HH:MM offset (a ts without a zone is read in the host's current offset).
# sc_summarize_ledger CUTOFF_EPOCH < JSON lines
#   -> "lines=N requests=R up=B down=B", then "host<TAB>h<TAB>count<TAB>bytes", "initiator<TAB>i<TAB>count" (request
#      records only: bytes are never summed over connect or guard records) and "guard<TAB>event<TAB>host<TAB>count".
#   Records whose ts (converted to epoch seconds) is older than CUTOFF_EPOCH are ignored. A record whose ts cannot be
#   parsed is kept (fail closed: a guard finding is never dropped for its timestamp format).
sc_summarize_ledger() {
  awk -v cutoff="$1" -v localoff="$(date +%z)" '
    function field(s, key,   re, m) {
      re = "\"" key "\"[ ]*:[ ]*(\"[^\"]*\"|[0-9]+)"
      if (match(s, re)) { m = substr(s, RSTART, RLENGTH); sub(/^[^:]*:[ ]*/, "", m); gsub(/"/, "", m); return m }
      return ""
    }
    function zone(z,   sign) { # "+0900", "+09:00", "Z" or "" -> offset seconds east of UTC; -1e9 = invalid
      if (z == "Z" || z == "z") return 0
      gsub(/:/, "", z)
      if (z !~ /^[+-][0-9][0-9][0-9][0-9]$/) return -1e9
      sign = substr(z, 1, 1) == "-" ? -1 : 1
      return sign * (substr(z, 2, 2) * 3600 + substr(z, 4, 2) * 60)
    }
    function epoch(ts,   y, mo, d, rest, off) { # ISO-8601 -> epoch seconds, or -1 when unparseable
      if (ts !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) return -1
      y = substr(ts, 1, 4) + 0; mo = substr(ts, 6, 2) + 0; d = substr(ts, 9, 2) + 0
      rest = substr(ts, 20); sub(/^\.[0-9]+/, "", rest)
      off = rest == "" ? zone(localoff) : zone(rest)
      if (off == -1e9) return -1
      if (mo <= 2) { y--; mo += 12 }
      return (365 * y + int(y / 4) - int(y / 100) + int(y / 400) + int((153 * (mo - 3) + 2) / 5) + d - 719469) * 86400 \
        + substr(ts, 12, 2) * 3600 + substr(ts, 15, 2) * 60 + substr(ts, 18, 2) - off
    }
    {
      ts = field($0, "ts")
      e = epoch(ts)
      if (e >= 0 && e < cutoff + 0) next
      n++
      k = field($0, "kind"); h = field($0, "host")
      if (k == "request") {
        r++; u = field($0, "bytesUp") + 0; d = field($0, "bytesDown") + 0; i = field($0, "initiator")
        up += u; down += d
        if (h != "") { hc[h]++; hb[h] += u + d }
        if (i != "") ic[i]++
      } else if (k == "guard") {
        e = field($0, "event"); gc[e "\t" h]++
      }
    }
    END {
      printf "lines=%d requests=%d up=%d down=%d\n", n, r, up, down
      for (h in hc) printf "host\t%s\t%d\t%d\n", h, hc[h], hb[h]
      for (i in ic) printf "initiator\t%s\t%d\n", i, ic[i]
      for (g in gc) printf "guard\t%s\t%d\n", g, gc[g]
    }' | sort
}

# sc_ledger_connect_map < JSON lines -> "ip host" for each connect record that pinned an address.
sc_ledger_connect_map() {
  awk '
    function field(s, key,   re, m) {
      re = "\"" key "\"[ ]*:[ ]*(\"[^\"]*\"|[0-9]+)"
      if (match(s, re)) { m = substr(s, RSTART, RLENGTH); sub(/^[^:]*:[ ]*/, "", m); gsub(/"/, "", m); return m }
      return ""
    }
    field($0, "kind") == "connect" && field($0, "outcome") == "pinned" {
      ip = tolower(field($0, "ip")); h = field($0, "host")
      if (ip != "" && h != "") print ip, h
    }' | sort -u
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

sc_since_files() { # DIR CUTOFF_EPOCH -> ledger files (incl. egress-DATE.N.jsonl parts) dated on or after the UTC day
  # before the cutoff: one day of slack covers a file named by local or by UTC date in any timezone (records are then
  # filtered exactly by their own ts).
  local dir="$1" cutoff f d
  cutoff="$(sc_utc_date "$(($2 - 86400))")"
  for f in "$dir"/egress-*.jsonl; do
    [ -e "$f" ] || continue
    d="${f##*/egress-}"
    d="${d:0:10}"
    [[ "$d" < "$cutoff" ]] || echo "$f"
  done | sort
}

sc_resolve_forward() { # prints "IP host" for each allowlisted host (macOS dscacheutil)
  local h
  for h in $SC_ALLOWED_HOSTS; do
    dscacheutil -q host -a name "$h" 2>/dev/null | awk -v h="$h" '$1 == "ip_address:" || $1 == "ip6_address:" { print tolower($2), h }'
  done
  return 0
}

SC_FAILS=()
SC_WARNS=()
sc_fail() { SC_FAILS+=("$1"); }
sc_warn() { SC_WARNS+=("$1"); }

# sc_json_array_lines TEXT -> JSON array body of the non-empty lines.
sc_json_array_lines() {
  printf '%s' "$1" | LC_ALL=C tr '\000-\010\013-\037' ' ' | awk 'NF { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); printf "%s\"%s\"", (c++ ? "," : ""), $0 }'
}

sc_main() {
  local json=0 since="24h" expect_stopped=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) json=1 ;;
      --since)
        shift
        since="${1:-}"
        sc_valid_since "$since" || { echo "usage: quoky-net-selfcheck.sh [--json] [--since 24h|7d] [--expect-stopped]" >&2; return 2; }
        ;;
      --expect-stopped) expect_stopped=1 ;;
      -h | --help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; return 0 ;;
      *) echo "usage: quoky-net-selfcheck.sh [--json] [--since 24h|7d] [--expect-stopped]" >&2; return 2 ;;
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
    [ "$expect_stopped" -eq 1 ] && sc_fail "Quoky service ($SC_LABEL) is running but --expect-stopped was given"
  elif [ "$expect_stopped" -eq 0 ]; then
    sc_fail "Quoky service ($SC_LABEL) is not running, so its connections cannot be checked (use --expect-stopped before a restart)"
  fi

  # 0. ledger (read first: its connect records map live IPs to hosts)
  local ldir lfiles allfiles cutoff lsum="" connmap="" ledger_state="ledger not yet available" f
  cutoff="$(sc_cutoff "$since")"
  if ldir="$(sc_ledger_dir)"; then
    allfiles="$(sc_since_files "$ldir" "$(sc_cutoff 7d)")"
    [ -n "$allfiles" ] && connmap="$(printf '%s\n' "$allfiles" | while IFS= read -r f; do cat "$f"; done | sc_ledger_connect_map)"
    lfiles="$(sc_since_files "$ldir" "$cutoff")"
    if [ -n "$lfiles" ]; then
      lsum="$(printf '%s\n' "$lfiles" | while IFS= read -r f; do cat "$f"; done | sc_summarize_ledger "$cutoff")"
      ledger_state="present"
    else
      ledger_state="present, no entries in the last $since"
    fi
  fi

  # 2. connections and listeners
  local conns="" fwdmap rows="" listeners="" unexpected=0 ok_count=0 unverified=0
  local pid cmd proto state loc rem ip ledger_host fwd verdict host port
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
    ip="$(sc_normalize_ip "$ip")"
    ledger_host="$(printf '%s\n' "$connmap" | awk -v ip="$ip" '$1 == ip { print $2; exit }')"
    fwd="$(printf '%s\n' "$fwdmap" | awk -v ip="$ip" '$1 == ip { print $2; exit }')"
    verdict="$(sc_classify_remote "$ip" "$ledger_host" "$fwd")"
    case "$verdict" in
      ok*)
        ok_count=$((ok_count + 1))
        rows="${rows}${proto} ${state} -> ${rem}  ${verdict#ok$'\t'}  [verified by ledger]"$'\n'
        ;;
      unverified*)
        unverified=$((unverified + 1))
        rows="${rows}${proto} ${state} -> ${rem}  ${verdict#unverified$'\t'}  [unverified: no ledger mapping]"$'\n'
        sc_warn "unverified destination ${rem} (static allowlist host ${verdict#unverified$'\t'}, no ledger connect record)"
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

  # 4. ledger guard findings in the window (host and type); the summary was read above
  local g gevent ghost gcount
  while IFS=$'\t' read -r g gevent ghost gcount; do
    [ "$g" = guard ] || continue
    case " $SC_FAIL_GUARD_EVENTS " in
      *" $gevent "*) sc_fail "ledger guard finding in the last $since: $gevent on $ghost (x$gcount)" ;;
      *) sc_warn "ledger guard event in the last $since: $gevent on $ghost (x$gcount)" ;;
    esac
  done <<<"$lsum"

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
  echo "Connections of the Quoky process tree ($ok_count verified by ledger, $unverified unverified, $unexpected unexpected)"
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
