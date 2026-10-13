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
ok host-sub sc_host_allowed gateway.discord.gg
ok host-trailing-dot sc_host_allowed gmail.googleapis.com.
no host-lookalike sc_host_allowed evil-discord.gg.example.com
no host-suffix-trick sc_host_allowed notdiscord.com
no host-other sc_host_allowed tracker.example.net

eq classify-fwd "ok	api.telegram.org" "$(sc_classify_remote 149.154.166.110 '' api.telegram.org)"
eq classify-range "ok	telegram range" "$(sc_classify_remote 149.154.166.110)"
eq classify-rname "ok	a.b.googleapis.com" "$(sc_classify_remote 142.250.1.1 a.b.googleapis.com)"
eq classify-loop "ok	loopback" "$(sc_classify_remote 127.0.0.1)"
eq classify-bad "unexpected	8.8.8.8 (dns.google) is not in the allowlist" "$(sc_classify_remote 8.8.8.8 dns.google)"
eq classify-bad-noname "unexpected	8.8.4.4 (no hostname) is not in the allowlist" "$(sc_classify_remote 8.8.4.4)"

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

LEDGER='{"ts":"2026-10-13T09:00:00+09:00","host":"api.telegram.org","bytesUp":100,"bytesDown":900,"initiator":"startup"}
{"ts":"2026-10-13T09:00:01+09:00","host":"api.telegram.org","bytesUp":50,"bytesDown":50,"initiator":"owner-turn"}
{"ts":"2026-10-13T09:00:02+09:00","host":"discord.com","bytesUp":10,"bytesDown":20,"initiator":"owner-turn"}'
SUM="$(printf '%s\n' "$LEDGER" | sc_summarize_ledger)"
eq ledger-total "lines=3 up=160 down=970" "$(printf '%s\n' "$SUM" | grep '^lines=')"
eq ledger-host "host	api.telegram.org	2	1100" "$(printf '%s\n' "$SUM" | grep 'api.telegram.org')"
eq ledger-initiator "initiator	owner-turn	2" "$(printf '%s\n' "$SUM" | grep 'owner-turn')"

eq json-escape 'a\"b\\c' "$(sc_json_escape 'a"b\c')"

printf 'selfcheck tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
