"""Save and restore the device's settings as one file.

Everything a user can change lives in the XDG config folder, as on any OVOS
device: the user layer of mycroft.conf and one settings.json per skill under
~/.config/mycroft/skills/. In the browser that folder is kept in IndexedDB,
which a browser may clear (low storage, "clear site data"). Exporting it as a
zip file puts a copy on the phone itself; importing one puts it back, also
on another phone.

The zip holds the folder as is, plus `emkay-mobile.json` describing it, so a
file made by something else is refused instead of half-applied.
"""
import io
import json
import os
import shutil
import time
import zipfile

#: The folder that is saved: ~/.config (mycroft.conf, skill settings, personas).
CONFIG_DIR = os.path.expanduser("~/.config")

#: Marker file inside every export.
MANIFEST = "emkay-mobile.json"

#: Never exported: regenerated on boot, or large and not settings.
SKIP_DIRS = {"__pycache__"}


def export_zip() -> bytes:
    """Return the config folder as zip bytes, with a manifest."""
    buf = io.BytesIO()
    files = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, names in os.walk(CONFIG_DIR):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for name in names:
                path = os.path.join(root, name)
                zf.write(path, os.path.relpath(path, CONFIG_DIR))
                files += 1
        zf.writestr(MANIFEST, json.dumps({
            "format": 1,
            "what": "Emkay Mobile settings (~/.config)",
            "exported": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "files": files,
        }, indent=1))
    return buf.getvalue()


def import_zip(data: bytes) -> dict:
    """Replace the config folder with the one in an export.

    Raises ValueError for a file that is not an Emkay Mobile export, or that
    tries to write outside the folder. The old folder is moved aside first
    and put back if extracting fails, so a bad file never leaves it half
    replaced.
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise ValueError("not a zip file") from e
    if MANIFEST not in zf.namelist():
        raise ValueError("not an Emkay Mobile settings file")
    for name in zf.namelist():
        target = os.path.realpath(os.path.join(CONFIG_DIR, name))
        if not target.startswith(os.path.realpath(CONFIG_DIR) + os.sep):
            raise ValueError(f"refusing path outside the config folder: {name}")
    manifest = json.loads(zf.read(MANIFEST))

    backup = CONFIG_DIR + ".before-import"
    shutil.rmtree(backup, ignore_errors=True)
    # the folder itself is an IndexedDB mount point, so it stays; its
    # contents are moved aside one by one
    os.makedirs(backup)
    for entry in os.listdir(CONFIG_DIR):
        shutil.move(os.path.join(CONFIG_DIR, entry), os.path.join(backup, entry))
    try:
        for name in zf.namelist():
            if name != MANIFEST:
                zf.extract(name, CONFIG_DIR)
    except Exception:
        for entry in os.listdir(CONFIG_DIR):
            shutil.rmtree(os.path.join(CONFIG_DIR, entry), ignore_errors=True)
        for entry in os.listdir(backup):
            shutil.move(os.path.join(backup, entry), os.path.join(CONFIG_DIR, entry))
        raise
    finally:
        shutil.rmtree(backup, ignore_errors=True)
    return manifest
