#!/bin/bash
# hyprpi voice-routing installer: speak to hyprpi agents (see README.md).
#
#   voice-routing/install.sh              install everything that applies to this machine
#   voice-routing/install.sh --no-gpu     force CPU faster-whisper (skip CUDA wheels, ~1.3 GB smaller)
#   voice-routing/install.sh --no-widget  skip the Omarchy bar widget even if omarchy-shell exists
#   voice-routing/install.sh --no-pi      skip the Pi extension (/voice-switch)
#   VOICE_WHISPER_MODEL=tiny.en voice-routing/install.sh    choose the whisper model
#                             (default: small.en with a GPU, base.en on CPU)
#
# The scripts, the bar widget and the Pi extension are LINKED from this checkout, so a `git pull` updates
# them; re-run after moving the checkout to repoint the links. Idempotent. Nothing is enabled to start at
# login; hands-free is off until you turn it on (voice-agent handsfree on).
set -euo pipefail

HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
BIN="${XDG_BIN_HOME:-$HOME/.local/bin}"
SHARE="${XDG_DATA_HOME:-$HOME/.local/share}"
DATA="${VOICE_ROUTING_HOME:-$SHARE/voice-routing}"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
GPU=auto WIDGET=auto PI=yes
MODEL="${VOICE_WHISPER_MODEL:-}"   # empty = small.en on GPU, base.en on CPU
for a in "$@"; do case $a in
  --no-gpu) GPU=no ;; --no-widget) WIDGET=no ;; --no-pi) PI=no ;;
  -h|--help) sed -n 2,13p "$0"; exit 0 ;;
  *) echo "unknown option $a" >&2; exit 2 ;;
esac; done

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
need() { command -v "$1" >/dev/null || { echo "missing required command: $1 ($2)" >&2; exit 1; }; }
# Link $2 -> $1. An existing plain file or folder (an older copy-based install) is moved to
# $SHARE/voice-routing-backups first; a link elsewhere is replaced.
link() {
  local to=$1 at=$2
  if [[ -L $at ]]; then [[ $(readlink -f "$at") == "$(readlink -f "$to")" ]] && return 0; rm -f "$at"
  elif [[ -e $at ]]; then mkdir -p "$SHARE/voice-routing-backups"; mv "$at" "$SHARE/voice-routing-backups/$(basename "$at").$(date +%Y%m%d-%H%M%S)"; warn "moved the old $(basename "$at") to $SHARE/voice-routing-backups"; fi
  mkdir -p "$(dirname "$at")"; ln -s "$to" "$at"
}

# ---- prerequisites -----------------------------------------------------------
need jq     "package: jq"
need socat  "package: socat"
need uv     "https://docs.astral.sh/uv/ (or: pip install uv)"
need pw-record "PipeWire (pipewire-audio / pipewire-pulse)"
command -v hyprpi >/dev/null || [[ -x $HERE/../bin/hyprpi ]] || warn "hyprpi not found: voice has nowhere to deliver"
command -v notify-send >/dev/null || command -v omarchy-notification-send >/dev/null || warn "no notify-send: toasts disabled"
command -v hyprctl >/dev/null || warn "hyprctl not found: the 'focused window' context is disabled"

# ---- data folder (an older herdr-voice-to-agents install is moved, keeping its venv and models) -------
if [[ -z ${VOICE_ROUTING_HOME:-} && ! -e $DATA && -d $SHARE/herdr-voice-to-agents ]]; then
  say "moving $SHARE/herdr-voice-to-agents -> $DATA (venv and models kept)"
  mv "$SHARE/herdr-voice-to-agents" "$DATA"
  rm -f "$DATA/voice_listen.py" "$DATA/voice_whisper.py"; rm -rf "$DATA/__pycache__"   # now run from the checkout
fi
mkdir -p "$DATA"

# ---- links ---------------------------------------------------------------------
say "scripts -> $BIN (links into $HERE/bin)"
for f in voice-agent voice-agent-target voice-listen voice-whisper-client; do link "$HERE/bin/$f" "$BIN/$f"; done
case ":$PATH:" in *":$BIN:"*) ;; *) warn "$BIN is not on your PATH";; esac
if [[ ! -f $CFG/voice-listen/config.json ]]; then
  mkdir -p "$CFG/voice-listen"; install -m644 "$HERE/listen/config.example.json" "$CFG/voice-listen/config.json"
fi

# ---- python env ----------------------------------------------------------------------
say "python environment (uv) in $DATA"
[[ -d $DATA/.venv ]] || uv venv -q "$DATA/.venv"
if [[ $GPU == auto ]]; then
  if command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1; then GPU=yes; else GPU=no; fi
