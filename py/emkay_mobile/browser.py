"""Make a single-threaded WebAssembly Python look enough like a normal host for OVOS.

Pyodide runs CPython in one thread and cannot start OS threads. OVOS assumes
threads in a few places; each gets its own treatment, applied by `install()`:

* ThreadPoolExecutor.submit (bounded intent matching, bus emitter): run the
  call at once and hand back an already-finished Future.
* threading.Timer (timeouts, delayed speech, skill schedules): schedule the
  callback on the browser event loop with loop.call_later.
* threading.Thread: the body runs later on the event loop, or at once when
  something joins the thread before that (a join waits for the body).
  Service loops that never return (the skill manager's 30 s rescan, the
  event scheduler) are not started at all.
* Event.wait / time.sleep / Condition.wait / join: with JavaScript Promise
  Integration (JSPI: Chrome/Edge 137+, Firefox 153+, Safari 27+) a wait
  really waits. Python
  is suspended where it waits and the worker goes on receiving the page's
  messages and running the event loop meanwhile, so a skill waiting for the
  user's answer (get_response) gets it, as with threads (issue #20).
  Without JSPI (older browsers; and boot, which runs synchronously) nothing
  else can run while the one thread waits, so a wait could only ever run
  out its timeout: waits return at once and are noted in SKIPPED_WAITS, a
  timed Condition.wait is answered at once and an endless one raises where
  it was made instead of freezing the page (_WaiterLock).

`adapt_ovos()` holds the few changes that are about OVOS itself rather than
the platform: a speed-up made for a normal CPU that costs more than it saves
in WebAssembly, or a worker thread that waits forever and is replaced by work
on the event loop. None changes an answer.
"""
import asyncio
import concurrent.futures as _cf
import os
import re
import sys
import threading
import time

#: Name of every thread and timer that was asked to start, for diagnostics.
STARTED = []

#: Thread bodies that never return (service loops). They are not run at all;
#: what they poll for is either not needed in a browser or driven by the page.
FOREVER_LOOPS = (
    "tqdm._monitor.TMonitor.run",   # progress bar monitor (m2v's model load starts it)
    "ovos_core.skill_manager.SkillManager.run",
    "ovos_bus_client.util.scheduler.EventScheduler.run",
    "ovos_utils.events.EventScheduler.run",
)

#: (seconds asked, what, where) for every wait that was answered at once.
SKIPPED_WAITS = []

#: (seconds, what) for each thread body or timer that held the event loop
#: for SLOW seconds or more (waits it really waited, JSPI, included): the one
#: thread does nothing else meanwhile, so what was said waits for it (#4).
SLOW_WORK = []
SLOW = 0.5


def _timed(name, fn):
    """Run fn(); note it in SLOW_WORK (and the dev log) when it took SLOW s or more."""
    t0 = time.monotonic()
    try:
        return fn()
    finally:
        took = time.monotonic() - t0
        if took >= SLOW:
            SLOW_WORK.append((round(took, 2), name))
            try:
                from ovos_utils.log import LOG
                LOG.info(f"slow on the event loop: {name} took {took:.1f} s")
            except Exception:  # noqa: BLE001 - only a note
                pass

#: threading.Thread.join as Python has it, for threads this module did not start.
_ORIGINAL_JOIN = threading.Thread.join

#: Pure-Python stand-ins for native packages without a WebAssembly build.
_SHIMS = os.path.join(os.path.dirname(__file__), "shims")


#: Waits really wait where the call stack allows it (JSPI). EMKAY_INSTANT_WAITS=1
#: turns that off, for comparing with the old behaviour.
REAL_WAITS = os.environ.get("EMKAY_INSTANT_WAITS") != "1"

#: How often a real wait looks again at what it waits for, in seconds.
_POLL = 0.05


def can_wait() -> bool:
    """True when this call stack can really wait: JSPI is there and Python was
    entered in a way that can be suspended (an event loop callback, or a
    command the worker calls with callPromising). Boot is not, so boot
    keeps its instant waits and takes no longer than before."""
    if not REAL_WAITS:
        return False
    try:
        from pyodide.ffi import can_run_sync
    except ImportError:   # not in Pyodide (tests, CPython)
        return False
    return can_run_sync()


