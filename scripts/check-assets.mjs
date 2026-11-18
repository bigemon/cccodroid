#!/usr/bin/env node
// 检查打包后的 assets/app 是否自洽（P6-C1-A）
//
//   node scripts/check-assets.mjs <assets/app 目录> [--smoke]
//
// 1. 扫描所有 .mjs：相对 import / import() / 从子目录再 import 的目标必须存在
// 2. --smoke：在临时 HOME 里真起一次网关，确认能打印启动日志

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

const dir = process.argv[2];
const SMOKE = process.argv.includes("--smoke");
if (!dir || !fs.existsSync(dir)) {
  console.error("usage: check-assets.mjs <assets/app 目录> [--smoke]");
  process.exit(2);
}

const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory() && e.name !== "tests") walk(p);
    else if (e.name.endsWith(".mjs")) files.push(p);
  }
};
walk(dir);

const RE = /(?:import\s[^;]*?from\s*|import\s*\(\s*|export\s[^;]*?from\s*)["'](\.[^"']+)["']/g;
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  let m;
  while ((m = RE.exec(src))) {
    const spec = m[1];
    const target = path.resolve(path.dirname(f), spec.replace(/[?#].*$/, ""));
    if (!fs.existsSync(target)) {
      console.error(`✗ ${path.relative(dir, f)} → ${spec} 不存在`);
      bad += 1;
    }
  }
}
console.log(`检查 ${files.length} 个 .mjs，缺失 ${bad} 个`);
if (bad) process.exit(1);

if (SMOKE) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "ccassets-"));
  fs.mkdirSync(path.join(home, "ws"), { recursive: true });
  const port = 9000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [path.join(dir, "server.mjs"), String(port)], {
    env: { ...process.env, CCAPP_HOME: home, CCAPP_WORKSPACE: path.join(home, "ws"), CCAPP_TEST: "1", CCAPP_LOG: path.join(home, "gw.log") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (out += String(d)));
  // 以「端口能连上」为准：CCAPP_TEST=1 时日志可能被抑制，不能靠打印
  const canConnect = () =>
    new Promise((resolve) => {
      const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
      s.on("error", () => resolve(false));
      setTimeout(() => { try { s.destroy(); } catch {} resolve(false); }, 800);
    });
  const ok = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 10000);
    const iv = setInterval(async () => {
      if (await canConnect()) { clearTimeout(t); clearInterval(iv); resolve(true); }
    }, 400);
    child.on("exit", () => { clearTimeout(t); clearInterval(iv); resolve(false); });
  });
  try { child.kill("SIGTERM"); } catch {}
  await new Promise((r) => setTimeout(r, 800));
  fs.rmSync(home, { recursive: true, force: true });
  if (!ok) {
    console.error("✗ 冒烟失败：网关没有启动\n" + out.slice(-1200));
    process.exit(1);
  }
  console.log("冒烟通过：网关可启动");
}
