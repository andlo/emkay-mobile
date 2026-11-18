"""Install a skill (or plugin) straight from its GitHub repository.

pip installs `git+https://github.com/owner/repo@ref` by cloning the repo and
building it. A browser can do neither, so here pip.run hands such a
requirement to this module, which does the same job another way:

1. ask GitHub's API which commit the ref is and which files it has, and
   fetch them from raw.githubusercontent.com (both answer a browser; the
   zip download does not),
2. read the project as setuptools would: pyproject.toml ([project],
   [tool.setuptools]) or setup.py, which runs with a stand-in `setup()`
   that only records its arguments (OVOS' setup.py template computes the
   entry point, the package and the requirements in Python),
3. build the pure-Python wheel pip would have built, with the commit
   recorded as PEP 610's direct_url.json, the way pip records a VCS install,
   and its version given a "+g<commit>" local part, so the next commit is an
   upgrade ovos-core's SkillManager reloads,
4. give that wheel back to pip.py, which installs its requirements and
   unpacks it like any other.

So `ovos.pip.install {"packages": ["git+https://github.com/o/r"]}` works in
Emkay as it does on a device. Nothing here decides *whether* to install: the
page asks the user first (app.js, ?install=github:...), as for the store.
"""
import io
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import quote

#: git+https://github.com/<owner>/<repo>[.git][@<ref>][#...], optionally "name @ " first
URL_RE = re.compile(
    r"^(?:(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)\s*@\s*)?"
    r"git\+https://github\.com/(?P<owner>[A-Za-z0-9-]{1,39})/(?P<repo>[A-Za-z0-9._-]{1,100}?)"
    r"(?:\.git)?(?:@(?P<ref>[A-Za-z0-9._/-]{1,200}))?(?:#\S*)?$")

API = "https://api.github.com/repos/{owner}/{repo}"
RAW = "https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}"

#: what is fetched: no more files or bytes than this (a skill is small)
MAX_FILES = 400
MAX_BYTES = 20_000_000
#: folders a skill's package never needs
SKIP_DIRS = {".git", ".github", ".vscode", ".devcontainer", "test", "tests", "docs",
             "node_modules", "build", "dist", "venv", ".venv", "__pycache__"}


class GithubError(RuntimeError):
    """Something pip would also have failed on, said plainly."""


def parse(spec: str):
    """{owner, repo, ref, name} for a GitHub requirement, else None."""
    m = URL_RE.match(spec.strip()) if isinstance(spec, str) else None
    return m.groupdict() if m else None


def _get(url, **kw):
    import requests
    r = requests.get(url, timeout=60, headers={"Accept": "application/vnd.github+json"}, **kw)
    if r.status_code == 404:
        raise GithubError(f"Not found on GitHub: {url}")
    if r.status_code == 403 and "rate limit" in r.text.lower():
        raise GithubError("GitHub's limit for requests without a login is used up for now; "
                          "try again in an hour")
    r.raise_for_status()
    return r


def fetch(owner, repo, ref=None, log=print):
    """(commit sha, {path: bytes}) of the repo at `ref` (default branch if None)."""
    api = API.format(owner=owner, repo=repo)
    if not ref:
        ref = _get(api).json()["default_branch"]
    sha = _get(f"{api}/commits/{quote(ref, safe='')}").json()["sha"]
    tree = _get(f"{api}/git/trees/{sha}?recursive=1").json()
    blobs = [e for e in tree.get("tree", []) if e.get("type") == "blob"
             and not (set(e["path"].split("/")[:-1]) & SKIP_DIRS)
             and not e["path"].split("/")[-1].startswith(".")]
    if tree.get("truncated") or len(blobs) > MAX_FILES:
        raise GithubError(f"{owner}/{repo} has more files than a skill ({len(blobs)}+)")
    total = sum(e.get("size", 0) for e in blobs)
    if total > MAX_BYTES:
        raise GithubError(f"{owner}/{repo} is {total // 1_000_000} MB; a skill is far smaller")
    log(f"Fetching {owner}/{repo}@{ref} ({sha[:7]}): {len(blobs)} files")
    files = {}
    for e in blobs:
        url = RAW.format(owner=owner, repo=repo, sha=sha, path=quote(e["path"]))
        files[e["path"]] = _get(url).content
    return sha, files


# --- reading the project ----------------------------------------------------

def _find_packages(root: Path, where=".", exclude=()):
    """setuptools.find_packages, enough for a skill."""
    base = (root / where).resolve()
    out = []
    for init in sorted(base.rglob("__init__.py")):
        rel = init.parent.relative_to(base)
        if not rel.parts or set(rel.parts) & SKIP_DIRS:
            continue
        name = ".".join(rel.parts)
        if any(name == x or name.startswith(x.rstrip("*").rstrip(".") + ".") for x in exclude):
            continue
        out.append(name)
    return out


