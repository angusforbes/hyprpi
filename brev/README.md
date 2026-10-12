# brev/: a remote world on a Brev GPU instance

Status: tested end to end twice. J476 (2026-10-11) on a g4dn.xlarge (AWS, one T4 16 GB, 16 GB RAM, $0.63/h): hyprpi as world I, Qwen/Qwen2.5-3B-Instruct served by vLLM, and a pi agent (brev-alpha) answering and using its bash tool through it, in a window on the laptop. The T4 was too small for more than one model at a time, and an SD3.5 test ran its RAM out. J483 (2026-10-12) moved world I to an l40s-48gb.1x (Crusoe, one L40S 48 GB, 147 GB RAM, $1.74/h): Qwen2.5-3B and SDXL-Turbo resident side by side, and brev-alpha made a picture with `brev-image`.

Why Brev: its GPUs and its large disks, to run bigger models on the box itself, next to the agents. hyprpi runs on a GPU instance, and its agents use those local models (and, if you add one, a hosted provider).

Brev rents cloud VMs (Ubuntu, Docker, SSH, CUDA) billed per running hour. Its CLI writes your ~/.ssh config, so a plain `ssh <instance>` reaches the box. That is all hyprpi's remote-world code needs: everything in `omnistation/` works over any ssh argv. So a Brev box is just another remote world, with no Brev-specific code; this folder holds the setup steps, an example binding and `serve-model.sh`.

How it differs from the Omnistation world (H):

| Topic          | Omnistation     | Brev GPU box        |
| -------------- | --------------- | ------------------- |
| Login          | Teleport, hours | plain ssh           |
| GitHub, HF     | blocked         | work                |
| hyprpi install | copied tar      | copied tar for now  |
| Models         | hosted only     | local, hosted opt.  |
| GPU            | none            | on the box          |
| sudo, Docker   | no              | yes, NVIDIA runtime |
| Cost           | none per hour   | per hour, even idle |
| After a stop   | n/a             | depends on cloud    |
| Allowed work   | your org's      | personal / public   |

- hyprpi install: `world X setup` copies the laptop's committed master as a tar, as for H. A git clone works too (GitHub is reachable), but only once the public repo has the omnistation/ code.
- Crusoe (l40s-48gb.1x, J483): Ubuntu 22.04, Docker with the NVIDIA runtime, no Node, no /home/ubuntu/workspace; a 124 GB root disk plus a 118 GB /data disk, and both survived a stop/start (boot about 40 s). Its GPU driver (565, CUDA 12.7) is older than the newest vLLM image's CUDA, so serve with `VLLM_IMAGE=vllm/vllm-openai:v0.10.1.1` (cu128).
- After a stop: on AWS types (g4dn, g5, g6) the root EBS disk survives a stop, and there is no /home/ubuntu/workspace at first; ~/.cache, however, is a link to an instance-store NVMe (/opt/dlami/nvme), which is wiped. On types that come with /home/ubuntu/workspace, only that folder survives. Either way: keep everything under /home/ubuntu/workspace (create it on AWS), never in ~/.cache.
- Allowed work: check your organisation's rules for what may run on a cloud box; typically personal experiments and public work only, with no company code, keys or internal names there.

## Setup (as tested)

1. Pick a STOPPABLE GPU type: `brev search gpu --stoppable --sort price --wide` (Features column: S = stoppable; the others can only be deleted, so they bill until then). Ask Angus first, with the type, its $/h and the S flag. Tested: g4dn.xlarge (T4 16 GB, 16 GB RAM, $0.63/h: one small model at a time) and l40s-48gb.1x (Crusoe, L40S 48 GB, 147 GB RAM, $1.74/h: a text model and an image model side by side). Avoid 1-vCPU / 4 GB RAM types: too small for vLLM plus pi.
2. Create it with a disk that fits the models: `brev create hyprpi-gpu --type g4dn.xlarge --min-disk 100 --jupyter=false -d` (the default is 500 GB, billed per GB-month even while stopped). Wait until `brev ls` says READY (about 5 min), then `brev refresh` (the IP can change after each start) and check `ssh hyprpi-gpu nvidia-smi`.
3. Bind a free world letter to it, privately: copy `brev/binding.example.json` to `~/.config/hyprpi/remote/<letter>.json` (600) and set the host. Its "prefix" starts every agent's name there (e.g. brev-). Tested as world I (workspaces 81-90).
4. Keep what must survive a stop under workspace, first:
   - `mkdir -p -m 700 ~/workspace/.hyprpi-<x> ~/workspace/.pi ~/workspace/work`, then links `~/.hyprpi-<x>`, `~/.pi` and `~/work` to them (remote.sh accepts linked folders since J476);
   - `chmod go-w ~ ~/.config`: the image ships them group-writable, and remote.sh refuses to start until they aren't;
   - `HF_HOME=/home/ubuntu/workspace/.cache/huggingface` in ~/.bashrc (serve-model.sh mounts that path into the vLLM container).