def _really_wait(seconds):
    """Suspend this call stack for `seconds`; the worker runs on meanwhile."""
    from pyodide.ffi import run_sync
    run_sync(asyncio.sleep(max(0.0, seconds)))


def _wait_until(done, timeout=None) -> bool:
    """Wait (really) until done() is true or `timeout` seconds have passed;
    return done(). Polls: the things waited for (an event set by a bus
    handler, a lock released) are plain Python state."""
    import time as _t
    end = None if timeout is None else _t.monotonic() + max(0.0, timeout)
    while not done():
        left = None if end is None else end - _t.monotonic()
        if left is not None and left <= 0:
            break
        _really_wait(_POLL if left is None else min(_POLL, left))
    return bool(done())


def hand_over(fn):
    """Run fn() as its own piece of work on the event loop, the way the
    listener puts an utterance on the bus and goes back to listening: the
    caller returns at once while fn() is handled (and may wait, JSPI).
    Without real waits it runs now, as before."""
    loop = _loop()
    if can_wait() and loop is not None:
        loop.call_soon(fn)
    else:
        fn()


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
        if self._emkay_ran:   # already run by a join()
            return
        self._emkay_ran = True
        try:
            _timed(f"thread {name}", self.run)
        except Exception as e:  # a failing worker must not stop the page
            print(f"[emkay] thread {name} failed: {e!r}", file=sys.stderr)
        finally:
            self._emkay_done = True

    self._emkay_done = False
    self._emkay_ran = False
    self._emkay_body = body
    self.is_alive = lambda: not self._emkay_done
    if loop is not None:
        loop.call_soon(body)


def _thread_join(self, timeout=None):
    """Thread.join: the body has not run yet (it waits for the event loop),
    and joining means waiting until it has, so it runs now. With a timeout
    it still runs to the end: there is no other thread to leave it to. A
    body that already runs and is waiting itself (JSPI) is waited for.
    Threads not started by _thread_start (none here) join as usual."""
    body = getattr(self, "_emkay_body", None)
    if body is None:
        return _ORIGINAL_JOIN(self, timeout)
    if not self._emkay_ran:
        if timeout is not None:
            SKIPPED_WAITS.append((timeout, f"join {_target_name(self)}", _where()))
        body()
    elif not self._emkay_done and can_wait():
        # the body is running and waiting somewhere itself (JSPI): wait for it
        _wait_until(lambda: self._emkay_done, timeout)


def _timer_start(self):
    """Timer.start: call the function after `interval` seconds on the event loop."""
    STARTED.append(self.name)
    self._started.set()
    loop = _loop()

    def fire():
        if not self.finished.is_set():
            self.finished.set()
            try:
                _timed(f"timer {self.name} ({getattr(self.function, '__qualname__', self.function)})",
                       lambda: self.function(*self.args, **self.kwargs))
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
    if (seconds is None or seconds >= 0.5) and len(SKIPPED_WAITS) < 500:
        SKIPPED_WAITS.append((seconds, what, _where()))


def _event_wait(self, timeout=None):
    """Event.wait: nothing can set the event while this one thread waits for
    it, so the wait is answered with what is true now (a device would have
    timed out with the same answer). With JSPI it really waits (#20)."""
    if self._flag:
        return True
    if can_wait():
        return _wait_until(lambda: self._flag, timeout)
    _note(timeout, "Event.wait")
    return self._flag


def _sleep(seconds):
    """time.sleep: sleeping holds back every timer and bus message queued
    behind it, and nothing else runs meanwhile, so it is skipped. With JSPI
    it really sleeps, and the rest goes on meanwhile (#20)."""
    if can_wait():
        _really_wait(seconds)
        return
    _note(seconds, "time.sleep")


