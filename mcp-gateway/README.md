# mcp-gateway

One shared, lazily started copy of each stdio MCP server for all your pi agents. Part of hyprpi
(its many parallel agents are what make it necessary), but standalone: plain Node, no hyprpi
dependency, so it works with any pi setup.

**Why:** pi's built-in MCP starts every enabled stdio server at session start, once per pi process.
With ~30 agents that was ~100 server processes and several GB idle. With the gateway, a server
runs only while it's being used and stops after `idleMin` minutes without calls: 0 server
processes at rest.

**How it works:**

- pi connects to `http://127.0.0.1:<port>/<name>` (streamable HTTP, plain JSON responses).
- `initialize` and the `*/list` calls are answered from a cache (`~/.cache/mcp-gateway/<name>.json`),
  so connecting starts nothing.
- The real server starts on the first call that needs it (`tools/call`, `resources/read`, …) and
  stops after `idleMin` minutes without calls. Each start refreshes the cache.
- By default one copy is shared by every agent. `"perSession": true` gives each MCP session (agent)
  its own copy, still lazy and idle-stopped, for servers that keep per-client state (e.g. hyprcu).

## Config

Copy the example to `~/.config/mcp-gateway/servers.json` (or set `MCP_GATEWAY_CONFIG`) and list your
stdio servers. See `servers.example.json`; `port` defaults to 8790 and `idleMin` to 10.

Then point pi at the gateway in `~/.pi/agent/mcp.json`, one entry per server, in place of its
`command`:

```json
"hyprcu": { "url": "http://127.0.0.1:8790/hyprcu", "exposure": "direct" }
```

## Install (systemd --user)

`hyprpi mcp-gateway install` links `mcp-gateway.service` into `~/.config/systemd/user/` and runs
`systemctl --user enable --now mcp-gateway`. It's idempotent: a link that's already correct is left
alone, and it refuses to overwrite a different file. `hyprpi mcp-gateway status` shows the unit, the
port and which servers are running.

By hand: `ln -s ~/Work/hyprpi/mcp-gateway/mcp-gateway.service ~/.config/systemd/user/ && systemctl --user enable --now mcp-gateway`

The unit's `%h/Work/hyprpi` path ties it to this checkout; edit `ExecStart` if hyprpi lives
elsewhere. Without systemd: `node mcp-gateway/gateway.mjs`. Logs go to
`journalctl --user -u mcp-gateway`.

Restarting it briefly drops in-flight calls: an agent mid-call (e.g. a hyprcu screenshot) gets an
error and can retry.
