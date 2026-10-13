#!/usr/bin/env bash
# Offline tests for the parsing functions in quoky-net-selfcheck.sh, on canned lsof / netstat / ifconfig fixtures.
# Runs nothing against the host. Usage: ops/security/quoky-net-selfcheck.test.sh   (exit 0 = all pass)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=quoky-net-selfcheck.sh
. "$HERE/quoky-net-selfcheck.sh"

PASS=0
FAIL=0
eq() { # NAME EXPECTED ACTUAL
  if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); printf 'FAIL %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3"; fi
}
ok() { # NAME CMD...
  local name="$1"; shift
  if "$@"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); printf 'FAIL %s (expected success)\n' "$name"; fi
}
no() {
  local name="$1"; shift
  if "$@"; then FAIL=$((FAIL + 1)); printf 'FAIL %s (expected failure)\n' "$name"; else PASS=$((PASS + 1)); fi
}

LSOF='COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    76277 me   27u  IPv4 0x85f70f741e0c3290      0t0  TCP 172.16.10.97:63533->149.154.166.110:443 (ESTABLISHED)
node    76277 me   28u  IPv4 0x37e720cce3464edd      0t0  TCP 172.16.10.97:63203->162.159.133.234:443 (ESTABLISHED)
node    76277 me   31u  IPv4 0xd83989abe213c35a      0t0  TCP 127.0.0.1:47613 (LISTEN)
node    76277 me   32u  IPv6 0xd83989abe213c35b      0t0  TCP *:8080 (LISTEN)
node    76277 me   33u  IPv4 0xd83989abe213c35c      0t0  UDP *:5353
node    76277 me   34u  IPv4 0xd83989abe213c35d      0t0  UDP 10.0.0.2:5000->8.8.8.8:53'
PARSED="$(printf '%s\n' "$LSOF" | sc_parse_lsof_conns)"
eq lsof-rows 6 "$(printf '%s\n' "$PARSED" | wc -l | tr -d ' ')"
eq lsof-established "76277	node	TCP	ESTABLISHED	172.16.10.97:63533	149.154.166.110:443" "$(printf '%s\n' "$PARSED" | sed -n 1p)"
eq lsof-listen "76277	node	TCP	LISTEN	127.0.0.1:47613	" "$(printf '%s\n' "$PARSED" | sed -n 3p)"
eq lsof-wildcard-listen "76277	node	TCP	LISTEN	*:8080	" "$(printf '%s\n' "$PARSED" | sed -n 4p)"
eq lsof-udp-bound "76277	node	UDP	BOUND	*:5353	" "$(printf '%s\n' "$PARSED" | sed -n 5p)"
LSOF6='COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    76277 me   30u  IPv6 0x1      0t0  TCP [2001:db8::2]:50000->[2606:4700:4400::6812:1234]:443 (ESTABLISHED)'
P6="$(printf '%s\n' "$LSOF6" | sc_parse_lsof_conns)"
eq lsof-v6-remote "[2606:4700:4400::6812:1234]:443" "$(printf '%s\n' "$P6" | cut -f6)"
eq lsof-udp-connected "76277	node	UDP	CONNECTED	10.0.0.2:5000	8.8.8.8:53" "$(printf '%s\n' "$PARSED" | sed -n 6p)"

eq split-v4 "149.154.166.110 443" "$(sc_split_endpoint 149.154.166.110:443)"
eq split-v6 "2606:4700::1 443" "$(sc_split_endpoint '[2606:4700::1]:443')"
eq split-wild "* 8080" "$(sc_split_endpoint '*:8080')"

ok loopback-v4 sc_is_loopback 127.0.0.1
ok loopback-v6 sc_is_loopback '[::1]'
no loopback-lan sc_is_loopback 172.16.10.97
no loopback-wildcard sc_is_loopback '*'

ok cidr-in sc_ip_in_cidr 149.154.166.110 149.154.160.0/20
no cidr-out sc_ip_in_cidr 8.8.8.8 149.154.160.0/20
ok cgnat-in sc_ip_in_cidr 100.100.1.2 100.64.0.0/10
no cgnat-out sc_ip_in_cidr 100.128.0.1 100.64.0.0/10
no cidr-bad-ip sc_ip_in_cidr 999.1.1.1 10.0.0.0/8

ok host-exact sc_host_allowed api.telegram.org
ok host-exact2 sc_host_allowed gateway.discord.gg
ok host-trailing-dot sc_host_allowed gmail.googleapis.com.
no host-subdomain-not-trusted sc_host_allowed evil.api.telegram.org
no host-suffix-trick sc_host_allowed notdiscord.com
no host-other sc_host_allowed tracker.example.net
no host-bare-suffix sc_host_allowed googleapis.com

