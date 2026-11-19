// Emkay – "What's happening?" (#50): what Emkay heard, which skill understood
// it, what it answered, and what left this device, live, one question at a
// time. A web version of ovos-tui-client's activity pane: the same bus
// messages, read the same way (ovos_tui_client/activity.py), plus what only
// Emkay knows – which speech plugin ran where, and the network log.
//
// The worker forwards the few bus messages this needs (worker_main.py,
// _ACTIVITY) as they happen, so the last questions are here when the view
// opens; the network log (netlog.js) is read while it is open.

/** Where a speech or wake word plugin runs, by its name. */
const PLACES = [
  // the browser's own speech recognition (Web Speech API): Chrome sends the
  // audio to Google, Safari and Edge to their makers – not this device
  [/stt-plugin-browser$|web-?speech/i, "browser"],
  [/browser|whisper|piper|vosk|onnx|openwakeword|oww|silero|precise|kokoro|nos|roest|rost/i, "device"],
  [/./, "server"],
];
export const place = (module) => (module ? PLACES.find(([re]) => re.test(module))[1] : "");

const MAX = 400;           // events kept
const TURN_GAP = 20000;    // ms of quiet that ends a question

/**
 * @param {object} o
 * @param {(kind: string, fn: Function) => void} o.on   brain.on
 * @param {Function} o.call   worker commands
 * @param {(key: string, vars?: object) => string} o.t   texts (i18n.js)
 * @param {(id: string) => HTMLElement} o.$
 * @param {Function} o.el   element maker (app.js)
 */
