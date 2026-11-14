"""Make a single-threaded WebAssembly Python look enough like a normal host for OVOS.

Pyodide cannot start OS threads. OVOS uses threads in three ways, and each gets
its own treatment:

* ThreadPoolExecutor.submit (bounded intent matching, bus emitter): run the
  call synchronously and hand back an already-finished Future.
* threading.Timer (timeouts, delayed speech, skill schedules): schedule the
  callback on the browser event loop with loop.call_later.
* threading.Thread (long-lived service loops such as the skill manager's
  30 s rescan or the event scheduler's poll): not started. Each one is
  recorded in STARTED so the page can show what was skipped; the few loops
  that matter are driven from JavaScript timers instead (see boot.tick()).
"""
import asyncio
import concurrent.futures as _cf
import os
import sys
import threading

STARTED = []
# Thread bodies that never return (service loops). They are not run at all;
# what they poll for is driven from the page instead.
FOREVER_LOOPS = (
    "ovos_core.skill_manager.SkillManager.run",
    "ovos_bus_client.util.scheduler.EventScheduler.run",
    "ovos_utils.events.EventScheduler.run",
)
_SHIMS = os.path.join(os.path.dirname(__file__), "shims")


def _loop():
    try:
        return asyncio.get_event_loop()
    except RuntimeError:  # pragma: no cover
        return None


def _target_name(self):
    t = getattr(self, "_target", None)
    if t is None:
        return f"{type(self).__module__}.{type(self).__qualname__}.run"
    return f"{getattr(t, '__module__', '?')}.{getattr(t, '__qualname__', repr(t))}"


def _thread_start(self):
    """Run the thread's body later on the event loop, unless it is a service loop."""
    name = _target_name(self)
    STARTED.append(name)
    self._started.set()
    if any(name.startswith(p) for p in FOREVER_LOOPS):
        return
    loop = _loop()

    def body():
        try:
            self.run()
        except Exception as e:
            print(f"[emkay] thread {name} failed: {e!r}", file=sys.stderr)
        finally:
            self._emkay_done = True

    self._emkay_done = False
    self.is_alive = lambda: not self._emkay_done
    if loop is not None:
        loop.call_soon(body)


def _timer_start(self):
    STARTED.append(self.name)
    self._started.set()
    loop = _loop()

    def fire():
        if not self.finished.is_set():
            self.finished.set()
            try:
                self.function(*self.args, **self.kwargs)
            except Exception as e:  # keep the page alive
                print(f"[emkay] timer {self.name} failed: {e!r}", file=sys.stderr)

    if loop is not None:
        self._emkay_handle = loop.call_later(max(0.0, float(self.interval)), fire)


def _timer_cancel(self):
    self.finished.set()
    h = getattr(self, "_emkay_handle", None)
    if h is not None:
        h.cancel()


def _submit(self, fn, *args, **kwargs):
    fut = _cf.Future()
    try:
        fut.set_result(fn(*args, **kwargs))
    except BaseException as e:
        fut.set_exception(e)
    return fut


BLOCKED = []   # (seconds, what, where) for every wait that actually stalled


def _where():
    import traceback
    frames = [f for f in traceback.extract_stack()[:-2]
              if "/threading.py" not in f.filename and "emkay_mobile/browser.py" not in f.filename]
    return " <- ".join(f"{f.filename.split('site-packages/')[-1]}:{f.lineno}" for f in frames[-3:][::-1])


def _timed(fn, what):
    import time

    def wrapper(*a, **k):
        t = time.time()
        r = fn(*a, **k)
        dt = time.time() - t
        if dt > 0.5:
            where = _where()
            BLOCKED.append((round(dt, 1), what, where))
            print(f"[emkay] blocked {dt:.1f}s in {what} at {where}", file=sys.stderr)
        return r
    return wrapper


def install():
    """Apply all patches. Safe to call more than once."""
    if getattr(install, "_done", False):
        return
    if _SHIMS not in sys.path:
        # after site-packages, so a real wheel always wins over a shim
        sys.path.append(_SHIMS)
    threading.Thread.start = _thread_start
    threading.Timer.start = _timer_start
    threading.Timer.cancel = _timer_cancel
    _cf.ThreadPoolExecutor.submit = _submit
    # A single thread cannot be woken by another one, so every wait with a
    # timeout runs to its end. Log the ones that stall, with their caller.
    threading.Event.wait = _timed(threading.Event.wait, "Event.wait")
    import time as _time
    _time.sleep = _timed(_time.sleep, "time.sleep")
    os.environ.setdefault("OVOS_DEFAULT_LOG_NAME", "emkay")
    # Emscripten has no users; OVOS checks file ownership with these
    for fn in ("geteuid", "getuid", "getegid", "getgid"):
        if not hasattr(os, fn):
            setattr(os, fn, lambda: 1000)
    install._done = True
