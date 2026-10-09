# tiny CUDA job: a 1024 x 1024 float32 matrix multiply on the GPU (driver API + a hand-written PTX kernel, no frameworks, no pip).
# A is all 1.0, B is all 2.0, so every entry of C must be 2048.0. Uses about 48 MiB of VRAM plus the CUDA context.
import array, ctypes, os, time
N = int(os.environ.get("MATMUL_N", "1024"))
PTX = b"""
.version 7.0
.target sm_50
.address_size 64
.visible .entry matmul(.param .u64 pa, .param .u64 pb, .param .u64 pc, .param .u32 pn)
{
 .reg .pred p; .reg .b32 r<10>; .reg .b64 rd<12>; .reg .f32 f<5>;
 ld.param.u64 rd1,[pa]; ld.param.u64 rd2,[pb]; ld.param.u64 rd3,[pc]; ld.param.u32 r1,[pn];
 mov.u32 r2,%ctaid.x; mov.u32 r3,%ntid.x; mov.u32 r4,%tid.x; mad.lo.s32 r5,r2,r3,r4;
 mov.u32 r6,%ctaid.y; mov.u32 r7,%ntid.y; mov.u32 r8,%tid.y; mad.lo.s32 r9,r6,r7,r8;
 setp.ge.s32 p,r5,r1; @p bra DONE;
 setp.ge.s32 p,r9,r1; @p bra DONE;
 mov.f32 f1,0f00000000; mov.u32 r2,0;
LOOP:
 setp.ge.s32 p,r2,r1; @p bra STORE;
 mad.lo.s32 r3,r9,r1,r2; mul.wide.s32 rd4,r3,4; add.s64 rd5,rd1,rd4; ld.global.f32 f2,[rd5];
 mad.lo.s32 r4,r2,r1,r5; mul.wide.s32 rd6,r4,4; add.s64 rd7,rd2,rd6; ld.global.f32 f3,[rd7];
 fma.rn.f32 f1,f2,f3,f1; add.s32 r2,r2,1; bra LOOP;
STORE:
 mad.lo.s32 r3,r9,r1,r5; mul.wide.s32 rd8,r3,4; add.s64 rd9,rd3,rd8; st.global.f32 [rd9],f1;
DONE:
 ret;
}
\0"""
cu = ctypes.CDLL("libcuda.so.1")
def ck(r, what):
    if r != 0: raise SystemExit(f"{what} failed: CUDA error {r}")
ck(cu.cuInit(0), "cuInit")
dev = ctypes.c_int(); ck(cu.cuDeviceGet(ctypes.byref(dev), 0), "cuDeviceGet")
name = ctypes.create_string_buffer(100); cu.cuDeviceGetName(name, 100, dev); print("device:", name.value.decode())
ctx = ctypes.c_void_p(); ck(cu.cuCtxCreate_v2(ctypes.byref(ctx), 0, dev), "cuCtxCreate")
mod = ctypes.c_void_p(); ck(cu.cuModuleLoadData(ctypes.byref(mod), PTX), "cuModuleLoadData (JIT of the PTX)")
fn = ctypes.c_void_p(); ck(cu.cuModuleGetFunction(ctypes.byref(fn), mod, b"matmul"), "cuModuleGetFunction")
nb = N * N * 4
def dalloc():
    p = ctypes.c_uint64(); ck(cu.cuMemAlloc_v2(ctypes.byref(p), ctypes.c_size_t(nb)), "cuMemAlloc"); return p
dA, dB, dC = dalloc(), dalloc(), dalloc()
hA = (ctypes.c_float * (N * N)).from_buffer_copy(array.array("f", [1.0]) * (N * N))
hB = (ctypes.c_float * (N * N)).from_buffer_copy(array.array("f", [2.0]) * (N * N))
ck(cu.cuMemcpyHtoD_v2(dA, hA, ctypes.c_size_t(nb)), "copy A"); ck(cu.cuMemcpyHtoD_v2(dB, hB, ctypes.c_size_t(nb)), "copy B")
args = [ctypes.c_uint64(dA.value), ctypes.c_uint64(dB.value), ctypes.c_uint64(dC.value), ctypes.c_uint32(N)]
argv = (ctypes.c_void_p * 4)(*[ctypes.cast(ctypes.pointer(a), ctypes.c_void_p) for a in args])
g = (N + 15) // 16
t = time.time()
ck(cu.cuLaunchKernel(fn, g, g, 1, 16, 16, 1, 0, None, argv, None), "cuLaunchKernel"); ck(cu.cuCtxSynchronize(), "cuCtxSynchronize")
dt = time.time() - t
hC = (ctypes.c_float * (N * N))(); ck(cu.cuMemcpyDtoH_v2(hC, dC, ctypes.c_size_t(nb)), "copy C")
bad = sum(1 for v in hC if v != 2.0 * N)
gflops = 2.0 * N ** 3 / dt / 1e9
print(f"matmul {N}x{N} float32 on the GPU: {dt*1000:.1f} ms, {gflops:.0f} GFLOP/s, wrong entries: {bad} of {N*N}, C[0][0]={hC[0]}, C[N-1][N-1]={hC[N*N-1]}")
open("/out/matmul.txt", "w").write(f"N={N} ms={dt*1000:.1f} wrong={bad} c00={hC[0]}\n")
raise SystemExit(0 if bad == 0 else 1)
