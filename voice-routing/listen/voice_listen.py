#!/usr/bin/env python3
"""voice-listen — always-on keyword listener for hands-free dictation to agents (hyprpi voice-routing).

Holds the microphone open and runs a Vosk recogniser constrained to a tiny
grammar (the command phrases + [unk]), which costs a few percent of one CPU
core and no GPU. Audio is only *kept* while transcribing is "on"; keyword-only
listening never touches disk.

Phrases (configurable via ~/.config/voice-listen/config.json):
    "on the the on"      start keeping audio (state: on)
    "send the the send"  cut the buffer before the phrase, hand the segment to
                         `voice-agent deliver <wav>` (whisper + routing), keep going
    "off the the off"    deliver what is pending, stop keeping audio (state: idle)

Control (SIGUSR1/2 or the CLI wrapper): `voice-listen on|off|send|pause|resume|status`
communicate through $XDG_RUNTIME_DIR/voice-listen/{state,cmd}.
"""
import json, os, queue, signal, subprocess, sys, time, wave, threading
from pathlib import Path

import sounddevice as sd
from vosk import Model, KaldiRecognizer, SetLogLevel

SetLogLevel(-1)
RATE = 16000
RT = Path(os.environ.get("XDG_RUNTIME_DIR", "/tmp")) / "voice-listen"
RT.mkdir(parents=True, exist_ok=True)
STATE = RT / "state"          # idle | on | paused
CMD = RT / "cmd"              # one-shot commands written by the CLI
SEG_DIR = RT / "segments"; SEG_DIR.mkdir(exist_ok=True)
CFG = Path.home() / ".config/voice-listen/config.json"
HERE = Path(__file__).resolve().parent

DEFAULTS = {
    "phrases": {"on": "on on on", "send": "send send send", "off": "off off off"},
    "min_segment_secs": 0.6,       # ignore segments shorter than this (just the phrase)
    "phrase_lead_secs": 0.35,      # extra audio trimmed before the matched words (covers a clipped leading word)
    "match_min_hits": 3,           # of the last 4 recognised words, how many must belong to the phrase
    "deliver": ["voice-agent", "deliver"],
    "device": None,                # sounddevice input device (None = default)
}

def load_cfg():
    cfg = dict(DEFAULTS)
    try:
        cfg.update(json.loads(CFG.read_text()))
    except FileNotFoundError:
        CFG.parent.mkdir(parents=True, exist_ok=True)
        CFG.write_text(json.dumps(DEFAULTS, indent=2) + "\n")
    except Exception as e:
        print(f"config error: {e}; using defaults", file=sys.stderr)
    return cfg

import shutil
def notify(title, body="", ms=2500):
    if shutil.which("omarchy-notification-send"):
        cmd = ["omarchy-notification-send", "-g", "👂", "-u", "normal", "-t", str(ms), title, body]
    else:
        cmd = ["notify-send", "-a", "Voice", "-t", str(ms), "👂 " + title, body]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def set_state(s):
    STATE.write_text(s + "\n")

