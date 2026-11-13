// Backlash Tool -- measure declination (or RA) backlash with a guide camera,
// through PHD2, on any mount that PHD2 can pulse-guide.
//
// One file, no dependencies. Run `node app.cjs` (or the packaged executable):
// it starts a small web server on this computer only and opens the page.
//
// WHAT IT MEASURES. A guide pulse turns the motor. If the gear train has
// slack, the first part of every pulse AFTER A DIRECTION REVERSAL is spent
// taking the slack up, and the star does not move. Commanded time minus the
// time the star's travel accounts for is the slack, in milliseconds:
//
//      slack_ms = leg_ms - travel_arcsec / guide_rate_arcsec_per_ms
//
// It is scored against the GUIDE RATE THE MOUNT IS SET TO (the user enters
// it; 0.5x sidereal = 7.52"/s is the commonest). The rate fitted from the
// run itself is reported separately, as "springiness": on a real mount it
// varies run to run by +/-10% and scoring against it made two of the original
// rounds misleading (Losmandy G11, 2026-11-04).
//
// TWO MODES.
//   Measure       K steps one way (preload), 2K back (reversal 1), K forward
//                 (reversal 2). Net command zero. The number to compare
//                 between adjustments.
//   Live adjust   short legs back and forth forever, a reversal every 20-30 s,
//                 a slack figure after EVERY reversal, so the effect of a
//                 turn of a screw is visible within a minute. Star jumps
//                 (someone touched the mount) re-reference instead of
//                 aborting.
//
// It commands only guide pulses, through PHD2's own guide_pulse, which is the
// same path a real guide correction takes. It refuses while PHD2 is guiding.
//
// Optional: a Losmandy Gemini-II's motor effort (DEC_PWM / RA_PWM from its
// web server, GET only) shown beside each reversal as a friction warning.

"use strict";
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");

const VERSION = "1.0.0";
const PORT = Number(process.env.BACKLASH_PORT || 7171);
const PHD2_HOST = process.env.PHD2_HOST || "127.0.0.1";
const PHD2_PORT = Number(process.env.PHD2_PORT || 4400);
const DATA_DIR = process.env.BACKLASH_DATA || path.join(os.homedir(), "Documents", "BacklashTool");
const SIDEREAL = 15.0411;                       // arcsec per second of time
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Assets are injected by build.cjs for the packaged executable; when run from
// source they are read beside this file.
/* @@ASSETS@@ */
const ASSETS = (typeof __ASSETS__ !== "undefined") ? __ASSETS__ : {
  page: fs.readFileSync(path.join(__dirname, "page.html"), "utf8"),
  sample: fs.readFileSync(path.join(__dirname, "sample.json"), "utf8"),
};

// ------------------------------------------------------------- PHD2 client --
// PHD2's event server: line-delimited JSON-RPC on port 4400. One connection,
// re-opened on demand. Events (lines without our id) are ignored.
class Phd2 {
  constructor() { this.sock = null; this.pending = new Map(); this.id = 1; this.buf = ""; }
  connect() {
    if (this.sock && !this.sock.destroyed && this.sock.readyState === "open") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: PHD2_HOST, port: PHD2_PORT });
      const fail = (e) => { reject(e); };
      s.setEncoding("utf8");
      s.once("error", fail);
      s.on("data", (d) => this.onData(d));
      s.on("close", () => {
        for (const { no } of this.pending.values()) no(new Error("PHD2 connection closed"));
        this.pending.clear();
        if (this.sock === s) this.sock = null;
      });
      s.once("connect", () => { s.off("error", fail); s.on("error", () => {}); this.sock = s; resolve(); });
      s.setTimeout(0);
    });
  }
  onData(d) {
    this.buf += d;
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { ok, no } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) no(new Error(m.error.message || JSON.stringify(m.error))); else ok(m.result);
      }
    }
  }
  async call(method, params, timeoutMs = 15000) {
    await this.connect();
    return new Promise((ok, no) => {
      const id = this.id++;
      this.pending.set(id, { ok, no });
      const req = { method, id };
      if (params !== undefined) req.params = params;
      this.sock.write(JSON.stringify(req) + "\r\n");
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); no(new Error(`PHD2 did not answer ${method}`)); } }, timeoutMs);
    });
  }
}
const phd2 = new Phd2();

