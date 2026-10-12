# Third-party material in hyprpi

hyprpi itself is MIT-licensed (see [LICENSE](LICENSE)). These parts come from other projects and keep their own licences:

| Files | From | Licence |
|---|---|---|
| assets/sounds/done.mp3 | herdr | Apache-2.0 |
| assets/sounds/request.mp3 | herdr | Apache-2.0 |
| hyprwrlds-vimarchy/Overview.qml (parts) | Vimarchy | MIT |

- herdr: <https://github.com/herdrdev/herdr>. The two sounds are byte-identical copies of herdr's `assets/sounds/done.mp3` and `assets/sounds/request.mp3` (herdr's done ding and request sound), unmodified. Licensed under the Apache License 2.0; a copy is in [licenses/herdr-Apache-2.0.txt](licenses/herdr-Apache-2.0.txt). herdr has no NOTICE file.
- Vimarchy: <https://github.com/clickety-clacks/vimarchy>, Copyright (c) 2026 Mike Manzano, MIT. hyprwrlds-vimarchy's overview adapts Vimarchy's look (its hint colour palette and badge sizing rule) and a few code shapes (the snapshot/generation loading, the settings save timer, the layer anchors). Vimarchy's licence notice is in [licenses/vimarchy-MIT.txt](licenses/vimarchy-MIT.txt).
