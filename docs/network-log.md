# The network log

Emkay keeps a log of everything it contacts on the network, so what goes out
is something you can look at, not just a promise. It is in the menu
(⚙ → Guardian), and a skill can read it ("what did you send out today?").

## What is logged

Every request the Emkay worker makes, which is all of Emkay's own traffic:

- Python's requests, urllib and httpx: OVOS, its skills and plugins (they go
  through pyodide-http, XMLHttpRequest and fetch)
- the page's own downloads in the worker: speech recognition models, Piper
  voices, wake word models, Pyodide packages, the site's own files

For each request: when, the host, the method, the status, the size of the
answer, who asked (the skill or plugin, read from Python's call stack) and
the service in words. **Never the path, the query or the body.** Some
services carry what you said in the address (a translate server has the
sentence in its URL), and the log must not become the thing it is there to
show.

Not logged: what the browser itself fetches outside the worker, such as a
radio stream the page plays in `<audio>`.

## Where and how long

`~/.local/state/emkay/network.jsonl` in OVOS' file system, which Emkay keeps
in the browser's IndexedDB with the rest of `~/.local`. Entries older than
7 days are dropped when Emkay starts. The menu can clear it.

## Format

One JSON object per line ([JSON Lines](https://jsonlines.org)):

```json
{"t": 1794863530091, "host": "stt.openvoiceos.pt", "method": "POST", "status": 200, "bytes": 52, "who": "ovos-stt-plugin-server", "kind": "stt", "service": "speech recognition (OpenVoiceOS server)"}
```

| field | |
|---|---|
| `t` | when the request was made, milliseconds since 1970 (UTC) |
| `host` | host and port, e.g. `da.wikipedia.org` |
| `method` | `GET`, `POST`, … |
| `status` | the HTTP status; `0` when it never got an answer (blocked or offline) |
| `bytes` | size of the answer, when known; else `null` |
| `who` | the package that asked (its pip name, e.g. `ovos-skill-wikipedia`), `ovos` for OVOS itself, or `emkay` for the page |
| `kind` | what kind of service, a fixed id to translate (optional): `self` (Emkay's own site), `stt`, `tts`, `translate`, `wikipedia`, `models`, `store`, `packages`, `pyodide`, `github`, `weather`, `radio`, or `other` |
| `service` | the same in English words (`"Wikipedia"`), or the host itself when unknown (optional) |

The format is not tied to Emkay: anything that writes these lines to that
file can be read by the same skill
([ovos-skill-guardian](https://github.com/emkay-voice/ovos-skill-guardian)),
for instance a plugin on an ordinary OVOS device.

## How it works

- [`web/netlog.js`](../web/netlog.js) wraps `fetch` and `XMLHttpRequest` in
  the worker, keeps the entries and appends them to the file every few
  seconds.
- [`py/emkay_mobile/netlog.py`](../py/emkay_mobile/netlog.py) tells the
  worker who is calling right before each request from Python: the first
  package on the call stack that is not the HTTP machinery, the standard
  library or OVOS' shared libraries.
