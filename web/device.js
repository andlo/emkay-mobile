// The phone's hardware, as the browser PHAL plugin sees it
// (ovos-phal-plugin-browser, emkay-voice/ovos-phal-plugin-browser).
//
// The plugin speaks OVOS' bus contracts; this side reads the browser's APIs
// and reports changes, and carries out what the plugin asks for:
//   reports  online/offline, sensor readings (battery, network, screen,
//            motion, position, compass, light, storage, memory, CPU),
//            whether there is a camera, pictures
//   requests reload (reboot / restart services), off (shutdown),
//            forget_welcome (factory reset), camera_check / _open / _close,
//            picture
// Each API is used only where the browser has it; the rest stays silent.

import { t } from "./i18n.js";

let call = null;               // app.js' call() into the worker
const event = (name, data) => call("phal_event", { event: name, data }).catch(() => {});

const lastSent = new Map();   // "device_name" -> last state sent

/**
 * One sensor reading, in ovos-PHAL-sensors' terms (see ovos-phal-plugin-browser).
 * Only a changed state is sent: motion and orientation events come many
 * times a second, and the worker should hear about changes, not samples.
 */
function sensor(device, name, state, attributes = {}, binary = false) {
  const key = `${device}_${name}`;
  if (lastSent.get(key) === state) return;
  lastSent.set(key, state);
  event("sensor", { device, name, state, attributes, binary });
}

// ---------------------------------------------------------- connectivity
function watchOnline() {
  const report = () => event("online", { online: navigator.onLine });
  addEventListener("online", report);
  addEventListener("offline", report);
  report();
}

// --------------------------------------------------------------- sensors
async function watchBattery() {
  const battery = await navigator.getBattery?.().catch(() => null);
  if (!battery) return;
  const report = () => {
    sensor("battery", "percent", Math.round(battery.level * 100),
      { unit_of_measurement: "%", device_class: "battery", icon: "mdi:battery" });
    sensor("battery", "charging", battery.charging,
      { device_class: "battery_charging", icon: "mdi:battery-charging" }, true);
  };
  battery.addEventListener("levelchange", report);
  battery.addEventListener("chargingchange", report);
  report();
}

function watchNetwork() {
  const report = () => {
    sensor("network", "online", navigator.onLine, { device_class: "connectivity" }, true);
    const c = navigator.connection;
    if (c?.effectiveType) sensor("network", "type", c.effectiveType, { icon: "mdi:signal" });
    if (c?.downlink) sensor("network", "downlink", c.downlink,
      { unit_of_measurement: "Mbit/s", device_class: "data_rate", icon: "mdi:download-network" });
  };
  addEventListener("online", report);
  addEventListener("offline", report);
  navigator.connection?.addEventListener?.("change", report);
  report();
}

function watchScreen() {
  const report = () => {
    sensor("screen", "on", document.visibilityState === "visible",
      { device_class: "power", icon: "mdi:cellphone-screenshot" }, true);
    const o = screen.orientation?.type;
    if (o) sensor("screen", "orientation", o.split("-")[0], { icon: "mdi:phone-rotate-portrait" });
  };
  document.addEventListener("visibilitychange", report);
  screen.orientation?.addEventListener?.("change", report);
  report();
}

/** Moving or still, from the accelerometer (a binary "motion" sensor). */
function watchMotion() {
  if (!("DeviceMotionEvent" in self)) return;
  let moving = null;
  let lastMove = 0;
  const update = (now) => {
    const m = now - lastMove < 3000;
    if (m !== moving) {
      moving = m;
      sensor("motion", "moving", m, { device_class: "motion", icon: "mdi:run" }, true);
    }
  };
  addEventListener("devicemotion", (e) => {
    const a = e.acceleration;   // without gravity, m/s²
    if (a?.x == null) return;
    if (Math.hypot(a.x, a.y, a.z) > 1.2) lastMove = performance.now();
    update(performance.now());
  });
  setInterval(() => moving !== null && update(performance.now()), 2000);
}

/**
 * How the phone lies, from its orientation: "face_up" (flat, screen up),
 * "face_down", "upright" (held or standing) or "tilted" - e.g. for a rule
 * that mutes the assistant while the phone lies face down.
 */
