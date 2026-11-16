"""A small pip for the browser: what ovos-core's skill installer runs here.

On a device, installing a skill or plugin goes over the bus to ovos-core's
installer (ovos_core.skill_installer.SkillsStore), which runs `pip install`
(or `uv pip install`) in a subprocess. A browser has no subprocesses, so the
only change is the one method that starts one, SkillsStore._run_pip: here it
gets `run()` below, which reads the same command line and does the same job
inside Pyodide. Everything around it - the bus messages, allow_pip, the
constraints file, the protected core packages, reloading the plugin manager
- is ovos-core's own.

What it can install: pure-Python wheels ("py3-none-any"), which is what OVOS
skills and most plugins are, from PyPI, with their dependencies. A
pure-Python package PyPI only has as source comes as a wheel the Emkay store
built from that source (STORE_WHEELS). A package
that needs a compiled (native) wheel without a WebAssembly build cannot be
installed, and says so.

Where: like `pip install --user`, into USER_SITE below ~/.local, which lives
in the browser's IndexedDB and so survives a reload. USER_SITE comes first
on sys.path (browser.install), so an upgraded package wins over the copy
that shipped with the site. A package that shipped with the site cannot be
uninstalled; one installed here can.

Downloads use requests, which pyodide_http routes through the browser
(synchronously, as a worker may), so a run finishes before it returns, as
the subprocess did.
"""
import importlib
import importlib.metadata
import io
import os
import shutil
import sys
import zipfile
from pathlib import Path

#: Where installed packages go (persistent, see the module docstring).
USER_SITE = os.path.expanduser(
    f"~/.local/lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages")

PYPI = "https://pypi.org/pypi/{name}/json"

#: Wheels the Emkay store built for pure-Python packages that PyPI only has as
#: source (emkay-voice/store, tools/build_wheels.py): {name: {version: [file
#: entries as in PyPI's JSON]}}. Used only for a release PyPI has no wheel for.
STORE_WHEELS = "https://store.emkay.ai/wheels/index.json"
_store_wheels = None


def _built_wheels(name: str) -> dict:
    """{version: [files]} the store built for `name` ({} if none or unreachable)."""
    global _store_wheels
    if _store_wheels is None:
        import requests
        try:
            r = requests.get(STORE_WHEELS, timeout=30)
            _store_wheels = r.json() if r.ok else {}
        except Exception:
            _store_wheels = {}
    from packaging.utils import canonicalize_name
    return _store_wheels.get(canonicalize_name(name), {})


class PipError(RuntimeError):
    """A run that failed; the message is what pip would have printed."""


def run(args: list, print_logs: bool = True) -> str:
    """Do what `pip install|uninstall ...` would do; return its output.

    Understands the arguments SkillsStore builds: install/uninstall, -c
    CONSTRAINTS, --pre, --upgrade, -y and --break-system-packages, then one
    requirement per call. Raises RuntimeError carrying the output on
    failure, as SkillsStore._run_pip does.
    """
    out = []

    def log(line):
        out.append(line)
        if print_logs:
            print(f"[emkay] (pip) {line}")

    try:
        action, opts, targets = _parse(args)
        if action == "install":
            constraints = _read_constraints(opts.get("constraints"), log)
            for target in targets:
                _install(target, constraints, opts, log, top=True)
        elif action == "uninstall":
            for target in targets:
                _uninstall(target, log)
        else:
            raise PipError(f"unsupported pip command: {' '.join(args)}")
    except PipError as e:
        log(f"ERROR: {e}")
        raise RuntimeError("\n".join(out)) from None
    except Exception as e:  # network, bad metadata: report like a failed pip
        log(f"ERROR: {type(e).__name__}: {e}")
        raise RuntimeError("\n".join(out)) from None
    importlib.invalidate_caches()
    return "\n".join(out)