eq classify-ledger "ok	api.telegram.org" "$(sc_classify_remote 149.154.166.110 api.telegram.org)"
eq classify-unverified "unverified	api.telegram.org" "$(sc_classify_remote 149.154.166.110 '' api.telegram.org)"
eq classify-loop "ok	loopback" "$(sc_classify_remote 127.0.0.1)"
eq classify-cloudflare-not-trusted "unexpected	162.159.1.1 is not in the traffic ledger and not an allowlisted host address" "$(sc_classify_remote 162.159.1.1)"
eq normalize-v6 "2606:4700::1" "$(sc_normalize_ip '[2606:4700::1]')"

ok since-24h sc_valid_since 24h
ok since-7d sc_valid_since 7d
no since-inject sc_valid_since '1$(touch /tmp/x)h'
no since-arith sc_valid_since 'a[$(id)]d'
no since-empty sc_valid_since ''
no since-bad-unit sc_valid_since 24m
no since-neg sc_valid_since -1h
CUT="$(TZ=UTC sc_cutoff 24h 1760400000)"
eq cutoff-24h 1760313600 "$CUT"
eq cutoff-7d 1759795200 "$(TZ=UTC sc_cutoff 7d 1760400000)"
eq cutoff-tz-free 1760313600 "$(TZ=Asia/Seoul sc_cutoff 24h 1760400000)"

NETSTAT='Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  127.0.0.1.47613        *.*                    LISTEN
tcp4       0      0  *.22                   *.*                    LISTEN
tcp6       0      0  *.5900                 *.*                    LISTEN
tcp4       0      0  172.16.10.97.63533     149.154.166.110.443    ESTABLISHED'
LISTEN="$(printf '%s\n' "$NETSTAT" | sc_parse_listen_netstat | cut -f1 | paste -sd, -)"
eq netstat-listen 47613,22,5900 "$LISTEN"

IFCONFIG='lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
	inet 127.0.0.1 netmask 0xff000000
utun3: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
	inet 100.101.102.103 --> 100.101.102.103 netmask 0xffffffff
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1380
	inet6 fe80::1%utun4 prefixlen 64 scopeid 0xf
utun5: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500
	inet 10.8.0.2 --> 10.8.0.1 netmask 0xffffff00'
eq utun-cgnat utun3 "$(printf '%s\n' "$IFCONFIG" | sc_parse_utun_cgnat)"
eq utun-none "" "$(printf 'lo0: flags=1\n\tinet 127.0.0.1\n' | sc_parse_utun_cgnat)"

for n in tailscaled /Applications/Tailscale.app/Contents/PlugIns/IPNExtension.appex/Contents/MacOS/IPNExtension; do
  eq "tunnel-$n" Tailscale "$(sc_match_tunnel_process "$n")"
done
eq tunnel-zerotier ZeroTier "$(sc_match_tunnel_process zerotier-one)"
eq tunnel-ngrok ngrok "$(sc_match_tunnel_process /usr/local/bin/ngrok)"
eq tunnel-cloudflared cloudflared "$(sc_match_tunnel_process cloudflared)"
eq tunnel-anydesk AnyDesk "$(sc_match_tunnel_process AnyDesk)"
eq tunnel-teamviewer TeamViewer "$(sc_match_tunnel_process TeamViewer_Service)"
no tunnel-none sc_match_tunnel_process /usr/bin/ssh-agent
no tunnel-node sc_match_tunnel_process node

