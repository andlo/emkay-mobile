// SPDX-License-Identifier: Apache-2.0
/**
 * The page side of ovos-audio-plugin-browser: music, radio and podcasts.
 *
 * ovos-audio's AudioService runs in the worker, unchanged, with the
 * browser backend (ovos-audio-plugin-browser) as its player. The backend
 * sends ovos.audio.browser.{play,pause,resume,stop,seek,volume}; this
 * module plays them in one <audio> element and answers with
 * ovos.audio.browser.state: playing, paused, ended or error, with the
 * position and length in milliseconds. The protocol is in the plugin's
 * README, so another page (or a browser on a real OVOS device) can do the
 * same.
 *
 * Why <audio> and not the AudioContext the speech uses: <audio> plays a
 * stream from another site without that site's permission (CORS); routing
 * it through Web Audio would make such a stream silent. So the volume is
 * set on the element instead: the PHAL plugin's level (the "mixer"), times
 * the backend's duck factor while OVOS speaks or listens.
 *
 * What it cannot play: an http:// stream, because the page is https
 * (browsers block such "mixed content"). That is reported as an error with
 * a plain reason, and OCP goes on with the next result.
 */

const PREFIX = "ovos.audio.browser.";
const POSITION_EVERY = 5000;   // ms between position reports while playing

/**
 * @param {(type: string, data: object) => void} send - put a message on the bus
 * @returns {{onBus(msg): boolean, setLevel(level): void}}
 */
export function createMediaPlayer(send) {
  const audio = new Audio();
  audio.preload = "auto";
  let level = { volume: 0.75, muted: false };
  let factor = 1;          // ducking, from the backend
  let uri = null;          // what the backend asked for; null when stopped
  let lastReport = 0;

  const ms = (s) => (Number.isFinite(s) ? Math.round(s * 1000) : 0);
  const applyVolume = () => {
    audio.volume = level.muted ? 0 : Math.max(0, Math.min(1, level.volume * factor));
  };
  const report = (state, extra = {}) => {
    if (!uri) return;      // stopped: nothing to tell
    lastReport = Date.now();
    send(PREFIX + "state", {
      uri, state,
      position_ms: ms(audio.currentTime),
      length_ms: ms(audio.duration),   // 0 for a live stream (Infinity)
      ...extra,
    });
  };
  const why = () => {
    if (uri?.startsWith("http:") && location.protocol === "https:")
      return "an https page cannot play an http:// stream (mixed content)";
    const code = audio.error?.code;
    return ({ 1: "aborted", 2: "network error", 3: "could not decode",
              4: "format not supported or not found" })[code] || audio.error?.message || "unknown";
  };

  audio.addEventListener("playing", () => report("playing"));
  audio.addEventListener("pause", () => { if (uri && !audio.ended) report("paused"); });
  audio.addEventListener("ended", () => { report("ended"); uri = null; });
  audio.addEventListener("error", () => { if (uri && audio.getAttribute("src")) { report("error", { error: why() }); uri = null; } });
  audio.addEventListener("timeupdate", () => {
    if (!audio.paused && Date.now() - lastReport > POSITION_EVERY) report("playing");
  });

  function play({ uri: next, position_ms = 0 }) {
    uri = next;
    audio.src = next;
    if (position_ms) audio.currentTime = position_ms / 1000;
    audio.play().catch((e) => {
      // NotAllowedError: the browser wants a tap first; AbortError: a newer
      // play or stop came first (nothing to report then)
      if (e.name !== "AbortError" && uri === next) { report("error", { error: e.message || e.name }); uri = null; }
    });
  }
  function stop() {
    uri = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();          // drops the stream's connection
  }

  return {
    /** Handle an ovos.audio.browser.* message; true when it was one. */
    onBus(msg) {
      if (!msg.type?.startsWith(PREFIX) || msg.type === PREFIX + "state") return false;
      const d = msg.data || {};
      switch (msg.type.slice(PREFIX.length)) {
        case "play": play(d); break;
        case "pause": audio.pause(); break;
        case "resume": if (uri) audio.play().catch(() => {}); break;
        case "stop": stop(); break;
        case "seek": if (uri) audio.currentTime = (d.position_ms || 0) / 1000; break;
        case "volume": factor = d.ducked ? (d.factor ?? 0.3) : 1; applyVolume(); break;
        default: return false;
      }
      return true;
    },
    /** The PHAL plugin's {volume: 0..1, muted}, the same as for speech. */
    setLevel(l) { level = l; applyVolume(); },
    /** What is playing, for debugging and the browser tests. */
    state: () => ({ uri, paused: audio.paused, ended: audio.ended,
                    volume: audio.volume, position_ms: ms(audio.currentTime) }),
  };
}
