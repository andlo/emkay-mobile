// web/brains/hivemind.js against a real hivemind-core (issue #11), in Node.
//
// Needs a running ovos-messagebus + hivemind-core, a client made with
//   hivemind-core add-client --name emkay-test --access-key K --password P
// and something on the bus that answers an utterance (a real ovos-core, or
// tools/probes/hivemind_responder.py). Then:
//
//   HM_HOST=127.0.0.1 HM_PORT=5678 HM_KEY=K HM_PASSWORD=P node tools/probes/hivemind_node.mjs
//
// Logs: the handshake, an utterance answered by `speak`, and that a wrong
// password and a wrong key are both refused.
import { HiveMindClient } from "../../web/brains/hivemind.js";

const base = {
  host: process.env.HM_HOST || "127.0.0.1", port: +(process.env.HM_PORT || 5678),
  ssl: process.env.HM_SSL === "1", key: process.env.HM_KEY, password: process.env.HM_PASSWORD,
};
const log = (m) => console.log(m);

const hm = new HiveMindClient(base);
await hm.connect();
log(`connected: node ${hm.nodeId}, encoding ${hm.encoding}`);
const said = new Promise((resolve) => hm.addEventListener("message", (e) => {
  if (e.message.type === "speak") resolve(e.message.data.utterance);
}));
await hm.emit("recognizer_loop:utterance", { utterances: [process.env.QUESTION || "what time is it"], lang: "en-US" });
log(`speak: ${await Promise.race([said, new Promise((r) => setTimeout(() => r("(nothing in 15 s)"), 15000))])}`);
hm.close();

for (const [what, opts] of [["wrong password", { password: "not-it" }], ["wrong key", { key: "not-it" }]]) {
  try {
    await new HiveMindClient({ ...base, ...opts }).connect(8000);
    log(`${what}: accepted (bad)`);
  } catch (e) {
    log(`${what}: refused (${e.message})`);
  }
}
process.exit(0);