export function position(beta, gamma) {
  if (Math.abs(beta) > 155 && Math.abs(gamma) < 25) return "face_down";
  if (Math.abs(beta) < 25 && Math.abs(gamma) < 25) return "face_up";
  if (Math.abs(beta) > 55 && Math.abs(beta) < 125) return "upright";
  return "tilted";
}

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** Position, and the compass direction where the browser knows north. */
function watchOrientation() {
  if (!("DeviceOrientationEvent" in self)) return;
  addEventListener("deviceorientation", (e) => {
    if (e.beta == null || e.gamma == null) return;
    sensor("phone", "position", position(e.beta, e.gamma), { icon: "mdi:phone-rotate-landscape" });
  });
  // alpha is a compass heading only in the "absolute" event (Chrome on
  // Android); Safari gives webkitCompassHeading on the ordinary one
  const heading = (e) => {
    const deg = e.webkitCompassHeading ?? (e.absolute && e.alpha != null ? 360 - e.alpha : null);
    if (deg == null) return;
    sensor("compass", "direction", POINTS[Math.round(deg / 45) % 8], { icon: "mdi:compass" });
  };
  addEventListener("deviceorientationabsolute", heading);
  addEventListener("deviceorientation", (e) => e.webkitCompassHeading != null && heading(e));
}

/** Storage the site uses and may use, every few minutes. */
async function watchStorage() {
  if (!navigator.storage?.estimate) return;
  const report = async () => {
    const { usage, quota } = await navigator.storage.estimate().catch(() => ({}));
    if (usage == null) return;
    sensor("storage", "used", Math.round(usage / 1e6),
      { unit_of_measurement: "MB", device_class: "data_size", icon: "mdi:database" });
    if (quota) sensor("storage", "available", Math.round(quota / 1e6),
      { unit_of_measurement: "MB", device_class: "data_size", icon: "mdi:database-outline" });
  };
  report();
  setInterval(report, 5 * 60e3);
}

/** What the browser tells about the device itself; read once. */
function readDevice() {
  if (navigator.deviceMemory) sensor("device", "memory", navigator.deviceMemory,
    { unit_of_measurement: "GB", device_class: "data_size", icon: "mdi:memory" });
  if (navigator.hardwareConcurrency) sensor("device", "cpu_cores", navigator.hardwareConcurrency,
    { icon: "mdi:cpu-64-bit" });
}

/** Ambient light, where the browser has the Generic Sensor for it. */
function watchLight() {
  if (!("AmbientLightSensor" in self)) return;
  try {
    const s = new AmbientLightSensor({ frequency: 0.2 });
    s.addEventListener("reading", () => sensor("light", "illuminance", Math.round(s.illuminance),
      { unit_of_measurement: "lx", device_class: "illuminance", icon: "mdi:brightness-5" }));
    s.start();
  } catch { /* not allowed here */ }
}

// ---------------------------------------------------------------- camera
let stream = null;

async function cameraCheck() {
  const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) || [];
  event("camera", { available: devices.some((d) => d.kind === "videoinput") });
}

async function cameraOpen() {
  if (!stream) stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
  return stream;
}

function cameraClose() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
}

/** One frame as a JPEG (base64), for ovos.phal.camera.get. */
async function picture(id) {
  const wasOpen = !!stream;
  try {
    const video = Object.assign(document.createElement("video"),
      { srcObject: await cameraOpen(), muted: true, playsInline: true });
    await video.play();
    await new Promise((r) => (video.videoWidth ? r() : video.addEventListener("loadeddata", r, { once: true })));
    const canvas = Object.assign(document.createElement("canvas"),
      { width: video.videoWidth, height: video.videoHeight });
    canvas.getContext("2d").drawImage(video, 0, 0);
    video.pause();
    const jpeg_b64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
    event("picture", { id, jpeg_b64 });
  } catch (e) {
    event("picture", { id, error: e.message || String(e) });
  } finally {
    if (!wasOpen) cameraClose();
  }
}

// ----------------------------------------------------------------- power
/** Reboot / restart the services: save to disk, then load the page anew. */
async function reload() {
  await call("sync").catch(() => {});
  location.reload();
}

/** Shut down: the screen goes dark until it is tapped. */
function off() {
  cameraClose();
  const el = document.getElementById("off");
  el.textContent = t("off");
  el.hidden = false;
  el.onclick = reload;
  call("sync").catch(() => {});
}

// ------------------------------------------------------------------------
/** The plugin's requests (worker -> page, kind "phal"); true if handled. */
export function onRequest(msg) {
  switch (msg.request) {
    case "reload": setTimeout(reload, 1500); return true;   // let the GUI show it
    case "off": setTimeout(off, 1500); return true;
    case "forget_welcome": try { localStorage.removeItem("emkay-welcomed"); } catch {} return true;
    case "camera_check": cameraCheck(); return true;
    case "camera_open": cameraOpen().catch(() => {}); return true;
    case "camera_close": cameraClose(); return true;
    case "picture": picture(msg.id); return true;
  }
  return false;
}

/** Start reporting, once OVOS (and with it the plugin) is up. */
export function startDevice(callWorker) {
  call = callWorker;
  watchOnline();
  watchBattery();
  watchNetwork();
  watchScreen();
  watchMotion();
  watchOrientation();
  watchLight();
  watchStorage();
  readDevice();
}