def _from_setup_py(root: Path) -> dict:
    """setup()'s arguments, by running setup.py with a recording setup()."""
    import types
    seen = {}

    def setup(**kw):
        seen.update(kw)

    fake = types.ModuleType("setuptools")
    fake.setup = setup
    fake.find_packages = lambda where=".", exclude=(), include=("*",): _find_packages(root, where, exclude)
    fake.find_namespace_packages = fake.find_packages
    saved = {k: sys.modules.get(k) for k in ("setuptools", "distutils.core")}
    sys.modules["setuptools"] = fake
    core = types.ModuleType("distutils.core")
    core.setup = setup
    sys.modules["distutils.core"] = core
    cwd = os.getcwd()
    try:
        os.chdir(root)
        code = compile((root / "setup.py").read_text(), str(root / "setup.py"), "exec")
        exec(code, {"__name__": "__main__", "__file__": str(root / "setup.py")})
    finally:
        os.chdir(cwd)
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
    if not seen:
        raise GithubError("setup.py did not call setup()")
    eps = {}
    for group, items in (seen.get("entry_points") or {}).items():
        items = [items] if isinstance(items, str) else items
        for item in items:
            name, _, value = item.partition("=")
            eps.setdefault(group, {})[name.strip()] = value.strip()
    return {"name": seen.get("name"), "version": str(seen.get("version") or "0.0.0"),
            "summary": seen.get("description") or "",
            "requires": list(seen.get("install_requires") or []),
            "entry_points": eps,
            "packages": list(seen.get("packages") or []),
            "package_dir": dict(seen.get("package_dir") or {}),
            "py_modules": list(seen.get("py_modules") or [])}


def _from_pyproject(root: Path, data: dict) -> dict:
    proj = data.get("project") or {}
    st = (data.get("tool") or {}).get("setuptools") or {}
    eps = {g: dict(v) for g, v in (proj.get("entry-points") or {}).items()}
    packages = st.get("packages")
    if isinstance(packages, dict):              # {find = {where, exclude}}
        f = packages.get("find") or {}
        packages = []
        for where in f.get("where") or ["."]:
            packages += _find_packages(root, where, f.get("exclude") or ())
    if packages is None:                         # setuptools' automatic discovery
        packages = _find_packages(root / "src") if (root / "src").is_dir() else _find_packages(root)
        package_dir = {"": "src"} if (root / "src").is_dir() else {}
    else:
        package_dir = dict(st.get("package-dir") or {})
    requires = list(proj.get("dependencies") or [])
    if (root / "requirements.txt").is_file() and "dependencies" in (proj.get("dynamic") or []):
        requires += _requirements_txt(root / "requirements.txt")
    return {"name": proj.get("name"), "version": str(proj.get("version") or "0.0.0"),
            "summary": proj.get("description") or "", "requires": requires,
            "entry_points": eps, "packages": packages, "package_dir": package_dir,
            "py_modules": list(st.get("py-modules") or [])}


def _requirements_txt(path: Path):
    out = []
    for line in path.read_text().splitlines():
        line = line.split("#")[0].strip()
        if line and not line.startswith("-"):
            out.append(line)
    return out


def describe(root: Path) -> dict:
    """What setuptools would build from `root`: name, version, requirements,
    entry points and which folders become which packages."""
    meta = None
    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        import tomllib
        data = tomllib.loads(pyproject.read_text())
        if (data.get("project") or {}).get("name"):
            meta = _from_pyproject(root, data)
    if meta is None and (root / "setup.py").is_file():
        meta = _from_setup_py(root)
    if meta is None:
        raise GithubError("no pyproject.toml [project] or setup.py: not a Python package")
    if not meta.get("name"):
        raise GithubError("the package has no name")
    if not meta["entry_points"]:
        raise GithubError("it declares no entry points, so OpenVoiceOS would not find it")
    return meta


def _package_folders(root: Path, meta: dict) -> dict:
    """{package name: folder} for every package the wheel gets."""
    pdir = meta["package_dir"]
    out = {}
    for pkg in meta["packages"]:
        if pkg in pdir:                          # {"ovos_skill_x": ""}: the repo root is the package
            folder = root / pdir[pkg]
        elif "" in pdir:
            folder = root / pdir[""] / pkg.replace(".", "/")
        else:
            folder = root / pkg.replace(".", "/")
        out[pkg] = folder
    return out


# --- building the wheel -------------------------------------------------------

def _version(version: str, sha: str) -> str:
    from packaging.version import InvalidVersion, Version
    try:
        v = Version(version)
        base = v.public
    except InvalidVersion:
        base = "0.0.0"
    return f"{base}+g{sha[:7]}"