class _WaiterLock:
    """The lock threading.Condition.wait parks on (threading._allocate_lock).

    Condition.wait takes this lock once and then waits to take it again until
    notify() releases it from another thread. With one thread that second
    take can never succeed: a real lock would spin forever and freeze the
    page (Queue.get, Queue.join, Future.result all wait this way). So a wait
    with a timeout is answered at once, like Event.wait, and a wait without
    one raises with the place it was made, instead of hanging.
    """

    def __init__(self):
        self._held = False

    def acquire(self, blocking=True, timeout=-1):
        if not self._held:
            self._held = True
            return True
        if not blocking:
            return False
        if can_wait():   # JSPI: wait for notify() (another call stack) to release it
            if _wait_until(lambda: not self._held, None if timeout is None or timeout < 0 else timeout):
                self._held = True
                return True
            return False
        if timeout is not None and timeout >= 0:
            # not noted: a caller like Queue.get(timeout=...) asks again in a
            # loop until its own deadline, which a device would also wait out
            return False
        where = _where()
        _note(None, "Condition.wait (forever)")
        raise RuntimeError(f"waiting forever on a Condition in a single thread, at {where}")

    __enter__ = acquire

    def __exit__(self, *exc):
        self.release()

    def release(self):
        if not self._held:
            raise RuntimeError("release unlocked lock")
        self._held = False

    def locked(self):
        return self._held

    def _at_fork_reinit(self):
        self._held = False


def raise_http_errors():
    """urllib's urlopen through the browser raises HTTPError for 4xx/5xx again.

    pyodide-http's urlopen returns every answer as a response, a 404 page
    included; CPython's raises urllib.error.HTTPError. Code written for the
    latter then reads an error page as data: the control panel, asking the
    package index for a name it does not have, parsed the 404 page as JSON and
    failed with a 502 instead of answering "not found". Applied after
    pyodide_http.patch_all(), to urlopen and to the opener it also patches.
    """
    import io
    import urllib.error
    import urllib.request
    if getattr(urllib.request.urlopen, "_emkay_errors", False):
        return
    plain = urllib.request.urlopen

    def urlopen(url, *args, **kwargs):
        response = plain(url, *args, **kwargs)
        status = getattr(response, "status", 200) or 200
        if status >= 400:
            body = response.read()
            target = url.full_url if isinstance(url, urllib.request.Request) else str(url)
            raise urllib.error.HTTPError(target, status, getattr(response, "reason", "") or "",
                                         response.headers, io.BytesIO(body))
        return response

    urlopen._emkay_errors = True
    urllib.request.urlopen = urlopen
    opener_open = urllib.request.OpenerDirector.open
    if getattr(opener_open, "__name__", "") == "urlopen_self_removed":   # pyodide-http's
        urllib.request.OpenerDirector.open = lambda self, url, *a, **k: urlopen(url, *a, **k)


#: MediaWiki's action API (Wikipedia, Wiktionary, Wikidata ...)
_MEDIAWIKI_API = re.compile(r"^https://[^/]+\.(wikipedia|wiktionary|wikidata|wikimedia|wikiquote|wikibooks)\.org/w/api\.php")


def mediawiki_cors():
    """Requests to MediaWiki's action API carry origin=*, so a browser may read
    the answer.

    MediaWiki sends CORS headers only to anonymous requests that ask with
    origin=* (mediawiki.org/wiki/API:Cross-site_requests); without it the
    browser blocks the reply and Wikipedia never answers here. A device
    ignores the parameter. Fixed upstream in ovos-wikipedia-plugin
    (OpenVoiceOS/ovos-wikipedia-plugin#50); this covers it until that is
    released, and any other skill that asks the action API through requests.
    """
    import requests
    request = requests.sessions.Session.request
    if getattr(request, "_emkay_mediawiki", False):
        return

    def with_origin(self, method, url, params=None, **kwargs):
        if isinstance(url, str) and _MEDIAWIKI_API.match(url) and "origin=" not in url:
            if isinstance(params, dict):
                params = {**params, "origin": params.get("origin", "*")}
            elif params is None:
                params = {"origin": "*"}
            else:   # a list of pairs or a string: add it to the URL instead
                url += ("&" if "?" in url else "?") + "origin=*"
        return request(self, method, url, params=params, **kwargs)

    with_origin._emkay_mediawiki = True
    requests.sessions.Session.request = with_origin


