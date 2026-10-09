#!/usr/bin/env python3
"""voice-whisper — resident faster-whisper transcription server (hyprpi voice-routing).

    voice_whisper.py            serve on $XDG_RUNTIME_DIR/voice-listen/whisper.sock
    voice_whisper.py --once F   transcribe one WAV and print the text (cold fallback)


Keeps the model loaded (GPU if available) so each dictation segment costs
~0.5-1 s instead of a 2.5 s cold model load. Unix-socket protocol, one JSON
line per request:  {"path": "/abs/file.wav"}  ->  {"text": "...", "secs": 1.23}
Client: `voice-whisper-client <wav>` (used by voice-agent deliver; falls back to
`voxtype transcribe` when the socket is absent).
"""
import json, os, socket, sys, time, threading
from pathlib import Path

RT = Path(os.environ.get("XDG_RUNTIME_DIR", "/tmp")) / "voice-listen"
RT.mkdir(parents=True, exist_ok=True)
SOCK = RT / "whisper.sock"
MODEL = os.environ.get("VOICE_WHISPER_MODEL", "small.en")

def load():
    """Load on CUDA if it is actually usable, else CPU. Constructing a CUDA model can
    succeed and then fail on the first transcription (missing cuBLAS), so probe."""
    from faster_whisper import WhisperModel
    want = os.environ.get("VOICE_WHISPER_DEVICE", "auto")
    if want != "cpu":
        try:
            m = WhisperModel(MODEL, device="cuda", compute_type="float16")
            list(m.transcribe(_silence_wav(), language="en", beam_size=1)[0])   # probe
            return m, "cuda/float16"
        except Exception as e:
            print(f"cuda unavailable ({e.__class__.__name__}: {e}); falling back to cpu", file=sys.stderr, flush=True)
    return WhisperModel(MODEL, device="cpu", compute_type="int8"), "cpu/int8"

def _silence_wav():
    import wave
    p = RT / "probe.wav"
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0" * 16000)
    return str(p)

def transcribe(model, path):
    segs, _info = model.transcribe(path, language="en", beam_size=3, vad_filter=True,
                                   condition_on_previous_text=False)
    return " ".join(s.text.strip() for s in segs).strip()

def serve():
    t0 = time.time(); model, dev = load()
    print(f"voice-whisper: {MODEL} loaded on {dev} in {time.time()-t0:.1f}s", flush=True)
    # warm-up so the first real request isn't slow
    try:
        import wave
        p = RT / "warm.wav"
        with wave.open(str(p), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0" * 32000)
        transcribe(model, str(p)); p.unlink(missing_ok=True)
    except Exception as e:
        print(f"warm-up failed: {e}", flush=True)
    SOCK.unlink(missing_ok=True)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); srv.bind(str(SOCK)); os.chmod(SOCK, 0o600); srv.listen(8)
    lock = threading.Lock()
    def handle(conn):
        with conn:
            try:
                req = json.loads(conn.makefile().readline() or "{}")
                t = time.time()
                with lock:
                    text = transcribe(model, req["path"])
                conn.sendall((json.dumps({"text": text, "secs": round(time.time() - t, 2)}) + "\n").encode())
                print(f"{req['path']}: {time.time()-t:.2f}s {text[:60]!r}", flush=True)
            except Exception as e:
                try: conn.sendall((json.dumps({"error": str(e)}) + "\n").encode())
                except Exception: pass
    while True:
        c, _ = srv.accept()
        threading.Thread(target=handle, args=(c,), daemon=True).start()

if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--once":
        try:
            model, _dev = load()
            print(transcribe(model, sys.argv[2]))
        except Exception as e:  # never let a traceback become the "transcript"
            print(f"voice-whisper: {e.__class__.__name__}: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        serve()