export function createActivity({ on, call, t, $, el }) {
  const events = [];          // {t, msg}
  let net = [];               // network log entries since the oldest event
  let setup = null;
  let open = false, timer = null, lastRecord = 0;

  on("activity", (d) => {
    let msg;
    try { msg = JSON.parse(d.payload); } catch { return; }
    const now = Date.now();
    if (msg.type === "recognizer_loop:record_begin" || msg.type === "recognizer_loop:wakeword") lastRecord = now;
    // typed or spoken: an utterance soon after the microphone opened was spoken
    if (msg.type === "recognizer_loop:utterance") msg.spoken = now - lastRecord < 30000;
    // "speak" and "ovos.utterance.speak" mirror each other: one line per sentence
    if (msg.type === "speak" || msg.type === "ovos.utterance.speak") {
      msg.type = "speak";
      const prev = events.findLast?.((e) => e.msg.type === "speak");
      if (prev && now - prev.t < 3000 && prev.msg.data?.utterance === msg.data?.utterance) return;
    }
    // the voice fell back to another plugin: the sentence just said was spoken by that one
    if (msg.type === "emkay.speech.interim" && msg.data?.what === "tts" && msg.data?.using === "fallback") {
      const said = events.findLast?.((e) => e.msg.type === "speak" && now - e.t < 20000);
      if (said) said.msg.voice = msg.data.module;
    }
    events.push({ t: now, msg });
    if (events.length > MAX) events.splice(0, events.length - MAX);
    if (open) render();
  });

  const where = (module) => (module ? t(`act.where.${place(module)}`) : "");
  const nice = (module) => String(module || "?").replace(/^ovos-(stt|tts|ww)-plugin-/, "").replace(/^ovos-/, "");
  const skill = (id) => String(id || "?").replace(/\.[^.]+$/, "").replace(/^ovos-skill-/, "");

  /** One bus message as [lane, icon, text, sub] (or null: not shown). */
  function line(msg) {
    const d = msg.data || {};
    switch (msg.type) {
      case "recognizer_loop:wakeword":
        return ["heard", "👂", t("act.wake", { word: d.utterance || setup?.wake_word || "" }), t("act.where.device")];
      case "recognizer_loop:record_begin":
        return ["heard", "🎙", t("act.listening"), ""];
      case "recognizer_loop:utterance": {
        const text = (d.utterances || [""])[0];
        return ["heard", "💬", `“${text}”`, msg.spoken && setup?.stt
          ? t("act.spoken", { engine: nice(setup.stt), where: where(setup.stt) }) : t("act.typed")];
      }
      case "recognizer_loop:speech.recognition.unknown":
        return ["heard", "❓", t("act.unknown"), ""];
      case "emkay.speech.interim":
        if (d.using !== "fallback") return null;
        return ["note", "⚠", t(d.what === "tts" ? "act.tts_fallback" : "act.stt_fallback",
          { module: nice(d.module), where: where(d.module) }), ""];
      case "ovos.intent.matched": {
        // the fallback round is shown by its own lines below
        if (/^ovos\.skills\.fallback\./.test(d.intent_name || "")) return null;
        const slots = Object.entries(d.slots || {})
          .filter(([k]) => !/^(skill_id|utterance|utterances|lang|conf|confidence|intent_type|target|__tags__)$/.test(k))
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ");
        const intent = String(d.intent_name || "").split(":").pop().replace(/\.intent$/, "");
        return ["understood", "🎯", t("act.matched", { skill: skill(d.skill_id), intent }),
          [d.pipeline_id && t("act.via", { pipeline: d.pipeline_id }), slots].filter(Boolean).join(" · ")];
      }
      case "complete_intent_failure":
      case "ovos.intent.unmatched":
        return ["understood", "✗", t("act.unmatched"), ""];
      case "mycroft.skill.handler.error":
        return ["understood", "✗", t("act.error", { skill: skill(msg.skill_id || d.name), error: d.exception || d.error || "" }), ""];
      case "question:query":
        return ["understood", "🔍", t("act.query"), `“${d.phrase || ""}”`];
      case "question:query.response":
        if (d.searching) return null;
        return ["understood", d.answer ? "📥" : "·", t(d.answer ? "act.query_answer" : "act.query_none", { skill: skill(d.skill_id) }), ""];
      case "question:action":
        return ["understood", "🏆", t("act.query_won", { skill: skill(d.skill_id) }), ""];
      case "ocp:play":
        return ["understood", "🎵", t("act.media", { query: d.query || d.utterance || "" }), ""];
      case "ovos.common_play.skill.search_end":
        return null;
      case "speak":
        return ["answered", "🗣", `“${d.utterance || ""}”`, t("act.said_by", {
          skill: skill(d.meta?.skill || msg.skill_id), engine: nice(msg.voice || setup?.tts), where: where(msg.voice || setup?.tts) })];
      case "mycroft.stop":
        return ["note", "⏹", t("act.stop"), ""];
      default:
        if (msg.type.startsWith("ovos.skills.fallback.")) {
          const id = msg.type.slice("ovos.skills.fallback.".length).replace(/\.(start|response)$/, "");
          if (msg.type.endsWith(".start")) return ["understood", "↪", t("act.fallback", { skill: skill(id) }), ""];
          if (!d.result) return ["understood", "·", t("act.fallback_no", { skill: skill(id) }), ""];
        }
        return null;
    }
  }

  /** A network log entry as a line: only what left for others (not Emkay's own site). */
  function netLine(e) {
    if (e.kind === "self") return null;
    return ["network", e.blocked ? "🛡" : "🌐", e.service || e.host,
      [e.host !== e.service ? e.host : "", t("act.asked_by", { who: e.who }), e.blocked ? t("act.blocked") : ""]
        .filter(Boolean).join(" · ")];
  }

  function render() {
    const list = $("activity-list");
    const items = [
      ...events.map((e) => ({ t: e.t, l: line(e.msg), starts: /wakeword|record_begin/.test(e.msg.type)
        || (e.msg.type === "recognizer_loop:utterance" && !e.msg.spoken) })),
      ...net.map((e) => ({ t: e.t, l: netLine(e), starts: false })),
    ].filter((x) => x.l).sort((a, b) => a.t - b.t);
    // questions: a new one at the wake word, the microphone or a typed line,
    // or after a quiet spell; newest first
    const turns = [];
    let last = 0;
    for (const x of items) {
      const cur = turns[turns.length - 1];
      const asked = cur?.items.some((i) => i.l[1] === "💬");   // this question was heard already
      if (!cur || x.t - last > TURN_GAP || (x.starts && asked)) {
        turns.push({ t: x.t, items: [x] });
      } else cur.items.push(x);
      last = x.t;
    }
    list.replaceChildren();
    if (!turns.length) {
      list.append(el("p", { className: "small", textContent: t("act.empty") }));
      return;
    }
    for (const turn of turns.reverse().slice(0, 40)) {
      const box = el("div", { className: "act-turn" },
        el("div", { className: "act-time", textContent: new Date(turn.t).toLocaleTimeString() }));
      // a fallback that "could not answer" while something did answer is noise
      const answered = turn.items.some((i) => i.l[0] === "answered");
      for (const { l: [lane, icon, text, sub] } of turn.items) {
        if (answered && lane === "understood" && icon === "·") continue;
        box.append(el("div", { className: `act-line act-${lane}` },
          el("span", { className: "act-icon", textContent: icon }),
          el("span", { className: "act-body" },
            el("span", { className: "act-lane", textContent: t(`act.lane.${lane}`) }),
            el("span", { className: "act-text", textContent: text }),
            sub ? el("span", { className: "act-sub", textContent: sub }) : "")));
      }
      list.append(box);
    }
  }

  function renderSetup() {
    const s = setup || {};
    const row = (label, module) => module ? el("div", {},
      el("b", { textContent: `${t(label)}: ` }), `${nice(module)} – ${where(module)}`) : "";
    $("activity-setup").replaceChildren(row("act.hears", s.stt), row("act.speaks", s.tts),
      s.wake_word ? el("div", {}, el("b", { textContent: `${t("act.wakeword")}: ` }),
        `${String(s.wake_word).replace(/_/g, " ")} – ${t("act.where.device")}`) : "");
  }

  async function poll() {
    const since = events.length ? events[0].t - 5000 : Date.now() - 600000;
    const all = await call("net_log").catch(() => []);
    net = all.filter((e) => e.t >= since);
    render();
  }

  return {
    /** The message types seen so far (for the probe, tools/probes/activity_browser.mjs). */
    types: () => events.map((e) => e.msg.type),
    async show() {
      open = true;
      setup = await call("activity_setup").catch(() => null);
      renderSetup();
      await poll();
      timer = setInterval(poll, 2000);
    },
    hide() {
      open = false;
      clearInterval(timer);
    },
  };
}
