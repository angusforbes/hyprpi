# hyprpi remote control

A small web app for Angus's iPhone (and any browser on his tailnet): chat with a world's
**Thoughts** agent from anywhere. One top bar, always visible (also with the keyboard open): the
world chips (the desktop bar's worlds: A–E always, F–I while in use, live) and the tabs
Thgt · Proj · Agnt (Proj and Agnt come later). Board card:
`@hyprpi-remote-control` (world D). Phone first; an iPad layout comes later.

- `server.mjs`: plain Node, no dependencies. Listens on **127.0.0.1:8897** only, holds one
  connection to the hyprpi daemon (`ui.subscribe`) and relays it to the page as Server-Sent Events.
- `index.html`, `app.js`, `style.css`: the page (its own small Markdown renderer; the colours
  follow the Omarchy theme, the world chips the hyprpi world colours).
- Messages are sent with `thoughts.send {via: "phone"}`: the thread marks them 📱 and Thoughts is
  told Angus is away from the desk (no windows brought up unless he asks). The phone marks
  nothing as seen.
- Links in replies: `file:///…` links open read-only through `/file`, only files under
  `~/Obsidian` and `~/Work`.

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

## On the iPhone

The Tailscale app must be connected. Open the address in Safari. To make it an app: Share →
**Add to Home Screen** (no App Store, no developer account; delete it like any app).

## API

| | |
|---|---|
| `GET /api/state` | worlds (colour, agent count, Thoughts busy, `shown`: the desktop bar's rule, see server.mjs), the desktop's active world, theme |
| `GET /api/thoughts?world=C` | the thread (`thoughts.get`, last 300 entries) |
| `POST /api/send {world, text}` | to Thoughts (`thoughts.send`, via phone) |
| `POST /api/stop {world}` | interrupt Thoughts |
| `GET /events` | SSE: `state`, `thoughts {room, entry?, busy?}` |
| `GET /file?path=` | a file under ~/Obsidian or ~/Work, read-only |

Next (card): 📎 photos into Thoughts (the daemon already takes image paths), Projects and Agents
tabs, iPad layout, notifications for ding/bonk, desktop control on request.
