# Remote-access inventory

Scope: Quoky Platform on the owner's Mac (ADR-0121 S0; MSIT items 1-2 and 3-5). Last reviewed 2026-10-13.

## Statement

- **Quoky uses no inbound remote access.** It has no inbound port for the internet: Telegram is long polling, the Discord
  gateway is an outbound websocket, and every connector is an outbound HTTPS call to a fixed host.
- **The only listener is the ops UI**, default off (`QUOKY_OPS_UI_ENABLED`), bound to `127.0.0.1` only (default port
  47613, no bind-address setting), behind a per-start token file (mode 0600) and a 12-hour session.
- **Quoky needs no VPN, tunnel, remote-desktop or file-sharing tool** and none is part of its operation. Screen Sharing and
  Remote Login (ssh) are off on this host; if a remote maintenance session is ever needed, it is time-boxed, owner-approved
  and removed afterwards (MSIT 3-5).

## Inventory (2026-10-13)

| Item | State | Action |
|---|---|---|
| Quoky listeners | One: `127.0.0.1:47613` (ops UI, loopback) | None |
| Quoky outbound | Telegram and Discord only (idle); connectors on demand | Allowlist in design section 5.1 |
| Remote Login (ssh), Screen Sharing | Off | Keep off |
| Tailscale | Installed, **logged out** on 2026-10-13; the network extension may still run until removal | **Owner is removing it manually** (app, network extension, VPN profile) |
| ZeroTier, ngrok, cloudflared, frp, AnyDesk, TeamViewer | Not installed | Report if found |

## How to verify

```bash
ops/security/quoky-net-selfcheck.sh            # report for the security team
ops/security/quoky-net-selfcheck.sh --json     # same, machine-readable
```

Exit 0 means: only expected destinations, only loopback listeners, no tunnel, VPN or remote-access software running, and
Remote Login and Screen Sharing off. Exit 1 lists each failure with its reason. Until Tailscale (its `IPNExtension`
process and VPN configuration) is removed, the check reports it and exits 1; that is the expected signal, not a defect.

After the owner removes Tailscale: delete `/Applications/Tailscale.app`, remove the VPN configuration (System Settings,
VPN) and the network extension (System Settings, General, Login Items and Extensions, Network Extensions), reboot, then run the
self-check again and keep the exit-0 report with the date in this file's history. Re-run it after any host change and
whenever the security team asks.
