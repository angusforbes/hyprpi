# Sandboxing Pi / hyprpi agents: research and think-through

Brief J212 (@pidocker N13), 2026-10-07. Lead and integration: Harbor. NemoClaw/OpenShell section: Claw
([.research/nemoclaw.md](.research/nemoclaw.md)). Other-environments survey: helper SandboxEnvs
([.research/sandbox-envs.md](.research/sandbox-envs.md)). Use-case material: Thoughts-A and Thoughts-B.
Reviewed by Claw (2026-10-07): 6 must-fix, 6 should-fix and 3 nits, all applied; 5 missing channels
added to §6. Research and writing only: nothing was built, installed or started for this report. It follows on from
[sandbox-plan.md](sandbox-plan.md) (the design) and [../docker/README.md](../docker/README.md) (what works today).

## Summary in plain words

- **What's wrong today.** Every agent, including the 🐳 Docker ones, can do anything you can do. The Docker
  agents are boxed in for files, but they get the hyprpi socket, and that socket is an "Angus-level" remote
  control. Code inside a box can use it to prompt any agent as if you typed it, post as you, or (new finding)
  open new agents on the host that have full access. So the box has a door in it.
  Also, you're in the `docker` group, which on Linux is the same as having root.
- **The most important fix doesn't depend on which sandbox we pick.** We need a separate, restricted
  socket for sandboxed agents (sandbox-plan check 1). Without it, every sandbox below leaks through
  hyprpi. With it, the hyprpi door is closed. The other gaps (keys inside the box, open internet,
  the root-equivalent docker group, files that run later on the host) still need their own fixes (§1, §6).
- **Which sandbox:** use different ones for different jobs.
  - Lightweight **bubblewrap** "fences" around ordinary agents. This is what Claude Code and Codex ship;
    it's already installed and adds milliseconds.
  - **Rootless Podman** instead of rootful Docker for agents that install or run unknown code.
  - **OpenShell** (or Gondolin) for jobs that must have locked-down internet and keys kept outside.
  - **A VM** for rehearsing root/system changes.
  - Cloud sandboxes and gVisor/Kata/Firecracker don't fit a laptop where agents live in Hyprland
    windows.
- **Security is the main reason, but not the only one.** Sandboxes also give:
  - parallel agents that don't clash (ports, venvs, daemon state);
  - CPU, memory and heat limits;
  - the same toolchain every time;
  - snapshots you can roll back;
  - a separate, invisible screen for computer-use agents, so they stop stealing your focus.

  Durability (jobs that survive the laptop sleeping) needs a *second machine*, not a sandbox.
- **A sandboxed agent stays useful.** It's still a full Pi: it codes, tests, browses (allowed sites) and
  reports to the room. What it loses on purpose:
  - your desktop (hyprcu), mail, WhatsApp, Obsidian;
  - your keys;
  - the power to make other agents act.

  Its messages arrive labelled, and the risky ones wait for your OK.
- **Next step, if you want one:** build the restricted socket, tested on an isolated daemon (about a day). Then
  try *one* real use case (decisions at the end).

## 1. Docker best practices, and how our launcher measures up

