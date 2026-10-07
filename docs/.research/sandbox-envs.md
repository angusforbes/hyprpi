# Sandboxing environments for Pi agents on Angus's laptop

Research for @pidocker (brief J212). Research only, nothing installed or run.
Machine facts checked (read-only): kernel 7.2.5-omarchy, LSMs `lockdown,capability,landlock,yama,bpf` (Landlock is on; no AppArmor/SELinux), `/dev/kvm` present and world-rw, unprivileged user namespaces enabled, `bubblewrap 0.12.0` and `socat` already installed. In repos (extra): bubblewrap, firejail, podman 6.1.1, firecracker, qemu-full, libvirt. AUR: landrun-bin. Not found in repos/AUR search: gvisor, kata (unverified for AUR, I only searched repo names and landrun).
"(unverified)" = from memory / not fetched this session.

Key hyprpi facts that drive every verdict: agents are one kitty window each (the terminal stays on the host; only `pi` and its children need isolating), and they talk over a Unix socket in `$XDG_RUNTIME_DIR/hyprpi/`. A Unix socket is a filesystem object, so anything sharing the host kernel and mount namespace (bwrap, firejail, Landlock, containers, nspawn) can reach it by bind-mounting/allowing that path. VMs cannot (a Unix socket does not cross a VM boundary) and need a bridge (vsock/virtio-serial/TCP + socat).

## Comparison table

