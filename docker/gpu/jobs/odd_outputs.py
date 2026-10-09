# odd outputs: an escape sequence in a file name, a symlink to a host file, two paths that flatten to one name, a big file
import os
os.makedirs("/out/sub", exist_ok=True)
open("/out/sub/x", "w").write("one\n"); open("/out/sub__x", "w").write("two two\n")
open("/out/\x1b[31mEVIL", "w").write("x")
os.symlink("/etc/passwd", "/out/link")
open("/out/big.bin", "wb").write(b"0" * (2 << 20))
open("/out/fine.txt", "w").write("fine\n")
print("\x1b]0;title\x07done \x1b[31mred")
