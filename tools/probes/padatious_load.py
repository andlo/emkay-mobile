"""How long padatious needs to load its cached networks (no training)."""
import glob
import sys
import os
import time

from ovos_padatious import fann

folder = sys.argv[1] if len(sys.argv) > 1 else "/cache/en-US"
nets = sorted(glob.glob(os.path.join(folder, "*.net")))
t = time.time()
for p in nets:
    n = fann.neural_net()
    assert n.create_from_file(p), p
dt = time.time() - t
size = sum(os.path.getsize(p) for p in nets) / 1e6
print(f"loaded {len(nets)} nets ({size:.1f} MB) in {dt:.1f}s = {1000 * dt / max(1, len(nets)):.0f} ms each")