def build_wheel(root: Path, meta: dict, url: str, sha: str, ref: str) -> tuple:
    """(file name, bytes) of the pure wheel setuptools would have built."""
    import base64
    import hashlib
    import json
    from packaging.utils import canonicalize_name
    name = meta["name"]
    dist = re.sub(r"[-_.]+", "_", canonicalize_name(name))
    version = _version(meta["version"], sha)
    info = f"{dist}-{version}.dist-info"
    entries = {}
    folders = _package_folders(root, meta)
    for pkg, folder in folders.items():
        if not folder.is_dir():
            raise GithubError(f"package {pkg} has no folder {folder.relative_to(root)}")
        nested = [f for p, f in folders.items() if p != pkg and p.startswith(pkg + ".")]
        for f in sorted(folder.rglob("*")):
            if not f.is_file() or set(f.relative_to(folder).parts[:-1]) & SKIP_DIRS:
                continue
            if any(n in f.parents for n in nested):
                continue                          # written as its own package
            rel = f.relative_to(folder)
            if folder == root and (rel.name in ("setup.py", "pyproject.toml", "setup.cfg",
                                                "MANIFEST.in") or rel.name.startswith(".")):
                continue
            entries["/".join([*pkg.split("."), *rel.parts])] = f.read_bytes()
    for mod in meta["py_modules"]:
        f = root / f"{mod}.py"
        if f.is_file():
            entries[f"{mod}.py"] = f.read_bytes()
    lines = ["Metadata-Version: 2.1", f"Name: {name}", f"Version: {version}",
             f"Summary: {meta['summary']}".rstrip(), f"Project-URL: Source, {url}"]
    lines += [f"Requires-Dist: {r}" for r in meta["requires"]]
    entries[f"{info}/METADATA"] = ("\n".join(lines) + "\n").encode()
    entries[f"{info}/WHEEL"] = b"Wheel-Version: 1.0\nGenerator: emkay-github\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
    ep = ""
    for group, items in meta["entry_points"].items():
        ep += f"[{group}]\n" + "".join(f"{k} = {v}\n" for k, v in items.items()) + "\n"
    entries[f"{info}/entry_points.txt"] = ep.encode()
    tops = sorted({p.split("/")[0] for p in entries if not p.startswith(info)})
    entries[f"{info}/top_level.txt"] = ("\n".join(t.removesuffix(".py") for t in tops) + "\n").encode()
    # PEP 610: how pip records an install from a VCS URL
    entries[f"{info}/direct_url.json"] = json.dumps(
        {"url": url, "vcs_info": {"vcs": "git", "commit_id": sha, "requested_revision": ref}}).encode()
    record = []
    for path, data in entries.items():
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        record.append(f"{path},sha256={digest},{len(data)}")
    record.append(f"{info}/RECORD,,")
    entries[f"{info}/RECORD"] = ("\n".join(record) + "\n").encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path, data in entries.items():
            z.writestr(path, data)
    return f"{dist}-{version}-py3-none-any.whl", buf.getvalue()


def wheel_for(spec: str, log=print) -> tuple:
    """(name, version, wheel file name, wheel bytes) for a GitHub requirement."""
    p = parse(spec)
    if not p:
        raise GithubError(f"not a GitHub requirement: {spec}")
    sha, files = fetch(p["owner"], p["repo"], p["ref"], log)
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for path, data in files.items():
            dest = root / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        meta = describe(root)
        url = f"https://github.com/{p['owner']}/{p['repo']}"
        filename, blob = build_wheel(root, meta, url, sha, p["ref"] or "")
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        version = filename.split("-")[1]
    log(f"  Built {filename} ({len(blob) // 1024} kB) from {url}@{sha[:7]}")
    return meta["name"], version, filename, blob


def origin(dist) -> dict | None:
    """{url, commit, ref} for a distribution installed from GitHub (PEP 610), else None."""
    import json
    try:
        text = dist.read_text("direct_url.json")
        data = json.loads(text) if text else None
    except Exception:
        return None
    if not data or "github.com/" not in data.get("url", ""):
        return None
    vcs = data.get("vcs_info") or {}
    return {"url": data["url"], "commit": vcs.get("commit_id"), "ref": vcs.get("requested_revision")}


def installed() -> list:
    """Every package installed from GitHub: [{name, version, url, commit, ref, skills}]."""
    import importlib.metadata
    out = []
    for dist in importlib.metadata.distributions():
        o = origin(dist)
        if not o:
            continue
        eps = [e.name for e in dist.entry_points if e.group == "opm.skill"]
        out.append({"name": dist.metadata["Name"], "version": dist.version, **o, "skills": eps})
    return sorted(out, key=lambda d: d["name"].lower())