fi
pkgs=(vosk sounddevice faster-whisper)
[[ $GPU == yes ]] && pkgs+=(nvidia-cublas-cu12 nvidia-cudnn-cu12)
uv pip install -q --python "$DATA/.venv/bin/python" "${pkgs[@]}"
[[ -n $MODEL ]] || MODEL=$([[ $GPU == yes ]] && echo small.en || echo base.en)
say "faster-whisper: $([[ $GPU == yes ]] && echo 'CUDA (GPU)' || echo 'CPU int8'), model $MODEL"

if [[ ! -d $DATA/model ]]; then
  say "Vosk small English model (~40 MB) for the command phrases"
  tmp=$(mktemp -d); curl -sL -o "$tmp/m.zip" https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip
  unzip -q "$tmp/m.zip" -d "$tmp"; mv "$tmp"/vosk-model-small-en-us-0.15 "$DATA/model"; rm -rf "$tmp"
fi

fetch_model=("$DATA/.venv/bin/python" - "$MODEL")
if HF_HUB_OFFLINE=1 "${fetch_model[@]}" >/dev/null 2>&1 <<<'import sys; from huggingface_hub import snapshot_download; snapshot_download("Systran/faster-whisper-" + sys.argv[1], allow_patterns=["*.bin", "*.json", "*.txt"])'; then
  say "faster-whisper $MODEL is already downloaded"
else
say "pre-downloading faster-whisper $MODEL (one time; Ctrl-C to skip)"
HF_HUB_DISABLE_TELEMETRY=1 timeout 600 "$DATA/.venv/bin/python" - "$MODEL" <<'PY' || warn "model not pre-downloaded; fetched on first use instead (needs network once)"
import sys; from huggingface_hub import snapshot_download
snapshot_download("Systran/faster-whisper-" + sys.argv[1], allow_patterns=["*.bin", "*.json", "*.txt"])
PY
fi

# ---- systemd user units -------------------------------------------------------------
say "systemd user units (installed, NOT enabled)"
mkdir -p "$CFG/systemd/user"
for u in voice-listen voice-whisper; do
  sed -e "s|%h/.local/bin/|$BIN/|" -e "s|^Environment=VOICE_WHISPER_MODEL=.*|Environment=VOICE_WHISPER_MODEL=$MODEL|" \
    "$HERE/systemd/$u.service" > "$CFG/systemd/user/$u.service"
done
[[ $BIN == "$HOME/.local/bin" ]] && sed -i "s|$HOME/.local/bin/|%h/.local/bin/|" "$CFG/systemd/user/voice-listen.service" "$CFG/systemd/user/voice-whisper.service"
systemctl --user daemon-reload 2>/dev/null || warn "systemctl --user unavailable here; run: systemctl --user daemon-reload"

# ---- pi extension ------------------------------------------------------------------
if [[ $PI == yes ]]; then
  if [[ -d $HOME/.pi/agent/extensions ]]; then
    say "Pi extension -> ~/.pi/agent/extensions/voice-switch.ts (link; agents pick it up on /reload)"
    link "$HERE/pi/voice-switch.ts" "$HOME/.pi/agent/extensions/voice-switch.ts"
  else
    warn "~/.pi/agent/extensions not found; skipping the Pi extension (--no-pi to silence)"
  fi
fi

# ---- omarchy bar widget -----------------------------------------------------------
if [[ $WIDGET != no ]] && command -v omarchy-shell >/dev/null; then
  say "Omarchy bar widget -> ~/.config/omarchy/plugins/herdr.voice (link)"
  link "$HERE/omarchy-plugin/herdr.voice" "$CFG/omarchy/plugins/herdr.voice"
  if ! omarchy-shell shell listShellConfig 2>/dev/null | jq -e '.bar.layout[][] | select(.id=="herdr.voice")' >/dev/null; then
    omarchy-shell shell putBarWidget herdr.voice '{"section":"right","before":"omarchy.audio"}' >/dev/null 2>&1 \
      || warn "could not add the widget to the bar automatically; use the Omarchy bar settings"
  fi
elif [[ $WIDGET != no ]]; then
  warn "omarchy-shell not found: skipping the bar widget (use 'voice-agent target' as the picker)"
fi

cat <<EOF

Done. Next:
  1. Bind a key to 'voice-agent' (push-to-talk) and one to 'voice-agent target'
     or 'omarchy-shell herdr.voice toggle'. See voice-routing/hypr/ for examples.
  2. With no target, dictation goes to the Thoughts of the world you're on. Pick another:
     voice-agent target   (or the bar widget, or /voice-switch in a Pi agent)
  3. Optional hands-free: voice-agent handsfree on  (say "on on on" / "send send send" / "off off off")
Status any time:         voice-agent status
EOF