5. On the box, once: Node 22+ (the image has none; tmux, git and Docker are there). For example the nodejs.org tarball under workspace, linked into ~/.local/bin, which remote.sh puts on PATH:
   - `ssh hyprpi-gpu 'cd ~/workspace && curl -fsSL https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz | tar -xJ && ln -sfn ~/workspace/node-v22.20.0-linux-x64 ~/workspace/node && mkdir -p ~/.local/bin && for b in node npm npx; do ln -sf ~/workspace/node/bin/$b ~/.local/bin/$b; done'`
6. `omnistation/world X setup`: copies remote.sh and hbroker.mjs into `~/.hyprpi-<x>`, copies hyprpi to ~/hyprpi, installs Pi (the laptop's version) into ~/.local, and writes the headless config.
7. Serve a model: `scp brev/serve-model.sh hyprpi-gpu:workspace/`, then `ssh hyprpi-gpu workspace/serve-model.sh Qwen/Qwen2.5-3B-Instruct`. It runs `vllm/vllm-openai` in Docker on 127.0.0.1:8000 (half precision on a T4, which has no bfloat16; tool calls on, hermes parser), waits until it answers, and adds the model to pi's `~/.pi/agent/models.json` as provider local-vllm. First pull of the image: about 7 min; first start of a 3B model: about 3 min (download, compile, CUDA graphs). Gated models (e.g. Llama) need a Hugging Face token: make a separate read-only one for Brev and put it on the box yourself, `ssh hyprpi-gpu 'mkdir -p -m700 ~/workspace/.secrets && cat > ~/workspace/.secrets/hf_token && chmod 600 ~/workspace/.secrets/hf_token'` (paste, Ctrl-D); serve-model.sh passes it to vLLM as HF_TOKEN (accept each model's licence on its page first). Set it as pi's default once: `~/.pi/agent/settings.json` = `{ "defaultProvider": "local-vllm", "defaultModel": "Qwen/Qwen2.5-3B-Instruct" }` (600).
8. Images (optional): `scp brev/image/server.py brev/image/serve-image.sh hyprpi-gpu:workspace/brev-image/` and `scp brev/image/brev-image hyprpi-gpu:.local/bin/`, then `ssh hyprpi-gpu workspace/brev-image/serve-image.sh`. It keeps SDXL-Turbo resident on the GPU (about 7.5 GB) as a small service on 127.0.0.1:8001; start vLLM with `GPU_UTIL=0.6` so both fit on a 48 GB GPU. An agent runs `brev-image "<prompt>"` with its bash tool and gets the PNG's path (about 0.3–0.9 s at 512², 4 steps, on an L40S). `omnistation/world X images` copies new images to ~/Downloads/brev on the laptop and prints them as file:// links.
9. Agents: `omnistation/world X new NAME` (or SUPER+A on the world's workspaces) starts brev-NAME and opens its window on the laptop; `/model` there picks the model. No hosted key is on the box unless you add a separate, scoped one.
10. Between sessions: stop the agents and the box: `omnistation/world X stop all`, `brev stop hyprpi-gpu`. An idle GPU still bills by the hour. Afterwards (ask first, it spends credits): `brev start hyprpi-gpu`, `brev refresh`, `ssh hyprpi-gpu workspace/serve-model.sh` (restarts the last model) and `workspace/brev-image/serve-image.sh`, then `omnistation/world X recover`, which waits for ssh and starts and opens every agent that has a session there. Tested (J476): boot about 1 min, workspace, sessions and the Docker image all intact, the model back in about 4 min, and the agent resumed its conversation. A laptop window still open from before the stop reconnects by itself, so recover then opens a second one for the same agent: close one, or close the windows before stopping. Leave `recover --start-desktop` unused: it is for Omnistation.

## What the T4 test showed

- vLLM 0.31 runs on a T4 (compute capability 7.5) with the TRITON_ATTN backend (FlashAttention 2 needs 8.0+); a 3B model in fp16 plus a 32k context uses about 13 GB of the 15 GB.
- Qwen2.5-3B-Instruct answers in about 1-2 s and makes simple tool calls (it ran `nvidia-smi -L` through pi's bash tool), but it is weak as an agent. A 7B AWQ model (or a bigger GPU) is the next step.
- pi's system prompt alone is about 7k tokens, so keep the context at 32k or more.

## Rules for this world

1. Personal experiments and public work only.
2. Ask Angus before `brev create` or `brev start`; stop the box when you're done: it bills while running, idle or not.
3. Rebuild it per project or milestone; the setup above is cheap to repeat.
4. Watch the credit balance: running out can delete instances, and deleted data can't be recovered.

## Open

1. `recover` should skip agents whose window is already open on the laptop.
2. A stop/start routine (idea, not built): `world X` notices when all of the world's agents are idle and offers `brev stop`; `world X recover` could also run `brev start`, `brev refresh` and serve-model.sh.
3. The laptop's room and board panels don't show a remote world's room yet (it lives in the box's own daemon, as for H).
4. Once the public repo has omnistation/, `world X setup` could clone instead of copying a tar.
