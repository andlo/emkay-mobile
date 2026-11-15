"""Run the headless-browser tests against a built site and check their output.

Each probe (tools/probes/*_browser.mjs) boots Emkay in a real headless
Chromium, does one thing a user does and logs what happened; this runner
serves build/site, runs the probes one after another and checks the lines
each must log. It exits non-zero when one is missing, so CI does not
deploy a site that fails them.

  CHROME=/path/to/chrome python3 tools/probes/ci.py [LOG_DIR]

The logs go to LOG_DIR (default build/probe-logs).
"""
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
URL = "http://127.0.0.1:8080/"

#: probe, extra env, arguments, the lines its log must hold (regex)
PROBES = [
    ("setup_browser.mjs", {}, [], [
        r"\| Start ",                            # the first start offers setup
        r"wake step shown: false",              # browser-honest wizard
        r"setup url: .*/panel/setup",
    ]),
    ("lang_browser.mjs", {"PHONE_LANG": "da-DK"}, [], [
        r"OVOS lang: da-DK",                    # the phone's language
        r"downloaded: \['intents-da-DK', 'm2v-da'\]",   # and only that one
        r"menu: OpenVoiceOS settings",          # texts follow the panel
        r"restart button: Restart to use en-US",
        r"after restart: .*intents-en-US",
    ]),
    ("install_browser.mjs", {}, [URL, "ovos-skill-number-facts", "tell me a fact about the number 7"], [
        r"install finished: state=done returncode=0",
        r"new: ovos-skill-number-facts\.openvoiceos",
        r"Successfully uninstalled ovos-skill-number-facts",
    ]),
    ("tx_browser.mjs", {}, [], [
        r"enable: \['ovos-dialog-normalizer-plugin'\]",
        r"spoken: I('ve| have) got (three|tre) apples",   # rewritten before TTS
    ]),
    ("backup_browser.mjs", {}, [], [
        r"backup: 200 application/gzip attachment",   # the panel's Backup page
        r"after restore: unit imperial",
    ]),
    ("mic_browser.mjs", {"SPEECH_WAV": str(REPO / "tools/probes/audio/what_time.wav")}, [], [
        r'captions: \["Listening…","One moment…","“What time is it\?”"',   # tap, STT
        r'second said: \["(It|Currently)',                 # and an answer
    ]),
    ("wakeword_browser.mjs", {"SPEECH_WAV": str(REPO / "tools/probes/audio/hey_mycroft_what_time.wav"), "ANSWERS": "2"}, [], [
        r"wake word engine ready",
        r'said: \["(It|Currently)',                        # no tap: the wake word
        r"answer 2; mic: mic, wake listening",                # and back waiting for the next one
    ]),
    # a skill asking back (get_response) gets the answer: Python really waits (JSPI, #20)
    ("noanswer_browser.mjs", {"QUESTIONS": "set an alarm|in five minutes|read the latest post from ovosblog|yes|stop"}, [], [
        r'"in five minutes": said \["Your alarm is set',
        r'"yes": said \["[^"]*from the OpenVoiceOS Blog',     # the skill's dialogs vary
        r'"stop": said \["[^"]+"\] \| captions \[\]',          # a stop line, not "couldn't help"
    ]),
    ("panel_mobile.mjs", {}, [], [
        r"after tapping Settings: /panel/config",       # the panel's menu by touch
    ]),
    ("noanswer_browser.mjs", {}, [], [
        r'"what time is it": said \["(It|Currently)[^|]*\|[^|]*\| sounds 0',   # answered: no error sound, no "couldn't help"
    ]),
    ("noanswer_browser.mjs", {"QUESTIONS": "what is 17 times 23|what is the capital of australia|read my horoscope for leo"}, [], [
        r'"what is 17 times 23": said \[[^\]]*391',            # the skills Emkay adds
        r'"what is the capital of australia": said \[[^\]]*Canberra',
        r'"read my horoscope for leo": said \["[^"]*Leo',       # common reading
    ]),
    ("installable_browser.mjs", {}, [], [
        r"manifest errors: none",
        r"installability errors: none",                     # "Install as app" can be offered
        r"panel simple view: 1 \| nav items: [1-9] ",       # the panel opens in its Simple view
    ]),
    ("phal_browser.mjs", {}, [], [
        r'internet_check: \[\{"internet_connected": true',
        r'camera\.get: .*"b64_frame"',
        r"sensors: .*phone_position=face_down",
        r"capabilities: .*power=ovos-phal-plugin-browser",
        r"page reloaded: true",
    ]),
]


def serve():
    proc = subprocess.Popen([sys.executable, str(REPO / "tools/serve.py")],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            urllib.request.urlopen(URL, timeout=1)
            return proc
        except OSError:
            time.sleep(0.2)
    proc.kill()
    sys.exit("the site server did not start")


def main():
    logs = Path(sys.argv[1] if len(sys.argv) > 1 else REPO / "build/probe-logs")
    logs.mkdir(parents=True, exist_ok=True)
    if not os.environ.get("CHROME"):
        sys.exit("set CHROME to a Chromium or Chrome binary")
    # every probe starts from an empty browser profile, as on CI (a profile
    # left by an earlier local run keeps its OVOS config and changes results)
    import glob, shutil
    for d in glob.glob("/tmp/emkay-chrome*"):
        shutil.rmtree(d, ignore_errors=True)
    server = serve()
    failed = []
    try:
        for probe, env, args, expect in PROBES:
            t = time.time()
            log = logs / probe.replace(".mjs", ".log")
            with open(log, "w") as out:
                subprocess.run(["node", str(REPO / "tools/probes" / probe), *(args or [URL])],
                               env={**os.environ, **env}, stdout=out, stderr=subprocess.STDOUT,
                               cwd=REPO, timeout=900)
            text = log.read_text(errors="replace")
            missing = [e for e in expect if not re.search(e, text)]
            print(f"{'ok  ' if not missing else 'FAIL'} {probe} ({time.time() - t:.0f} s)")
            for e in missing:
                print(f"     missing: {e}")
            if missing:
                failed.append(probe)
    finally:
        server.kill()
    if failed:
        sys.exit(f"{len(failed)} of {len(PROBES)} browser tests failed; logs in {logs}")


if __name__ == "__main__":
    main()