Sources: Docker Engine security ([docs.docker.com/engine/security](https://docs.docker.com/engine/security/)),
rootless mode ([…/rootless](https://docs.docker.com/engine/security/rootless/)), user namespaces
([…/userns-remap](https://docs.docker.com/engine/security/userns-remap/)), seccomp
([…/seccomp](https://docs.docker.com/engine/security/seccomp/)), AppArmor
([…/apparmor](https://docs.docker.com/engine/security/apparmor/)), resource limits
([…/resource_constraints](https://docs.docker.com/engine/containers/resource_constraints/)), `none` network
([…/drivers/none](https://docs.docker.com/engine/network/drivers/none/)), OWASP Docker Security Cheat Sheet
([cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)),
Docker Sandboxes security model ([docs.docker.com/ai/sandboxes/security](https://docs.docker.com/ai/sandboxes/security/)),
Pi's own [containerization.md and security.md] (installed docs, Pi 1.0.2).

| Practice (source) | What it means | Our launcher (`docker/run-hyprpi-agent.sh`) |
|---|---|---|
| Rootless daemon (Docker rootless / Podman) (OWASP #11, Docker rootless) | The container engine itself isn't root, so an escape lands as you, not root | ❌ Rootful Docker, and `agf` is in the `docker` group (root-equivalent, OWASP #1) |
| Non-root user in the container (OWASP #2) | No root inside | ✅ `--user $(id -u):$(id -g)` |
| `--security-opt no-new-privileges` (OWASP #4) | Blocks setuid escalation inside | ❌ missing (one flag) |
| `--cap-drop ALL` (OWASP #3, Docker "capabilities") | Remove kernel capabilities the agent never needs | ❌ missing (low impact with a non-root user, still free) |
| Keep default seccomp; add AppArmor/SELinux (OWASP #6, Docker seccomp) | Default profile blocks ~44 risky syscalls | ✅ builtin seccomp on; no AppArmor/SELinux LSM active (LSMs: lockdown, capability, landlock, yama, bpf) |
| Read-only root fs + tmpfs (OWASP #8) | The agent can't change the image's system files | ❌ missing (`--read-only --tmpfs /tmp`) |
| Minimal mounts, read-only where possible (OWASP #8) | Mount only what the job needs | ⚠️ work folder rw (needed), hyprpi checkout ro ✅, tools ro ✅, **hyprpi socket dir rw** ❌ (the big hole) |
| Never mount control sockets (OWASP #1: docker.sock is root) | A control socket inside = control outside | ✅ no docker.sock; ❌ hyprpi socket is the same kind of thing (sandbox-plan) |
| Egress control (Docker sbx, OpenShell: deny by default + proxy) | Only allowed hosts are reachable | ❌ default bridge = whole internet |
| Credentials outside the box (Docker sbx: proxy injects headers; OpenShell) | The agent can use a key without being able to read it | ❌ Anthropic access token and (with `TOOLS=nim`) the NIM key are env vars, readable by any `npm install` script inside |
| Resource limits (OWASP #7) | `--memory`, `--cpus`, `--pids-limit` | ❌ missing (recall the NemoClaw fan/heat episode) |
| Pinned, updated images (OWASP #0, #13) | Known versions, patched base | ✅ Pi pinned in `docker/PI_VERSION`, `--ignore-scripts`; base updates are manual |
| Review files that run later (Docker sbx security) | Git hooks, `package.json` scripts, `Makefile`, **`.pi/` and `AGENTS.md`** written by the agent run on the *host* later | ❌ not addressed. Easy to miss: a boxed agent can write `.pi/extensions/x.ts` into the mounted folder. Pi's project trust (security.md) gates `.pi/` extensions, skills, settings and `mcp.json`, but a trust decision already saved for the folder or a parent (e.g. `~/Work`) lets it load without a prompt. `AGENTS.md` loads regardless of trust |

The honest summary: the container keeps an *accident* contained (the agent can only touch its folder) but not
*hostile code*. Three changes would close most of the gap: the restricted socket, rootless Podman, and a
network proxy with keys injected outside. The one-flag fixes (no-new-privileges, cap-drop, read-only,
limits) are worth adding at the same time.

Two Docker-specific notes:
- **Docker's own secrets** (`docker secret`) are a Swarm feature. For a single `docker run`, a key mounted
  as a file is just as readable by code inside as an env var. Only *injection outside the box* (a proxy that adds
  the header) truly hides a key. Short-lived or low-budget keys limit the damage otherwise.
- **Rootless Podman** runs the same Dockerfiles. `--userns=keep-id` keeps file ownership and the socket
  working, and it removes the root-equivalent daemon (SandboxEnvs §7).

## 2. NemoClaw / OpenShell (from Claw, condensed; full text with all sources in [.research/nemoclaw.md](.research/nemoclaw.md))

Sources: [OpenShell architecture](https://docs.nvidia.com/openshell/about/architecture),
[security best practices](https://docs.nvidia.com/openshell/security/best-practices),
[inference routing (0.0.116, our version)](https://docs.nvidia.com/openshell/v0.0.116/sandboxes/inference-routing),
[compute drivers (0.0.116)](https://docs.nvidia.com/openshell/v0.0.116/reference/sandbox-compute-drivers),
[inference in 0.1.2](https://docs.nvidia.com/openshell/how-it-works/inference).

- **Verdict:** use **OpenShell (not NemoClaw) as the place to run Pi.** NemoClaw is NVIDIA's OpenClaw-agent
  wrapper on top of OpenShell. Pi runs directly with `openshell sandbox create --from pi -- pi`, as Pi's own
  docs describe.
- **What it adds over our Docker launcher:**
  - deny-by-default egress, per program and per HTTP method/path;
  - keys the agent never sees (placeholders swapped in only at allowed hosts);
  - Landlock + seccomp + a non-root agent;
  - a log of every allowed or denied connection.
- **Isolation depends on the driver.** With the Docker driver, the kernel is shared. With the Podman driver
  (rootless), it's shared too. The opt-in **MicroVM driver** (libkrun/KVM; the guest has no network card and
  talks to the supervisor over vsock) gives it its own kernel; we haven't tested that one.
- **Version cliff:** installed are openshell/gateway **0.0.116** and nemoclaw v0.0.124 (checked with
  `--version`). Current docs are 0.1.2, which **removed `inference.local`** (our proven path) in favour of
  per-sandbox provider attachments. Its upgrade guide says to recreate every sandbox. Any next step must
  first choose between 0.0.116 as it is and an upgrade, after checking NemoClaw's compatibility.
- **Proven (2026-09-29, historical, not re-run):** Pi 0.77.0 (the host has 1.0.2) ran in an OpenShell
  sandbox as uid 998. It answered through `inference.local` with a dummy key, ran bash, and was denied
  `example.com`.
  - *Not tested:* escapes, data leaving through allowed hosts, extensions, an interactive window.
- **Lessons:**
  - The image pull timed out inside `sandbox create` while on the VPN, though a direct `docker pull`
    worked. Separately, our inference upstream (NVIDIA's Inference Hub) needs the Prisma VPN; OpenShell
    itself doesn't.
  - At startup the gateway restarts every sandbox whose intended state is "running". Ours had crashed
    rather than been stopped, so all of them came back. Their auto-pair watchers then spun a CPU core
    each (the heat episode). Fix: `openshell sandbox stop` unused ones, or give Pi its own gateway.
  - In 0.0.116, the container starts with SYS_ADMIN/NET_ADMIN for the supervisor's setup. The agent then
    runs unprivileged after the drop, and the supervisor is part of what you trust. (In 0.1.x the
    supervisor gets its own container.)
  - Earlier scout runs overwrote a digest and broke API pacing: a sandbox protects the outside, not the
    quality of the work.
- **Keys:** provider profiles give the sandbox a placeholder `NVIDIA_API_KEY` and swap in the real one only
  at bound hosts. That should cover the REST NIM calls (`ai.api.nvidia.com`, `api.nvcf.nvidia.com`). Riva
  gRPC is still open: the docs show no gRPC credential rewrite, so assume that key would have to be inside.
  Untested. A hidden key can still be *spent*, so use low-budget keys and rate limits.
- **How it joins hyprpi:**
  - Phase 1: a host-side **job/result adapter**. It uses `openshell sandbox exec` / `upload` / `download`
    and pulls results into quarantine. No hyprpi socket inside, and patches are reviewed before they're
    applied.
  - Phase 2: only after the restricted socket exists, a membership with host-assigned identity. For a
    remote gateway that means an authenticated relay with the same allowlist, never the raw daemon. A
    kitty window running `openshell sandbox connect` works like our 🐳 windows; window mapping still uses
    `HYPRPI_AGENT_ID` on the host process.
- **Best fits:**
  - the literature scout;
  - reproducing a bug in an unfamiliar repo;
  - testing an untrusted Pi extension or npm package;
  - NIM demo experiments (REST first);
  - a web/data extraction worker.
- **Poor fits:** desktop, mail, WhatsApp, voice or Hyprland work, and editing live config.
- **Open:** the version decision, Riva gRPC keys, forwarding the demo port (:8770) safely, and the upkeep cost
  on Arch.

## 3. Other environments (from SandboxEnvs, checked; full sources in [.research/sandbox-envs.md](.research/sandbox-envs.md))

Machine facts it checked:
- Landlock is active, `/dev/kvm` exists and unprivileged user namespaces are on.
- bubblewrap 0.12 and socat are installed.
- podman, firejail, qemu and libvirt are in the Arch repos; landrun is in the AUR.

The deciding factor is hyprpi's **Unix socket**. Namespace sandboxes (bwrap, Podman, systemd) can bind-mount
one path. VMs can't share a Unix socket and need a vsock/TCP relay.

| Environment | Isolation | Setup on Arch | Agent window | Network control | hyprpi socket | Fit for Pi here |
|---|---|---|---|---|---|---|
| **bubblewrap** (+ Anthropic `srt` proxy) | Medium: namespaces, shared kernel | Installed | Unchanged (kitty on host runs `bwrap … pi`) | None, or a domain allowlist via `srt`'s proxy | one `--bind` | **Good**: lightest; Claude Code and Codex use it |
| **systemd-run --user** (properties) | Medium: cgroup + seccomp + fs properties | Built in | Unchanged | `PrivateNetwork=`, `IPAddressAllow=` | `BindPaths=` | **Good** as the launcher: limits + clean kill per agent |
| **Landlock / landrun** | Low-medium: file access + TCP ports only | AUR | Unchanged | TCP port list only | Path rule | Good as an extra file guard; weak alone |
| **Podman rootless** | Medium: user namespace, shared kernel | repo | Same as Docker | `--network none`, pasta | bind dir, `--userns=keep-id` | **Good**: replaces rootful Docker |
| Docker (today, rootful) | Medium, but the daemon is root | installed | ✅ works (🐳) | default: open | mounted (the hole) | Works; swap for Podman |
| **OpenShell** (Claw) | Medium + policy (Docker/Podman driver: shared kernel; MicroVM driver: own kernel, untested) | gateway (installed 0.0.116) | kitty running `openshell sandbox connect` | **Deny-by-default allowlist, keys in gateway** | Needs bridge/relay | **Good for narrow jobs** |
| Docker Sandboxes (`sbx`) | High: microVM each | `sbx` CLI (Arch support unverified) | Terminal | Proxy + policy + key injection | Not documented | Watch: best key story, unclear on Arch |
| **Gondolin** (documented by Pi) | High for *tools* (micro-VM) | npm + qemu | Unchanged: Pi stays on host | Host policy proxy | Unchanged (Pi on host) | **Good**: VM-grade for tools, hyprpi untouched |
| **Full VM** (QEMU/libvirt/quickemu) | Very high: own kernel, snapshots | repo / AUR | Separate desktop or ssh | Full | Relay needed | **Good only for rehearsing root/system changes** |
| devcontainers | = Docker/Podman | npm CLI | n/a | = underlying | mounts | Niche: per-repo environments |
| systemd-nspawn | Medium | built in, needs a rootfs + root | ok | private net | bind | Niche |
| firejail | Medium; setuid-root binary | repo | ok | `--net=none` | whitelist | Skip: bwrap does it with less trust |
| gVisor | High: user-space kernel | not in repos | containers only | Docker's | slower mount | Skip: overkill locally |
| Kata / Firecracker | Very high: microVM | firecracker in repo | no Wayland | tap | vsock | Skip: infrastructure-grade glue |
| Cloud (E2B, Modal, Daytona) | High, remote | account + SDK | none locally | provider policy | relay/tunnel | Skip for hyprpi; fine for batch jobs (code and keys leave the laptop) |

What other coding-agent tools do:
- **Claude Code** sandboxes its bash tool with bubblewrap plus a host proxy that enforces a domain allowlist
  ([anthropic.com/engineering/claude-code-sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing),
  open-sourced as [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)).
- **Codex CLI** applies an OS sandbox to every command (bubblewrap/Landlock+seccomp on Linux): read-only,
  workspace-write (network off) or full access
  ([developers.openai.com/codex/concepts/sandboxing](https://developers.openai.com/codex/concepts/sandboxing)).
- **OpenHands** runs actions in a Docker runtime container.
- **Docker `sbx`** gives each agent a microVM and has an official Pi kit.
- **Pi itself** has **no built-in sandbox** and says so (security.md: "lack of a built-in sandbox" is outside
  its security boundary). Its containerization.md lists plain Docker, Docker Sandboxes, OpenShell and Gondolin.

Pattern worth copying: the two biggest vendors keep the agent's UI outside, fence the *commands* with
bubblewrap, and send all network traffic through an allowlisting proxy. No images, millisecond overhead,
local auth keeps working.

## 4. Not only security

You asked whether security is the main reason. For most of your use cases, yes. These are the real
non-security reasons, and how strong each one is:

| Reason | What a sandbox gives | How strong, honestly |
|---|---|---|
| **Parallel work without clashes** | Each agent gets its own ports, dev servers, venvs/`node_modules`, tmp and config. World E's five three.js projects running dev servers side by side; scratch venvs (arc-cua) | **Strong.** Containers make this the default rather than a discipline |
| **Resource caps** | CPU/memory/process limits per agent (cgroups via `systemd-run` or `--cpus/--memory`); kill one job and everything it started dies with it | **Strong and cheap.** It would have contained the NemoClaw fan/heat episode and the 9 GB of MCP copies |
| **Desktop and focus protection** | A computer-use agent drives its *own* invisible screen (a headless compositor plus the app, inside a container or VM), not yours | **Strong.** The hyprcu log shows agents avoiding hyprcu to protect your screen, and this is ideas 8/9 on @computer-use. Headless compositor details are unverified |
| **Rehearse and roll back** | A VM snapshot before root/system changes (Dormouse's initramfs/logind work); disposable containers for "try it and throw it away" | **Strong for system changes.** Containers can't rehearse kernel/initramfs/systemd work; a VM can |
| **Reproducibility** | Same pinned image every time (Pi version, Node, Python, ffmpeg, Playwright) | Medium. Good for demos and sharing, small gain for daily work |
| **Different toolchains / GPU** | CUDA or older Python in a container without touching the host | Medium, when needed (GPU passthrough to containers needs the NVIDIA toolkit; unverified on this laptop) |
| **Portability and handoff** | Move an agent's environment to another machine; share an image with others | Medium: the image moves, the hyprpi session doesn't (yet) |
| **Durability** | Jobs that survive suspend, reboot or a daemon restart | **Weak on the laptop.** A container sleeps when the laptop sleeps. Real durability needs a second machine (home server or cloud VM) running the agent, with a relay to hyprpi. CRIU/VM snapshots can pause and resume, but that's fiddly |
| **Separate state** | An agent with its own daemon/state dir can't overwrite the main board | Careful: J57/J80 (overwritten board writes) came from a *second daemon* sharing state. A sandbox with its own state stays separate, but it must not then write back to your board directly |

So: security first, then **clash-free parallel work, resource caps and a private screen** as genuine
second reasons. Durability is a different project (a remote agent host).

## 5. Use cases from your workflow

Built from Thoughts-A's cross-world overview, Claw's list and our own Docker tests.

1. **Running code you didn't write** (security). World E's web projects (@poetry-chains, @maze,
   @mazeglass, @triptychs, @swirlfluid) `npm install` and run dev servers. Agents try new tools in scratch
   venvs (Pocket's arc-cua on @computer-use). Testing a third-party Pi extension or MCP server belongs here
   too.
   - *Why a sandbox:* an install script runs as you, next to your SSH keys, gh token, pi auth and browser
     profile.
   - *Environment:* rootless Podman with the pi-sandbox image, working on a clone (or a copy), not your
     live folder.
   - *Must reach:* npm/PyPI, a forwarded dev-server port for you to look at, and the room through the
     restricted socket.
   - *Must not reach:* your keys, `~/.pi/agent`, the host MCP gateway.
2. **Scouts and API workers that hold only the keys they need** (security: secrets and exfiltration). Covers
   the cell-cycle literature scout, @nimdemos calls to NVIDIA endpoints and web/data extraction.
   - *Why:* these read untrusted web pages *and* can send data out. That's two of the "lethal trifecta"
     legs ([Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)). Taking away the third
     leg, your private data and keys, is what makes them safe.
   - *Environment:* OpenShell (allowlist plus keys swapped in outside the box), or bubblewrap with
     `srt`'s domain proxy for a lighter version.
   - *Must reach:* the listed APIs; results go to an outbox for review; the room gets a status line.
3. **Rehearsing root/system changes** (safety and rollback, mostly non-security). Dormouse's power work
   (initramfs rebuild, upower/logind drop-ins, hibernate test) and Herdsman's `.bashrc`/config edits all
   happened with sudo on the real machine.
   - *Environment:* an Arch VM (quickemu or libvirt) with a snapshot. The agent works out and tests the
     change there and hands back a script and a log. A host agent applies it with your OK. Hibernate and
     hardware-specific parts can't be fully rehearsed in a VM; say so in the hand-off.
   - *Must reach:* package mirrors and the room (a relay, or just the hand-off file).
4. **Computer use without stealing your screen** (non-security). hyprcu agents take focus and move
   windows (the MATLAB evening).
   - *Environment:* a container or VM running a headless Wayland compositor plus the app under test,
     with a hyprcu-like driver pointed at *that* display; you can watch it through a viewer window if you
     like. Hyprland's own headless outputs are an alternative without a sandbox, but they share your seat
     and pointer (unverified).
   - *Must reach:* the app, its files, the room.
5. **Many agents overnight without clashes or heat** (non-security: parallelism, caps, durability). Fifteen
   window-less agents overnight via phone SSH overwrote board writes (J57, J80), and 27 MCP server copies
   used about 9 GB (J88, since fixed by the shared gateway).
   - *Environment:* on the laptop, `systemd-run --user` with limits (CPU, memory, tasks) and its own
     scratch dirs and ports, plus Podman where a job needs its own toolchain. For jobs that must survive
     the laptop sleeping, a second machine plus a relay.
   - *Must reach:* the one hyprpi daemon (through the restricted socket or relay, never a second daemon
     writing the same board) and the shared MCP gateway, only for tools that are safe to share.

## 6. How a sandboxed agent stays useful and talks to the others

**What it keeps:** a full Pi with bash, files, git, tests, the web (allowed hosts), image and NIM tools, its own
window with the 🐳 marker, the room, its own card. **What it gives up on purpose:**
- your desktop (hyprcu), WhatsApp, mail, gdrive, Obsidian;
- your keys and pi auth (only a scoped token or proxy-injected keys);
- the power to make other agents act.

Most coding and research work needs none of those.

Every channel between a sandbox and the rest, its risk, and the control. The "plan" column refers to the
checks in [sandbox-plan.md](sandbox-plan.md).

| Channel | Use | Risk | Control (plan check) |
|---|---|---|---|
| **The main hyprpi socket** (today) | Everything | **Critical.** Code (no LLM needed) can call `agent.prompt` (arrives "as Angus"), `room.post` with `as_human`, board edits as Angus or as another agent (`as_agent`), claim another agent's id in `agent.hello`, and **`orch.spawn` a full-access host agent** (new: current code 6d07ed7, read not tested) | Never mount it into a sandbox again once check 1 exists |
| **Restricted sandbox socket** | Room, own card, talk/demand, replies | Low if the allowlist is right; identity comes from the connection plus a one-time launch token, never from a claim | Check 1 (allowlist adds: refuse `orch.*`, `as_agent`, `room.post as_human`) |
| **Room posts** | Status, results, questions to you | Every agent reads the room as history: a planted instruction reaches all of them | Check 2: daemon-added "🐳 sandboxed" label; length caps |
| **Board writes** | Its own card | Persistent: an injected line stays and is re-read for days | Check 1: own card only, labelled |
| **talk/demand to host agents** | Asking a full-access peer for help | **Highest.** A confused deputy: the host agent does what the sandbox couldn't | Check 3b by default (waits for your one-click OK); 3a for untrusted material. An OK covers *one* message, not the sandbox forever |
| **Host → sandbox prompts** | Giving it work | Low for the host, but **data can leak out**: a host agent may paste private text or keys into a box that can reach the internet | Rule for host agents: send tasks, not secrets. An allowlist narrows the leak but doesn't close it: allowed hosts still carry data out (query strings; our scout preset allows POST to NCBI/RCSB), wildcard hosts allow DNS-label tricks, and rules match the interpreter (node/python), so any script inherits the access |
| **Shared files (work folder)** | Code changes | Files that run later on the host: git hooks, `package.json` scripts, `Makefile`, **`.pi/` extensions and `AGENTS.md`** | Clone/copy mode, or review the diff (including `.git/hooks`, `.pi/`, `AGENTS.md`) before a host agent works there |
| **Outbox / drop-box** | Results, digests, patches | Symlinks, path tricks, huge files, HTML that runs in your logged-in browser | Claw's Phase 1: quarantine folder, size limits, structured results, review before import |
| **MCP gateway (127.0.0.1:8790)** | hyprcu, mcp-nvidia, blender | hyprcu is desktop control. Today a default-bridge container can't reach host loopback, so it's safe by accident (for the container itself, see the next row) | Keep it unreachable; offer only safe, per-sandbox tools if ever needed |
| **Forwarded ports opened in your browser** | Looking at a dev server | The page runs in your *logged-in* browser and can `fetch()` host loopback services (the MCP gateway on :8790, other dev servers): CSRF / DNS rebinding unless they check Origin/Host | Open sandbox ports in a separate browser profile; make :8790 check Origin |
| **Terminal output** (its TUI renders in a host kitty window) | Seeing the agent | Escape sequences can write your clipboard (OSC 52) and print `file://` links (OSC 8) that Ctrl+click opens | Deny clipboard writes for sandbox windows (kitty `clipboard_control`); keep kitty remote control off (it is today) |
| **Spending** | Using APIs | A hidden key can still be spent (NIM credits, Anthropic budget) | Low-budget or scoped keys, rate limits, revoke on stop |
| **Flooding the daemon** | (abuse of the restricted socket) | Message floods or giant posts slow everyone down | Per-connection rate and size limits in check 1 |
| **Transcripts and logs brought back** | Debugging, hand-offs | Injected text inside session logs becomes context for the host agent that reads them | Treat them as untrusted input, like the room |
| **Internet** | Docs, packages, APIs | Data leaving the box; instructions arriving from pages | Allowlist proxy (OpenShell/srt/sbx); keys injected outside |

The design principle (from the prompt-injection literature, e.g.
[Design Patterns for Securing LLM Agents against Prompt Injections](https://arxiv.org/abs/2506.08837)): an
agent that has read untrusted text must not be able to cause consequential actions elsewhere. The restricted
socket and the 3b gate turn that into plumbing instead of a hope that the receiving model behaves. Labels help
reviewers, but they can't stop an injection on their own.

For VMs and remote boxes the same allowlist runs behind an authenticated **relay** (vsock or TCP with a token).
The daemon is never exposed raw.

## 7. Recommended direction

1. **Build the restricted sandbox socket first** (plan check 1, with `orch.*` and `as_agent` added to the
   refusals, plus per-connection rate and size limits). Add forced labels (check 2) and the 3b gate (check 3). Test against an isolated daemon. This is
   the only part every option needs, and without it no sandbox is real.
2. **Harden the existing Docker path cheaply:**
   - move to rootless Podman (same images);
   - add no-new-privileges, cap-drop, read-only root, memory/CPU/process limits;
   - work on a clone by default;
   - stop passing long-lived keys as env vars where a proxy can inject them;
   - deny clipboard writes in sandbox windows, and open sandbox ports in a separate browser profile.
3. **Add a light "fenced" launcher:** `systemd-run --user` + bubblewrap (optionally `srt` for a domain allowlist)
   for ordinary agents that should only touch their project. It's cheap enough to be a default later.
4. **Use OpenShell for the scout/API-worker case**, through Claw's job/result bridge first.
5. **Keep a VM for rehearsing system changes.** Try a headless-display container for computer use when
   @computer-use gets there.
6. **Skip** cloud sandboxes, gVisor, Kata/Firecracker and firejail for now. Durability is a separate "remote
   agent host" idea.

Order of value per effort: 1 → 2 → use case 1 or 2 as the first real trial → 3 → 5.

## 8. Decisions for you (plain words)

1. **Go ahead with the restricted socket?** About a day, tested on a separate daemon, no change to normal
   agents. Recommended: yes. Without it, sandboxes are only for accidents.
2. **Default for messages from a sandboxed agent to a normal one:** (a) not allowed, room only; (b) wait for
   your one-click OK; (c) delivered with a label. Recommended: (b), and (a) for untrusted material.
3. **Rootful Docker → rootless Podman?** This also means leaving the `docker` group, which is root-equivalent.
   Recommended: yes, for the agent containers. NemoClaw's gateway is configured for the Docker driver, so it
   needs checking first. OpenShell itself also has a rootless Podman driver.
4. **First real trial:** untrusted web-project code (use case 1), or the literature scout on OpenShell (use case
   2)? Recommended: use case 1. It reuses what already works and shows the restricted socket in daily use.
   The scout on OpenShell first needs the version decision (0.0.116 as-is or upgrade, §2).
5. **Fenced bubblewrap launcher as an option, or the default for new agents?** Recommended: an option first,
   then decide after a week.
6. **Publish for the Omarchy community?** Still open from sandbox-plan. Recommended: not before 1–3 are done.

## Sources and what wasn't verified

- The Docker sources are linked in §1. Other environments are in [.research/sandbox-envs.md](.research/sandbox-envs.md);
  items marked "(unverified)" there were not fetched. OpenShell/NemoClaw is from local records (2026-09-17–29,
  not re-run); see [.research/nemoclaw.md](.research/nemoclaw.md).
- The current-code findings (`orch.spawn`, `as_agent`, `agent.prompt` unchecked) come from reading
  `lib/daemon.mjs` at 6d07ed7, not from tests.
- Not tested: `srt` with the hyprpi socket path, `sbx` on Arch, headless compositor details, GPU containers on
  this laptop.
