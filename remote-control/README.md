# hyprpi remote control

A small web app for Angus's iPhone (and any browser on his tailnet): chat with a world's
**Thoughts** agent from anywhere. One top bar, always visible (also with the keyboard open): the
world chips (the desktop bar's worlds: A–E always, F–I while in use, live) and the tabs
Thgt · Proj · Agnt (Proj: this world's projects, one open at a time as a short summary; Agnt: its agents as the desktop agents panel lists them, one open at a time as a short read-only summary; Strm: the world's Stream, one line per event, a tap opens an event in place and closes it again; a 🔍 filter bar at the bottom with the desktop Stream panel's own syntax, kind chips and "search all history"). Board card:
`@hyprpi-remote-control` (world D). Phone first; an iPad layout comes later.

- `server.mjs`: plain Node, no dependencies. Listens on **127.0.0.1:8897** only, holds one
  connection to the hyprpi daemon (`ui.subscribe`) and relays it to the page as Server-Sent Events.
- `index.html`, `app.js`, `style.css`: the page (`md.mjs`: its small Markdown renderer, shared with the document viewer; the colours
  follow the Omarchy theme, the world chips the hyprpi world colours).
- Messages are sent with `thoughts.send {via: "phone"}`: the thread marks them 📱 and Thoughts is
  told Angus is away from the desk (no windows brought up unless he asks). The phone marks
  nothing as seen.
- Links in replies: `file:///…` links open read-only through `/file`, only files under
  `~/Obsidian`, `~/Work`, `~/Downloads` and `~/Documents`; never a hidden path (any `.x` part) or
  anything named like a key or credential (*.pem, *.key, id_rsa*, id_ed25519*, *.p12, *.kdbx,
  *secret*, *token*, *credential*, *password*, *wallet* …), checked before and after symlinks.

## Who can reach it

`tailscale serve` publishes it on the tailnet only (never Funnel):
`https://<this machine>.<tailnet>.ts.net:8443/` (`tailscale serve status` shows it). Requests through Tailscale carry
`Tailscale-User-Login`, which must be this machine's own Tailscale login (extra ones:
`HYPRPI_REMOTE_LOGINS=a@x,b@y`). Requests without it must come from 127.0.0.1. POSTs must come
from the page itself (Origin check). There is no shell and no file writing.

## Run it

- Service (installed, starts at login): `systemctl --user restart hyprpi-remote-control`
- Logs: `journalctl --user -u hyprpi-remote-control -f`
- Install on another machine: `ln -s ~/Work/hyprpi/remote-control/hyprpi-remote-control.service ~/.config/systemd/user/ && systemctl --user enable --now hyprpi-remote-control`
- Publish on the tailnet (once; it persists): `tailscale serve --bg --https=8443 http://127.0.0.1:8897`
- Stop publishing: `tailscale serve --https=8443 off`
- By hand: `node ~/Work/hyprpi/remote-control/server.mjs` (port: `HYPRPI_REMOTE_PORT`)

## The icon

π ringed by the world colours (J61, Angus's pick of four in `icon-options/`): `icon-180.png` (apple-touch-icon), `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `favicon.png`; `manifest.webmanifest` (standalone). After an icon change, remove and re-add the Home Screen icon (iOS caches it).

## On the iPhone

The Tailscale app must be connected. Open the address in Safari. To make it an app: Share →
**Add to Home Screen** (no App Store, no developer account; delete it like any app).

## API

| | |
|---|---|
| `GET /api/state` | worlds (colour, agent count, Thoughts busy, `shown`: the desktop bar's rule, see server.mjs), the desktop's active world, theme |
| `GET /api/thoughts?world=C` | the thread (`thoughts.get`, last 300 entries) |
| `GET /api/board?world=C` | the Proj tab: each project's summary (status, where, open decide/next/done items, next step; no archive, no Heard) |
| `GET /api/agents?world=C` | the Agnt tab: the world's agents in the desktop panel's order, each with mark, topic, workspace, last turn, model, current job, projects, last room posts |
| `GET /api/stream?world=C` | the Strm tab: the world's Stream as the desktop Stream panel builds it (lib/stream.mjs, last 200 interactions) |
| `GET /lib/tui/agent-click.mjs` | the desktop panels' Ctrl+click name matcher, as-is: names in the page become links (agent → Agnt, @project → Proj, Thoughts-X → Thgt, switching world) |
| `GET /lib/thoughts-lines.mjs` | the thread's display rule, the same module the desktop Thoughts window uses |
| `POST /api/send {world, text}` | to Thoughts (`thoughts.send`, via phone) |
| `POST /api/stop {world}` | interrupt Thoughts |
| `GET /events` | SSE: `state`, `thoughts {room, entry?, busy?}` |
| `GET /file?path=X.md` | the document viewer (viewer.html/viewer.js): the file rendered with md.mjs, a raw toggle; `&raw=1` gives the text (same guard) |
| `GET /wiki?name=&from=` | an Obsidian [[wiki link]]: the vault file of that name (nearest to the linking note), redirected to /file |
| `GET /file?path=` | a file under ~/Obsidian, ~/Work, ~/Downloads or ~/Documents, read-only (no hidden paths, no key/credential names) |

Next (card): 📎 photos into Thoughts (the daemon already takes image paths), Projects and Agents
tabs, iPad layout, notifications for ding/bonk, desktop control on request.
