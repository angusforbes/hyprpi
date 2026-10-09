# disk-cap test: writes 8 MiB files into /out until the host kills the worker (cap: 48 MiB total in /job + /out)
import os, time
i = 0
while True:
    with open(f"/out/f{i}.bin", "wb") as f: f.write(os.urandom(8 << 20))
    i += 1; time.sleep(0.05)