// ---------------------------------------------- optional Gemini-II effort --
// GET only. The Gemini's /motor.cgx is the feed its own Servo page polls.
let gemini = { host: "", user: "admin", pass: "" };     // held in memory only, never written to disk
function geminiEffort(axis) {
  if (!gemini.host) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get({ host: gemini.host, path: "/motor.cgx", timeout: 2500,
      headers: { Authorization: "Basic " + Buffer.from(`${gemini.user}:${gemini.pass}`).toString("base64") } }, (res) => {
      let body = ""; res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        const f = {};
        for (const m of body.matchAll(/<id>([^<]*)<\/id><value>([^<]*)<\/value>/g)) f[m[1].trim()] = m[2].trim();
        const v = Number(f[axis === "dec" ? "DEC_PWM" : "RA_PWM"]);
        resolve(Number.isFinite(v) ? v : null);
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

// ----------------------------------------------------------------- the run --
let run = null;          // the current or last run (what the page draws)
let stopAsked = false;

function newRun(mode, p) {
  const fwd = p.axis === "dec" ? "N" : "W", back = p.axis === "dec" ? "S" : "E";
  const stamp = new Date();
  const z = (n) => String(n).padStart(2, "0");
  const id = `${stamp.getFullYear()}-${z(stamp.getMonth() + 1)}-${z(stamp.getDate())}_${z(stamp.getHours())}${z(stamp.getMinutes())}${z(stamp.getSeconds())}`;
  return { id, mode, state: "running", message: "starting", started: stamp.toISOString(), finished: null,
           axis: p.axis, fwd, back, stepMs: p.stepMs, steps: p.steps, legSteps: p.legSteps,
           rate: p.rate, scale: null, exposureMs: null, label: p.label || "",
           points: [], reversals: [], result: null, csv: null, events: [] };
}

function csvPath(r) { return path.join(DATA_DIR, `backlash_${r.axis}_${r.mode}_${r.id}.csv`); }
function csvLine(r, q) {
  fs.appendFileSync(r.csv, [q.i, new Date(q.t).toISOString(), q.leg, q.dir, q.cmdMs, q.x.toFixed(2), q.y.toFixed(2),
    q.alongArcsec.toFixed(2), q.effort ?? "", q.note ?? ""].join(",") + "\n");
}

// Where is the star? find_star with a region of interest around the last
// position: once a guide star saturates PHD2 may otherwise prefer a different
// star (a 1290 px jump on 2026-11-04). Averaged over n reads.
async function starPos(n, near) {
  let sx = 0, sy = 0, k = 0;
  for (let i = 0; i < n; i++) {
    const params = near ? { roi: [Math.max(0, Math.round(near.x - near.r)), Math.max(0, Math.round(near.y - near.r)),
                                  Math.round(2 * near.r), Math.round(2 * near.r)] } : [];
    let pos;
    try { pos = await phd2.call("find_star", params); } catch (e) { if (i === n - 1 && !k) throw e; continue; }
    if (Array.isArray(pos)) { sx += pos[0]; sy += pos[1]; k++; }
    if (i < n - 1) await sleep(400);
  }
  if (!k) throw new Error("PHD2 found no star -- is it looping, with a star in the field?");
  return { x: sx / k, y: sy / k };
}

// Preconditions, shared by the status endpoint and both modes.
async function checkPhd2() {
  const out = { phd2: false, state: null, connected: null, scale: null, exposureMs: null, problems: [] };
  try {
    out.state = await phd2.call("get_app_state", undefined, 5000);
    out.phd2 = true;
    out.connected = await phd2.call("get_connected", undefined, 5000).catch(() => null);
    out.scale = await phd2.call("get_pixel_scale", undefined, 5000).catch(() => null);
    out.exposureMs = await phd2.call("get_exposure", undefined, 5000).catch(() => null);
  } catch (e) {
    out.problems.push(`PHD2 not reachable on ${PHD2_HOST}:${PHD2_PORT} -- start PHD2 and tick Tools > Enable Server.`);
    return out;
  }
  if (out.connected === false) out.problems.push("PHD2's equipment is not connected (camera and mount).");
  if (out.state === "Guiding") out.problems.push("PHD2 is GUIDING -- stop guiding (keep looping). Guiding would correct the pulses away.");
  if (out.state === "Calibrating") out.problems.push("PHD2 is calibrating -- wait for it to finish.");
  if (!(out.scale > 0)) out.problems.push("PHD2 does not know the pixel scale -- set focal length and pixel size in its profile.");
  return out;
}

async function prepare(r) {
  const c = await checkPhd2();
  if (c.problems.length) throw new Error(c.problems.join(" "));
  if (c.state !== "Looping" && c.state !== "Selected" && c.state !== "LostLock") {
    r.message = "starting PHD2 looping"; await phd2.call("loop"); await sleep(Math.max(2500, (c.exposureMs || 1000) * 2.5));
  }
  r.scale = c.scale; r.exposureMs = c.exposureMs || 1000;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  r.csv = csvPath(r);
  fs.writeFileSync(r.csv, `# backlash tool ${VERSION}  mode ${r.mode}  axis ${r.axis}  step ${r.stepMs} ms  guide rate ${r.rate.toFixed(3)} "/s  scale ${r.scale} "/px  label ${JSON.stringify(r.label)}\n` +
    "i,t,leg,dir,cmd_ms,x,y,along_arcsec,effort,note\n");
}

// One measured run of steps, shared by both modes.
function makeStepper(r) {
  // a whole fresh frame after the move (BACKLASH_SETTLE_MS: tests only)
  const settle = process.env.BACKLASH_SETTLE_MS ? Number(process.env.BACKLASH_SETTLE_MS) : Math.max(1200, r.exposureMs * 1.3 + 600);
  const expectPx = (r.rate * r.stepMs / 1000) / r.scale;
  let i = 0, cmd = 0, ux = 0, uy = 0, ref = null;
  const st = {
    settle, expectPx,
    get cmd() { return cmd; },
    // direction of travel in the guide frame, learnt from the first leg, so drift
    // on the OTHER axis (perpendicular) projects out
    learn() {
      const pts = r.points.filter((q) => !q.reref), last = pts.at(-1);
      if (!ref || !last) return;
      const dx = last.x - ref.x, dy = last.y - ref.y, d = Math.hypot(dx, dy);
      if (d > 3) { ux = dx / d; uy = dy / d; st.learned = true; }
    },
    learned: false,
    async pulse(dir, sgn) {
      const effP = geminiEffort(r.axis).catch(() => null);           // read while the pulse runs
      const res = await phd2.call("guide_pulse", [r.stepMs, dir, "Mount"]);
      if (res && res.code) throw new Error(`PHD2 refused the pulse -- ${res.message || JSON.stringify(res)}`);
      cmd += sgn * r.stepMs;
      await sleep(Math.min(400, r.stepMs / 2));
      const eff = await effP;
      await sleep(Math.max(0, r.stepMs - Math.min(400, r.stepMs / 2)) + settle);
      return eff;
    },
    // returns { q, jumped }
    async sample(leg, dir, eff, { allowJump }) {
      const prev = r.points.at(-1);
      let s, jumped = false;
      const box = prev ? { x: prev.x, y: prev.y, r: 4 * expectPx + 40 } : null;
      try { s = await starPos(2, box); }
      catch (e) { if (!allowJump || !prev) throw e; s = await starPos(2, null); jumped = true; }
      const jump = prev ? Math.hypot(s.x - prev.x, s.y - prev.y) : 0;
      if (jump > 4 * expectPx + 12) {
        if (!allowJump) throw new Error(`the star jumped ${jump.toFixed(0)} px in one ${r.stepMs} ms step -- PHD2 probably picked a different star, or the mount was knocked. Stopped.`);
        jumped = true;
      }
      const q = { i: i++, t: Date.now(), leg, dir, cmdMs: cmd, x: s.x, y: s.y, effort: eff, alongArcsec: 0 };
      if (!ref) ref = q;
      // A jump re-references: this point carries the previous point's value,
      // and everything after it is measured from here. The trace stays continuous.
      if (jumped) { q.reref = true; q.note = "re-referenced (star jump)"; }
      r.points.push(q);
      st.reproject2();
      csvLine(r, q);
      return { q, jumped };
    },
    // projection that honours re-references: each point is measured from the
    // most recent re-reference point before it
    reproject2() {
      if (!ref) return;
      let base = { x: ref.x, y: ref.y, along: 0 };
      for (let j = 0; j < r.points.length; j++) {
        const q = r.points[j];
        if (q.reref) {
          const prev = r.points[j - 1];
          base = { x: q.x, y: q.y, along: prev ? prev.alongArcsec : 0 };
          q.alongArcsec = base.along;
        } else {
          q.alongArcsec = base.along + ((q.x - base.x) * ux + (q.y - base.y) * uy) * r.scale;
        }
      }
    },
  };
  return st;
}

// Slack for one reversal leg: commanded time minus what the travel accounts for.
function scoreLeg(r, pts, start, dirSign) {
  const end = pts.at(-1);
  const legMs = pts.length * r.stepMs;
  const rate = r.rate / 1000;                                   // arcsec per ms
  const scatter = 0.4 * r.scale;                                // centroid noise, generous
  const travel = (end.alongArcsec - start.alongArcsec) * dirSign;
  const saturated = travel < 3 * scatter + rate * r.stepMs;     // less than ~one step of real motion
  const lostMs = saturated ? legMs : Math.max(0, legMs - travel / rate);
  let firstMoveAfterMs = null;
  for (const q of pts) {
    if ((q.alongArcsec - start.alongArcsec) * dirSign > Math.max(3 * scatter, 0.6 * rate * r.stepMs)) {
      firstMoveAfterMs = Math.abs(q.cmdMs - start.cmdMs); break;
    }
  }
  // springiness: the rate once moving, fitted to the second half of the leg
  const tail = pts.slice(Math.floor(pts.length / 2));
  let fitted = null;
  if (tail.length >= 3) {
    const n = tail.length, mx = tail.reduce((s, q) => s + q.cmdMs, 0) / n, my = tail.reduce((s, q) => s + q.alongArcsec, 0) / n;
    const sxx = tail.reduce((s, q) => s + (q.cmdMs - mx) ** 2, 0);
    if (sxx) fitted = Math.abs(tail.reduce((s, q) => s + (q.cmdMs - mx) * (q.alongArcsec - my), 0) / sxx) * 1000;
  }
  return { legMs, travelArcsec: +travel.toFixed(2), lostMs: Math.round(lostMs), lostArcsec: +(lostMs * rate).toFixed(1),
           saturated, firstMoveAfterMs, fittedRate: fitted == null ? null : +fitted.toFixed(2) };
}

async function measure(r) {
  await prepare(r);
  const S = makeStepper(r);
  const K = r.steps;
  r.message = "reading the start position";
  await S.sample(0, "-", null, { allowJump: false });
  const legs = [[1, r.fwd, K, +1], [2, r.back, 2 * K, -1], [3, r.fwd, K, +1]];
  for (const [leg, dir, n, sgn] of legs) {
    for (let k = 0; k < n; k++) {
      if (stopAsked) throw new Error("stopped by you");
      r.message = `leg ${leg} (${dir}) step ${k + 1} of ${n}`;
      const eff = await S.pulse(dir, sgn);
      await S.sample(leg, dir, eff, { allowJump: false });
      if (leg === 1) { S.learn(); S.reproject2(); }
    }
  }
  if (!S.learned) throw new Error("the star hardly moved on the first leg -- the slack is longer than the whole leg. Use more steps or longer steps.");
  const P = r.points, legPts = (n) => P.filter((q) => q.leg === n);
  const r1 = scoreLeg(r, legPts(2), legPts(1).at(-1), -1);
  const r2 = scoreLeg(r, legPts(3), legPts(2).at(-1), +1);
  const eff = (n) => { const v = legPts(n).map((q) => q.effort).filter((e) => e != null); return v.length ? +(v.reduce((s, e) => s + Math.abs(e), 0) / v.length).toFixed(1) : null; };
  const both = [r1, r2].filter((x) => !x.saturated);
  r.result = { reversal1: { ...r1, from: r.fwd, to: r.back, effort: eff(2) }, reversal2: { ...r2, from: r.back, to: r.fwd, effort: eff(3) },
               averageMs: both.length === 2 ? Math.round((r1.lostMs + r2.lostMs) / 2) : null,
               preloadFittedRate: scoreLeg(r, legPts(1), P[0], +1).fittedRate };
}

async function live(r) {
  await prepare(r);
  const S = makeStepper(r);
  const L = r.legSteps;
  const maxMs = 45 * 60 * 1000;                                   // a live session ends itself after 45 min
  r.message = "reading the start position";
  await S.sample(0, "-", null, { allowJump: false });
  let leg = 0, dir = r.fwd, sgn = +1, legStart = r.points[0], legBroken = false;
  while (!stopAsked) {
    if (Date.now() - Date.parse(r.started) > maxMs) { r.message = "45 minutes -- live session ended itself"; break; }
    leg++;
    legBroken = false;
    for (let k = 0; k < L && !stopAsked; k++) {
      r.message = `leg ${leg} ${dir}, step ${k + 1} of ${L}`;
      const eff = await S.pulse(dir, sgn);
      const { jumped } = await S.sample(leg, dir, eff, { allowJump: true });
      if (jumped) { legBroken = true; r.events.push({ t: Date.now(), leg, what: "star jumped -- re-referenced; this leg is not scored" }); }
      if (leg === 1) { S.learn(); S.reproject2(); }
    }
    if (stopAsked) break;
    const pts = r.points.filter((q) => q.leg === leg);
    if (leg === 1 && !S.learned) throw new Error("the star hardly moved on the first leg -- the slack is longer than the leg. Use more steps per leg.");
    if (leg >= 2 && !legBroken && pts.length === L) {
      const s = scoreLeg(r, pts, legStart, sgn);
      const effs = pts.map((q) => q.effort).filter((e) => e != null);
      const rev = { n: r.reversals.length + 1, t: Date.now(), from: sgn > 0 ? r.back : r.fwd, to: dir, ...s,
                    effort: effs.length ? +(effs.reduce((a, e) => a + Math.abs(e), 0) / effs.length).toFixed(1) : null };
      // pair average with the previous reversal (opposite direction): steady drift along the axis cancels
      const prev = r.reversals.at(-1);
      rev.pairMs = prev && !prev.saturated && !s.saturated && prev.to !== rev.to ? Math.round((prev.lostMs + s.lostMs) / 2) : null;
      r.reversals.push(rev);
    }
    legStart = r.points.at(-1);
    dir = dir === r.fwd ? r.back : r.fwd; sgn = -sgn;
  }
  // bring the pointing roughly back: one leg the way that returns toward start
  const net = S.cmd;
  if (Math.abs(net) >= r.stepMs && !stopHard) {
    r.message = "returning toward the start position";
    const d = net > 0 ? r.back : r.fwd, s = net > 0 ? -1 : +1;
    for (let k = 0; k < Math.round(Math.abs(net) / r.stepMs) && !stopHard; k++) await S.pulse(d, s);
  }
  const ok = r.reversals.filter((x) => !x.saturated);
  r.result = { reversals: r.reversals.length, medianMs: ok.length ? ok.map((x) => x.lostMs).sort((a, b) => a - b)[Math.floor(ok.length / 2)] : null };
}

let stopHard = false;
async function start(mode, p) {
  if (run && run.state === "running") throw new Error("a run is already going");
  stopAsked = false; stopHard = false;
  run = newRun(mode, p);
  const r = run;
  (async () => {
    try {
      if (mode === "measure") await measure(r); else await live(r);
      r.state = "done"; if (mode === "measure" || !r.message.startsWith("45")) r.message = stopAsked ? "stopped" : "finished";
    } catch (e) {
      r.state = stopAsked ? "stopped" : "failed"; r.message = e.message;
    } finally {
      r.finished = new Date().toISOString();
      try { if (r.csv) fs.appendFileSync(r.csv, `# result ${JSON.stringify(r.result)}\n`); } catch {}
    }
  })();
}

// ------------------------------------------------------------------- HTTP --
function readBody(req) {
  return new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on("end", () => resolve(b)); });
}
function send(res, code, type, body) { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); }
const json = (res, obj, code = 200) => send(res, code, "application/json", JSON.stringify(obj));