def _callback_name(handle):
    cb = getattr(handle, "_callback", None)
    cb = getattr(cb, "__func__", cb)
    task = getattr(cb, "__self__", None)
    coro = getattr(task, "get_coro", lambda: None)() if task is not None else None
    if coro is not None:   # a Task step: name the coroutine it runs
        return f"task {getattr(coro, '__qualname__', coro)}"
    return f"{getattr(cb, '__module__', '?')}.{getattr(cb, '__qualname__', repr(cb))}"


def _time_handles():
    """Time every callback the event loop runs; note slow ones in SLOW_WORK.

    The one thread runs one callback at a time, so a question waits for
    whatever callback holds it. Thread bodies and timers are named by
    _timed; this catches the rest (asyncio tasks, call_soon from packages)."""
    import asyncio.events as events
    if getattr(events.Handle._run, "_emkay_timed", False):
        return
    original = events.Handle._run

    def run(self):
        t0 = time.monotonic()
        try:
            return original(self)
        finally:
            took = time.monotonic() - t0
            if took >= SLOW:
                name = _callback_name(self)
                if not name.startswith(f"{__name__}."):   # _timed names its own
                    SLOW_WORK.append((round(took, 2), name))
                    try:
                        from ovos_utils.log import LOG
                        LOG.info(f"slow on the event loop: {name} took {took:.1f} s")
                    except Exception:  # noqa: BLE001 - only a note
                        pass
    run._emkay_timed = True
    events.Handle._run = run


def install():
    """Apply the platform patches above. Safe to call more than once."""
    if getattr(install, "_done", False):
        return
    if _SHIMS not in sys.path:
        # after site-packages, so a real wheel always wins over a shim
        sys.path.append(_SHIMS)
    # packages installed later (pip.py), like `pip install --user`: first on
    # the path, so an upgrade wins over the copy that shipped with the site
    from .pip import USER_SITE
    os.makedirs(USER_SITE, exist_ok=True)
    if USER_SITE not in sys.path:
        sys.path.insert(0, USER_SITE)
    threading.Thread.start = _thread_start
    threading.Thread.join = _thread_join
    _time_handles()
    try:   # tqdm's own switch for its monitor thread (a loop that never ends here)
        import tqdm
        tqdm.tqdm.monitor_interval = 0
    except ImportError:
        pass
    threading.Timer.start = _timer_start
    threading.Timer.cancel = _timer_cancel
    _cf.ThreadPoolExecutor.submit = _submit
    threading.Event.wait = _event_wait
    threading._allocate_lock = _WaiterLock
    import time as _time
    _time.sleep = _sleep
    if sys.platform == "emscripten":
        # httpx through the browser's fetch (pyodide-http covers requests
        # and urllib only); applied when httpx is first imported
        from . import httpx_fetch
        httpx_fetch.install()
    os.environ.setdefault("OVOS_DEFAULT_LOG_NAME", "emkay")
    # Emscripten has no users; OVOS checks file ownership with these
    for fn in ("geteuid", "getuid", "getegid", "getgid"):
        if not hasattr(os, fn):
            setattr(os, fn, lambda: 1000)
    install._done = True


def _send_to_scheduler(self, description, request):
    """OVOSSkill._send_to_scheduler without its sending thread.

    The skill queues each scheduler request and a thread sends them, in
    order, by waiting on the queue forever (_send_scheduler_requests). That
    wait cannot work with one thread, so the request is queued exactly as
    before and the queue is drained on the next turn of the event loop:
    same order, still never blocking or raising at the caller.
    """
    self._scheduler_requests.put((description, request))
    _loop().call_soon(self._send_scheduler_requests)


def _send_scheduler_requests(self):
    """Send every queued scheduler request now, in order (see above)."""
    import queue
    from ovos_utils.log import LOG
    from ovos_workshop.skills.ovos import _STOP_SENDING
    while True:
        try:
            description, request = self._scheduler_requests.get_nowait()
        except queue.Empty:
            return
        try:
            if request is _STOP_SENDING:
                continue
            request()
        except Exception as failure:
            LOG.error(f"{description} failed: {failure}")
        finally:
            self._scheduler_requests.task_done()


