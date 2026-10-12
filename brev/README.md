# brev/: a remote world on a Brev GPU instance (skeleton)

Status: notes only. Nothing here has been run yet; the commands are the plan.

Why Brev: its GPUs and its large disks, to run bigger models on the box itself, next to the agents. hyprpi runs on a GPU instance, and its agents can use those local models as well as a hosted provider.

Brev rents cloud VMs (Ubuntu, Docker, SSH, CUDA) billed per running hour. Its CLI writes your ~/.ssh config, so a plain `ssh <instance>` reaches the box. That is all hyprpi's remote-world code needs: everything in `omnistation/` works over any ssh argv. So a Brev box is just another remote world, with no Brev-specific code; this folder holds the setup steps and an example binding.

How it differs from the Omnistation world:

| Topic          | Omnistation     | Brev GPU box        |
| -------------- | --------------- | ------------------- |
| Login          | Teleport, hours | plain ssh           |
| GitHub, HF     | blocked         | work                |
| hyprpi install | copied tar      | git clone           |
| Models         | hosted only     | hosted plus local   |
| Cost           | none per hour   | per hour, even idle |
| After a stop   | n/a             | only workspace/     |
| Allowed work   | your org's      | personal / public   |

- Allowed work: check your organisation's rules for what may run on a cloud box; typically personal experiments and public work only, with no company code, data or internal tools there.
- After a stop: only `/home/ubuntu/workspace` (plus system packages and Docker images) survives, so models, caches and hyprpi's state live there (step 5).

## Setup (plan)

1. Pick a STOPPABLE GPU type: in `brev search` only types marked S can be stopped; the others can only be deleted, so they bill until then. A suggested start: one L40S 48 GB (roughly $0.9–1.5/h), or one H100 80 GB (roughly $3–5.40/h) for bigger models. Give it a large disk (`--min-disk`; 500 GB is the default, more for large models): `brev create hyprpi-gpu --type <a stoppable GPU type> --min-disk 1000`.
2. `brev login`; after each start `brev refresh` (the IP can change). Check: `ssh hyprpi-gpu nvidia-smi`.
3. Bind a free world letter to it, privately: copy `brev/binding.example.json` to `~/.config/hyprpi/remote/<letter>.json` and set the host. Its "prefix" starts every agent's name there (e.g. brev-).
4. On the box, once: Node 22+, tmux and git (`sudo apt install tmux git`; Node from nodejs.org or nvm, since Ubuntu's may be too old). Clone hyprpi there: `ssh hyprpi-gpu git clone https://github.com/angusforbes/hyprpi.git /home/ubuntu/workspace/hyprpi`, linked as `~/hyprpi`. `world X setup` then updates it with `git pull` instead of copying a tar.
5. Keep what must survive a stop under workspace:
   - `HF_HOME=/home/ubuntu/workspace/.cache/huggingface` (in ~/.bashrc), and the models themselves under `/home/ubuntu/workspace/models`;
   - hyprpi's world state: make `~/.hyprpi-<x>` a link to `/home/ubuntu/workspace/.hyprpi-<x>` before the first `world X setup`;
   - pi's settings and sessions: likewise `~/.pi` as a link into workspace (keeping files 600, folders 700).
6. `omnistation/world X setup`: copies remote.sh and hbroker.mjs into `~/.hyprpi-<x>`, installs Pi if missing, and writes the headless config.
7. Serve models on the box with an OpenAI-compatible server on localhost: vLLM, llama.cpp's server, or a model container. For example: `vllm serve <model> --port 8000`. Then add it to pi's `~/.pi/agent/models.json` there as a local provider (baseUrl `http://127.0.0.1:8000/v1`, the model ids it serves), next to a hosted provider with a key of its own: a separate, scoped key, not one shared with other machines. Files 600, folders 700: remote.sh refuses to start otherwise.
8. Agents: `omnistation/world X new` (or SUPER+A on the world's workspaces) starts one and opens its window on the laptop; `/model` in the window picks a local or a hosted model.
9. Between sessions: stop the box (`brev stop hyprpi-gpu`). An idle GPU still bills by the hour. Afterwards: `brev start`, `brev refresh`, start the model server again, then `omnistation/world X recover`, which waits for ssh and starts and opens every agent that has a session there. Leave `recover --start-desktop` unused: it is for Omnistation.

## Rules for this world

1. Personal experiments and public work only.
2. Stop the box when you're done: it bills while running, idle or not.
3. Rebuild it per project or milestone; the setup above is cheap to repeat.
4. Watch the credit balance: running out can delete instances, and deleted data can't be recovered.

## Open

1. Test the steps on a real instance and correct this file (the links into workspace, the model server's start after a stop).
2. A stop/start routine (idea, not built): `world X` notices when all of the world's agents are idle and offers `brev stop`; `world X recover` could also run `brev start` and `brev refresh`.
3. Starting the model server with the agents (a small script under workspace that `recover` runs first).