| Environment | Isolation strength | Setup on Arch | GUI/window | Network control | Socket access | Fit verdict |
|---|---|---|---|---|---|---|
| bubblewrap | Medium: mount/pid/net/ipc ns, shared kernel; policy is yours | `bubblewrap` in extra (installed) | Fine: run `pi` inside, kitty stays outside | `--unshare-net` = none; allow-list needs a proxy (see srt) | `--bind` the socket dir | **Good fit** (lightest, most flexible; Claude Code & Codex use it) |
| firejail | Medium: ns + seccomp + caps + profiles; setuid-root binary | `firejail` in extra | Fine; has Wayland/X11 profiles | `--net=none`, `--netfilter`, own veth | `--whitelist`/`--noblacklist` path | Niche (setuid attack surface; bwrap is simpler to script) |
| Landlock / landrun | Medium-low: fs (+TCP bind/connect ports) only, same ns, no hiding | `landrun-bin` (AUR); kernel has Landlock | Fine, nothing changes | TCP port allow-list only, no hostnames/UDP | Unix-socket connect: path-based via fs rules (newer ABI has scoping) (unverified) | **Good** as a cheap fs guard; weak alone |
| gVisor (runsc) | High: user-space kernel | Not in repos (binary/AUR unverified); plugs into Docker as a runtime | Poor-ish: no GPU/Wayland, containers only | Docker nets; own netstack | Mount socket through gofer; works but slower | Niche (overkill for local trusted-ish agent) |
| Kata / Firecracker | Very high: microVM per sandbox | `firecracker` in extra; Kata not in repos (unverified) | No Wayland; terminal via ssh/pty | tap + host firewall | vsock bridge needed | Poor fit (infra-grade; heavy glue) |
| systemd-nspawn / systemd-run | Medium: full ns container (nspawn) / cgroup+seccomp+fs props (systemd-run) | In `systemd` (installed) | Fine (nspawn needs rootfs; `systemd-run --user -p` needs none) | `PrivateNetwork=`, `IPAddressAllow=` (cgroup BPF, IP-level) | `BindPaths=` / `--bind` | **Good** for `systemd-run --user` hardening; nspawn niche |
| Podman rootless | Medium (userns, shared kernel); better than rootful Docker | `podman` in extra | Same as Docker | pasta/slirp4netns; `--network none` | `-v $XDG_RUNTIME_DIR/hyprpi:...`; uid mapped via `--userns=keep-id` | **Good** vs current rootful Docker |
| Devcontainers | Same as underlying Docker/Podman | `@devcontainers/cli` (npm) | n/a (config layer) | Docker's | mounts in `devcontainer.json` | Niche (per-repo env, not isolation) |
| Full VM (QEMU/KVM, libvirt, quickemu) | Very high | `qemu-full`, `libvirt` in extra; `quickemu` AUR (unverified) | Separate desktop, or virtio-gpu/ssh | Full (user-mode net, bridges, nftables) | Needs vsock/TCP bridge | Good only for **rehearsing root/system changes**; poor for daily agents |
| Gondolin (QEMU micro-VM; documented by Pi) | High: micro-VM for tools only | npm + `qemu-full` | Host Pi window unchanged | Host-side policy HTTP/TLS proxy | Host Pi keeps the socket | **Good** (Pi's own example); tool-scope only |
| E2B / Modal / Daytona (cloud) | High (Firecracker / gVisor / containers, remote) | Account + SDK, no install | None locally | Provider policy | Impossible without tunnel | Poor (code leaves machine, hyprpi is local) |
| Docker `sbx` Docker Sandboxes | High: per-sandbox microVM | Docker's `sbx` CLI (availability on Arch unverified) | Terminal only | Host proxy with policy + credential injection | Not documented; likely hard (unverified) | Niche/watch: best credential story |
| Claude Code sandbox (srt) | Medium (bwrap + seccomp + proxy) | `npm i @anthropic-ai/sandbox-runtime` + bwrap + socat | Fine | Domain allow-list proxy over Unix sockets | Explicit unix-socket allowance | **Good**: closest ready-made match |
| Codex CLI sandbox | Medium (bwrap/Landlock+seccomp) | bundled with Codex | Fine | Off by default in workspace-write | n/a | Reference design |
| OpenHands Docker runtime | Medium (Docker) | Docker | Browser UI | Docker | n/a | Poor fit (its own agent runtime) |

## Per environment

### 1. bubblewrap (bwrap)
Unprivileged namespace sandbox (user, mount, pid, net, ipc, uts) built from bind mounts; it is the building block of Flatpak, Claude Code and Codex. Isolates fs (you choose what is visible, tmpfs over `$HOME`), processes (`--unshare-pid`), network (`--unshare-net` gives an empty netns), not the kernel. Already installed here, userns enabled. GUI: not needed, the kitty window is the host's terminal; run `kitty -e bwrap ... pi`. Socket: `--bind "$XDG_RUNTIME_DIR/hyprpi" "$XDG_RUNTIME_DIR/hyprpi"`. Overhead: milliseconds. Caveats: with `--unshare-net` there is no internet unless you bridge via a proxy over a socket; `--new-session` is needed to stop TIOCSTI escapes (note: that disables job control). Verdict: **good fit**, best effort/value ratio.
Sources: https://github.com/containers/bubblewrap , https://wiki.archlinux.org/title/Bubblewrap

### 2. firejail
SUID-root sandbox with big profile library (mount ns, seccomp, caps, netfilter, apparmor optional). Fs and network controls are easy (`--net=none`, `--private`, `--whitelist`). Weaknesses: setuid binary with a long CVE history (unverified specifics); profiles aimed at desktop apps, not agent toolchains (git, npm, ssh-agent). Same socket story via whitelist. Verdict: niche, bwrap does it with less trust.
Sources: https://github.com/netblue30/firejail , https://wiki.archlinux.org/title/Firejail

### 3. Landlock (+ landrun)
LSM in kernel (ABI v1 fs; v4+ TCP bind/connect ports; later versions add IPC/signal scoping, unverified for exact ABI) for self-restricting unprivileged processes; no namespaces, so the process still sees the whole filesystem layout but access to other paths returns EACCES. `landrun` is a Go CLI (`landrun --rox /usr --rw $PWD --connect-tcp 443 -- cmd`); AUR `landrun-bin` 0.1.17. Kernel here has landlock active. Limits: no hostname filtering, no UDP, cannot hide files, can't give `/tmp` privately; sockets allowed by path rules. Codex CLI uses Landlock+seccomp. Verdict: good as a zero-overhead fs-write guard (e.g. protect `~/.ssh`, `~/.config`) or layered with bwrap; not enough alone for network exfiltration.
Sources: https://github.com/Zouuup/landrun , https://docs.kernel.org/userspace-api/landlock.html

### 4. gVisor (runsc)
User-space kernel (Sentry) intercepting syscalls, so the container no longer talks to the host kernel directly; used by Modal and GKE Sandbox. Integrates as a Docker/Podman runtime (`runtime: runsc`). Cost: syscall overhead, compat gaps (some fs ops, inotify/FUSE), no GPU/Wayland. Not in Arch repos (AUR/binary route unverified). Pi in it would work (Node is fine) but the gain is only for hostile code, not accidents. Verdict: niche.
Sources: https://gvisor.dev/docs/ , https://github.com/google/gvisor

### 5. Kata Containers and Firecracker
Firecracker: minimal KVM microVM monitor (AWS Lambda; E2B). Kata: OCI runtime that launches each container/pod in a lightweight VM (QEMU/Cloud Hypervisor/Firecracker). Strongest isolation short of full VMs, boots ~125 ms (Firecracker claim, unverified here). But you must supply kernel, rootfs, tap networking, and a vsock bridge for hyprpi's socket; Firecracker has no virtio-fs (fs sharing is block devices only, unverified), so a live repo mount is awkward. `firecracker` is in extra; Kata is not in repos. Verdict: poor fit locally; Gondolin and `sbx` are the packaged versions of this idea.
Sources: https://github.com/firecracker-microvm/firecracker , https://katacontainers.io/

### 6. systemd-nspawn and systemd-run sandboxing
Two things. (a) `systemd-nspawn`: light container from a rootfs dir (`pacstrap` it); `--bind`, `--private-network`, `--private-users`; needs root or machinectl. (b) `systemd-run --user --pty -p ProtectHome=tmpfs -p BindPaths=... -p PrivateNetwork=yes -p IPAddressAllow=... -p NoNewPrivileges=yes -p SystemCallFilter=@system-service pi`: transient unit with cgroup limits (MemoryMax, CPUQuota, TasksMax) and namespace/seccomp properties, no image. Caveat: in a `--user` instance, some mount-namespace properties work only with unprivileged userns (works here) (unverified per-property). Bonus: the cgroup gives resource caps and clean `systemctl --user kill` per agent. Verdict: (b) is a **good, underrated** fit and a natural way to launch agents; (a) niche.
Sources: https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html , https://man.archlinux.org/man/systemd-nspawn.1 , https://man.archlinux.org/man/systemd-run.1

### 7. Podman rootless (vs Docker rootless)
Daemonless, user-namespaced containers; root in container maps to Angus's uid, so no root-equivalent socket (rootful Docker group membership is effectively root on the host, today's setup). `--userns=keep-id` gives identical uid/gid so files and the hyprpi socket keep working. `podman-docker` provides a `docker` shim; compose via `podman-compose`. Network: pasta (default in v5+) or `--network none`. Docker rootless exists too but needs rootlesskit/slirp, and has more moving parts; Podman is the simpler path on Arch. Verdict: **good**, the cheapest upgrade from the existing Docker setup (same Dockerfile from Pi's docs).
Sources: https://docs.podman.io/en/latest/ , https://docs.docker.com/engine/security/rootless/ , https://wiki.archlinux.org/title/Podman

### 8. Devcontainers
A spec (`devcontainer.json`) layered over Docker/Podman, with CLI (`@devcontainers/cli`, npm). Adds reproducibility and per-repo images, not stronger isolation; Claude Code ships a reference devcontainer with a firewall script (iptables allow-list) that is a useful pattern. Verdict: niche; useful if Angus wants per-project environments, otherwise just config on top of the Docker/Podman choice.
Sources: https://containers.dev/ , https://github.com/devcontainers/cli

### 9. Full VMs (QEMU/KVM, libvirt, quickemu)
Strongest boundary and the only sane way to **rehearse root/system changes** (pacman -Syu, mkinitcpio, systemd units, Hyprland config) with snapshots. `/dev/kvm` is available. `qemu-full` and `libvirt` in extra (virt-manager too); quickemu is an AUR wrapper that downloads and starts distro VMs (Arch ISO) with one config file (unverified in repo). For agents: run `pi` inside via ssh from a kitty window, snapshot before, revert after. hyprpi socket: not shareable; either run a second hyprpi daemon inside, or forward with socat over vsock/TCP (unverified feasibility with the daemon's auth). Gondolin (below) is Pi's own QEMU micro-VM solution for tools only.
Sources: https://wiki.archlinux.org/title/QEMU , https://libvirt.org/ , https://github.com/quickemu-project/quickemu

### 9b. Gondolin (documented by Pi itself)
Local Linux micro-VM (QEMU) with host-side network/secret mediation (TLS-intercepting policy proxy, secret substitution, VFS mounts). The Pi docs ship an example extension that keeps Pi and its credentials on the host and routes `read/write/edit/bash/grep/find/ls` and `!` commands into the VM, mounting the working folder at `/workspace`. Caveat from the docs: commands inherit host env vars, and other extensions' tools still run on the host. Because Pi stays on the host, the hyprpi socket and kitty window keep working unchanged. Needs Node 23.6+ and QEMU. Verdict: **good**, the one VM-grade option that doesn't break hyprpi; but it only constrains tools, and hyprpi's own `talk`/room tools run on the host, which is actually what we want.
Sources: https://github.com/earendil-works/gondolin , Pi docs `containerization.md` (local: `~/.local/share/mise/installs/pi/1.0.2/pi/docs/containerization.md`)

### 10. Remote/cloud sandboxes
- **E2B**: Firecracker microVMs via SDK, built for agent code execution (Python/JS SDKs, pause/resume, templates). https://e2b.dev/docs , https://github.com/e2b-dev/E2B
- **Modal sandboxes**: gVisor containers created from Python/JS, can be given network blocks (`block_network`, CIDR allowlists) (unverified details). https://modal.com/docs/guide/sandbox
- **Daytona**: Docker/OCI-based dev sandboxes, open-source and self-hostable, SDK + API, claims sub-100 ms start (unverified). https://www.daytona.io/docs , https://github.com/daytonaio/daytona
- Similar: Docker cloud sandboxes (same `sbx`), NVIDIA OpenShell (documented by Pi, can be remote), Cloudflare Sandboxes, Fly Machines/Sprites (unverified).
All: strong isolation and no blast radius for the laptop, but code, repo and tokens leave the machine, latency, billing, and the hyprpi socket/GUI can't reach them. Verdict: poor fit for local hyprpi; fine for untrusted batch jobs or CI-like tasks.

### 11. Docker Sandboxes (`sbx`) and OpenShell
Docker's `sbx` runs each agent in its own microVM with its own Docker daemon, mounts the workspace at the same absolute path through virtiofs, routes all outbound TCP through a host proxy with network policy, and injects credentials at the proxy so the agent only sees sentinel values. Pi has an official kit (`sbx run --kit docker.io/sbx/pi-kit:latest pi`), and Pi's docs list it. Unknowns for Angus: whether `sbx` is installable on Arch with KVM (unverified), and how to expose hyprpi's Unix socket into the VM (not documented; likely needs a TCP bridge). Free for local use per Docker docs. NVIDIA OpenShell adds fs/process/network/credential/inference policy, local or remote, also documented in Pi's docs. Verdict: niche now, watch: best credential isolation but conflicts with hyprpi socket model.
Sources: https://docs.docker.com/ai/sandboxes/ , https://docs.docker.com/ai/sandboxes/architecture/ , https://github.com/docker/sbx-kits-contrib/tree/main/pi , https://docs.nvidia.com/openshell/about/overview

## What other coding-agent tools do

- **Claude Code**: Sandboxed bash tool built on Linux bubblewrap (macOS Seatbelt): writes allowed only in the working directory, network namespace removed and all traffic forced through a host proxy over Unix sockets that enforces a domain allow-list and asks the user on new domains. Anthropic reports 84% fewer permission prompts. Open-sourced as `@anthropic-ai/sandbox-runtime` (`srt <command>`, wraps any process incl. MCP servers, configurable fs/unix-socket/domain rules). Also ships a reference devcontainer. Sources: https://www.anthropic.com/engineering/claude-code-sandboxing , https://github.com/anthropic-experimental/sandbox-runtime , https://docs.anthropic.com/en/docs/claude-code/sandboxing
- **OpenAI Codex CLI**: OS-native sandbox applied to every spawned command: Seatbelt on macOS, bubblewrap on Linux (falls back to a bundled helper; older versions Landlock+seccomp), separate from approval policy (sandbox = technical boundary; approvals decide when to ask). Modes: read-only, workspace-write (network off by default, writes limited to workspace), danger-full-access. Source: https://developers.openai.com/codex/concepts/sandboxing , https://github.com/openai/codex
- **OpenHands**: runs the agent's actions in a Docker "runtime" container (sandbox) with a mounted workspace; the agent server itself is outside. https://docs.openhands.dev/openhands/usage/runtimes/docker (page fetched but not read in detail, unverified specifics)
- **Docker Sandboxes (`sbx`)**: microVM per agent, above.
- **Pi itself**: no built-in sandbox, stated in Pi's own `security.md`: Pi's trust boundary is the OS user; sandbox failures from prompt injection or "lack of a built-in sandbox" are explicitly out of scope. `containerization.md` documents four ways: plain Docker, Docker Sandboxes, OpenShell (whole process isolated), Gondolin (tools only, host Pi). Local docs: `~/.local/share/mise/installs/pi/1.0.2/pi/docs/{containerization,security}.md`.

Pattern: the two big vendors both chose **bubblewrap + proxy-based egress + keep the agent process's UI outside**, not containers or VMs, because it is fast, needs no images, and keeps local tools/auth working.

## Top 3 recommendations for Angus

1. **Wrap pi in bubblewrap (or `srt`) as the default per-agent launcher.** Already installed, ms overhead, one kitty window per agent unchanged, the socket is a single `--bind`. Give it: `$HOME` as tmpfs, ro system, rw `~/Work/<project>` and `~/.pi/agent` (needed for sessions), rw hyprpi socket dir, and either full network (accident protection) or `srt`'s domain-allow-list proxy (exfiltration protection). Launch through `systemd-run --user` for free cgroup limits and a clean kill. Same pattern Claude Code and Codex ship, so it is well exercised.
2. **Move the Docker setup to rootless Podman** (`--userns=keep-id`, same Dockerfile, socket bind-mount) for the cases wanting a real image/devenv (heavy toolchains, `npm install` of untrusted code). This removes the root-equivalent Docker daemon, the biggest hole in the current setup, at nearly zero migration cost.
3. **A QEMU/KVM VM (libvirt or quickemu, or Gondolin for tool-only isolation) as a rehearsal/stronger tier**: snapshot, let an agent try pacman/systemd/Hyprland/root changes, revert. Gondolin is the option that doesn't break hyprpi, since Pi and the socket stay on the host while risky commands run in a micro-VM.

Skip: Firejail (setuid, redundant with bwrap), gVisor/Kata/Firecracker (infra-grade glue), cloud sandboxes (code leaves the machine, can't reach the local socket).

## Surprises / open questions
- Pi's own docs already enumerate Docker, Docker Sandboxes (`sbx`, with an official pi-kit), OpenShell and Gondolin; none of them is bubblewrap, though the two biggest competitors use exactly that.
- Landlock is active on this kernel and `landrun` is in the AUR, so a zero-install-config fs guard is possible for tools that don't need isolation of visibility.
- The hyprpi Unix socket is the deciding factor: it favors namespace-based sandboxes over VMs; VM options need a vsock/TCP bridge (unverified how the daemon would authenticate).
- Open: how `sbx` could expose the hyprpi socket, whether `sbx` runs on Arch, and how well `srt` handles the `XDG_RUNTIME_DIR` socket path (needs testing, not done here).
