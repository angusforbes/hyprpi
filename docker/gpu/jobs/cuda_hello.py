# tiny CUDA driver-API job: allocate 256 MiB on the GPU, fill it, read it back (no frameworks, no pip)
import ctypes, os, subprocess, time
cu = ctypes.CDLL("libcuda.so.1")
def ck(r, what):
    if r != 0: raise SystemExit(f"{what} failed: CUDA error {r}")
ck(cu.cuInit(0), "cuInit")
dev = ctypes.c_int(); ck(cu.cuDeviceGet(ctypes.byref(dev), 0), "cuDeviceGet")
name = ctypes.create_string_buffer(100); cu.cuDeviceGetName(name, 100, dev); print("device:", name.value.decode())
ctx = ctypes.c_void_p(); ck(cu.cuCtxCreate_v2(ctypes.byref(ctx), 0, dev), "cuCtxCreate")
n = int(os.environ.get("ALLOC_MIB", "256")) << 20
p = ctypes.c_uint64(); ck(cu.cuMemAlloc_v2(ctypes.byref(p), ctypes.c_size_t(n)), "cuMemAlloc")
ck(cu.cuMemsetD8_v2(p, ctypes.c_ubyte(0xA5), ctypes.c_size_t(n)), "cuMemset")
buf = (ctypes.c_ubyte * 16)(); ck(cu.cuMemcpyDtoH_v2(buf, p, ctypes.c_size_t(16)), "cuMemcpyDtoH")
print("allocated", n >> 20, "MiB, first bytes", bytes(buf).hex())
time.sleep(float(os.environ.get("HOLD_S", "2")))
smi = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.used", "--format=csv,noheader"], capture_output=True, text=True)
print("nvidia-smi in the worker:", (smi.stdout or smi.stderr).strip())
open("/out/cuda_hello.txt", "w").write(f"ok {n>>20} MiB {bytes(buf).hex()}\n")
