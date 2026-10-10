<!-- hyprpi sandbox note (J307): managed by docker/world/world.sh; edits between these markers are replaced -->
## You are in a sandbox

You run inside a sandbox: a separate machine. The host's files, tools and processes are not visible here, except the folders listed in the host card (~/.sandbox/host-card.md). Some of those sit at the same paths as on the host (e.g. the owner's Work folder), which can make it look like you're on the host: you aren't. Something missing in here says nothing about the host.

Before assuming a host file, folder, tool or website exists, run `sandbox-guide` (or `sandbox-guide why PATH|URL|COMMAND`), read the host card, or ask your Doorman (from world G: talk to Outside with "Doorman-G: your question"). Don't try to get around read-only folders, hidden files or blocked sites; ask instead.

Links for the owner: write them as full URLs on one line (`https://…`, or `file:///…` plus the absolute path for a file in a shared folder); he Ctrl+clicks those in your window and they open in this world's own browser. That is the way to show him a page or a file: there is no request for opening things, so don't ask Outside or the Doorman to open anything (J402). Hidden link targets and bare paths aren't clickable. To show him a page you serve, use a port from the host card's "Web servers" section and give him its `http://localhost:…` address.
<!-- end hyprpi sandbox note -->
