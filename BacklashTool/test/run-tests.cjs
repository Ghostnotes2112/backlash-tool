// End-to-end tests against the mock PHD2. Known slack in, measured slack out.
//   node test/run-tests.cjs            (from source)
//   node test/run-tests.cjs --exe dist/BacklashTool-win-x64.exe
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const exeArg = process.argv.indexOf("--exe");
const EXE = exeArg > 0 ? path.resolve(process.argv[exeArg + 1]) : null;
const APP_PORT = 17171, MOCK_PORT = 14401;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "backlash-test-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const results = [];
const check = (name, pass, detail = "") => { results.push({ name, pass: !!pass }); console.log(`${pass ? "  ok  " : "  FAIL"}  ${name}${detail ? "   [" + detail + "]" : ""}`); };

function req(method, p, body, headers = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: APP_PORT, path: p, method,
      headers: { "Content-Type": "application/json", Host: `localhost:${APP_PORT}`, ...headers } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ code: res.statusCode, body: b, json: j }); });
    });
    r.on("error", (e) => resolve({ code: 0, body: e.message }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const post = (p, body) => req("POST", p, body, { "X-Backlash": "1" });

async function startMock(env) {
  const m = spawn(process.execPath, [path.join(__dirname, "mock-phd2.cjs")], { env: { ...process.env, MOCK_PORT: String(MOCK_PORT), ...env }, stdio: "ignore" });
  procs.push(m); await sleep(500); return m;
}
async function startApp() {
  const env = { ...process.env, PHD2_PORT: String(MOCK_PORT), BACKLASH_PORT: String(APP_PORT), BACKLASH_NO_BROWSER: "1",
                BACKLASH_DATA: DATA, BACKLASH_SETTLE_MS: "60" };
  const a = EXE ? spawn(EXE, [], { env, stdio: "ignore" }) : spawn(process.execPath, [path.join(ROOT, "src", "app.cjs")], { env, stdio: "ignore" });
  procs.push(a);
  for (let i = 0; i < 40; i++) { await sleep(250); if ((await req("GET", "/api/status")).code === 200) return a; }
  throw new Error("app did not start");
}
const kill = (p) => { try { p.kill(); } catch {} };
async function waitDone(limitMs = 240000) {
  const t = Date.now();
  while (Date.now() - t < limitMs) { const r = (await req("GET", "/api/run")).json; if (r && r.state !== "running") return r; await sleep(500); }
  return (await req("GET", "/api/run")).json;
}
const base = { axis: "dec", stepMs: 750, steps: 12, legSteps: 8, rateX: 0.5 };

(async () => {
  try {
    // ---- 1. measure, known slack ----
    let mock = await startMock({ MOCK_SLACK_MS: "3700" });
    let app = await startApp();
    const page = await req("GET", "/");
    check("page served", page.code === 200 && /Backlash/.test(page.body));
    check("sample data served", (await req("GET", "/api/sample")).json?.before?.length > 40);
    check("POST without the header refused", (await req("POST", "/api/start", base)).code === 403);
    check("foreign Host header refused", (await req("GET", "/api/status", null, { Host: "evil.example:7171" })).code === 403);
    check("bad step refused", (await post("/api/start", { ...base, stepMs: 50 })).json?.error?.includes("step"));
    let st = await req("GET", "/api/status");
    check("status reads PHD2", st.json?.phd2 === true && st.json?.scale === 0.604, JSON.stringify(st.json?.problems));
    await post("/api/start", { ...base, mode: "measure" });
    check("second start while running refused", (await post("/api/start", { ...base, mode: "measure" })).json?.error?.includes("already"));
    let r = await waitDone();
    const a1 = r.result?.reversal1?.lostMs, a2 = r.result?.reversal2?.lostMs;
    check("measure finished", r.state === "done", r.message);
    check("reversal 1 within 10% of the true 3700 ms", Math.abs(a1 - 3700) < 370, `${a1} ms`);
    check("reversal 2 within 10% of the true 3700 ms", Math.abs(a2 - 3700) < 370, `${a2} ms`);
    check("CSV written", r.csv && fs.existsSync(r.csv) && fs.readFileSync(r.csv, "utf8").split("\n").length > 48);
    kill(app); kill(mock); await sleep(400);

    // ---- 2. springiness: the mount moves 10% slow once going; scoring stays at the SET rate ----
    mock = await startMock({ MOCK_SLACK_MS: "2000", MOCK_RATE_FACTOR: "0.9" });
    app = await startApp();
    await post("/api/start", { ...base, mode: "measure" });
    r = await waitDone();
    check("fitted rate reported separately (~6.8\"/s)", Math.abs((r.result?.reversal1?.fittedRate ?? 0) - 6.77) < 0.6, `${r.result?.reversal1?.fittedRate}`);
    kill(app); kill(mock); await sleep(400);

    // ---- 3. slack longer than the leg ----
    mock = await startMock({ MOCK_SLACK_MS: "12000" });
    app = await startApp();
    await post("/api/start", { ...base, steps: 6, mode: "measure" });
    r = await waitDone();
    check("slack longer than the leg is reported, not mis-measured", r.state === "failed" && /longer than/.test(r.message) || r.result?.reversal1?.saturated, r.message);
    kill(app); kill(mock); await sleep(400);

    // ---- 4. live adjust, and a knocked mount ----
    mock = await startMock({ MOCK_SLACK_MS: "3000", MOCK_JUMP_AFTER: "60" });
    app = await startApp();
    await post("/api/start", { ...base, mode: "live" });
    for (let i = 0; i < 600; i++) { await sleep(500); const x = (await req("GET", "/api/run")).json; if ((x.reversals?.length ?? 0) >= 6) break; }
    await post("/api/stop", {});
    r = await waitDone();
    const good = (r.reversals || []).filter((x) => !x.saturated);
    const med = good.map((x) => x.lostMs).sort((a, b) => a - b)[Math.floor(good.length / 2)];
    check("live: a slack figure after every reversal", good.length >= 5, `${good.length} reversals`);
    check("live: median within 12% of the true 3000 ms", Math.abs(med - 3000) < 360, `${med} ms`);
    check("live: the jump re-referenced instead of stopping", (r.events || []).some((e) => /jumped/.test(e.what)) && r.state === "done", r.message);
    check("live: pair averages present", good.some((x) => x.pairMs != null));
    kill(app); kill(mock); await sleep(400);

    // ---- 5. refuses while PHD2 is guiding ----
    mock = await startMock({ MOCK_STATE: "Guiding" });
    app = await startApp();
    await post("/api/start", { ...base, mode: "measure" });
    r = await waitDone(10000);
    check("refuses while PHD2 is guiding", r.state === "failed" && /GUIDING/.test(r.message), r.message);
    kill(app); kill(mock);
  } catch (e) {
    check("test harness", false, e.message);
  } finally {
    procs.forEach(kill);
    const bad = results.filter((x) => !x.pass).length;
    console.log(bad ? `\n${bad} FAILED` : `\nall ${results.length} passed`);
    process.exitCode = bad ? 1 : 0;
  }
})();