def _scheduler_requests_sent(self):
    """OVOSSkill._scheduler_requests_sent: send what is queued, then return
    (on a device it waits for the sending thread to get through the queue)."""
    self._send_scheduler_requests()


QUESTIONS_NOT_WAITED = []   # (skill_id, dialog) get_response could not wait for (issue #20)


_ORIGINAL_GET_RESPONSE = None


def _get_response(self, dialog="", data=None, validator=None, on_fail=None,
                  num_retries=-1, message=None, wait=True):
    """OVOSSkill.get_response without waiting for the answer.

    On a device the skill's handler waits in its thread while the listener,
    STT and ovos-core deliver the next utterance on other threads. Here there
    is one thread, and the handler holding it is the one waiting: the reply
    can never be heard, and the wait (time.sleep returns at once) spins until
    its deadline and re-prompts, again and again - "mycroft.mic.listen" each
    time, the listening sound in a loop, the worker busy for minutes.

    So the question is still asked (the dialog is spoken, as OVOS would) but
    no answer is waited for: it returns None, which is what get_response
    returns when the user says nothing, and every skill handles that (an
    ask_yesno gets None too). The listening that would follow is not started:
    what the user then says goes to ovos-core as a new question.

    Where the call stack can really wait (JSPI), OVOS' own get_response runs
    unchanged.
    """
    if can_wait() and _ORIGINAL_GET_RESPONSE is not None:
        return _ORIGINAL_GET_RESPONSE(self, dialog, data, validator, on_fail, num_retries, message, wait)
    if dialog:
        self.speak_dialog(dialog, data or {}, wait=False)
    QUESTIONS_NOT_WAITED.append((self.skill_id, dialog))
    print(f"[emkay] {self.skill_id} asked a question; a browser cannot wait for the answer (issue #20)")
    return None


#: How long OCP's search waits after the last media skill was heard from
#: before it decides that every skill has answered (OCPQuery's own 0.5 s).
OCP_QUIET = 0.5


def _ocp_search_end(self, message):
    """OCPQuery.handle_skill_search_end: note that a media skill is done.

    On a device every media skill gets the query at once on its own thread
    and says "searching" (search_start) right away; when the last one is
    done, OCP sleeps half a second ("hacky, but avoids a race condition")
    and stops waiting. Here the skills search one after another, so when
    the first is done the next has not said "searching" yet: OCP saw no
    skill left, stopped, and the next skill's results came "too late"
    (only the first media skill could ever play). The decision moves to
    _ocp_wait, which waits for the bus to go quiet instead."""
    skill_id = message.data["skill_id"]
    with self.active_skills_lock:
        if skill_id in self.active_skills:
            with self.active_skills[skill_id]:
                del self.active_skills[skill_id]
    self._emkay_heard = time.time()


def _ocp_wait(self):
    """OCPQuery.wait: as OVOS has it, and it also ends when no media skill
    is searching and none has been heard from for OCP_QUIET seconds."""
    from ovos_utils.ocp import MediaType
    timeout = self.config.get("max_timeout", 15) + (3 if self.media_type == MediaType.GENERIC else 0)
    while self.searching and time.time() - self.search_start <= timeout:
        time.sleep(0.1)
        heard = getattr(self, "_emkay_heard", None)
        if heard and not self.active_skills and time.time() - heard >= OCP_QUIET:
            break
    self.searching = False
    self.remove_events()


def _ocp_heard(original):
    def handler(self, message):
        self._emkay_heard = time.time()
        return original(self, message)
    return handler


