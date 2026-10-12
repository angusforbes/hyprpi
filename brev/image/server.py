# brev/image/server.py: a tiny text-to-image service on the Brev GPU box (J483). Keeps SDXL-Turbo resident on the GPU and
# answers POST /generate {"prompt": "...", "steps": 4, "size": 512} on 127.0.0.1:8001 with {"path": ..., "seconds": ...}.
# Images go to /outputs (the box's ~/workspace/outputs). Started by brev/image/serve-image.sh; called by brev-image.
import json, os, re, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import torch
from diffusers import AutoPipelineForText2Image

MODEL = os.environ.get("IMAGE_MODEL", "stabilityai/sdxl-turbo")
OUT = os.environ.get("IMAGE_OUT", "/outputs")
pipe = AutoPipelineForText2Image.from_pretrained(MODEL, torch_dtype=torch.float16, variant="fp16").to("cuda")
pipe.set_progress_bar_config(disable=True)
lock = threading.Lock()  # one image at a time on the GPU


class H(BaseHTTPRequestHandler):
    timeout = 30  # a client that stops sending is dropped

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        self._send(200, {"model": MODEL, "ok": True})

    def do_POST(self):
        if self.path != "/generate":
            return self._send(404, {"error": "POST /generate"})
        try:
            try:
                n = int(self.headers.get("Content-Length", "0") or 0)
            except ValueError:
                n = -1
            if not 0 <= n <= 16384:
                return self._send(413, {"error": "the request body must be 0-16384 bytes"})
            try:
                req = json.loads(self.rfile.read(n) or b"{}")
                if not isinstance(req, dict):
                    raise ValueError("not an object")
                prompt = str(req.get("prompt", "")).strip()[:1000]
                steps = max(1, min(int(req.get("steps", 4)), 8))
                size = max(256, min(int(req.get("size", 512)) // 64 * 64, 1024))
            except (ValueError, TypeError) as e:
                return self._send(400, {"error": f"bad request: {e}"[:200]})
            if not prompt:
                return self._send(400, {"error": "empty prompt"})
            with lock:
                t = time.time()
                img = pipe(prompt, num_inference_steps=steps, guidance_scale=0.0, height=size, width=size).images[0]
                secs = round(time.time() - t, 2)
            slug = re.sub(r"[^a-z0-9]+", "-", prompt.lower())[:40].strip("-") or "image"
            path = os.path.join(OUT, f"{time.strftime('%Y%m%d-%H%M%S')}-{int(time.time() * 1000) % 1000:03d}-{slug}.png")
            img.save(path)
            self._send(200, {"path": path, "seconds": secs, "steps": steps, "size": size, "model": MODEL})
        except Exception as e:  # report, keep serving
            self._send(500, {"error": str(e)[:300]})

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("0.0.0.0", 8001), H).serve_forever()
