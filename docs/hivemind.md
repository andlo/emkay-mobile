# Emkay as a HiveMind satellite

Emkay can use an OpenVoiceOS in your house instead of the one in the
browser ([#11](https://github.com/emkay-voice/emkay/issues/11), part of
[#27](https://github.com/emkay-voice/emkay/issues/27)). The phone keeps the
body – the face, the wake word, the microphone and the speaker – and the
questions go to the house over [HiveMind](https://github.com/JarbasHiveMind/HiveMind-core).
Nothing heavy loads on the phone: no Pyodide, no OVOS. Emkay starts in a
second or two.

It works like `hivemind-voice-sat`: the wake word and the speech
recognition run on the phone (Whisper in the browser, or the browser's own
recognition), only the text goes to the house; the answer (`speak`) comes
back and the phone makes the voice (Piper in the browser).

## In the house

A hivemind-core next to your OVOS, and a client for Emkay:

```sh
hivemind-core add-client --name kitchen-tablet
```

It prints an access key and a password; Emkay needs both.

**The browser needs `wss://`.** A page on https (app.emkay.ai) may only open
a secure WebSocket to your LAN, so hivemind-core must have TLS: its own
certificate (`ssl: true` and `cert_dir` in its config), or a reverse proxy
in front of it (Caddy, Nginx Proxy Manager, …) with a certificate the phone
trusts. Emkay served from the house over plain http
([#30](https://github.com/emkay-voice/emkay/issues/30)) can use `ws://`.

## On the phone

Open Emkay with `?brain=hivemind`, e.g. `https://app.emkay.ai/?brain=hivemind`.
The first time it asks for host, port, the access key and the password, and
remembers them in the browser.

The connection can also be handed over in the address, after
`#hivemind=` as base64 JSON – the part after `#` never leaves the browser,
and Emkay removes it from the address once saved. Handy for a QR code:

```sh
echo -n '{"host":"ovos.local","port":5678,"ssl":true,"key":"…","password":"…"}' | base64 -w0
# → https://app.emkay.ai/?brain=hivemind#hivemind=<that>
```

Optional fields: `lang` (default: the browser's language), `stt`
(`"whisper"`, the default, or `"browser"`), `siteId`.

In this mode the ⚙ menu has no control panel, skill store or network log:
those belong to the OVOS in the browser. Skills are installed on the OVOS
in the house.

## Testing

- `tools/probes/hivemind_node.mjs` – the client (`web/brains/hivemind.js`)
  against a real hivemind-core: handshake, an answer, wrong password and
  wrong key refused.
- `tools/probes/hivemind_browser.mjs` – Emkay with `?brain=hivemind` in
  headless Chromium: boot, start, a typed question answered and spoken.
- `tools/probes/hivemind_responder.py` – a stand-in skill on the bus that
  answers every utterance, for when there is no full OVOS at hand.

A throw-away hivemind-core for the probes (in a venv; note
`bitstring<4.3` and `setuptools<81`, which hivemind-bus-client 0.4.4 and
hivemind-plugin-manager 0.5 still need):

```sh
python3 -m venv /tmp/hm && /tmp/hm/bin/pip install hivemind-core ovos-messagebus "bitstring<4.3" "setuptools<81"
export XDG_DATA_HOME=/tmp/hm-home/data XDG_CONFIG_HOME=/tmp/hm-home/config
/tmp/hm/bin/hivemind-core add-client --name emkay-test --access-key K --password P
/tmp/hm/bin/ovos-messagebus &  /tmp/hm/bin/hivemind-core listen &
/tmp/hm/bin/python tools/probes/hivemind_responder.py &
HM_KEY=K HM_PASSWORD=P node tools/probes/hivemind_node.mjs
```

## Not yet

- Skill pages (ovos-gui) from the house on the phone's screen – the face
  and its clock work; GUI pages need HiveMind to carry the GUI stream.
- The mouth follows no visemes yet in this mode (#28: mouth from the audio level).
- Emkay's own texts for the setup form are in English and Danish; the other
  languages fall back to English until translated.