class Listener:
    def __init__(self, cfg):
        self.cfg = cfg
        self.phrases = cfg["phrases"]
        words = sorted({w for p in self.phrases.values() for w in p.split()})
        grammar = json.dumps(list(self.phrases.values()) + words + ["[unk]"])
        # the Vosk model sits in the data folder ($VOICE_ROUTING_HOME, set by `voice-listen run`); an older
        # install kept it next to this script
        data = Path(os.environ.get("VOICE_ROUTING_HOME", "")) if os.environ.get("VOICE_ROUTING_HOME") else HERE
        self.model = Model(str(data / "model" if (data / "model").is_dir() else HERE / "model"))
        self.rec = KaldiRecognizer(self.model, RATE, grammar)
        self.rec.SetWords(True)
        self.q = queue.Queue()
        self.buf = bytearray()          # audio kept while on
        self.buf_t0 = 0.0               # stream time (secs) of buf[0]
        self.stream_t = 0.0             # secs of audio consumed so far
        self.on = False
        self.paused = False
        self.lock = threading.Lock()
        set_state("idle")

    # ---- audio
    def _cb(self, indata, frames, t, status):
        self.q.put(bytes(indata))

    def run(self):
        signal.signal(signal.SIGUSR1, lambda *_: self.command("toggle"))
        signal.signal(signal.SIGUSR2, lambda *_: self.command("send"))
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        threading.Thread(target=self._cmd_watcher, daemon=True).start()
        dev = self.cfg.get("device")
        with sd.RawInputStream(samplerate=RATE, blocksize=RATE // 10, dtype="int16", channels=1,
                               device=dev, callback=self._cb):
            print("voice-listen: listening for", self.phrases, flush=True)
            while True:
                data = self.q.get()
                with self.lock:
                    self._consume(data)

    def _consume(self, data):
        n_secs = len(data) / 2 / RATE
        if self.paused:
            self.stream_t += n_secs
            return
        if self.on:
            self.buf.extend(data)
        self.stream_t += n_secs
        if self.rec.AcceptWaveform(data):
            self._handle(json.loads(self.rec.Result()))
        else:
            # partials let us react before the utterance ends (silence)
            part = json.loads(self.rec.PartialResult()).get("partial", "")
            if self._match(part):
                # force a final result with a little silence; it must be counted
                # in stream_t too, or Vosk's timestamps drift from our clock
                pad = b"\x00" * 3200
                self.stream_t += len(pad) / 2 / RATE
                if self.on:
                    self.buf.extend(pad)
                if self.rec.AcceptWaveform(pad):
                    self._handle(json.loads(self.rec.Result()))

    def _tail(self, phrase):
        # the distinctive core: the last N words ("the the on"); a leading word
        # is often clipped by the recogniser, especially right after silence
        n = int(self.cfg.get("match_tail_words", 3))
        return " ".join(phrase.split()[-n:])

    def _match(self, text):
        # Tolerant match: the last recognised word is the phrase's key word and
        # at least `match_min_hits` of the last 4 words belong to the phrase
        # ("the the on", "on the on", "send the send" all pass; "[unk]" never).
        w = text.split()
        if not w:
            return None
        window = w[-4:]
        for k, p in self.phrases.items():
            pw = p.split()
            if window[-1] == pw[-1] and sum(x in pw for x in window) >= int(self.cfg.get("match_min_hits", 3)):
                return k
        return None

    def _handle(self, res):
        text = res.get("text", "")
        k = self._match(text)
        if not k:
            return
        # start time of the phrase = start of its first word within the result
        words = res.get("result", [])
        pw = self.phrases[k].split()
        tail = words[-4:]
        hits = [x for x in tail if x["word"] in pw]
        phrase_words = hits or tail[-1:]
        # Vosk timestamps are relative to recogniser start, i.e. stream time
        phrase_start = phrase_words[0]["start"] if phrase_words else self.stream_t
        # Vosk often merges repeated words; assume ~0.45 s per missing repeat
        missing = max(0, len(pw) - len(hits))
        cut_t = max(0.0, phrase_start - float(self.cfg["phrase_lead_secs"]) - 0.45 * missing)
        print(f"phrase {k!r} at {phrase_start:.2f}s (stream {self.stream_t:.2f}s)", flush=True)
        self.command(k, cut_t=cut_t)

    # ---- commands
    def _cmd_watcher(self):
        while True:
            time.sleep(0.2)
            if CMD.exists():
                try:
                    c = CMD.read_text().strip()
                finally:
                    CMD.unlink(missing_ok=True)
                with self.lock:
                    self.command(c)

    def command(self, c, cut_t=None):
        if c.startswith("inject "):
            # debug: feed a 16 kHz mono s16 WAV through the pipeline as if spoken
            path = c.split(" ", 1)[1].strip()
            try:
                with wave.open(path, "rb") as w:
                    data = w.readframes(w.getnframes())
                for i in range(0, len(data), 3200):
                    self.q.put(data[i:i + 3200])
                self.q.put(b"\x00" * (RATE * 2))   # a second of silence to finalise
                print(f"injected {path} ({len(data)/2/RATE:.1f}s)", flush=True)
            except Exception as e:
                print(f"inject failed: {e}", flush=True)
            return
        if c == "toggle":
            c = "off" if self.on else "on"
        if c == "pause":
            self.paused = True; self.on = False; self.buf.clear(); set_state("paused")
            notify("Voice listening paused", "voice-listen resume · or say nothing", 2000); return
        if c == "resume":
            self.paused = False; set_state("idle"); notify("Listening for phrases", f"say “{self.phrases['on']}” to start", 2000); return
        if self.paused:
            return
        if c == "on":
            if not self.on:
                self.on = True; self.buf.clear(); self.buf_t0 = self.stream_t; set_state("on")
                notify("🎙 Transcribing", f"“{self.phrases['send']}” to send · “{self.phrases['off']}” to stop", 3000)
            return
        if c in ("send", "off"):
            if self.on:
                self._flush(cut_t)
            if c == "off":
                self.on = False; set_state("idle")
                notify("Stopped transcribing", f"listening for “{self.phrases['on']}”", 2000)
            elif self.on:
                # start next segment right after the phrase
                self.buf.clear(); self.buf_t0 = self.stream_t
            return
        if c == "status":
            return

    def _flush(self, cut_t):
        end = len(self.buf)
        if cut_t is not None:
            end = int(max(0.0, cut_t - self.buf_t0) * RATE) * 2
            end = min(end, len(self.buf))
        seg = bytes(self.buf[:end])
        secs = len(seg) / 2 / RATE
        if secs < float(self.cfg["min_segment_secs"]):
            print(f"segment too short ({secs:.2f}s), skipped", flush=True)
            return
        path = SEG_DIR / f"seg-{int(time.time()*1000)}.wav"
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(seg)
        print(f"segment {secs:.1f}s -> {path}", flush=True)
        subprocess.Popen(self.cfg["deliver"] + [str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if __name__ == "__main__":
    Listener(load_cfg()).run()