def adapt_ovos():
    """Changes to OVOS itself for a single-threaded WebAssembly host.

    Called by boot.start() once the OVOS packages are importable. Each change
    keeps every answer the same (but get_response, see below); it only
    moves work to where it can run.

    * padatious: after each training pass, PadatiousPipeline._warm_prefilters
      compiles one combined regex per padaos intent "so the first query in
      that language does not pay for them". Queries only use a prefilter that
      is already built and "the scan without it gives the same answer"
      (padaos.Regexes.built_prefilter). Regex compilation is about ten times
      slower in WebAssembly, so the warm-up cost minutes of boot to save
      milliseconds per query. It is left out.
    * ovos-workshop: scheduler requests go out from the event loop instead of
      from a thread that waits on a queue forever (_send_to_scheduler above).
    * ovos-workshop: get_response asks its question but does not wait for
      the answer, which only this same thread could deliver (_get_response
      above). This one does change answers: follow-up questions get "no
      answer" instead of hanging the assistant.
    * padaos: its line regexes come from the cache of the last start
      (re_cache.py) instead of Python's re parser, which took ~28 s after
      every start in WebAssembly (#4). The same regexes, faster; and its
      pattern file keeps the lines of every container that shares it.
    * chronologia: its loader reads the one language it loads instead of
      all 61 of its locale tree (chronologia_speed.py, #4).
    * ovos-m2v-pipeline: word_sequence through str.translate instead of a
      Python loop over every character (m2v_speed.py, #4).
    * ovos-spec-tools: a template's expansion is kept and given again, the
      same samples or the same error (spec_speed.py, #4).
    * ovos-utils: is_process_running answers "no" instead of running `ps`,
      which a browser does not have (OCP asks it on every search).
    * ovos-bus-client: OCP's search waits until the media skills have gone
      quiet, not just until those that already said "searching" are done
      (_ocp_wait above): skills search one after another here.
    """
    try:
        from ovos_padatious.opm import PadatiousPipeline
        PadatiousPipeline._warm_prefilters = lambda self, lang: None
    except ImportError:
        pass
    try:
        # padaos' line regexes from the cache of the last start (re_cache.py):
        # compiling them is Python's own re parser, ~28 s in WebAssembly
        # (re_cache.py), and each line's pattern built without formatting
        # the entities it doesn't use (padaos_speed.py)
        from . import padaos_speed
        padaos_speed.install()
    except ImportError:
        pass
    # chronologia (typed slots: dates in what was said) reads only the
    # language it loads, not all 61 of its tree (chronologia_speed.py)
    from . import chronologia_speed
    chronologia_speed.install()
    # m2v puts every template sample in word form one character at a time
    # in Python: a quarter of the boot. The same text through str.translate
    # (m2v_speed.py)
    from . import m2v_speed
    m2v_speed.install()
    # every pipeline expands the same template lines again: nine in ten
    # expansions at boot were one already made (spec_speed.py)
    from . import spec_speed
    spec_speed.install()
    try:
        # ovos-utils asks `ps axw` whether a program is running
        # (is_process_running, used by is_gui_running, which OCP calls for
        # every search). There is no ps and no subprocess in a browser
        # (Emscripten raises OSError), and no other program runs beside
        # OVOS here, so the answer is always no. gui.py has its own copy of
        # the name.
        import ovos_utils.gui as _gui
        import ovos_utils.system as _system
        _system.is_process_running = _gui.is_process_running = lambda process: False
    except ImportError:
        pass
    try:
        from ovos_bus_client.apis.ocp import OCPQuery
        if OCPQuery.wait is not _ocp_wait:
            OCPQuery.handle_skill_search_start = _ocp_heard(OCPQuery.handle_skill_search_start)
            OCPQuery.handle_skill_response = _ocp_heard(OCPQuery.handle_skill_response)
            OCPQuery.handle_skill_search_end = _ocp_search_end
            OCPQuery.wait = _ocp_wait
    except ImportError:
        pass
    try:
        from ovos_workshop.skills.ovos import OVOSSkill
    except ImportError:
        return
    OVOSSkill._send_to_scheduler = _send_to_scheduler
    OVOSSkill._send_scheduler_requests = _send_scheduler_requests
    OVOSSkill._scheduler_requests_sent = _scheduler_requests_sent
    global _ORIGINAL_GET_RESPONSE
    if OVOSSkill.get_response is not _get_response:
        _ORIGINAL_GET_RESPONSE = OVOSSkill.get_response
    OVOSSkill.get_response = _get_response
