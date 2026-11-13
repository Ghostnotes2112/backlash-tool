// A pretend PHD2 + mount with KNOWN backlash, for testing the tool indoors.
//
//   MOCK_PORT=14401 MOCK_SLACK_MS=3700 node test/mock-phd2.cjs
//
// The motor turns at the guide rate; the output (the telescope) follows it
// through a dead band of MOCK_SLACK_MS worth of motor travel. The star sits on
// a diagonal in the guide frame, with slow drift on the OTHER axis and 0.15 px
// of centroid noise, so the tool has to learn the direction and project the
// drift out. MOCK_JUMP_AFTER=n moves the star 300 px after n find_star calls
// (someone knocked the mount).
"use strict";
const net = require("net");
const PORT = Number(process.env.MOCK_PORT || 14401);
const SLACK_MS = Number(process.env.MOCK_SLACK_MS || 3700);
const RATE = 7.52 * Number(process.env.MOCK_RATE_FACTOR || 1);   // arcsec/s the output actually moves
const SCALE = 0.604;
const JUMP_AFTER = Number(process.env.MOCK_JUMP_AFTER || 0);
const slack = RATE * SLACK_MS / 1000;                           // arcsec of motor travel inside the gap
let motor = 0, out = 0, finds = 0, jump = 0;
const t0 = Date.now();
const ux = 0.6, uy = 0.8;                                       // along-axis direction in pixels
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += Math.random(); return (s - 3) / Math.sqrt(0.5); };
function star() {
  const along = out / SCALE;
  const drift = ((Date.now() - t0) / 1000) * 0.05;              // 0.05 px/s on the other axis
  return [600 + along * ux - drift * uy + jump + 0.15 * gauss(), 500 + along * uy + drift * ux + 0.15 * gauss()];
}
function move(arcsec) {
  motor += arcsec;
  if (motor > out + slack / 2) out = motor - slack / 2;
  if (motor < out - slack / 2) out = motor + slack / 2;
}
net.createServer((sock) => {
  sock.setEncoding("utf8");
  let buf = "";
  sock.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      const reply = (result, error) => sock.write(JSON.stringify(error ? { jsonrpc: "2.0", id: m.id, error } : { jsonrpc: "2.0", id: m.id, result }) + "\r\n");
      switch (m.method) {
        case "get_app_state": reply(process.env.MOCK_STATE || "Looping"); break;
        case "get_connected": reply(true); break;
        case "get_pixel_scale": reply(SCALE); break;
        case "get_exposure": reply(500); break;
        case "loop": reply(0); break;
        case "find_star": {
          finds++;
          if (JUMP_AFTER && finds === JUMP_AFTER) jump = 300;
          const [x, y] = star();
          const roi = m.params && m.params.roi;
          if (roi && (x < roi[0] || y < roi[1] || x > roi[0] + roi[2] || y > roi[1] + roi[3])) { reply(null, { code: 1, message: "could not find star in roi" }); break; }
          reply([+x.toFixed(2), +y.toFixed(2)]); break;
        }
        case "guide_pulse": {
          const [ms, dir] = m.params;
          const sgn = dir === "N" || dir === "W" ? 1 : -1;
          setTimeout(() => move(sgn * RATE * ms / 1000), 10);
          reply(0); break;
        }
        default: reply(null, { code: 1, message: "mock: unknown method " + m.method });
      }
    }
  });
  sock.on("error", () => {});
}).listen(PORT, "127.0.0.1", () => console.log(`mock PHD2 on ${PORT}, slack ${SLACK_MS} ms`));
