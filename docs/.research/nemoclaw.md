# NemoClaw / OpenShell: section for the Pi sandboxing report

Author: 🦞 Claw · J213 · 2026-10-07 · research only. Harbor owns the integrated report.

Nothing was started for this: no gateway, sandbox or container. "Local" facts below are from our
2026-09-17–29 records (`~/Work/nemoclaw/README.md`, @nemoclaw card H2–H5/N3, the NemoClaw runbook), not
fresh tests. Installed versions checked today with `--version` only: **openshell 0.0.116,
openshell-gateway 0.0.116, nemoclaw v0.0.124**; kernel 7.2.5 with Landlock in the active LSM list.

## 1. Bottom line

- **Use OpenShell (not NemoClaw) as the Pi backend.** NemoClaw is NVIDIA's OpenClaw-agent wrapper
  (onboarding, heartbeat, dashboard) on top of OpenShell; its own Pi runtime (`--agent pi`) was still not
  selectable (NemoClaw issue #7923). Pi runs directly in OpenShell with `openshell sandbox create --from pi -- pi`
  (Pi's own docs, "Run Pi with OpenShell"), and we did that successfully on 2026-09-29.
- **What it adds over our Docker launcher:** deny-by-default egress per binary and per HTTP method/path,
  credentials the agent never sees, Landlock + seccomp + non-root inside the container, logs of every
  allowed/denied connection, and an optional **MicroVM driver** (KVM) for a real VM boundary.
- **What it doesn't fix:** a sandbox handed the main hyprpi socket is not sandboxed (same as Docker).
  hyprpi access must go through a host-side bridge or the planned restricted socket.
- **Version cliff:** we run 0.0.116; current docs are 0.1.2, which **removed `inference.local`** (our
  working inference path) in favour of per-sandbox provider attachments, and moved the supervisor out of the
  workload container. Any new work should decide 0.0.116-as-is vs upgrade first, and check NemoClaw's
  compatibility before upgrading the shared gateway (upgrade guide says recreate every sandbox).

## 2. What isolates what (policy model)

Sources: [Architecture (0.1.2)](https://docs.nvidia.com/openshell/about/architecture),
[Sandbox Policies](https://docs.nvidia.com/openshell/how-it-works/policies/overview),
[Network Rules](https://docs.nvidia.com/openshell/how-it-works/policies/network-rules),
[Security Best Practices](https://docs.nvidia.com/openshell/security/best-practices),
[Inference (0.1.2)](https://docs.nvidia.com/openshell/how-it-works/inference),
[Inference Routing (0.0.116)](https://docs.nvidia.com/openshell/v0.0.116/sandboxes/inference-routing),
[Compute Drivers (0.0.116)](https://docs.nvidia.com/openshell/v0.0.116/reference/sandbox-compute-drivers),
[Manage Sandboxes (0.0.116)](https://docs.nvidia.com/openshell/v0.0.116/sandboxes/manage-sandboxes).

| Layer | Mechanism (documented) | Changeable live? |
|---|---|---|
| Gateway | Control plane: sandbox lifecycle, policy store, provider (credential) store, mTLS to CLI; issues per-sandbox, per-run JWTs | — |
| Supervisor | Trusted side: checks each connection against policy, resolves DNS, injects credentials, relays traffic, logs | — |
| Filesystem | **Landlock** (needs ABI 3 / Linux ≥ 6.2). Mandatory baseline always; your extra rules default to `best_effort` → set `compatibility: hard_requirement` | No (recreate) |
| Process | Non-root uid (root rejected), seccomp (blocks mount, ptrace, bpf, io_uring, user namespaces, AF_PACKET/VSOCK…), no core dumps | No (recreate) |
| Network | All egress goes through the supervisor's proxy; default deny; rules = host:port **+ calling binary** (real exe path from /proc, re-checked if the file changes) + optional L7 rules (`rest` method/path/query, `websocket`, `graphql`, `mcp`, `json-rpc`, raw `tcp`). Loopback/link-local always blocked; private IPs only for exact declared hosts | Yes (hot reload; operator approval in `openshell term`) |
| Credentials | Agent gets an **opaque placeholder**; real secret substituted only at the endpoints the provider profile binds it to. Allowing a host does *not* allow credentials to go there | Yes (attach/detach/rotate) |
| Inference (0.0.116) | `https://inference.local` privacy router: strips caller auth, injects provider key, rewrites the model; **one provider+model per gateway**; only chat/completions/responses/embeddings/models (OpenAI), messages (Anthropic), Bedrock invoke | Yes (~5 s) |
| Inference (0.1.x) | `inference.local` removed; attach a provider profile per sandbox, call the vendor's native endpoint with the placeholder key | Yes |

Practical policy lessons:
- **Binary identity is not trust.** Rules name the interpreter (`/usr/bin/node`, `python3`), so *any*
  script run by that interpreter inherits the access. Our literature preset allows node, curl and python
  to every API host. Keep per-host binary lists minimal; separate rules per binary when they need different hosts.
- **Allowed = exfiltration path.** A GET with a query string still carries data out; our "read-only"
  preset also allows POST to NCBI E-utilities and RCSB search. Narrow paths, prefer `access: read-only`, use
  `enforce` not `audit`, avoid wildcard hosts (DNS-label exfiltration).
- Prove policies with the **policy prover** (`openshell-prover`) and check the *effective* policy
  (`openshell policy get <sb> --full`), which includes provider-contributed rules.
- **Policy advisor** (`policy.local`) lets the agent *propose* rules; approval stays with the operator.
  Fits Angus: he approves from `openshell term` rather than pre-writing YAML.

Runtime boundary:
- **Docker driver (what we use):** the agent is in a container on the host kernel. In 0.0.116 the
  supervisor runs *inside* the workload with privileged bootstrap helpers, which matches what we saw (H3:
  SYS_ADMIN/NET_ADMIN/SYS_PTRACE/SYSLOG, apparmor unconfined, agent uid 998). The agent itself is
  unprivileged after the drop, but a kernel bug is still a host bug. 0.1.x moves the supervisor to its own
  container and gives the workload no network and no capabilities.
- **MicroVM driver** (libkrun on KVM, opt-in `compute_drivers = ["vm"]`): guest has no network device;
  supervisor talks over vsock. This is the option for untrusted code where a shared kernel is not acceptable.
  Note: VM driver ignores `--cpu/--memory` per sandbox (uses gateway-wide sizing). Not tried here.
- **Mounts:** host bind mounts are **off by default** (`enable_bind_mounts = true` in gateway TOML) and the
  docs warn they "can negate OpenShell controls". Default workflow is `sandbox upload` / `download`
  (download refuses paths escaping the workdir, including via symlinks) or named volumes.
- **Ports:** `openshell forward start 8770 <sb>` or `service expose`; loopback gateway gives local URLs only.

## 3. What we learned on this card (local, 2026-09)

- **Pi in OpenShell works.** Community image `ghcr.io/nvidia/openshell-community/sandboxes/pi` (5.1 GB,
  Pi 0.77.0, uid 998). Pi provider `openshell` → `https://inference.local/v1`, dummy key, model
  `aws/anthropic/claude-haiku-4-5-v1`. `pi -p` answered in ~11 s and used bash; log showed inference.local
  ALLOWED and curl → example.com DENIED; no API keys in the sandbox env. Not tested: escapes, exfiltration
  through allowed hosts, extensions, interactive window.
- Image pull timed out inside `sandbox create` over the VPN; `docker pull` first worked. Pi 0.77.0 in the image
  vs 1.0.2 on the host: pin and rebuild for real use.
- Inference went to NVIDIA's internal Inference Hub, so it needed the Prisma VPN. That's our upstream, not an
  OpenShell requirement.
- **Gateway start restarts every sandbox (H4).** Documented behaviour: at startup the gateway starts all
  sandboxes whose *intent* is running; only explicitly stopped ones stay stopped. Ours had crashed (not stopped),
  so `angus-claw` and `cell-cycle-scout` came back and their NemoClaw auto-pair watchers polled
  `openclaw devices list` ~1/s, timing out, one core each, 8 h deadline. Lesson: `openshell sandbox stop`
  anything not in use (it then survives restarts stopped), and check `top` after starting the gateway.
  Better: a separate gateway for Pi experiments.
- **Two gateway states (H3/N2).** The real NemoClaw gateway is `~/.local/state/nemoclaw/openshell-docker-gateway/`
  (TLS, `openshell.db`, 127.0.0.1:8080); the generic systemd unit uses `~/.local/state/openshell/tls` and :17670
  and created a second default workspace. `nemoclaw recover` refused; `~/Work/nemoclaw/start-gateway.sh` starts
  it NemoClaw's way.
- **NIM key question (H5).** In 0.0.116, `inference.local` covers chat-style LLM calls only; the nim-demos
  site's image/video/audio endpoints are other REST paths on other hosts. Provider profiles (v2, present in
  0.0.116 docs, default in 0.1.x) inject a placeholder `NVIDIA_API_KEY` and substitute it at bound hosts, which
  should cover the REST/JSON NIM calls (needs a custom profile listing `ai.api.nvidia.com`,
  `api.nvcf.nvidia.com`, etc. and the Python binary). **Unknown:** the Riva **gRPC** speech calls
  (`grpc.nvcf.nvidia.com`, key in gRPC metadata): the docs list no gRPC inspection or credential rewrite, so
  assume the key would have to be inside the sandbox for those. Not tested.
- **Sandboxing doesn't make the work correct.** The scout overwrote its own digest and hammered NCBI (429s).
  Keep immutable per-run outputs, rate limits and review.

## 4. Reaching hyprpi safely

Starting point: `hyprpi/docs/sandbox-plan.md` (design only, nothing built) and `hyprpi/docker/README.md`,
whose current warning still applies: the main socket is an Angus-level channel (`agent.prompt` with no
caller check, `as_human`, board writes as Angus with no hello). An OpenShell sandbox given that socket loses
most of its value.

Technical facts that shape the options:
- The agent **cannot reach host loopback** (always blocked) and has no host mounts by default, so there is no
  accidental path to the hyprpi socket. That's good; it also means any link is a deliberate hole.
- A Unix-socket link needs `enable_bind_mounts` on the gateway (all sandboxes on it), a gateway restart,
  socket permissions for uid 998 or the host uid, and a Landlock read-write path. A TCP link needs a host
  service reachable via `host.openshell.internal` plus a policy rule — reachable by every binary you list.
- A remote gateway can't mount a host socket at all.

Recommended path (D1 option a):

1. **Now: host-side bridge (N4), sandbox gets nothing.** A host extension or small hyprpi adapter
   lists the sandboxes it launched, shows them on a card/room with a 🦞 marker, sends jobs in through
   `openshell sandbox exec` / `upload` (or `nemoclaw <name> agent -m` for OpenClaw ones), and pulls results
   out with `download` into a quarantine folder. Posts in the room are tagged as from a sandbox. The host
   side holds all the hyprpi rights; the sandbox only ever produces files and text.
2. **Later: the restricted sandbox socket** from the plan, reached through a narrow relay, not a raw
   mount: host-assigned identity via one-time token, allowlist (room read/post, own-card board, talk to the
   room/its parent), no `agent.prompt`, no `as_human`, no window/daemon control; daemon-added "sandboxed"
   label; messages to host agents held for Angus's approval (plan gate 3b) or blocked (3a) for untrusted work.
   Window mapping still needs host-side `HYPRPI_AGENT_ID` and `HYPRPI_NO_ENSURE=1` (H2).
3. Never: main socket, Docker socket, MCP gateway (127.0.0.1:8790), `~/.pi/agent`, SSH/`gh`.

Main residual risk is **social, not technical**: a host agent that obeys a sandbox's text becomes the
confused deputy. Labels help; approval gates and "results are data, not instructions" rules matter more.

## 5. OpenShell vs plain Docker (our `hyprpi/docker`)

| | `hyprpi/docker` today | OpenShell (Docker driver) | OpenShell (MicroVM) |
|---|---|---|---|
| Kernel | shared | shared | separate guest |
| Network | open | deny-by-default, per binary + L7 | same, guest has no NIC |
| Credentials | Anthropic access token in env; `TOOLS=nim` puts NIM key in | placeholders, gateway/supervisor holds keys | same |
| Files | cwd mounted read-write | upload/download; binds off by default | per-sandbox overlay disk |
| hyprpi | full citizen (unsafe socket) | none yet; bridge first | none yet |
| Pi auth | host OAuth access token | needs an inference route; Pi's OAuth login not documented here | same |
| Cost on Arch | `docker build` | gateway + supervisor binaries (installed), TLS state, policy YAML, version churn (0.0.x → 0.1.x broke inference.local) | + KVM, untested |
| Ops risk | low | gateway restart revives sandboxes; shared NemoClaw gateway | unknown |

Hardened Docker (non-root, cap-drop, read-only root, egress proxy) can approach the network/credential story,
but you'd be building what OpenShell already ships. OpenShell's cost is operational complexity, not security.

## 6. Best-fit use cases (OpenShell-specific)

1. **Literature/data scout** (the existing cell-cycle scout, or a Pi version): fixed API allowlist, daily
   digest downloaded into Obsidian by the host bridge. Best fit: destinations known in advance.
2. **Untrusted repo or npm/pip package triage:** upload a checkout, allow only the registry (read-only),
   no `gh`/SSH, return a report or patch. MicroVM if the code is genuinely hostile.
3. **Trying a new Pi extension / MCP server:** the whole Pi runs inside, so the extension does too;
   egress log shows exactly what it calls home to.
4. **nim-demos inside a sandbox:** NVIDIA hosts + PyPI at build, `forward 8770`, key via provider
   profile (REST). Blocked on the gRPC key question for the audio pages.
5. **Long-running unattended jobs** (overnight research, batch NIM runs): resource limits per sandbox,
   no host access while Angus is away, results reviewed in the morning.

Poor fits: anything needing Hyprland, WhatsApp, mail, voice, Obsidian writes, or broad browsing. Keep those
on host agents that hand narrow jobs to sandboxes.

## 7. Checks before trusting it (none run for this report)

- Pin versions; decide 0.0.116 vs 0.1.x; separate gateway from NemoClaw's.
- Set Landlock `hard_requirement`; inspect effective policy; run the prover.
- Test: allowed inference works; other hosts, raw IPs, loopback and `host.openshell.internal` denied;
  non-listed binaries denied; redirects off allowed hosts denied.
- Check the real key appears nowhere in env, files or logs inside; detach provider revokes.
- Stop a sandbox and restart the gateway: nothing unexpected comes back; `top` stays quiet.
- Bridge: path/symlink/size checks on downloads; sandbox text never becomes a host command.

## Sources

- OpenShell docs: [overview](https://docs.nvidia.com/openshell/about/overview) ·
  [architecture](https://docs.nvidia.com/openshell/about/architecture) ·
  [policies](https://docs.nvidia.com/openshell/how-it-works/policies/overview) ·
  [network rules](https://docs.nvidia.com/openshell/how-it-works/policies/network-rules) ·
  [security best practices](https://docs.nvidia.com/openshell/security/best-practices) ·
  [inference 0.1.2](https://docs.nvidia.com/openshell/how-it-works/inference) ·
  [inference routing 0.0.116](https://docs.nvidia.com/openshell/v0.0.116/sandboxes/inference-routing) ·
  [compute drivers 0.0.116](https://docs.nvidia.com/openshell/v0.0.116/reference/sandbox-compute-drivers) ·
  [manage sandboxes 0.0.116](https://docs.nvidia.com/openshell/v0.0.116/sandboxes/manage-sandboxes) ·
  [Pi tutorial](https://docs.nvidia.com/openshell/dev/tutorials/run-pi) (cited in our README; returned 404 on 2026-10-07)
- Pi: installed `docs/containerization.md` (Pi 1.0.2), "Run Pi with OpenShell".
- NemoClaw Pi runtime status: https://github.com/NVIDIA/NemoClaw/issues/7923 (from our README; not re-checked).
- Local: `~/Work/nemoclaw/README.md`, `~/Work/nemoclaw/start-gateway.sh`, `~/Obsidian/ThingsToDo/NemoClaw runbook.md`,
  `~/.config/nemoclaw-presets/cell-cycle-literature-apis.yaml`, `hyprpi/docs/sandbox-plan.md`,
  `hyprpi/docker/README.md`, board card @nemoclaw (H2–H5, N3).
