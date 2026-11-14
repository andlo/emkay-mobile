"""Make a single-threaded WebAssembly Python look enough like a normal host for OVOS.

Pyodide runs CPython in one thread and cannot start OS threads. OVOS assumes
threads in a few places; each gets its own treatment, applied by `install()`:

* ThreadPoolExecutor.submit (bounded intent matching, bus emitter): run the
  call at once and hand back an already-finished Future.
* threading.Timer (timeouts, delayed speech, skill schedules): schedule the
  callback on the browser event loop with loop.call_later.
* threading.Thread: the body runs later on the event loop. Service loops
  that never return (the skill manager's 30 s rescan, the event scheduler)
  are not started at all.
* Event.wait / time.sleep: nothing else can run while the one thread waits,
  so a wait could only ever run out its timeout. Waits return at once and
  are noted in SKIPPED_WAITS, so a dependency on them can be found.

`adapt_ovos()` holds the few changes that are about OVOS itself rather than
the platform. Each one is a speed-up OVOS makes for a normal CPU that costs
more than it saves in WebAssembly, and none changes an answer.
"""
import asyncio
import concurrent.futures as _cf
import os
import sys
import threading

#: Name of every thread and timer that was asked to start, for diagnostics.
STARTED = []

#: Thread bodies that never return (service loops). They are not run at all;
#: what they poll for is either not needed in a browser or driven by the page.
FOREVER_LOOPS = (
    "ovos_core.skill_manager.SkillManager.run",
    "ovos_bus_client.util.scheduler.EventScheduler.run",
    "ovos_utils.events.EventScheduler.run",
)

#: (seconds asked, what, where) for every wait that was answered at once.
SKIPPED_WAITS = []

#: Pure-Python stand-ins for native packages without a WebAssembly build.
_SHIMS = os.path.join(os.path.dirname(__file__), "shims")


def _loop():
    """The running asyncio loop (Pyodide's browser loop), or None outside one."""
    try:
        return asyncio.get_event_loop()
    except RuntimeError:  # pragma: no cover
        return None


def _target_name(thread):
    """A readable `module.function` name for what a Thread would run."""
    t = getattr(thread, "_target", None)
    if t is None:
        return f"{type(thread).__module__}.{type(thread).__qualname__}.run"
    return f"{getattr(t, '__module__', '?')}.{getattr(t, '__qualname__', repr(t))}"


def _thread_start(self):
    """Thread.start: run the body later on the event loop, unless it is a
    service loop (FOREVER_LOOPS), which is not run at all.

    `is_alive()` reports True until the body has run, so code that checks
    for an already running worker (padatious does) behaves as on a device.
    """
    name = _target_name(self)
    STARTED.append(name)
    self._started.set()
    if any(name.startswith(p) for p in FOREVER_LOOPS):
        return
    loop = _loop()

    def body():
        try:
            self.run()
        except Exception as e:  # a failing worker must not stop the page
            print(f"[emkay] thread {name} failed: {e!r}", file=sys.stderr)
        finally:
            self._emkay_done = True

    self._emkay_done = False
    self.is_alive = lambda: not self._emkay_done
    if loop is not None:
        loop.call_soon(body)


def _timer_start(self):
    """Timer.start: call the function after `interval` seconds on the event loop."""
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
    """Timer.cancel: drop the scheduled call, if it has not fired yet."""
    self.finished.set()
    h = getattr(self, "_emkay_handle", None)
    if h is not None:
        h.cancel()


def _submit(self, fn, *args, **kwargs):
    """ThreadPoolExecutor.submit: run `fn` now; return a finished Future."""
    fut = _cf.Future()
    try:
        fut.set_result(fn(*args, **kwargs))
    except BaseException as e:
        fut.set_exception(e)
    return fut


def _where():
    """The three nearest callers outside threading/this module, for notes."""
    import traceback
    frames = [f for f in traceback.extract_stack()[:-2]
              if "/threading.py" not in f.filename and "emkay_mobile/browser.py" not in f.filename]
    return " <- ".join(f"{f.filename.split('site-packages/')[-1]}:{f.lineno}" for f in frames[-3:][::-1])


def _note(seconds, what):
    """Remember a skipped wait of half a second or more (or an endless one)."""
    if seconds is None or seconds >= 0.5:
        SKIPPED_WAITS.append((seconds, what, _where()))


def _event_wait(self, timeout=None):
    """Event.wait: nothing can set the event while this one thread waits for
    it, so the wait is answered with what is true now (a device would have
    timed out with the same answer)."""
    if not self._flag:
        _note(timeout, "Event.wait")
    return self._flag


def _sleep(seconds):
    """time.sleep: sleeping holds back every timer and bus message queued
    behind it, and nothing else runs meanwhile, so it is skipped."""
    _note(seconds, "time.sleep")


def install():
    """Apply the platform patches above. Safe to call more than once."""
    if getattr(install, "_done", False):
        return
    if _SHIMS not in sys.path:
        # after site-packages, so a real wheel always wins over a shim
        sys.path.append(_SHIMS)
    threading.Thread.start = _thread_start
    threading.Timer.start = _timer_start
    threading.Timer.cancel = _timer_cancel
    _cf.ThreadPoolExecutor.submit = _submit
    threading.Event.wait = _event_wait
    import time as _time
    _time.sleep = _sleep
    os.environ.setdefault("OVOS_DEFAULT_LOG_NAME", "emkay")
    # Emscripten has no users; OVOS checks file ownership with these
    for fn in ("geteuid", "getuid", "getegid", "getgid"):
        if not hasattr(os, fn):
            setattr(os, fn, lambda: 1000)
    install._done = True


def adapt_ovos():
    """OVOS speed-ups that cost more than they save in WebAssembly.

    Called by boot.start() once the OVOS packages are importable. Each change
    keeps every answer the same; it only moves work to where it is cheaper.

    * padatious: after each training pass, PadatiousPipeline._warm_prefilters
      compiles one combined regex per padaos intent "so the first query in
      that language does not pay for them". Queries only use a prefilter that
      is already built and "the scan without it gives the same answer"
      (padaos.Regexes.built_prefilter). Regex compilation is about ten times
      slower in WebAssembly, so the warm-up cost minutes of boot to save
      milliseconds per query. It is left out.
    """
    try:
        from ovos_padatious.opm import PadatiousPipeline
    except ImportError:
        return
    PadatiousPipeline._warm_prefilters = lambda self, lang: None
