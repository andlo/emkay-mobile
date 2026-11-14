"""Who waits forever on a lock in Pyodide?

With one thread, a blocking lock acquire that cannot succeed at once can
never succeed (Condition.wait, Queue.get, a plain Lock taken twice):
Pyodide then spins in _PyMutex_LockTimed. This swaps threading's lock
factories for one that prints the Python stack and raises instead.

  EMKAY_MOUNT=build/intent_cache:/home/pyodide/.local/share/mycroft,build/m2v:/home/pyodide/.local/share/emkay-mobile/m2v \
    node tools/node_run.mjs wheelhouse plan.json tools/probes/deadlock.py ["utterance"]
"""
import _thread
import asyncio
import sys
import threading
import time
import traceback

from emkay_mobile import boot

text = sys.argv[1] if len(sys.argv) > 1 else "what time is it"
seen = set()


class LoudLock:
    """A Lock that reports a blocking acquire that could never return."""

    def __init__(self):
        self._lock = _thread.allocate_lock()

    def acquire(self, blocking=True, timeout=-1):
        if self._lock.acquire(False):
            return True
        if not blocking:
            return False
        stack = "".join(traceback.format_stack()[-14:-1])
        if stack not in seen:
            seen.add(stack)
            print(f"\n=== blocking acquire (timeout={timeout}) on a held lock ===\n{stack}", flush=True)
        if timeout is not None and timeout >= 0:
            return False  # nothing else can release it within the timeout
        raise RuntimeError("deadlock: waiting forever on a lock in a single thread")

    __enter__ = acquire

    def __exit__(self, *exc):
        self.release()

    def release(self):
        self._lock.release()

    def locked(self):
        return self._lock.locked()

    def _at_fork_reinit(self):
        self._lock = _thread.allocate_lock()


threading.Lock = LoudLock
threading._allocate_lock = LoudLock

info = boot.start()
print(f"boot done: {info['seconds']}s", flush=True)
bus = boot.bus()
for t in ("speak", "intent_failure", "ovos.utterance.handled", "complete_intent_failure"):
    bus.on(t, lambda m, t=t: print(f"BUS {t}: {str(m.data)[:200]}", flush=True))
await asyncio.sleep(90)
print(f"utterance: {text!r}", flush=True)
t = time.time()
boot.utterance(text)
await asyncio.sleep(60)
print(f"done after {time.time() - t:.1f}s", flush=True)
