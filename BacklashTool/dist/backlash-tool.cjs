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
const __ASSETS__ = {"page":"<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Backlash Tool</title>\n<style>\n  /* Night palette: dark always, so it does not wreck dark adaptation at the mount. */\n  :root { --bg:#0b0b0e; --panel:#15151b; --line:#2a2a34; --ink:#dcdce4; --dim:#8a8a98;\n          --ok:#4ea36a; --warn:#d09a34; --bad:#d0504a; --star:#e8aa4c; --rev:#5f95cc; --acc:#b58ad6; --call:#ff7a59; }\n  body.red { --bg:#0a0000; --panel:#140303; --line:#3a0d0d; --ink:#e05a4a; --dim:#a03a30; --ok:#d04a3a; --warn:#e06a4a;\n             --bad:#ff5040; --star:#ff6a4a; --rev:#c03a2a; --acc:#e0503a; --call:#ff8a6a; }\n  * { box-sizing:border-box; }\n  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,-apple-system,\"Segoe UI\",sans-serif; }\n  header { display:flex; align-items:center; gap:1rem; flex-wrap:wrap; padding:.7rem 1rem; border-bottom:1px solid var(--line); }\n  h1 { font-size:1.05rem; margin:0; letter-spacing:.03em; }\n  nav { display:flex; gap:.25rem; flex-wrap:wrap; }\n  nav button { background:none; border:1px solid transparent; color:var(--dim); padding:.35rem .75rem; border-radius:7px; font:inherit; cursor:pointer; }\n  nav button.on { color:var(--ink); border-color:var(--line); background:var(--panel); }\n  .spacer { flex:1; }\n  .tiny { font-size:.8rem; color:var(--dim); }\n  main { padding:1rem; max-width:1150px; margin:0 auto; }\n  .tab { display:none; } .tab.on { display:grid; gap:.9rem; }\n  section { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.9rem 1rem; min-width:0; }\n  h2 { font-size:.72rem; letter-spacing:.13em; text-transform:uppercase; color:var(--dim); margin:0 0 .6rem; font-weight:600; }\n  h3 { font-size:1rem; margin:1.2rem 0 .4rem; }\n  .row { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:.9rem; }\n  label { display:block; font-size:.82rem; color:var(--dim); margin-bottom:.15rem; }\n  input, select { width:100%; background:var(--bg); color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:.4rem .5rem; font:inherit; }\n  .btns { display:flex; gap:.6rem; flex-wrap:wrap; align-items:center; }\n  button.go { background:var(--ok); color:#06120a; border:0; border-radius:7px; padding:.55rem 1.1rem; font:600 15px system-ui,sans-serif; cursor:pointer; }\n  button.stop { background:var(--bad); color:#170606; border:0; border-radius:7px; padding:.55rem 1.1rem; font:600 15px system-ui,sans-serif; cursor:pointer; }\n  button.plain { background:none; color:var(--ink); border:1px solid var(--line); border-radius:7px; padding:.5rem .9rem; font:inherit; cursor:pointer; }\n  button:disabled { opacity:.4; cursor:default; }\n  .big { font-size:1.7rem; font-weight:650; font-variant-numeric:tabular-nums; }\n  .huge { font-size:3rem; font-weight:700; font-variant-numeric:tabular-nums; line-height:1.1; }\n  .ok{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)} .dim{color:var(--dim)}\n  svg { display:block; width:100%; height:auto; }\n  .grid line { stroke:var(--line); stroke-width:1; }\n  .lbl { fill:var(--dim); font-size:12px; font-family:system-ui,sans-serif; }\n  .tr-star { fill:none; stroke:var(--star); stroke-width:2.5; stroke-linejoin:round; }\n  .tr-before { fill:none; stroke:var(--dim); stroke-width:2; stroke-dasharray:6 4; }\n  .tr-ideal { fill:none; stroke:var(--dim); stroke-width:1; stroke-dasharray:2 4; }\n  .call circle { fill:var(--call); } .call text { fill:#120400; font:700 12px system-ui,sans-serif; }\n  .callline { stroke:var(--call); stroke-width:1.5; fill:none; }\n  .brk { stroke:var(--call); stroke-width:2; fill:none; }\n  table { border-collapse:collapse; width:100%; font-size:.92rem; }\n  td, th { text-align:left; padding:.3rem .5rem; border-bottom:1px solid var(--line); vertical-align:top; }\n  th { color:var(--dim); font-weight:500; }\n  ol.callouts { margin:.4rem 0 0; padding-left:0; list-style:none; counter-reset:c; }\n  ol.callouts li { counter-increment:c; margin:.45rem 0; padding-left:2.1rem; position:relative; }\n  ol.callouts li::before { content:counter(c); position:absolute; left:0; top:.05rem; width:1.45rem; height:1.45rem; border-radius:50%;\n       background:var(--call); color:#120400; font:700 12px/1.45rem system-ui,sans-serif; text-align:center; }\n  ol.callouts li.l::before { content:attr(data-n); }\n  .note { border-left:3px solid var(--warn); padding:.3rem .8rem; color:var(--ink); background:rgba(208,154,52,.07); border-radius:0 6px 6px 0; }\n  code { font-family:ui-monospace,Consolas,monospace; font-size:.9em; }\n  .checks li { margin:.25rem 0; }\n  .pill { display:inline-block; padding:.05rem .5rem; border-radius:99px; border:1px solid var(--line); font-size:.8rem; }\n  @media (max-width:600px) { .huge { font-size:2.2rem; } main { padding:.6rem; } }\n</style>\n</head>\n<body>\n<header>\n  <h1>BACKLASH TOOL</h1>\n  <nav id=\"nav\">\n    <button data-t=\"measure\" class=\"on\">Measure</button>\n    <button data-t=\"live\">Live adjust</button>\n    <button data-t=\"guide\">How to read it</button>\n    <button data-t=\"about\">About</button>\n  </nav>\n  <span class=\"spacer\"></span>\n  <span id=\"phd\" class=\"tiny\">PHD2: checking...</span>\n  <button class=\"plain\" id=\"redbtn\" title=\"red light for dark adaptation\">red</button>\n</header>\n<main>\n\n<!-- ============================================================ MEASURE == -->\n<div class=\"tab on\" id=\"t-measure\">\n  <section>\n    <h2>Setup</h2>\n    <div class=\"row\">\n      <div><label>Axis</label><select id=\"axis\"><option value=\"dec\">Declination (N / S)</option><option value=\"ra\">Right ascension (W / E)</option></select></div>\n      <div><label>Step (ms per pulse)</label><input id=\"stepMs\" type=\"number\" value=\"750\" min=\"200\" max=\"3000\" step=\"50\"></div>\n      <div><label>Steps (preload K; then 2K back, K forward)</label><input id=\"steps\" type=\"number\" value=\"12\" min=\"4\" max=\"40\"></div>\n      <div><label>Mount guide rate (&times; sidereal) <span id=\"rateAs\" class=\"tiny\"></span></label><input id=\"rateX\" type=\"number\" value=\"0.5\" min=\"0.1\" max=\"2\" step=\"0.05\"></div>\n      <div><label>Label (what you just changed)</label><input id=\"label\" maxlength=\"80\" placeholder=\"e.g. depth screw 1/60 turn in\"></div>\n    </div>\n    <ul class=\"checks tiny\">\n      <li>PHD2 open, <b>Tools &rarr; Enable Server</b> ticked, camera and mount connected.</li>\n      <li>PHD2 <b>looping</b> (not guiding) with a clear, unsaturated star near the middle of the frame.</li>\n      <li>Mount <b>tracking</b>. Pointed somewhere comfortable; keep the same pose for every run you compare.</li>\n      <li>For RA, point below about Dec 70&deg; &mdash; near the pole an RA pulse barely moves the star.</li>\n    </ul>\n    <div class=\"btns\">\n      <button class=\"go\" id=\"mStart\">Start measurement</button>\n      <button class=\"stop\" id=\"mStop\" disabled>Stop</button>\n      <button class=\"plain\" id=\"loopBtn\">Start PHD2 looping</button>\n      <span id=\"mErr\" class=\"bad\"></span>\n    </div>\n  </section>\n  <section class=\"row\">\n    <div><h2>State</h2><div id=\"mState\" class=\"big dim\">idle</div><div id=\"mMsg\" class=\"dim\"></div></div>\n    <div><h2>Run</h2><div id=\"mRun\" class=\"dim\">--</div></div>\n    <div><h2>Now</h2><div id=\"mNow\" class=\"dim\">--</div></div>\n  </section>\n  <section>\n    <h2>Star position against commanded pulse time &mdash; the flat stretches at the turns are the slack</h2>\n    <svg id=\"mChart\" viewBox=\"0 0 900 420\" role=\"img\" aria-label=\"star position against commanded pulse time\"></svg>\n  </section>\n  <section>\n    <h2>Result</h2>\n    <div id=\"mResult\" class=\"dim\">appears when the run finishes</div>\n  </section>\n</div>\n\n<!-- =============================================================== LIVE == -->\n<div class=\"tab\" id=\"t-live\">\n  <section>\n    <h2>Live adjust &mdash; turn a screw, see the slack change within a minute</h2>\n    <div class=\"row\">\n      <div><label>Steps per leg (one leg each way, then reverse)</label><input id=\"legSteps\" type=\"number\" value=\"8\" min=\"4\" max=\"30\"></div>\n      <div><label>Step / axis / guide rate</label><div class=\"tiny\" id=\"liveUses\">taken from the Measure tab</div></div>\n      <div><label>Leg length</label><div class=\"tiny\" id=\"legLen\"></div></div>\n    </div>\n    <p class=\"tiny\">Shuttles the axis back and forth: a short leg one way, a short leg back, forever. After <b>every</b> reversal it prints\n      the slack. Adjust between reversals and watch the number. If you knock the mount the star jumps &mdash; that leg is thrown away\n      and it carries on. It stops itself after 45 minutes. When you stop it, it steps back toward where it started.</p>\n    <div class=\"btns\">\n      <button class=\"go\" id=\"lStart\">Start live adjust</button>\n      <button class=\"stop\" id=\"lStop\" disabled>Stop</button>\n      <span id=\"lErr\" class=\"bad\"></span>\n    </div>\n  </section>\n  <section class=\"row\">\n    <div><h2>Last reversal</h2><div id=\"lLast\" class=\"huge dim\">--</div><div id=\"lLastSub\" class=\"dim\"></div></div>\n    <div><h2>Pair average</h2><div id=\"lPair\" class=\"huge dim\">--</div><div class=\"tiny\">last two reversals, opposite directions &mdash; drift cancels</div></div>\n    <div><h2>Effort (optional)</h2><div id=\"lEff\" class=\"huge dim\">--</div><div class=\"tiny\" id=\"lEffSub\">motor duty while moving &mdash; Gemini-II only (About tab)</div></div>\n  </section>\n  <section>\n    <h2>Slack after each reversal</h2>\n    <svg id=\"lChart\" viewBox=\"0 0 900 360\" role=\"img\" aria-label=\"slack per reversal over time\"></svg>\n    <div class=\"tiny\" id=\"lState\"></div>\n  </section>\n</div>\n\n<!-- ============================================================== GUIDE == -->\n<div class=\"tab\" id=\"t-guide\">\n  <section>\n    <h2>What the tool does</h2>\n    <p>A guide pulse turns the motor at the guide rate. If the gears have slack, the first part of every pulse <b>after a change of\n      direction</b> is spent closing the gap, and the star does not move. The tool pulses in small steps, finds the star after each\n      one, and works out how much commanded time the star's movement does <i>not</i> account for. That missing time is the slack.</p>\n    <p class=\"note\">slack (ms) = commanded time of the leg &minus; star travel &divide; guide rate</p>\n    <p>It needs nothing but PHD2. Any mount PHD2 can pulse-guide works &mdash; worm gears, spur gears, belts. The example below is a\n      Losmandy G11 declination axis, measured before and after adjusting its spring-loaded worm block on 4 November 2026.</p>\n  </section>\n\n  <section>\n    <h2>1 &middot; The Measure chart</h2>\n    <svg id=\"gChart\" viewBox=\"0 0 900 470\" role=\"img\" aria-label=\"annotated example backlash chart\"></svg>\n    <ol class=\"callouts\" id=\"gList\">\n      <li><b>Horizontal axis &mdash; commanded time.</b> Net seconds of guide pulse sent: rightward while pulsing North, back\n        leftward while pulsing South. It is what you <i>asked</i> the mount to do.</li>\n      <li><b>Vertical axis &mdash; where the star actually went</b>, in arcseconds along the axis being tested. Drift on the\n        other axis is removed automatically.</li>\n      <li><b>The dotted diagonal &mdash; a perfect mount.</b> No slack: the star would follow the command exactly and the trace\n        would lie on this line going out and coming back.</li>\n      <li><b>Leg 1, the preload.</b> Takes up whatever slack is in the train so that leg 2 starts from a known state. Its slope\n        is the real speed once things are moving.</li>\n      <li><b>The flat stretch after the first turn &mdash; this is the backlash.</b> The command reverses but the star stays put\n        while the motor turns through the gap. Its width, read on the horizontal axis, is the slack in milliseconds.</li>\n      <li><b>The sloped part of leg 2</b> &mdash; the gears are engaged again and the star moves at the guide rate. If this slope is\n        clearly shallower than the dotted line, something in the train is springy (see &ldquo;fitted rate&rdquo;).</li>\n      <li><b>The second turn</b>, back the other way. Same story; the two reversals should agree to within about 10%.</li>\n      <li><b>The gap at the end.</b> The command came back to zero but the star did not &mdash; it is short by about one slack.\n        A loop that is <i>wide</i> means lots of slack; a loop that collapses onto the diagonal means none.</li>\n      <li><b>Before and after.</b> The grey dashed trace is the same test before the adjustment. Its flat stretches are much\n        longer: about 6000 ms then, about 3800 ms after (the two brackets read 4.1 s and 3.5 s).</li>\n    </ol>\n  </section>\n\n  <section>\n    <h2>2 &middot; The result table</h2>\n    <table>\n      <tr><th>column</th><th>what it means</th></tr>\n      <tr><td>reversal</td><td>Which turn: North&rarr;South is leg 2, South&rarr;North is leg 3.</td></tr>\n      <tr><td><b>slack</b></td><td><b>The number to track.</b> Milliseconds of pulse lost at that turn, scored at the guide rate\n        you entered. Shown as &ldquo;&ge; whole leg&rdquo; when the star never got going &mdash; then use more steps.</td></tr>\n      <tr><td>on the sky</td><td>The same slack in arcseconds: what a guide correction loses at every reversal.</td></tr>\n      <tr><td>star moved</td><td>How far the star really travelled on that leg.</td></tr>\n      <tr><td>first clear move</td><td>How long into the leg the star was first clearly moving &mdash; a rough cross-check on the slack.</td></tr>\n      <tr><td>fitted rate</td><td>The speed measured once moving (&ldquo;springiness&rdquo;). Expect it within about 10% of the guide\n        rate. It is <i>shown</i>, not used: scoring against a fitted rate turned out to swing results by &plusmn;10% from run to run.</td></tr>\n      <tr><td>average</td><td>Mean of the two reversals. Compare this between adjustments.</td></tr>\n      <tr><td>effort</td><td>Only with a Gemini-II connected: motor duty while moving. If slack goes down but effort climbs, the\n        worm is binding &mdash; you have traded backlash for friction and a stall risk.</td></tr>\n    </table>\n  </section>\n\n  <section>\n    <h2>3 &middot; The Live adjust chart</h2>\n    <svg id=\"gLive\" viewBox=\"0 0 900 360\" role=\"img\" aria-label=\"annotated example live adjust chart\"></svg>\n    <ol class=\"callouts\">\n      <li><b>Each dot is one reversal</b>, plotted at the moment it finished. Orange: the turn going North&rarr;South;\n        blue: South&rarr;North.</li>\n      <li><b>The line is the pair average</b> of the last two reversals. It cancels slow drift along the axis (polar alignment),\n        which makes one direction read high and the other low. Watch the line, not single dots.</li>\n      <li><b>An adjustment.</b> You turned a screw here. Within one or two reversals the dots settle at a new level.</li>\n      <li><b>A star jump.</b> Someone touched the mount; that leg is not scored, and the run carries on.</li>\n      <li><b>Effort bars</b> (Gemini-II only) under each reversal. A sudden rise is the warning to back off.</li>\n    </ol>\n  </section>\n\n  <section>\n    <h2>Why not just watch PHD2's guide graph?</h2>\n    <p>It seems as if you could adjust while guiding and watch the declination line. In practice the graph cannot show this:</p>\n    <ul>\n      <li><b>Guiding hides the slack.</b> PHD2 is busy correcting; a reversal shows up as a small overshoot mixed with seeing,\n        not as a number of milliseconds.</li>\n      <li><b>Reversals are rare.</b> A well-aligned mount may reverse declination a few times an hour, so you would wait a long\n        time between readings. Live adjust forces a reversal every 20&ndash;30 seconds.</li>\n      <li><b>Everything is mixed together</b> &mdash; seeing, drift, periodic error, dithers, backlash compensation. The tool moves\n        one axis on purpose and measures only that.</li>\n    </ul>\n  </section>\n\n  <section>\n    <h2>A good adjusting session</h2>\n    <ol>\n      <li>Run <b>Measure</b> once to get a starting number. Note the pose (where the scope points) &mdash; keep it the same.</li>\n      <li>Switch to <b>Live adjust</b>. Make one small change at a time (a fraction of a turn), then wait for two or three reversals.</li>\n      <li>Watch effort, if you have it, and listen to the mount. Smaller slack with rising effort is a worse mount, not a better one.</li>\n      <li>When the pair average stops improving, back off slightly and run <b>Measure</b> again to record the final number.</li>\n      <li>Check cold: gear trains tighten as they cool. Adjusting warm and running cold is a classic way to get stalls.</li>\n      <li>Then let your guiding software set its backlash compensation from its own test (PHD2 Guiding Assistant).</li>\n    </ol>\n    <p class=\"note\">Run-to-run spread is about &plusmn;10% even when nothing changed. Do not chase a 5% difference; repeat the run.</p>\n  </section>\n</div>\n\n<!-- ============================================================== ABOUT == -->\n<div class=\"tab\" id=\"t-about\">\n  <section>\n    <h2>About</h2>\n    <p>Backlash Tool <span id=\"ver\"></span>. Runs on this computer only (it listens on 127.0.0.1) and talks to PHD2's server on\n      port 4400. It sends guide pulses and nothing else; it refuses to run while PHD2 is guiding.</p>\n    <p>Every run is saved as a CSV in <code id=\"dataDir\"></code>.</p>\n    <p class=\"tiny\">Settings for unusual setups can be given as environment variables: <code>PHD2_HOST</code>, <code>PHD2_PORT</code>,\n      <code>BACKLASH_PORT</code>, <code>BACKLASH_DATA</code>.</p>\n  </section>\n  <section>\n    <h2>Optional: Losmandy Gemini-II motor effort</h2>\n    <p class=\"tiny\">Reads the controller's own Servo feed (<code>/motor.cgx</code>, read only) to show motor duty beside each reversal\n      as a friction warning. Kept in memory only; nothing is saved.</p>\n    <div class=\"row\">\n      <div><label>Gemini address</label><input id=\"gHost\" placeholder=\"192.168.1.150\"></div>\n      <div><label>User</label><input id=\"gUser\" value=\"admin\"></div>\n      <div><label>Password</label><input id=\"gPass\" type=\"password\"></div>\n    </div>\n    <div class=\"btns\" style=\"margin-top:.6rem\"><button class=\"plain\" id=\"gSave\">Connect</button><span id=\"gMsg\" class=\"tiny\"></span></div>\n  </section>\n</div>\n</main>\n\n<script>\n\"use strict\";\nconst NS = \"http://www.w3.org/2000/svg\";\nconst $ = (id) => document.getElementById(id);\nconst esc = (s) => String(s ?? \"\").replace(/[&<>\"]/g, (c) => ({ \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", '\"': \"&quot;\" }[c]));\nconst el = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };\nconst SIDEREAL = 15.0411;\n\n// ---- tabs, red light ----\nfor (const b of document.querySelectorAll(\"#nav button\")) b.onclick = () => {\n  document.querySelectorAll(\"#nav button\").forEach((x) => x.classList.toggle(\"on\", x === b));\n  document.querySelectorAll(\".tab\").forEach((t) => t.classList.toggle(\"on\", t.id === \"t-\" + b.dataset.t));\n  try { localStorage.setItem(\"tab\", b.dataset.t); } catch {}\n};\ntry { const t = location.hash.slice(1) || localStorage.getItem(\"tab\"); if (t) document.querySelector(`#nav button[data-t=\"${t}\"]`)?.click(); } catch {}\n$(\"redbtn\").onclick = () => { document.body.classList.toggle(\"red\"); try { localStorage.setItem(\"red\", document.body.classList.contains(\"red\") ? \"1\" : \"\"); } catch {} };\ntry { if (localStorage.getItem(\"red\")) document.body.classList.add(\"red\"); } catch {}\n\n// ---- settings ----\nconst fields = [\"axis\", \"stepMs\", \"steps\", \"rateX\", \"legSteps\"];\ntry { const s = JSON.parse(localStorage.getItem(\"settings\") || \"{}\"); for (const f of fields) if (s[f] != null) $(f).value = s[f]; } catch {}\nfunction settings() {\n  const s = Object.fromEntries(fields.map((f) => [f, $(f).value])); s.label = $(\"label\").value;\n  try { localStorage.setItem(\"settings\", JSON.stringify(s)); } catch {}\n  return s;\n}\nfunction showDerived() {\n  const rate = Number($(\"rateX\").value) * SIDEREAL;\n  $(\"rateAs\").textContent = isFinite(rate) ? `= ${rate.toFixed(2)}\"/s` : \"\";\n  const leg = Number($(\"legSteps\").value) * Number($(\"stepMs\").value);\n  $(\"legLen\").textContent = `${leg} ms commanded per leg -- must be longer than the slack (start at about 1.5x your Measure result)`;\n  $(\"liveUses\").textContent = `${$(\"stepMs\").value} ms steps, ${$(\"axis\").value.toUpperCase()}, ${rate.toFixed(2)}\"/s`;\n}\nfields.forEach((f) => $(f).addEventListener(\"input\", showDerived)); showDerived();\n\nasync function api(path, body) {\n  const r = await fetch(path, body ? { method: \"POST\", headers: { \"Content-Type\": \"application/json\", \"X-Backlash\": \"1\" }, body: JSON.stringify(body) } : { cache: \"no-store\" });\n  const j = await r.json().catch(() => ({}));\n  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);\n  return j;\n}\n$(\"mStart\").onclick = async () => { $(\"mErr\").textContent = \"\"; try { await api(\"/api/start\", { ...settings(), mode: \"measure\" }); } catch (e) { $(\"mErr\").textContent = e.message; } };\n$(\"lStart\").onclick = async () => { $(\"lErr\").textContent = \"\"; try { await api(\"/api/start\", { ...settings(), mode: \"live\" }); } catch (e) { $(\"lErr\").textContent = e.message; } };\n$(\"mStop\").onclick = $(\"lStop\").onclick = () => api(\"/api/stop\", {}).catch(() => {});\n$(\"loopBtn\").onclick = () => api(\"/api/loop\", {}).then(() => { $(\"mErr\").textContent = \"\"; }).catch((e) => { $(\"mErr\").textContent = e.message; });\n$(\"gSave\").onclick = async () => {\n  try { const j = await api(\"/api/gemini\", { host: $(\"gHost\").value, user: $(\"gUser\").value, pass: $(\"gPass\").value });\n        $(\"gMsg\").textContent = !$(\"gHost\").value ? \"off\" : j.ok ? `connected -- reading ${j.reading}` : \"no reading -- check address and password\"; }\n  catch (e) { $(\"gMsg\").textContent = e.message; }\n};\n\n// ---- the trace chart, used live and in the guide ----\nfunction trace(svg, d, opt = {}) {\n  svg.replaceChildren();\n  const W = 900, H = opt.H ?? 420, L = 64, R = 18, T = 16, B = 46;\n  const span = d.steps * d.stepMs / 1000, rate = d.rate;\n  const all = [...(d.pts ?? []), ...(d.before ?? [])].map((p) => p[1]);\n  const ymin = Math.min(-span * rate * 0.55, ...all) - 3, ymax = Math.max(span * rate * 1.05, ...all) + 3;\n  const x = (s) => L + ((s + span) / (2 * span)) * (W - L - R);\n  const y = (v) => T + (1 - (v - ymin) / (ymax - ymin)) * (H - T - B);\n  const g = el(\"g\", { class: \"grid\" }); svg.append(g);\n  const yStep = Math.max(5, Math.ceil((ymax - ymin) / 6 / 5) * 5);\n  for (let v = Math.ceil(ymin / yStep) * yStep; v <= ymax; v += yStep) {\n    g.append(el(\"line\", { x1: L, x2: W - R, y1: y(v), y2: y(v) }));\n    svg.append(el(\"text\", { x: L - 8, y: y(v) + 4, \"text-anchor\": \"end\", class: \"lbl\" }, `${v}\"`));\n  }\n  const xStep = span > 12 ? 4 : 2;\n  for (let s = -Math.floor(span / xStep) * xStep; s <= span + 1e-6; s += xStep) {\n    g.append(el(\"line\", { x1: x(s), x2: x(s), y1: T, y2: H - B }));\n    svg.append(el(\"text\", { x: x(s), y: H - B + 18, \"text-anchor\": \"middle\", class: \"lbl\" }, `${s}`));\n  }\n  svg.append(el(\"text\", { x: (L + W - R) / 2, y: H - 8, \"text-anchor\": \"middle\", class: \"lbl\" }, `commanded ${d.fwd ?? \"N\"} (net seconds of guide pulse)`));\n  svg.append(el(\"text\", { x: 14, y: (T + H - B) / 2, \"text-anchor\": \"middle\", class: \"lbl\", transform: `rotate(-90 14 ${(T + H - B) / 2})` }, \"star position along the axis (arcsec)\"));\n  const clip = el(\"clipPath\", { id: svg.id + \"-c\" }); clip.append(el(\"rect\", { x: L, y: T, width: W - L - R, height: H - T - B })); svg.append(clip);\n  svg.append(el(\"polyline\", { \"clip-path\": `url(#${svg.id}-c)`, class: \"tr-ideal\", points: `${x(-span)},${y(-span * rate)} ${x(span)},${y(span * rate)}` }));\n  const line = (pts, cls) => { if (pts?.length) svg.append(el(\"polyline\", { class: cls, points: pts.map((p) => `${x(p[0] / 1000).toFixed(1)},${y(p[1]).toFixed(1)}`).join(\" \") })); };\n  line(d.before, \"tr-before\");\n  line(d.pts, \"tr-star\");\n  const last = d.pts?.at(-1);\n  if (last && !opt.guide) svg.append(el(\"circle\", { cx: x(last[0] / 1000), cy: y(last[1]), r: 5, fill: \"var(--star)\" }));\n  return { x, y, span, rate, L, R, T, B, W, H };\n}\nfunction callout(svg, n, cx, cy, lx, ly) {\n  if (lx != null) svg.append(el(\"line\", { x1: cx, y1: cy, x2: lx, y2: ly, class: \"callline\" }));\n  const g = el(\"g\", { class: \"call\" }); g.append(el(\"circle\", { cx: lx ?? cx, cy: ly ?? cy, r: 11 }));\n  g.append(el(\"text\", { x: lx ?? cx, y: (ly ?? cy) + 4, \"text-anchor\": \"middle\" }, String(n))); svg.append(g);\n}\n\n// ---- the live-adjust chart ----\nfunction liveChart(svg, revs, opt = {}) {\n  svg.replaceChildren();\n  const W = 900, H = 360, L = 64, R = 18, T = 16, B = 70;\n  if (!revs.length) { svg.append(el(\"text\", { x: W / 2, y: H / 2, \"text-anchor\": \"middle\", class: \"lbl\" }, \"reversals appear here\")); return null; }\n  const t0 = revs[0].t, tN = Math.max(revs.at(-1).t, t0 + 60000);\n  const vals = revs.filter((r) => !r.saturated).map((r) => r.lostMs);\n  const ymax = Math.max(1000, ...vals) * 1.15;\n  const x = (t) => L + ((t - t0) / (tN - t0)) * (W - L - R);\n  const y = (v) => T + (1 - v / ymax) * (H - T - B);\n  const g = el(\"g\", { class: \"grid\" }); svg.append(g);\n  const yStep = ymax > 6000 ? 2000 : ymax > 3000 ? 1000 : 500;\n  for (let v = 0; v <= ymax; v += yStep) { g.append(el(\"line\", { x1: L, x2: W - R, y1: y(v), y2: y(v) })); svg.append(el(\"text\", { x: L - 8, y: y(v) + 4, \"text-anchor\": \"end\", class: \"lbl\" }, `${v}`)); }\n  svg.append(el(\"text\", { x: 14, y: (T + H - B) / 2, \"text-anchor\": \"middle\", class: \"lbl\", transform: `rotate(-90 14 ${(T + H - B) / 2})` }, \"slack (ms)\"));\n  const mins = (tN - t0) / 60000, mStep = mins > 20 ? 5 : mins > 8 ? 2 : 1;\n  for (let m = 0; m <= mins + 1e-6; m += mStep) svg.append(el(\"text\", { x: x(t0 + m * 60000), y: H - B + 16, \"text-anchor\": \"middle\", class: \"lbl\" }, `${m} min`));\n  // effort bars along the bottom\n  const effs = revs.map((r) => r.effort).filter((e) => e != null);\n  if (effs.length) {\n    const emax = Math.max(...effs, 1);\n    for (const r of revs) if (r.effort != null) {\n      const h = (r.effort / emax) * 28;\n      svg.append(el(\"rect\", { x: x(r.t) - 4, y: H - 8 - h, width: 8, height: h, fill: \"var(--acc)\", opacity: .8 }));\n    }\n    svg.append(el(\"text\", { x: L - 8, y: H - 12, \"text-anchor\": \"end\", class: \"lbl\" }, \"effort\"));\n  }\n  const pair = revs.filter((r) => r.pairMs != null);\n  if (pair.length > 1) svg.append(el(\"polyline\", { points: pair.map((r) => `${x(r.t).toFixed(1)},${y(r.pairMs).toFixed(1)}`).join(\" \"), fill: \"none\", stroke: \"var(--ink)\", \"stroke-width\": 2 }));\n  for (const r of revs) {\n    const v = r.saturated ? ymax / 1.15 : r.lostMs;\n    svg.append(el(\"circle\", { cx: x(r.t), cy: y(v), r: 6, fill: r.to === \"S\" || r.to === \"E\" ? \"var(--star)\" : \"var(--rev)\", stroke: r.saturated ? \"var(--bad)\" : \"none\", \"stroke-width\": 3 }));\n  }\n  for (const e of opt.events ?? []) {\n    if (e.t < t0) continue;\n    svg.append(el(\"line\", { x1: x(e.t), x2: x(e.t), y1: T, y2: H - B, stroke: \"var(--bad)\", \"stroke-dasharray\": \"3 3\" }));\n  }\n  return { x, y };\n}\n\n// ---- live state ----\nfunction fmtMs(v) { return v.saturated ? `&ge; ${v.legMs} ms` : `${v.lostMs} ms`; }\nfunction showRun(d) {\n  const running = d.state === \"running\";\n  for (const id of [\"mStart\", \"lStart\", \"loopBtn\"]) $(id).disabled = running;\n  $(\"mStop\").disabled = $(\"lStop\").disabled = !running;\n  if (d.state === \"none\") return;\n  const cls = { running: \"warn\", done: \"ok\", failed: \"bad\", stopped: \"dim\" }[d.state] ?? \"dim\";\n  if (d.mode === \"measure\") {\n    $(\"mState\").textContent = d.state; $(\"mState\").className = `big ${cls}`;\n    $(\"mMsg\").textContent = d.message ?? \"\";\n    $(\"mRun\").innerHTML = `${esc(d.id)}<br>${esc(d.axis).toUpperCase()} &middot; ${d.steps} &times; ${d.stepMs} ms &middot; ${d.rate.toFixed(2)}\"/s` + (d.label ? `<br>${esc(d.label)}` : \"\");\n    const q = d.points.at(-1);\n    $(\"mNow\").innerHTML = q ? `star ${q.alongArcsec.toFixed(1)}\"<br>commanded ${(q.cmdMs / 1000).toFixed(2)} s` : \"--\";\n    trace($(\"mChart\"), { steps: d.steps, stepMs: d.stepMs, rate: d.rate, fwd: d.fwd, pts: d.points.map((q) => [q.cmdMs, q.alongArcsec]) });\n    const r = d.result;\n    if (r) {\n      const row = (v) => `<tr><td>${esc(v.from)} &rarr; ${esc(v.to)}</td><td class=\"${v.saturated ? \"bad\" : \"\"}\" style=\"font-size:1.25rem;font-weight:650\">${fmtMs(v)}</td>` +\n        `<td>${v.saturated ? \"whole leg\" : v.lostArcsec + '\"'}</td><td>${v.travelArcsec}\"</td><td>${v.firstMoveAfterMs ?? \"--\"} ms</td>` +\n        `<td>${v.fittedRate ?? \"--\"}\"/s</td><td>${v.effort ?? \"--\"}</td></tr>`;\n      $(\"mResult\").innerHTML = `<table><tr><th>reversal</th><th>slack</th><th>on the sky</th><th>star moved</th><th>first clear move</th><th>fitted rate</th><th>effort</th></tr>` +\n        row(r.reversal1) + row(r.reversal2) + `</table>` +\n        `<p class=\"big\">${r.averageMs != null ? `average ${r.averageMs} ms` : \"average: one reversal saturated -- re-run with more steps\"}</p>` +\n        `<p class=\"tiny\">Scored at the guide rate you entered, ${d.rate.toFixed(2)}\"/s. Saved: <code>${esc(d.csv)}</code></p>`;\n    } else $(\"mResult\").textContent = d.state === \"running\" ? \"appears when the run finishes\" : \"no result -- \" + (d.message ?? \"\");\n  } else {\n    $(\"lState\").innerHTML = `<span class=\"${cls}\">${esc(d.state)}</span> &middot; ${esc(d.message ?? \"\")}` + (d.events?.length ? ` &middot; ${d.events.length} star jump(s), not scored` : \"\");\n    const rv = d.reversals ?? [], last = rv.at(-1);\n    if (last) {\n      $(\"lLast\").innerHTML = last.saturated ? `&ge;${last.legMs}` : `${last.lostMs}<span class=\"tiny\"> ms</span>`;\n      $(\"lLast\").className = `huge ${last.saturated ? \"bad\" : \"\"}`;\n      $(\"lLastSub\").textContent = `${last.from} -> ${last.to}, reversal ${last.n}` + (last.saturated ? \" -- leg too short: use more steps per leg\" : \"\");\n      const p = rv.filter((r) => r.pairMs != null).at(-1);\n      $(\"lPair\").innerHTML = p ? `${p.pairMs}<span class=\"tiny\"> ms</span>` : \"--\"; $(\"lPair\").className = \"huge\";\n      $(\"lEff\").textContent = last.effort ?? \"--\";\n    }\n    liveChart($(\"lChart\"), rv, { events: d.events });\n  }\n}\n\nlet lastId = null;\nasync function tick() {\n  try {\n    const d = await api(\"/api/run\");\n    if (d.id && d.id !== lastId) { lastId = d.id; document.querySelector(`#nav button[data-t=\"${d.mode}\"]`)?.click(); }\n    showRun(d);\n  } catch { $(\"phd\").textContent = \"tool not responding -- is its window still open?\"; $(\"phd\").className = \"tiny bad\"; }\n}\nasync function status() {\n  try {\n    const s = await api(\"/api/status\");\n    $(\"ver\").textContent = s.version; $(\"dataDir\").textContent = s.dataDir;\n    const okState = s.phd2 && !s.problems.length;\n    $(\"phd\").textContent = s.phd2 ? `PHD2: ${s.state}${s.scale ? ` · ${s.scale.toFixed(3)}\"/px` : \"\"}${s.problems.length ? \" · \" + s.problems[0] : \"\"}` : s.problems[0];\n    $(\"phd\").className = `tiny ${okState ? \"ok\" : \"warn\"}`;\n  } catch {}\n}\nsetInterval(tick, 1000); tick();\nsetInterval(status, 4000); status();\n\n// ---- the illustrated guide, drawn from real data ----\nfetch(\"/api/sample\").then((r) => r.json()).then((S) => {\n  const svg = $(\"gChart\");\n  const after = S.after.map((p) => [p[0], p[1]]), before = S.before.map((p) => [p[0], p[1]]);\n  const k = trace(svg, { steps: S.steps, stepMs: S.stepMs, rate: S.rate, fwd: \"N\", pts: after, before }, { guide: true, H: 470 });\n  const legOf = (n) => S.after.filter((p) => p[2] === n);\n  const l1 = legOf(1), l2 = legOf(2), l3 = legOf(3);\n  const X = (ms) => k.x(ms / 1000), Y = k.y;\n  // The slack of each reversal, computed exactly as the tool scores it (at the\n  // guide rate), so the bracket's width IS the number the text talks about.\n  const turn = l1.at(-1), turn2 = l2.at(-1);\n  const lost = (legPts, from, sign) => legPts.length * S.stepMs - ((legPts.at(-1)[1] - from[1]) * sign) / (S.rate / 1000);\n  const lost2 = lost(l2, turn, -1), lost3 = lost(l3, turn2, +1);\n  callout(svg, 1, X(S.steps * S.stepMs * 0.55), k.H - k.B + 4, X(S.steps * S.stepMs * 0.55), k.H - k.B - 22);\n  callout(svg, 2, k.L, Y(0), k.L + 26, Y(0) - 32);\n  const dx = S.steps * S.stepMs * 0.3;                         // a clear stretch of the diagonal\n  callout(svg, 3, X(dx), Y(dx * S.rate / 1000), X(dx) - 34, Y(dx * S.rate / 1000) - 34);\n  const mid1 = l1[Math.floor(l1.length * 0.6)]; callout(svg, 4, X(mid1[0]), Y(mid1[1]), X(mid1[0]) + 34, Y(mid1[1]) + 30);\n  const bx1 = X(turn[0]), bx2 = X(turn[0] - lost2), by = Y(Math.max(...l2.map((p) => p[1]), turn[1])) - 16;\n  svg.append(el(\"path\", { class: \"brk\", d: `M${bx1},${by + 8} V${by} H${bx2} V${by + 8}` }));\n  svg.append(el(\"text\", { x: (bx1 + bx2) / 2 + 18, y: by - 22, class: \"lbl\", fill: \"var(--call)\" }, `slack ${(lost2 / 1000).toFixed(1)} s`));\n  callout(svg, 5, (bx1 + bx2) / 2, by, (bx1 + bx2) / 2, by - 26);\n  const mid2 = l2[Math.floor(l2.length * 0.7)]; callout(svg, 6, X(mid2[0]), Y(mid2[1]), X(mid2[0]) - 30, Y(mid2[1]) - 30);\n  const cx3a = X(turn2[0]), cx3b = X(turn2[0] + lost3), cy3 = Y(Math.min(...l3.map((p) => p[1]), turn2[1])) + 16;\n  svg.append(el(\"path\", { class: \"brk\", d: `M${cx3a},${cy3 - 8} V${cy3} H${cx3b} V${cy3 - 8}` }));\n  svg.append(el(\"text\", { x: cx3b + 6, y: cy3 + 4, class: \"lbl\", fill: \"var(--call)\" }, `slack ${(lost3 / 1000).toFixed(1)} s`));\n  callout(svg, 7, (cx3a + cx3b) / 2, cy3, (cx3a + cx3b) / 2, cy3 + 26);\n  const end = l3.at(-1); svg.append(el(\"line\", { x1: X(0), y1: Y(0), x2: X(end[0]), y2: Y(end[1]), class: \"callline\", \"stroke-dasharray\": \"4 3\" }));\n  callout(svg, 8, X(end[0]), Y(end[1]), X(end[0]) + 30, Y(end[1]) + 30);\n  const b2 = S.before.filter((p) => p[2] === 2), bm = b2[Math.floor(b2.length * 0.6)];\n  callout(svg, 9, X(bm[0]), Y(bm[1]), X(bm[0]) - 30, Y(bm[1]) - 34);\n\n  // example live chart: synthetic, clearly so -- 12 minutes, an adjustment at 5 min, a knock at 9 min\n  const t0 = Date.now(), revs = [];\n  let lvl = 5200;\n  for (let i = 0; i < 28; i++) {\n    const t = t0 + i * 26000;\n    if (i === 11) lvl = 3800;\n    const drift = i % 2 ? 260 : -260, noise = ((i * 7919) % 11 - 5) * 40;\n    const to = i % 2 ? \"N\" : \"S\";\n    if (i === 20) continue;                                     // the knocked leg is not scored\n    const lost = Math.round(lvl + drift + noise);\n    const prev = revs.at(-1);\n    revs.push({ t, to, lostMs: lost, saturated: false, effort: i < 11 ? 9 + (i % 3) * 0.4 : 5.2 + (i % 3) * 0.3,\n                pairMs: prev && prev.to !== to ? Math.round((prev.lostMs + lost) / 2) : null });\n  }\n  const lk = liveChart($(\"gLive\"), revs, { events: [{ t: t0 + 20 * 26000 }] });\n  const r3 = revs[2], r6 = revs.find((r) => r.pairMs != null && r.t > t0 + 5 * 26000);\n  callout($(\"gLive\"), 1, lk.x(r3.t), lk.y(r3.lostMs), lk.x(r3.t) + 24, lk.y(r3.lostMs) - 30);\n  callout($(\"gLive\"), 2, lk.x(r6.t), lk.y(r6.pairMs), lk.x(r6.t) + 10, lk.y(r6.pairMs) + 40);\n  callout($(\"gLive\"), 3, lk.x(t0 + 10.5 * 26000), lk.y(4600), lk.x(t0 + 10.5 * 26000), lk.y(4600) - 70);\n  callout($(\"gLive\"), 4, lk.x(t0 + 20 * 26000), 30, lk.x(t0 + 20 * 26000) + 26, 30);\n  callout($(\"gLive\"), 5, lk.x(revs[4].t), 345, lk.x(revs[4].t) + 30, 318);\n  $(\"gLive\").append(el(\"text\", { x: 880, y: 30, \"text-anchor\": \"end\", class: \"lbl\" }, \"illustration -- not a real run\"));\n});\n</script>\n</body>\n</html>\n","sample":"{\"note\":\"Losmandy G11 Dec axis, 2026-11-04, 12 x 750 ms steps, 0.604 arcsec/px guide scale. before = first round of the night; after = final worm-block depth setting.\",\"stepMs\":750,\"steps\":12,\"rate\":7.52,\"before\":[[0,0,0],[750,1.95,1],[1500,5.59,1],[2250,12.66,1],[3000,12.87,1],[3750,17.55,1],[4500,25.07,1],[5250,30.3,1],[6000,38.92,1],[6750,39.62,1],[7500,46.54,1],[8250,52.23,1],[9000,57.42,1],[8250,60.59,2],[7500,61.26,2],[6750,61.47,2],[6000,61.2,2],[5250,61.37,2],[4500,59.92,2],[3750,56.8,2],[3000,52.38,2],[2250,47.93,2],[1500,40.83,2],[750,38.11,2],[0,32.91,2],[-750,27.86,2],[-1500,22.43,2],[-2250,16.81,2],[-3000,10.39,2],[-3750,7.63,2],[-4500,2.8,2],[-5250,-1.98,2],[-6000,-8.04,2],[-6750,-13.53,2],[-7500,-18.5,2],[-8250,-26.36,2],[-9000,-26.08,2],[-8250,-31.73,3],[-7500,-32.63,3],[-6750,-33.34,3],[-6000,-32.86,3],[-5250,-32.7,3],[-4500,-31.27,3],[-3750,-28.63,3],[-3000,-21.68,3],[-2250,-19.08,3],[-1500,-14.15,3],[-750,-9.33,3],[0,-4.2,3]],\"after\":[[0,0,0],[750,3.06,1],[1500,8.28,1],[2250,8.33,1],[3000,12.99,1],[3750,18.24,1],[4500,24.02,1],[5250,29.24,1],[6000,34.84,1],[6750,39.97,1],[7500,45.83,1],[8250,51.18,1],[9000,59.19,1],[8250,61.59,2],[7500,60.2,2],[6750,57.24,2],[6000,53.47,2],[5250,50.02,2],[4500,46.22,2],[3750,42.15,2],[3000,37.31,2],[2250,32.34,2],[1500,27.09,2],[750,21.6,2],[0,16.52,2],[-750,11.49,2],[-1500,6.41,2],[-2250,1.17,2],[-3000,-4.05,2],[-3750,-8.67,2],[-4500,-13.89,2],[-5250,-19.27,2],[-6000,-24.69,2],[-6750,-30.17,2],[-7500,-35.4,2],[-8250,-40.47,2],[-9000,-45.25,2],[-8250,-48.01,3],[-7500,-47.5,3],[-6750,-45.16,3],[-6000,-41.52,3],[-5250,-37.78,3],[-4500,-33.51,3],[-3750,-28.88,3],[-3000,-24.07,3],[-2250,-19.05,3],[-1500,-13.76,3],[-750,-8.53,3],[0,-3.57,3]]}"};
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
