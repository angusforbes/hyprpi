# brev/: a remote world on a Brev cloud instance (skeleton)

Status: notes only. Nothing here has been run yet; the commands are the plan.

Brev rents cloud VMs (Ubuntu, Docker, SSH; CPU or GPU) billed per running hour. Its CLI writes your ~/.ssh config, so a plain `ssh <instance>` reaches the box. That is all hyprpi's remote-world code needs: everything in `omnistation/` works over any ssh argv. So a Brev box is just another remote world. There is no Brev-specific code; this folder holds the setup steps and an example binding.

How it differs from the Omnistation world:

| Topic          | Omnistation     | Brev              |
| -------------- | --------------- | ----------------- |
| Login          | Teleport, hours | plain ssh         |
| GitHub         | blocked         | works             |
| hyprpi install | copied tar      | git clone         |
| Cost           | none per hour   | billed per hour   |
| After a stop   | n/a             | tmux, daemon gone |
| Allowed work   | your org's      | personal / public |

- Allowed work: check your organisation's rules for what may run on a cloud box. Typically only personal or public work, with no company code, data or internal tools there.
- After a stop: a stopped instance keeps only some folders, so test once whether `~/.hyprpi-<x>` (sessions) survives.

## Setup (plan)

1. Create a small, stoppable CPU instance (Pi needs no GPU when its model runs elsewhere): `brev search cpu --sort price`, then `brev create hyprpi-box --type <a stoppable CPU type>`.
2. `brev login`; after each start `brev refresh` (the IP can change). Check: `ssh hyprpi-box hostname`.
3. Bind a free world letter to it, privately: copy `brev/binding.example.json` to `~/.config/hyprpi/remote/<letter>.json` and set the host. Its "prefix" starts every agent's name there (e.g. brev-).
4. On the box, once: Node 22+, tmux and git (`sudo apt install tmux git`; Node from nodejs.org or nvm, since Ubuntu's may be too old). Then clone hyprpi there: `ssh hyprpi-box git clone https://github.com/angusforbes/hyprpi.git ~/hyprpi`. `world X setup` then updates it with `git pull` instead of copying a tar.
5. `omnistation/world X setup`: copies remote.sh and hbroker.mjs into `~/.hyprpi-<x>`, installs Pi if missing, and writes the headless config.
6. Pi's model provider on the box, privately: `~/.pi/agent/models.json` and a key of its own (a separate, scoped key, not one shared with other machines). Files 600, folders 700: remote.sh refuses to start otherwise.
7. Agents: `omnistation/world X new` (or SUPER+A on the world's workspaces) starts one and opens its window on the laptop.
8. After `brev stop` / `brev start`: `brev refresh`, then `omnistation/world X recover` (it waits for ssh, then starts and opens every agent that has a session there). Leave `recover --start-desktop` unused: it is for Omnistation.

## Rules for this world

1. Personal and public work only.
2. Stop the box when idle: it bills while running, idle or not.
3. Rebuild it per project or milestone; the setup above is cheap to repeat.
4. Watch the credit balance: running out can delete instances.

## Open

1. Test the steps on a real instance and correct this file.
2. Where state should live so a stop keeps it (inside the folder Brev keeps on stop, if `~/.hyprpi-<x>` is lost).
3. A `brev`-aware recover (start the instance, `brev refresh`) like Omnistation's desktop check, if it's wanted.