LEDGER='{"v":1,"kind":"request","ts":"2026-10-13T09:00:00+09:00","host":"api.telegram.org","label":"telegram","initiator":"startup","method":"POST","path":"/getUpdates","status":200,"bytesUp":100,"bytesDown":900,"latencyMs":5,"outcome":"ok"}
{"v":1,"kind":"request","ts":"2026-10-13T09:00:01+09:00","host":"api.telegram.org","initiator":"owner-turn","bytesUp":50,"bytesDown":50,"outcome":"ok"}
{"v":1,"kind":"connect","ts":"2026-10-13T09:00:01+09:00","host":"api.telegram.org","ip":"149.154.166.110","port":443,"outcome":"pinned"}
{"v":1,"kind":"connect","ts":"2026-10-13T09:00:01+09:00","host":"bad.example.net","ip":"203.0.113.9","port":443,"outcome":"refused"}
{"v":1,"kind":"guard","ts":"2026-10-13T09:00:02+09:00","host":"tracker.example.net","event":"new-destination","detail":"x","mode":"observe","action":"observed"}
{"v":1,"kind":"guard","ts":"2026-10-13T09:00:03+09:00","host":"tracker.example.net","event":"new-destination","detail":"x","mode":"observe","action":"observed"}
{"v":1,"kind":"request","ts":"2026-10-12T01:00:00+09:00","host":"old.example.net","initiator":"brief","bytesUp":999,"bytesDown":999,"outcome":"ok"}'
SUM="$(printf '%s\n' "$LEDGER" | sc_summarize_ledger 1791817200)" # 2026-10-13T00:00:00+09:00
eq ledger-total "lines=6 requests=2 up=150 down=950" "$(printf '%s\n' "$SUM" | grep '^lines=')"
eq ledger-host "host	api.telegram.org	2	1100" "$(printf '%s\n' "$SUM" | grep '^host')"
eq ledger-initiator "initiator	owner-turn	1" "$(printf '%s\n' "$SUM" | grep 'owner-turn')"
eq ledger-guard "guard	new-destination	tracker.example.net	2" "$(printf '%s\n' "$SUM" | grep '^guard')"
eq ledger-window-excludes-old "0" "$(printf '%s\n' "$SUM" | grep -c old.example.net)"
eq ledger-connect-map "149.154.166.110 api.telegram.org" "$(printf '%s\n' "$LEDGER" | sc_ledger_connect_map)"

TMPD="$(mktemp -d)"
touch "$TMPD/egress-2026-10-12.jsonl" "$TMPD/egress-2026-10-13.jsonl" "$TMPD/egress-2026-10-13.1.jsonl" "$TMPD/egress-2026-10-01.jsonl" "$TMPD/other.jsonl"
eq since-files "egress-2026-10-12.jsonl egress-2026-10-13.1.jsonl egress-2026-10-13.jsonl" "$(sc_since_files "$TMPD" 1791781200 | xargs -n1 basename | paste -sd' ' -)"
rm -rf "$TMPD"

# (e) Asia/Seoul host, UTC ledger timestamps: a guard event 10 minutes ago is inside a 1h window; one 2h ago is not.
# NOW is 2025-10-13T22:00:00Z (2025-10-14 07:00 in Seoul), so the record's UTC file date is the previous local day.
NOW=1760392800
utc_iso() { TZ=UTC date -r "$1" "+%Y-%m-%dT%H:%M:%S$2" 2>/dev/null || TZ=UTC date -d "@$1" "+%Y-%m-%dT%H:%M:%S$2"; }
TZLEDGER="{\"v\":1,\"kind\":\"guard\",\"ts\":\"$(utc_iso $((NOW - 600)) .123Z)\",\"host\":\"recent.example.net\",\"event\":\"new-destination\"}
{\"v\":1,\"kind\":\"guard\",\"ts\":\"$(utc_iso $((NOW - 7200)) Z)\",\"host\":\"stale.example.net\",\"event\":\"new-destination\"}
{\"v\":1,\"kind\":\"guard\",\"ts\":\"2025-10-14T06:55:00+09:00\",\"host\":\"offset.example.net\",\"event\":\"denied-range\"}"
TZCUT="$(TZ=Asia/Seoul sc_cutoff 1h "$NOW")"
TZSUM="$(printf '%s\n' "$TZLEDGER" | TZ=Asia/Seoul sc_summarize_ledger "$TZCUT")"
eq tz-seoul-recent-utc-guard "guard	new-destination	recent.example.net	1" "$(printf '%s\n' "$TZSUM" | grep recent.example.net)"
eq tz-seoul-offset-guard "guard	denied-range	offset.example.net	1" "$(printf '%s\n' "$TZSUM" | grep offset.example.net)"
eq tz-seoul-stale-excluded 0 "$(printf '%s\n' "$TZSUM" | grep -c stale.example.net)"
TMPD="$(mktemp -d)"
touch "$TMPD/egress-2025-10-13.jsonl" "$TMPD/egress-2025-10-10.jsonl"
eq tz-seoul-utc-file-in-window egress-2025-10-13.jsonl "$(TZ=Asia/Seoul sc_since_files "$TMPD" "$TZCUT" | xargs -n1 basename | paste -sd' ' -)"
rm -rf "$TMPD"

eq json-escape 'a\"b\\c' "$(sc_json_escape 'a"b\c')"
eq json-escape-tab 'a\tb' "$(sc_json_escape "$(printf 'a\tb')")"
eq json-escape-control 'a b' "$(sc_json_escape "$(printf 'a\001b')")"
eq json-array-tab '"x\ty","z"' "$(sc_json_array_lines "$(printf 'x\ty\nz\n')")"

printf 'selfcheck tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
