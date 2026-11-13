// Build the shareable package.
//   node build.cjs            bundle, build the Windows exe, assemble dist/release
//   node build.cjs --bundle-only
//
// 1. dist/backlash-tool.cjs -- app.cjs with page.html and sample.json inlined,
//    so the program is ONE file with nothing to lose beside it. This file IS
//    the macOS / Linux program (run with Node).
// 2. make-exe.ps1 -- the Windows executable, with Node's BUILT-IN single
//    executable support (no downloaded packager).
// 3. dist/release -- what gets shared: exe, the .cjs, the Mac launcher, README.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SRC = path.join(__dirname, "src"), DIST = path.join(__dirname, "dist");
fs.mkdirSync(DIST, { recursive: true });

const app = fs.readFileSync(path.join(SRC, "app.cjs"), "utf8");
const assets = { page: fs.readFileSync(path.join(SRC, "page.html"), "utf8"), sample: fs.readFileSync(path.join(SRC, "sample.json"), "utf8") };
const marker = "/* @@ASSETS@@ */";
if (app.split(marker).length !== 2) throw new Error("asset marker must appear exactly once in app.cjs");
// A replacer FUNCTION: the page is full of `$`, and a replacement STRING would expand `$&`, `$'` etc.
const bundled = app.replace(marker, () => `const __ASSETS__ = ${JSON.stringify(assets)};`);
const out = path.join(DIST, "backlash-tool.cjs");
fs.writeFileSync(out, bundled);
execFileSync(process.execPath, ["--check", out]);
if (!bundled.includes("const __ASSETS__ = {")) throw new Error("assets not inlined");
console.log(`bundled ${out} (${(bundled.length / 1024).toFixed(0)} KB)`);
if (process.argv.includes("--bundle-only")) process.exit(0);

if (process.platform === "win32") {
  execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "make-exe.ps1")], { stdio: "inherit" });
}
const REL = path.join(DIST, "release");
fs.rmSync(REL, { recursive: true, force: true });
fs.mkdirSync(REL, { recursive: true });
const copy = (from, to) => fs.copyFileSync(from, path.join(REL, to));
copy(out, "backlash-tool.cjs");
copy(path.join(__dirname, "README.md"), "README.md");
const cmd = fs.readFileSync(path.join(__dirname, "mac", "Start Backlash Tool.command"), "utf8").replace(/\r\n/g, "\n");
fs.writeFileSync(path.join(REL, "Start Backlash Tool.command"), cmd, { mode: 0o755 });   // LF only, or bash refuses it
const exe = path.join(DIST, "BacklashTool-win-x64.exe");
if (fs.existsSync(exe)) copy(exe, "BacklashTool-win-x64.exe");
console.log(`release: ${REL}`);
for (const f of fs.readdirSync(REL)) console.log(`  ${f}  ${(fs.statSync(path.join(REL, f)).size / 1024).toFixed(0)} KB`);
