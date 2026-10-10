# hyprpi remote control

A small web app for Angus's iPhone (and any browser on his tailnet): chat with a world's
**Thoughts** agent from anywhere. One top bar, always visible (also with the keyboard open): the
world chips (the desktop bar's worlds: A–E always, F–I while in use, live) and the tabs
Thgt · Proj · Agnt (Proj: this world's projects, one open at a time as a short summary; Agnt: its agents as the desktop agents panel lists them, one open at a time as a short read-only summary; Strm: the world's Stream, one line per event, a tap opens an event in place and closes it again; a 🔍 filter bar at the bottom with the desktop Stream panel's own syntax, kind chips and "search all history"; Fils: the Files app embedded (browse, view, upload to ~/Phone, Share, Send… to Thoughts or any live agent), and file links anywhere in π open there). Board card:
`@hyprpi-remote-control` (world D). Phone first; an iPad layout comes later.

- `server.mjs`: plain Node, no dependencies. Listens on **127.0.0.1:8897** only, holds one
  connection to the hyprpi daemon (`ui.subscribe`) and relays it to the page as Server-Sent Events.
- `index.html`, `app.js`, `style.css`: the page (`md.mjs`: its small Markdown renderer, shared with the document viewer; the colours
  follow the Omarchy theme, the world chips the hyprpi world colours).
- Messages are sent with `thoughts.send {via: "phone"}`: the thread marks them 📱 and Thoughts is
  told Angus is away from the desk (no windows brought up unless he asks). The phone marks
  nothing as seen.
- Links in replies: `file:///…` links open read-only through `/file`, only files under
  `~/Obsidian`, `~/Work`, `~/Downloads`, `~/Documents`, `~/Screenshots` (J69) and `~/Phone` (J74, the Files app's uploads); never a hidden path (any `.x` part) or
  anything named like a key or credential (*.pem, *.key, id_rsa*, id_ed25519*, *.p12, *.kdbx,
  *secret*, *token*, *credential*, *password*, *wallet* …), checked before and after symlinks.
- File links and thumbnails open in the app's own file viewer (`fileview.mjs`, J70), never as a new
  page: ✕ goes back to the same place, Share sends the file itself (iOS share sheet: Messages,
  Save Image, Copy). Images fitted (pinch / double-tap zoom, long-press Save/Copy), Markdown in the
  J56 viewer (its links open in the viewer too, ‹ back), PDFs framed, text as text, else Download.

## The Files app (J74)

A second Home Screen app on the same server: `https://<this machine>.<tailnet>.ts.net:8443/files/`
(open it in Safari, Share → Add to Home Screen; its own icon, the π folder). Browse the allowed
folders (`/api/ls`, the same J47 rules: hidden and key-like names never listed), open files in the
J70 viewer, search names everywhere (J142: typing filters the folder at once, and `/api/find` lists matching folder and file names across all the allowed roots via fd, clutter like node_modules/.git/build skipped, each hit re-checked by the read guard, folders first, 60 max), Select several → Share (one iOS share sheet with all the files), **⬆ Upload** phone
photos/files into **`~/Phone`** (the app's only write: `POST /api/upload`, files-routes.mjs), and
**→ Thoughts**: a note plus the files to a world's Thoughts (📱; images reach the model as images).

Upload rules: one plain name (no folders, not hidden, not key-like), never overwrites ("name (2).ext"),
250 MB a file, 1000 MB / 50 files per Upload tap, 5 GB always left free, at most 4 at once, a
minute without data ends it (env `HYPRPI_UPLOAD_MAX_FILE_MB`, `…_MAX_BATCH_MB`, `…_MAX_BATCH_FILES`,
`…_KEEP_FREE_GB`). Writes need the page's token (`/api/files/token`) and its own Origin. Log:
`~/.local/state/hyprpi/phone-uploads.log`. iOS doesn't let web apps appear in the Share sheet, so
sending from Photos starts in Files (Upload), not in Photos.

The server answers only to its own host names (localhost on its port, this machine's tailnet name;
more with `HYPRPI_REMOTE_HOSTS`), against DNS rebinding. Files from `/file` are never sniffed, and
anything that could run script (HTML, SVG, …) opens sandboxed.

## Who can reach it

`tailscale serve` publishes it on the tailnet only (never Funnel):
`https://<this machine>.<tailnet>.ts.net:8443/` (`tailscale serve status` shows it). Requests through Tailscale carry
`Tailscale-User-Login`, which must be this machine's own Tailscale login (extra ones:
`HYPRPI_REMOTE_LOGINS=a@x,b@y`). Requests without it must come from 127.0.0.1. POSTs must come
from the page itself (Origin check). There is no shell and no file writing.

## Run it

- Folders: what it may read, where uploads go and the Obsidian vault are `phone.folders`, `phone.uploadDir` and `phone.vault` in `~/.config/hyprpi/config.json` (see the main README, Config).
- Service (installed, starts at login): `systemctl --user restart hyprpi-remote-control`
- Logs: `journalctl --user -u hyprpi-remote-control -f`
- Install on another machine: `hyprpi remote install` (or `hyprpi integration install remote`): writes the unit with this checkout's path and enables it; `hyprpi remote status` shows it
- Publish on the tailnet (once; it persists): `tailscale serve --bg --https=8443 http://127.0.0.1:8897`
- Stop publishing: `tailscale serve --https=8443 off`
- By hand: `node <hyprpi>/remote-control/server.mjs` (port: `HYPRPI_REMOTE_PORT`)

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
| `POST /api/files/agent {agent, note, paths}` | a note + files to a live agent (Fils' Send…): its prompt lists the paths, like a pasted image (same token/Origin checks as Files) |
| `GET /api/session?agent=ID[&before=B\|&after=B]` | an agent's session page (J161): its last 10 turns read from the TAIL of its session file only (session-read.mjs; 1 MB chunks, capped), 10 more before byte B, or what came after B (live) |
| `GET /api/session/img?agent=&at=&i=` | an image inline in its session (by line offset) |
| `POST /api/agent/send\|interrupt\|stop {agent, text}` | a message from the phone (queued if it's working), Interrupt (stop its turn; the message is its next turn), Stop (like Esc); daemon `agent.interrupt` |
| `GET /lib/tui/agent-click.mjs` | the desktop panels' Ctrl+click name matcher, as-is: names in the page become links (agent → Agnt, @project → Proj, Thoughts-X → Thgt, switching world) |
| `GET /lib/thoughts-lines.mjs` | the thread's display rule, the same module the desktop Thoughts window uses |
| `POST /api/send {world, text, images?}` | to Thoughts (`thoughts.send`, via phone); `images`: up to 8 photos already uploaded to ~/Phone (📎 on the Thgt box, J219: shrunk to ≤ 2048 px JPEG on the phone first; each must be an allowed image ≤ 10 MB) |
| `POST /api/shot?world=&caption=` | anything from the iOS share sheet (an iOS Shortcut, "Send to π"; raw body ≤ 500 MB, `X-Shot-Token` from ~/.config/hyprpi/phone-shot-token, 0600; optional `X-File-Name`). Images (J250): saved in ~/Phone as screenshot-…; HEIC/AVIF or over 5 MB → JPEG ≤ 2048 px (vips); sent to that world's Thoughts like 📎. J415: PDFs, videos, audio and other files are saved in ~/Phone (their shared name, else pdf-/video-/file-…) and Thoughts gets the path; a URL, a Safari page (its canonical URL) or text ≤ 4000 chars is sent as the message itself. Over 500 MB → 413 "too big: 500 MB at most". No world: the one last written to from the phone, else the desktop's. Setup page with the URL, token and steps: `/shortcut` |
| `POST /api/decide {world, project, h, answer, typed?}` | answer a Decide item (`board.item decide`, as the desktop panel; Angus is the decider). The Proj tab: tap an option or "Answer in my own words…" → a confirm sheet → this (J219) |
| `POST /api/stop {world}` | interrupt Thoughts |
| `GET /events` | SSE: `state`, `thoughts {room, entry?, busy?}` |
| `GET /file?path=X.md` | the document viewer (viewer.html/viewer.js): the file rendered with md.mjs, a raw toggle; `&raw=1` gives the text (same guard) |
| `GET /wiki?name=&from=` | an Obsidian [[wiki link]]: the vault file of that name (nearest to the linking note), redirected to /file |
| `GET /file?path=` | a file under ~/Obsidian, ~/Work, ~/Downloads, ~/Documents or ~/Screenshots, read-only (no hidden paths, no key/credential names) |

Next (card): 📎 photos into Thoughts (the daemon already takes image paths), Projects and Agents
tabs, iPad layout, notifications for ding/bonk, desktop control on request.