function validate(p) {
  const out = {
    axis: p.axis === "ra" ? "ra" : "dec",
    stepMs: Math.round(Number(p.stepMs)), steps: Math.round(Number(p.steps)), legSteps: Math.round(Number(p.legSteps)),
    rate: Number(p.rateX) * SIDEREAL, label: String(p.label || "").slice(0, 80),
  };
  if (!(out.stepMs >= 200 && out.stepMs <= 3000)) throw new Error("step must be 200-3000 ms");
  if (!(out.steps >= 4 && out.steps <= 40)) throw new Error("steps must be 4-40");
  if (!(out.legSteps >= 4 && out.legSteps <= 30)) throw new Error("steps per leg must be 4-30");
  if (!(Number(p.rateX) >= 0.1 && Number(p.rateX) <= 2)) throw new Error("guide rate must be 0.1-2.0 x sidereal");
  return out;
}

const server = http.createServer(async (req, res) => {
  // This computer only: the server listens on 127.0.0.1, and this refuses any
  // page from another site trying to drive it (DNS rebinding / CSRF).
  const host = String(req.headers.host || "");
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, "text/plain", "local use only");
  const u = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) return send(res, 200, "text/html; charset=utf-8", ASSETS.page);
    if (req.method === "GET" && u.pathname === "/api/sample") return send(res, 200, "application/json", ASSETS.sample);
    if (req.method === "GET" && u.pathname === "/api/status") return json(res, { version: VERSION, dataDir: DATA_DIR, gemini: !!gemini.host, ...(await checkPhd2()) });
    if (req.method === "GET" && u.pathname === "/api/run") return json(res, run || { state: "none" });
    if (req.method === "POST") {
      if (req.headers["x-backlash"] !== "1") return send(res, 403, "text/plain", "missing header");
      const body = JSON.parse((await readBody(req)) || "{}");
      if (u.pathname === "/api/start") { await start(body.mode === "live" ? "live" : "measure", validate(body)); return json(res, { ok: true }); }
      if (u.pathname === "/api/stop") { stopAsked = true; if (body.hard) stopHard = true; return json(res, { ok: true }); }
      if (u.pathname === "/api/loop") { await phd2.call("loop"); return json(res, { ok: true }); }
      if (u.pathname === "/api/gemini") {
        gemini = { host: String(body.host || "").trim(), user: String(body.user || "admin"), pass: String(body.pass || "") };
        if (gemini.host && !/^[\w.-]+$/.test(gemini.host)) { gemini.host = ""; throw new Error("host must be an address like 192.168.1.150"); }
        const v = gemini.host ? await geminiEffort("dec") : null;
        return json(res, { ok: !gemini.host || v != null, reading: v });
      }
    }
    if (req.method === "GET" && u.pathname === "/api/csv" && run && run.csv) {
      return send(res, 200, "text/csv", fs.readFileSync(run.csv, "utf8"));
    }
    send(res, 404, "text/plain", "not found");
  } catch (e) { json(res, { error: e.message }, 400); }
});

function openBrowser(url) {
  const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { console.log(`Already running? Opening http://localhost:${PORT}`); openBrowser(`http://localhost:${PORT}`); setTimeout(() => process.exit(0), 1500); }
  else { console.error(e.message); process.exit(1); }
});
server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Backlash Tool ${VERSION}`);
  console.log(`  page:   ${url}`);
  console.log(`  PHD2:   ${PHD2_HOST}:${PHD2_PORT}`);
  console.log(`  saves:  ${DATA_DIR}`);
  console.log(`  Close this window to quit.`);
  if (!process.env.BACKLASH_NO_BROWSER) openBrowser(url);
});

module.exports = { scoreLeg };