def _parse(args):
    """(action, options, requirements) from a pip/uv command line."""
    args = list(args)
    for i, a in enumerate(args):          # skip "python -m pip" / "uv pip"
        if a in ("install", "uninstall"):
            action, rest = a, args[i + 1:]
            break
    else:
        raise PipError(f"no install/uninstall in {args}")
    opts, targets, it = {}, [], iter(rest)
    for a in it:
        if a in ("-c", "--constraint"):
            opts["constraints"] = next(it, None)
        elif a == "--pre":
            opts["pre"] = True
        elif a in ("-U", "--upgrade"):
            opts["upgrade"] = True
        elif a.startswith("-"):
            continue                       # -y, --break-system-packages: no meaning here
        else:
            targets.append(a)
    return action, opts, targets


# --- resolving ------------------------------------------------------------

def _read_constraints(source, log) -> dict:
    """{canonical name: SpecifierSet} from a constraints file or URL."""
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name
    if not source:
        return {}
    if source.startswith("http"):
        import requests
        text = requests.get(source, timeout=30).text
    else:
        text = Path(source).read_text()
    found = {}
    for line in text.splitlines():
        line = line.split("#")[0].strip()
        if not line or line.startswith("-"):
            continue
        try:
            req = Requirement(line)
        except Exception:
            continue
        found[canonicalize_name(req.name)] = req.specifier
    log(f"Using {len(found)} constraints from {source}")
    return found


def _installed(name):
    """The installed distribution called `name`, or None."""
    try:
        return importlib.metadata.distribution(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def _python_version() -> str:
    return f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"


def _pure_wheel(files):
    """The pure-Python wheel among a release's files, or None."""
    from packaging.specifiers import SpecifierSet
    from packaging.utils import parse_wheel_filename
    for f in files:
        if f.get("yanked") or f.get("packagetype") != "bdist_wheel":
            continue
        try:
            _, _, _, tags = parse_wheel_filename(f["filename"])
        except Exception:
            continue
        if not any(t.abi == "none" and t.platform == "any" and t.interpreter.startswith("py")
                   for t in tags):
            continue
        rp = f.get("requires_python")
        if rp:
            try:
                if not SpecifierSet(rp).contains(_python_version(), prereleases=True):
                    continue
            except Exception:
                pass
        return f
    return None


def _choose(req, constraints, pre):
    """(version, wheel file info) of the newest release that fits."""
    import requests
    from packaging.utils import canonicalize_name
    from packaging.version import InvalidVersion, Version
    data = requests.get(PYPI.format(name=req.name), timeout=30)
    if data.status_code == 404:
        raise PipError(f"No matching distribution found for {req}")
    data.raise_for_status()
    releases = data.json().get("releases", {})
    limit = constraints.get(canonicalize_name(req.name))
    allow_pre = pre or bool(req.specifier.prereleases)
    native_only = False
    for text in sorted(releases, key=_version_key, reverse=True):
        try:
            v = Version(text)
        except InvalidVersion:
            continue
        if v.is_prerelease and not allow_pre:
            continue
        # --pre takes OVOS' alphas (aN), betas and release candidates, but
        # not development snapshots (.devN) of other projects unless the
        # requirement names one: with OVOS' alpha channel pip would take
        # httpx 1.0.dev6, a rewrite with another API, for pyradios'
        # "httpx>=0.25.2", which breaks it on a device as well
        if v.is_devrelease and not req.specifier.prereleases and \
                not (limit is not None and limit.prereleases):
            continue
        if not req.specifier.contains(v, prereleases=True):
            continue
        if limit is not None and not limit.contains(v, prereleases=True):
            continue
        wheel = _pure_wheel(releases[text])
        if wheel is None and releases[text]:
            # PyPI has only source (or compiled builds) for this release: the
            # store may have built it as a pure wheel
            wheel = _pure_wheel(_built_wheels(req.name).get(text, []))
            if wheel is not None:
                log_built = f"{req.name} {text}: the Emkay store's wheel, built from PyPI's source"
                print(f"[emkay] (pip) {log_built}")
        if wheel is None:
            native_only = native_only or bool(releases[text])
            continue
        return text, wheel
    if native_only:
        raise PipError(f"{req} has no pure-Python wheel (only source or compiled "
                       f"builds), so it cannot be installed in the browser")
    raise PipError(f"No matching distribution found for {req}")


def _version_key(text):
    from packaging.version import InvalidVersion, Version
    try:
        return Version(text)
    except InvalidVersion:
        return Version("0")


# --- installing -----------------------------------------------------------

def _install(spec, constraints, opts, log, top=False, extras=(), seen=None):
    """Install one requirement and, first, what it needs."""
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name
    seen = set() if seen is None else seen
    req = Requirement(spec) if isinstance(spec, str) else spec
    key = canonicalize_name(req.name)
    if key in seen:
        return
    seen.add(key)
    have = _installed(req.name)
    upgrade = top and opts.get("upgrade")
    if have is not None and not upgrade and \
            req.specifier.contains(have.version, prereleases=True):
        # what is already here is taken as it is: the site leaves out a few
        # dependencies on purpose (native ones with no WebAssembly build)
        log(f"Requirement already satisfied: {req.name}=={have.version}")
        return
    if req.url:
        raise PipError(f"{req}: installing from a URL is not possible in the browser")
    version, wheel = _choose(req, constraints, opts.get("pre", False))
    if have is not None and have.version == version:
        log(f"Requirement already satisfied: {req.name}=={have.version}")
        return
    log(f"Collecting {req.name}=={version}")
    import requests
    blob = requests.get(wheel["url"], timeout=120)
    blob.raise_for_status()
    log(f"  Downloaded {wheel['filename']} ({len(blob.content) // 1024} kB)")
    with zipfile.ZipFile(io.BytesIO(blob.content)) as whl:
        meta = _wheel_metadata(whl)
        for dep in _requirements(meta, req.extras):
            _install(dep, constraints, opts, log, seen=seen)
        _unpack(whl, log)
    log(f"Successfully installed {req.name}-{version}")


def _wheel_metadata(whl):
    """The METADATA of a wheel, parsed like importlib.metadata's."""
    import email
    name = next(n for n in whl.namelist() if n.endswith(".dist-info/METADATA"))
    return email.message_from_bytes(whl.read(name))


def _requirements(meta, extras):
    """The Requires-Dist entries that apply here (markers evaluated)."""
    from packaging.requirements import Requirement
    out = []
    for line in meta.get_all("Requires-Dist") or []:
        req = Requirement(line)
        if req.marker is not None:
            envs = [{"extra": e} for e in (set(extras) | {""})]
            if not any(req.marker.evaluate(env) for env in envs):
                continue
        out.append(req)
    return out


def _unpack(whl, log):
    """Put a wheel's files into USER_SITE (pure libraries only)."""
    os.makedirs(USER_SITE, exist_ok=True)
    info_dir = None
    for item in whl.infolist():
        if item.is_dir():
            continue
        parts = item.filename.split("/")
        if parts[0].endswith(".data"):
            if len(parts) < 3 or parts[1] not in ("purelib", "platlib"):
                continue                    # scripts, headers, data: not used here
            parts = parts[2:]
        if parts[0].endswith(".dist-info"):
            info_dir = parts[0]
        dest = Path(USER_SITE, *parts)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(whl.read(item))
    if info_dir:
        Path(USER_SITE, info_dir, "INSTALLER").write_text("emkay\n")


# --- uninstalling ---------------------------------------------------------

def _uninstall(name, log):
    """Remove a package installed here (not one that shipped with the site)."""
    dist = _installed(name)
    if dist is None:
        log(f"WARNING: Skipping {name} as it is not installed.")
        return
    base = Path(USER_SITE).resolve()
    where = Path(str(dist.locate_file(""))).resolve()
    if where != base:
        raise PipError(f"{name} is part of Emkay itself and cannot be uninstalled")
    label = f"{dist.metadata['Name']}-{dist.version}"   # before its files go
    log(f"Uninstalling {label}")
    dirs = set()
    for f in dist.files or []:
        path = Path(dist.locate_file(f))
        dirs.add(path.parent)
        path.unlink(missing_ok=True)
    for d in sorted(dirs, key=lambda p: len(p.parts), reverse=True):
        if d != base and d.is_dir() and base in d.parents:
            if d.name.endswith(".dist-info") or not any(d.iterdir()):
                shutil.rmtree(d, ignore_errors=True)
    log(f"Successfully uninstalled {label}")
