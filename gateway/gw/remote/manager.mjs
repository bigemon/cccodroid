#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  cc-remote.mjs —— cccodroid 远程访问工具链
//
//  不改 cccodroid 的网关：在对外端口上做 HTTP 反向代理，校验口令、改写
//  Host / Origin、注入网关令牌，再转发到 127.0.0.1:8791。
//
//    node cc-remote.mjs set-password          # 设置/修改口令（隐藏输入，scrypt 哈希）
//    node cc-remote.mjs start                 # 启动（后台）
//    node cc-remote.mjs stop                  # 停止（并暂停看门狗）
//    node cc-remote.mjs status                # 看状态
//    node cc-remote.mjs url                   # 打印/刷新 iPad 访问地址
//    node cc-remote.mjs install-autostart     # 挂到 cccodroid 网关启动处 + 60 秒看门狗
//    node cc-remote.mjs repair                # App 更新覆盖 server.mjs 后重新挂上
//    node cc-remote.mjs uninstall-autostart   # 卸掉自启
//
//  其他：run（前台，内部用）、ensure（看门狗用）、restart、set-host / set-port /
//        set-cookie-days / set-preview / set-allow-rt / set-public-host、config、logs
//
//  认证：
//    · 设置了口令 → 浏览器打开 /__login 输入口令，换一个 30 天（可改）的
//      HttpOnly + SameSite=Strict 会话 Cookie。Cookie 过期就再输一次。
//    · 没设置口令 → 仍可用带 ?rt=<一次性口令> 的地址（兼容旧行为）。
//    · 设置口令后默认停用 rt；想保留恢复链接：set-allow-rt on + restart。
//
//  安全：转发出去的是完整网关权限（能执行命令、经 priv 走 Shizuku）。
//  口令只在手机私有目录里存 scrypt 哈希，不存明文；HTTP 是明文的，公共 Wi-Fi
//  请套 WireGuard / Tailscale。HTML 预览默认关闭（同源预览会拆掉网关的隔离）。
// ─────────────────────────────────────────────────────────────────────

import http from "node:http";
import { RemoteAuthStore } from "./auth-state.mjs";
import { accessAddresses, urlHost } from "./access-addresses.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import dns from "node:dns";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MANAGER = fileURLToPath(import.meta.url);
const HOME = process.env.CCAPP_HOME || process.env.HOME || "/data/user/0/cc.codroid/files/home";
const DEFAULT_APP_DIR = path.join(HOME, "..", "app");
const DEFAULT_URL_FILE = path.join(HOME, ".ccremote", "ipad-access-url.txt");
let APP_DIR = DEFAULT_APP_DIR;
const SETTINGS_FILE = path.join(path.dirname(MANAGER), "settings.html");
const SETTINGS_PATH = "/__settings";
const SETTINGS_API = "/__settings/api";
const APP_MANIFEST_PATH = "/__manifest.webmanifest";
// iPadOS 26 的主屏幕 Web App 默认无框；iPadOS 16 需要 apple-mobile-web-app-capable。
// 网关的 index.html 不带这个 meta，代理在 / 与 /index.html 的 HTML 响应里注入。
const APP_MANIFEST = {
  name: "cccodroid",
  short_name: "cccodroid",
  description: "cccodroid remote access",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#1f1e1d",
  theme_color: "#1f1e1d",
};
const APP_META = `<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="cccodroid">
<link rel="manifest" href="${APP_MANIFEST_PATH}">`;
const LOCAL_LISTEN = { ok: false, error: "" };

const F = {
  config: path.join(HOME, ".ccremote-config.json"),
  pass: path.join(HOME, ".ccremote-pass.json"),
  key: path.join(HOME, ".ccremote-session-key"),
  secret: path.join(HOME, ".ccremote-secret"),
  pid: path.join(HOME, ".ccremote.pid"),
  runtime: path.join(HOME, ".ccremote-runtime.json"),
  log: path.join(HOME, ".ccremote.log"),
  paused: path.join(HOME, ".ccremote-paused"),
  autostart: path.join(HOME, ".ccremote-autostart.json"),
};

const DEFAULT_CONFIG = {
  host: "auto",              // auto = 当前 Wi-Fi 的 IPv4；也可以写 IP / 主机名
  port: 8792,
  cookieDays: 30,            // 登录后 Cookie 的有效天数
  preview: false,            // HTML 预览默认关（安全）
  allowRt: false,            // 设置口令后是否还允许 ?rt= 链接
  publicHost: "",            // 写进 URL 的主机名；空 = 用 host
  urlFile: DEFAULT_URL_FILE,
  upstream: "http://127.0.0.1:8791",
};
const AUTH = new RemoteAuthStore(HOME, () => !!loadConfig().allowRt);
const MARK = "// ===== cc-remote autostart v2";
const AUTOSTART_BLOCK = `${MARK} (managed by cc-remote.mjs) =====
(async () => {
  try {
    const { spawn } = await import("node:child_process");
    const { readFileSync, existsSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const home = process.env.HOME || "/data/user/0/cc.codroid/files/home";
    const autoFile = path.join(home, ".ccremote-autostart.json");
    const paused = path.join(home, ".ccremote-paused");
    const pidFile = path.join(home, ".ccremote.pid");
    const rtFile = path.join(home, ".ccremote-runtime.json");
    const cfgFile = path.join(home, ".ccremote-config.json");
    const alive = () => {
      try {
        const p = Number(readFileSync(pidFile, "utf8"));
        if (!p) return false;
        process.kill(p, 0);
        return true;
      } catch { return false; }
    };
    // host=auto 时现在应该绑哪个地址（与 cc-remote.mjs 的 lanIP() 保持一致）
    const wantHost = () => {
      let cfg = {};
      try { cfg = JSON.parse(readFileSync(cfgFile, "utf8")); } catch {}
      const host = cfg.host || "auto";
      if (host !== "auto") return host;
      const ifs = os.networkInterfaces();
      for (const n of ["wlan0", "wifi0", "eth0", "wlan1", "ap0"]) {
        for (const a of ifs[n] || []) if (a.family === "IPv4" && !a.internal) return a.address;
      }
      return "127.0.0.1";
    };
    // 在跑，且绑的地址就是现在该绑的地址 → 什么都不用做
    const synced = () => {
      if (!alive()) return false;
      try {
        const rt = JSON.parse(readFileSync(rtFile, "utf8"));
        return !!rt.host && rt.host === wantHost();
      } catch { return false; }
    };
    const boot = () => {
      try {
        const a = JSON.parse(readFileSync(autoFile, "utf8"));
        if (!a || a.enabled === false || !a.manager || !existsSync(a.manager)) return;
        if (existsSync(paused) || synced()) return;
        // 没在跑就拉起；在跑但 Wi-Fi 地址变了（蜂窝→Wi-Fi、换网、断网）就交给 ensure 重启切换
        const loader = process.env.CCAPP_EXEC === "loader";
        const cmd = loader ? "/system/bin/linker64" : process.execPath;
        const args = loader ? [process.execPath, a.manager, "ensure"] : [a.manager, "ensure"];
        spawn(cmd, args, { detached: true, stdio: "ignore", env: process.env }).unref();
      } catch {}
    };
    boot();
    setInterval(boot, 60000).unref();
  } catch {}
})();`;

// ── 小工具 ────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lower = (s) => String(s || "").toLowerCase();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const eq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function atomicWrite(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp." + process.pid + "." + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, data, { mode });
  try { fs.chmodSync(tmp, mode); } catch {}
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, obj) { atomicWrite(file, JSON.stringify(obj, null, 1) + "\n", 0o600); }
function logLine(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`;
  try { fs.appendFileSync(F.log, line); } catch {}
}

// ── 配置 ──────────────────────────────────────────────────────────────
function loadConfig() {
  const c = { ...DEFAULT_CONFIG, ...readJson(F.config, {}) };
  if (!Number.isFinite(Number(c.port))) c.port = DEFAULT_CONFIG.port;
  if (!Number.isFinite(Number(c.cookieDays)) || Number(c.cookieDays) <= 0) c.cookieDays = DEFAULT_CONFIG.cookieDays;
  return c;
}
function saveConfig(c) { writeJson(F.config, c); }

// ── 口令 / 会话 ───────────────────────────────────────────────────────
function readPass() { return AUTH.read().password; }
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32, SCRYPT);
  return { v: 1, alg: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("hex"), hash: hash.toString("hex"), at: Date.now() };
}
function verifyPassword(pw, p) {
  return new Promise((resolve) => {
    if (!p) return resolve(false);
    const opts = {
      N: Math.min(Number(p.N) || SCRYPT.N, 1 << 20),
      r: Math.min(Number(p.r) || SCRYPT.r, 32),
      p: Math.min(Number(p.p) || SCRYPT.p, 8),
      maxmem: SCRYPT.maxmem,
    };
    crypto.scrypt(String(pw), Buffer.from(p.salt, "hex"), 32, opts, (err, got) => {
      if (err) return resolve(false);
      const want = Buffer.from(p.hash, "hex");
      resolve(want.length === got.length && crypto.timingSafeEqual(want, got));
    });
  });
}
function sessionKey() { return Buffer.from(AUTH.read().key, "hex"); }
function savePassword(pw) {
  const current = AUTH.read();
  return AUTH.save({ mode: "password", password: hashPassword(pw) }, current.revision).state;
}
function clearPassword() {
  const current = AUTH.read();
  return AUTH.save({ mode: "rt", token: crypto.randomBytes(32).toString("hex") }, current.revision).state;
}
function newSession(days) {
  const exp = Date.now() + Math.max(1, Math.round(Number(days) * 86400e3));
  const payload = "v1." + exp;
  const sig = crypto.createHmac("sha256", sessionKey()).update(payload).digest("hex");
  return payload + "." + sig;
}
function validSession(tok) {
  const m = /^v1\.(\d+)\.([0-9a-f]{64})$/.exec(String(tok || ""));
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  const sig = crypto.createHmac("sha256", sessionKey()).update("v1." + exp).digest("hex");
  return eq(sig, m[2]);
}
function rtSecret() { return AUTH.read().token; }

// ── 地址 / 进程 ───────────────────────────────────────────────────────
function lanIP() {
  const ifs = os.networkInterfaces();
  for (const name of ["wlan0", "wifi0", "eth0", "wlan1", "ap0"]) {
    for (const a of ifs[name] || []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return "";
}
function resolveHost(host) {
  if (!host || host === "auto") return lanIP();
  return host;
}
function isLoopback(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
function interfaceHasIPv4(ip) {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) if (a.family === "IPv4" && a.address === ip) return true;
  }
  return false;
}
function publicHostFor(bindHost, publicHost) {
  if (publicHost) return publicHost;
  if (bindHost === "0.0.0.0" || bindHost === "::") {
    const wifi = lanIP();
    if (wifi) return wifi;
    if (bindHost === "::") {
      let addresses = [];
      try { addresses = accessAddresses({ host: "::", port: 80 }, os.networkInterfaces()); } catch {}
      if (addresses.length) return new URL(addresses[0].url).hostname.replace(/^\[|\]$/g, "");
      return "::1";
    }
    return "127.0.0.1";
  }
  return bindHost;
}
function isAlive(pid) {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return false;
  try { process.kill(p, 0); return true; } catch { return false; }
}
function readPid() {
  try { return Number(fs.readFileSync(F.pid, "utf8").trim()) || 0; } catch { return 0; }
}
function readRuntime() {
  const r = readJson(F.runtime, null);
  return r && Number.isInteger(Number(r.pid)) ? r : null;
}
function running() {
  const rt = readRuntime();
  if (rt && isAlive(rt.pid)) return rt;
  const p = readPid();
  if (p && isAlive(p)) return { pid: p };
  return null;
}
function portInUse(host, port) {
  if (!host) return Promise.resolve(false);
  const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return new Promise((resolve) => {
    const s = net.connect({ host: h, port: Number(port), timeout: 700 });
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(v); };
    s.once("connect", () => fin(true));
    s.once("timeout", () => fin(false));
    s.once("error", () => fin(false));
  });
}
function nodeCmd(argv) {
  const node = process.execPath;
  let loader = process.env.CCAPP_EXEC === "loader";
  if (!loader) {
    try { loader = fs.readFileSync(path.join(HOME, "..", ".exec-mode"), "utf8").trim() === "loader"; } catch {}
  }
  return loader ? { cmd: "/system/bin/linker64", args: [node, ...argv] } : { cmd: node, args: argv };
}

// ── 参数 ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--preview") { out.preview = true; continue; }
    if (a === "--no-preview") { out.preview = false; continue; }
    if (a === "--allow-rt") { out["allow-rt"] = true; continue; }
    if (a === "--no-allow-rt") { out["allow-rt"] = false; continue; }
    if (a === "--stdin") { out.stdin = true; continue; }
    if (a === "--dry-run") { out.dryRun = true; continue; }
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a.startsWith("--")) {
      const eqi = a.indexOf("=");
      const k = eqi > 0 ? a.slice(2, eqi) : a.slice(2);
      const v = eqi > 0 ? a.slice(eqi + 1) : argv[++i];
      out[k] = v === undefined ? "" : v;
      continue;
    }
    out._.push(a);
  }
  return out;
}

function makeOptions(args, cfg = loadConfig(), { fallbackLocal = false } = {}) {
  const hostArg = args.host ?? cfg.host ?? "auto";
  let bindHost = resolveHost(hostArg);
  let degraded = false;
  if (!bindHost) {
    // host=auto 但当前没有 Wi-Fi IPv4（没连 Wi-Fi / 只开了蜂窝）：先只监听本机，
    // 设置页仍然可用；看门狗会在 Wi-Fi 出现后自动切回局域网地址。
    if (fallbackLocal && (!hostArg || hostArg === "auto")) { bindHost = "127.0.0.1"; degraded = true; }
    else throw new Error("没有找到 Wi-Fi 的 IPv4 地址；请用 --host 指定，或先连上 Wi-Fi");
  }
  const port = Number(args.port ?? cfg.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口不对");
  const cookieDays = Number(args["cookie-days"] ?? args.cookieDays ?? cfg.cookieDays);
  if (!Number.isFinite(cookieDays) || cookieDays <= 0) throw new Error("Cookie 天数必须大于 0");
  const preview = args.preview !== undefined ? !!args.preview : !!cfg.preview;
  const allowRt = args["allow-rt"] !== undefined ? !!args["allow-rt"] : (args.allowRt !== undefined ? !!args.allowRt : !!cfg.allowRt);
  const publicHost = String(args["public-host"] ?? args.publicHost ?? cfg.publicHost ?? "");
  const urlFile = path.resolve(args["url-file"] ?? args.urlFile ?? cfg.urlFile ?? DEFAULT_URL_FILE);
  const upstream = String(args.upstream ?? cfg.upstream ?? "http://127.0.0.1:8791");
  const tokenFile = String(args["token-file"] ?? args.tokenFile ?? process.env.CCAPP_TOKEN_FILE ?? path.join(HOME, ".gateway-token"));
  return {
    host: bindHost,
    degraded,
    port,
    publicHost: publicHostFor(bindHost, publicHost),
    cookieDays,
    preview,
    allowRt,
    urlFile,
    upstream,
    tokenFile,
    cookieName: `cc_remote_${port}`,
    secret: rtSecret(),
  };
}

function currentOptions(cfg = loadConfig()) {
  const rt = running();
  if (rt && rt.host && rt.port) {
    return makeOptions({
      host: rt.host, port: rt.port, "public-host": rt.publicHost, "cookie-days": rt.cookieDays,
      preview: !!rt.preview, "allow-rt": !!rt.allowRt, "url-file": rt.urlFile,
      upstream: rt.upstream, "token-file": rt.tokenFile,
    }, cfg);
  }
  return makeOptions({}, cfg, { fallbackLocal: true });
}

function writeUrlFile(A) {
  const base = `http://${urlHost(A.publicHost)}:${A.port}/`;
  const auth = AUTH.read();
  const useRt = auth.allowRt || auth.mode === "rt";
  const url = useRt ? base + "?rt=" + auth.token : base;
  atomicWrite(A.urlFile, url + "\n", 0o600);
  return url;
}

// ── 登录页 ────────────────────────────────────────────────────────────
const LOGIN_ERR = {
  bad: "口令不对。",
  rate: "尝试次数太多，请 10 分钟后再试。",
  none: "还没有设置口令。请在手机上运行 set-password。",
  rt: "rt 链接已停用，请输入口令。",
};
function safeNext(s) {
  s = String(s || "/");
  if (!s.startsWith("/") || s.startsWith("//") || /[\u0000-\u001f]/.test(s)) return "/";
  return s;
}
function loginPage(hasPass, err, next) {
  const msg = LOGIN_ERR[err] || "";
  const form = hasPass
    ? `<form method="post" action="/__login">
        <input type="hidden" name="next" value="${esc(next)}">
        <label for="pw">口令</label>
        <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
        <button type="submit">进入</button>
      </form>`
    : `<p class="hint">在手机终端里运行：<code>node ${esc(MANAGER)} set-password</code></p>
       <p class="hint">设置好后再刷新。若用 ?rt= 地址，也可以从那个地址进入。</p>`;
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#1f1e1d">
<title>cccodroid 远程访问</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;
  background:#1f1e1d;color:#eceae6;-webkit-text-size-adjust:100%;
  font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  padding:calc(20px + env(safe-area-inset-top)) 20px calc(20px + env(safe-area-inset-bottom))}
main{width:min(470px,100%);background:#262624;border:1px solid #3a3935;border-radius:18px;padding:30px 26px;
  box-shadow:0 18px 60px rgba(0,0,0,.35)}
h1{margin:0 0 6px;font-size:26px;font-weight:600;color:#d97757}
p{margin:0 0 20px;color:#b9b4aa;line-height:1.55}
label{display:block;font-size:14px;color:#b9b4aa;margin-bottom:7px}
input[type=password]{width:100%;padding:14px 15px;border-radius:11px;border:1px solid #4a4843;background:#1f1e1d;
  color:#eceae6;font-size:18px;outline:none;margin-bottom:16px}
input[type=password]:focus{border-color:#d97757}
button{width:100%;padding:14px 16px;border:0;border-radius:11px;background:#d97757;color:#1f1e1d;
  font-size:17px;font-weight:600;cursor:pointer;min-height:52px}
button:active{opacity:.85}
.err{color:#e88b7a;font-size:15px;margin:0 0 16px}
.hint{color:#8f8a80;font-size:14px;margin:0 0 12px;line-height:1.55}
code{background:#1f1e1d;border:1px solid #3a3935;border-radius:6px;padding:3px 7px;font-size:13px;word-break:break-all}
@media (max-width:480px){
  body{padding:calc(16px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom))}
  main{padding:24px 20px;border-radius:16px}
  h1{font-size:24px}
  input[type=password]{padding:14px 15px}
  button{font-size:16px;min-height:52px}
}
/* Kiwi 等“桌面版”模式：粗指针 + 低 DPR + 宽布局视口。正常手机/平板不会命中。 */
html.desktop-mode main{width:min(92vw,820px);padding:40px 34px;border-radius:22px}
html.desktop-mode h1{font-size:34px}
html.desktop-mode p{font-size:20px;margin-bottom:24px}
html.desktop-mode label{font-size:18px;margin-bottom:9px}
html.desktop-mode input[type=password]{font-size:24px;padding:18px 19px;border-radius:14px;margin-bottom:20px}
html.desktop-mode button{font-size:22px;min-height:72px;border-radius:14px}
html.desktop-mode .err{font-size:19px;margin-bottom:20px}
html.desktop-mode .hint{font-size:18px;margin-bottom:14px}
html.desktop-mode code{font-size:16px;padding:4px 8px}
</style>
<script>(function(){try{var c=(window.matchMedia&&matchMedia("(pointer: coarse)").matches)||("ontouchstart" in window);var d=window.devicePixelRatio||1;var w=window.innerWidth||0;if(c&&d<1.6&&w>700&&w<1300)document.documentElement.classList.add("desktop-mode");}catch(e){}})();</script></head>
<body><main>
<h1>cccodroid</h1>
<p>远程访问 · 输入口令继续</p>
${msg ? `<p class="err">${esc(msg)}</p>` : ""}
${form}
</main></body></html>`;
}
function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": b.length, "cache-control": "no-store" });
  res.end(b);
}
function deny(res, code, why) {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(why === "auth" ? "unauthorized\n" : "forbidden\n");
}
function readBody(req, max = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > max) { reject(new Error("body too large")); try { req.destroy(); } catch {} return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function seeOther(res, loc) {
  res.writeHead(303, { location: loc, "cache-control": "no-store" });
  res.end();
}
function redirectLogin(res, next, e) {
  const q = new URLSearchParams({ next: safeNext(next) });
  if (e) q.set("e", e);
  res.writeHead(302, { location: "/__login?" + q.toString(), "cache-control": "no-store" });
  res.end();
}
function wantsHtml(req, p) {
  return p === "/" || p === "/index.html" || /\btext\/html\b/i.test(String(req.headers.accept || ""));
}
function originOk(origin, host, A, req, opts = {}) {
  // 现代浏览器（含 iOS 主屏幕 Web App）会带 Sec-Fetch-Site；这是浏览器自己设的，伪造不了。
  const sfs = lower(req && req.headers && req.headers["sec-fetch-site"]);
  if (sfs === "same-origin" || sfs === "none") return true;
  if (origin === undefined) return true;
  const o = lower(origin);
  if (A.publicOrigin && o === lower(A.publicOrigin)) return true;
  if (!host) return false;
  if (o === "http://" + lower(host)) return true;
  // iOS 主屏幕 Web App / 某些 WebKit 会发 Origin: null。
  // 登录请求本身放行（没有会话可偷）；已登录请求只在带着有效会话时放行。
  if (o === "null" && (opts.login || opts.authed)) return true;
  return false;
}
function cookieValue(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(String(req.headers.cookie || ""));
  return m ? m[1] : "";
}
function sessionCookie(A, token) {
  const sec = Math.max(1, Math.round(Number(A.cookieDays) * 86400));
  return `${A.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sec}`;
}
function authOk(req, A) {
  const c = cookieValue(req, A.cookieName);
  if (c && validSession(c)) return true;
  const auth = AUTH.read();
  if (c && (auth.allowRt || auth.mode === "rt") && eq(c, auth.token)) return true;
  return false;
}

// ── 限流 ──────────────────────────────────────────────────────────────
const RATE = new Map();
function rateKey(req) { return req.socket.remoteAddress || "?"; }
function rateCheck(key) {
  const now = Date.now();
  const r = RATE.get(key);
  if (!r || now > r.reset) { RATE.set(key, { n: 0, reset: now + 10 * 60e3 }); return false; }
  return r.n >= 10;
}
function rateBad(key) {
  const r = RATE.get(key);
  if (r) r.n++;
  if (RATE.size > 500) for (const [k, v] of RATE) if (Date.now() > v.reset) RATE.delete(k);
}
function rateGood(key) { RATE.delete(key); }

// ── 登录处理 ──────────────────────────────────────────────────────────
async function serveLogin(req, res, u, host, A) {
  if (req.method === "GET") {
    if (authOk(req, A)) {
      res.writeHead(302, { location: safeNext(u.searchParams.get("next")), "cache-control": "no-store" });
      return res.end();
    }
    const html = loginPage(!!readPass(), u.searchParams.get("e") || "", safeNext(u.searchParams.get("next")));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
    });
    return res.end(html);
  }
  if (req.method !== "POST") return deny(res, 405, "bad");
  logLine(`登录POST origin=${req.headers.origin ?? "-"} host=${host} sfs=${req.headers["sec-fetch-site"] || "-"}`);
  if (!originOk(req.headers.origin, host, A, req, { login: true })) return deny(res, 403, "origin");
  const key = rateKey(req);
  if (rateCheck(key)) return seeOther(res, "/__login?e=rate&next=" + encodeURIComponent(safeNext(u.searchParams.get("next"))));
  let body = "";
  try { body = await readBody(req); } catch { return deny(res, 413, "bad"); }
  let pw = "", next = safeNext(u.searchParams.get("next"));
  try {
    if (/application\/json/i.test(String(req.headers["content-type"] || ""))) {
      const j = JSON.parse(body || "{}");
      pw = String(j.password || "");
      next = safeNext(j.next || next);
    } else {
      const f = new URLSearchParams(body);
      pw = f.get("password") || "";
      next = safeNext(f.get("next") || next);
    }
  } catch { return deny(res, 400, "bad"); }
  const loginAuth = AUTH.read(), pass = loginAuth.password;
  if (!pass) return seeOther(res, "/__login?e=none&next=" + encodeURIComponent(next));
  if (!(await verifyPassword(pw, pass))) {
    rateBad(key);
    logLine(`登录失败 ip=${key}`);
    return seeOther(res, "/__login?e=bad&next=" + encodeURIComponent(next));
  }
  if (AUTH.read().revision !== loginAuth.revision) return deny(res, 403, "auth");
  rateGood(key);
  logLine(`登录成功 ip=${key}`);
  res.setHeader("Set-Cookie", sessionCookie(A, newSession(A.cookieDays)));
  return seeOther(res, next);
}

// ── 设置页 ────────────────────────────────────────────────────────────
function settingsCsrf() {
  return crypto.createHmac("sha256", sessionKey()).update("settings-csrf-v1").digest("hex");
}
function settingsUrlFor(req, host, port) {
  const h = String(req.headers.host || "");
  const local = /^(127\.0\.0\.1|localhost|\[::1\])(?::|$)/i.test(h);
  return `http://${urlHost(local ? "127.0.0.1" : host)}:${port}${SETTINGS_PATH}`;
}
function serviceEnabled(cfg = loadConfig()) {
  if (typeof cfg.enabled === "boolean") return cfg.enabled;
  return !!readJson(F.autostart, null)?.enabled || !!running();
}
function settingsStatus(A) {
  const cfg = loadConfig();
  const auth = AUTH.read(), pass = !!auth.password;
  const { a, appended } = autostartInfo();
  const autostart = a && appended ? "installed" : a && !appended ? "repair" : !a && appended ? "orphan" : "none";
  const base = `http://${urlHost(A.publicHost)}:${A.port}/`;
  const runtime = readRuntime();
  let interfaces = {};
  try { interfaces = os.networkInterfaces(); } catch {}
  const addresses = running() ? accessAddresses({
    host: A.host, port: A.port,
    publicHost: cfg.publicHost === A.publicHost ? cfg.publicHost : "",
    rt: (auth.allowRt || !pass) ? auth.token : "",
  }, interfaces) : [];
  return {
    ok: true,
    csrf: settingsCsrf(),
    pid: running()?.pid || null,
    running: !!running(),
    enabled: serviceEnabled(cfg),
    host: A.host,
    port: A.port,
    publicHost: A.publicHost,
    baseUrl: base,
    accessUrl: (auth.allowRt || !pass) ? base + "?rt=" + auth.token : base,
    accessAddresses: addresses,
    lanUrl: `http://${urlHost(A.publicHost)}:${A.port}${SETTINGS_PATH}`,
    localUrl: LOCAL_LISTEN.ok ? `http://127.0.0.1:${A.port}${SETTINGS_PATH}` : "",
    localError: LOCAL_LISTEN.error || "",
    authMode: auth.mode,
    authRevision: auth.revision,
    authToken: auth.mode === "rt" ? auth.token : "",
    passwordSet: pass,
    cookieDays: A.cookieDays,
    preview: A.preview,
    allowRt: auth.allowRt,
    paused: fs.existsSync(F.paused),
    autostart,
    autostartAppended: appended,
    autostartConfigured: !!a,
    appDir: APP_DIR,
    urlFile: A.urlFile,
    logFile: F.log,
    startedAt: runtime ? runtime.startedAt : null,
    config: {
      host: cfg.host, port: cfg.port, cookieDays: cfg.cookieDays,
      preview: !!cfg.preview, allowRt: !!cfg.allowRt, publicHost: cfg.publicHost || "",
    },
  };
}
// Keep the settings document self-contained under its existing inline-only CSP.
function settingsHtml() {
  return fs.readFileSync(SETTINGS_FILE, "utf8").replace("/*__LOCAL_QR_ENCODER__*/",
    () => fs.readFileSync(path.join(path.dirname(SETTINGS_FILE), "qrcodegen.js"), "utf8"));
}
function serveSettings(req, res) {
  let html;
  try { html = settingsHtml(); }
  catch {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    return res.end("settings.html 不见了：" + SETTINGS_FILE + "\n");
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
  });
  res.end(html);
}
async function serveSettingsApi(req, res, u, A) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method" });
  let body;
  try { body = JSON.parse((await readBody(req, 128 * 1024)) || "{}"); }
  catch { return sendJson(res, 400, { ok: false, error: "bad json" }); }
  const action = String(body.action || "");
  if (action !== "status" && !eq(req.headers["x-cc-csrf"] || "", settingsCsrf())) {
    return sendJson(res, 403, { ok: false, error: "csrf" });
  }
  try {
    if (u.pathname === "/api/remote/control" && !["status", "save", "apply", "password", "auth-save", "start", "restart", "stop", "logs"].includes(action)) {
      return sendJson(res, 400, { ok: false, error: "unknown action" });
    }
    if (u.pathname === "/api/remote/control" && ["start", "restart", "stop"].includes(action)) {
      if (action === "stop") await cmdStop();
      else if (action === "restart") await cmdRestart({});
      else await cmdStart({});
      if (action !== "stop" && !running()) throw new Error("启动失败，请检查日志和端口占用");
      saveConfig({ ...loadConfig(), enabled: action !== "stop" });
      return sendJson(res, 200, { ok: true, message: action === "stop" ? "已停止远程访问" : "远程服务已启动" });
    }
    switch (action) {
      case "status": {
        const status = settingsStatus(A);
        if (u.pathname === "/api/remote/control") {
          delete status.autostart;
          delete status.autostartAppended;
          delete status.autostartConfigured;
          delete status.allowRt;
          delete status.config.allowRt;
          status.localUrl = "http://" + req.headers.host + "/api/remote/page";
        }
        return sendJson(res, 200, status);
      }
      case "start":
        await cmdStart({});
        return sendJson(res, 200, { ok: true, message: "远程服务已启动" });

      case "save":
      case "apply": {
        const cur = loadConfig();
        const enabled = serviceEnabled(cur);
        const wasRunning = !!running();
        const next = { ...cur };
        const host = String(body.host ?? cur.host ?? "auto").trim() || "auto";
        next.host = host;
        const port = Number(body.port ?? cur.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口不对");
        next.port = port;
        const cd = Number(body.cookieDays ?? cur.cookieDays);
        if (!Number.isFinite(cd) || cd <= 0) throw new Error("Cookie 天数不对");
        next.cookieDays = cd;
        next.preview = body.preview !== undefined ? !!body.preview : !!cur.preview;
        next.allowRt = u.pathname !== "/api/remote/control" && body.allowRt !== undefined ? !!body.allowRt : !!cur.allowRt;
        next.publicHost = String(body.publicHost ?? cur.publicHost ?? "").trim();
        if (host !== "auto" && host !== "0.0.0.0" && host !== "::" && !net.isIP(host)) {
          try { await dns.promises.lookup(host); }
          catch { throw new Error("主机名解析不了：" + host); }
        }
        let nA = null, warning = "";
        if (action === "apply") nA = makeOptions({}, next, { fallbackLocal: true });
        else try { nA = makeOptions({}, next); } catch (e) { warning = e.message; }
        if (nA && (next.port !== A.port || !wasRunning) && await portInUse(nA.host, next.port)) throw new Error("端口 " + next.port + " 已被占用");
        if (action === "apply") {
          next.enabled = enabled;
          saveConfig(next);
          if (enabled && wasRunning) {
            try {
              await cmdRestart({});
              if (!running()) throw new Error("启动失败，请检查日志和端口占用");
            } catch (e) {
              // A failed restart must not silently leave the new form as the saved baseline.
              saveConfig(cur);
              let restored = false;
              if (wasRunning) {
                try { await cmdStart({}); restored = !!running(); } catch {}
              }
              throw new Error("保存并重启失败；已恢复原配置" + (wasRunning ? (restored ? "和原服务" : "，服务未恢复，请查看日志") : "") + "：" + e.message);
            }
          }
          return sendJson(res, 200, {
            ok: true, csrf: settingsCsrf(), config: next, enabled, restartNeeded: false,
            newUrl: settingsUrlFor(req, nA.publicHost, nA.port),
            message: enabled && wasRunning ? "已保存并重启服务" : "已保存；服务启动时应用",
          });
        }
        saveConfig(next);
        const changed = !nA || nA.host !== A.host || nA.port !== A.port || nA.publicHost !== A.publicHost ||
          nA.cookieDays !== A.cookieDays || nA.preview !== A.preview || nA.allowRt !== A.allowRt;
        return sendJson(res, 200, {
          ok: true, csrf: settingsCsrf(), config: next, restartNeeded: changed, warning,
          newUrl: nA ? settingsUrlFor(req, nA.publicHost, nA.port) : "",
          message: changed ? "已保存；需要重启生效。" : "已保存。",
        });
      }

      case "auth-save": {
        const active = running();
        if (active && active.authProtocol !== 1) throw new Error("请先重启远程服务以加载新版认证");
        const mode = String(body.mode || "");
        const pw = String(body.password || ""), confirm = String(body.confirm || "");
        if (mode === "password" && (pw || confirm)) {
          if (pw.length < 6) throw new Error("口令至少 6 位");
          if (pw !== confirm) throw new Error("两次输入不一致");
        }
        const result = AUTH.save({
          mode, password: mode === "password" && pw ? hashPassword(pw) : undefined,
          token: mode === "rt" ? body.token : undefined,
        }, body.revision);
        if (result.changed) {
          res.setHeader("Set-Cookie", sessionCookie(A, newSession(A.cookieDays)));
          try { writeUrlFile(A); } catch {}
          logLine("设置页：认证设置已保存");
        }
        return sendJson(res, 200, { ok: true, csrf: settingsCsrf(), changed: result.changed,
          authMode: result.state.mode, authRevision: result.state.revision,
          authToken: result.state.mode === "rt" ? result.state.token : "",
          message: result.changed ? (AUTH.compatibilityWarning ? "认证已保存；旧版兼容文件未同步" : "认证已保存，其他设备需重新登录") : "认证设置未改变" });
      }

      case "password": {
        const pw = String(body.password || ""), pw2 = String(body.confirm || "");
        if (pw.length < 6) throw new Error("口令至少 6 位");
        if (pw !== pw2) throw new Error("两次输入不一致");
        savePassword(pw);
        res.setHeader("Set-Cookie", sessionCookie(A, newSession(A.cookieDays)));
        try { writeUrlFile(A); } catch {}
        logLine("设置页：口令已更新");
        return sendJson(res, 200, { ok: true, csrf: settingsCsrf(), authMode: "password", message: "口令已更新；其它会话已失效。" });
      }

      case "clear-password": {
        clearPassword();
        res.setHeader("Set-Cookie", sessionCookie(A, newSession(A.cookieDays)));
        let url = "";
        try { url = writeUrlFile(A); } catch {}
        logLine("设置页：口令已清除");
        return sendJson(res, 200, { ok: true, csrf: settingsCsrf(), authMode: "rt", accessUrl: url, message: "口令已清除；当前回到 rt 模式。" });
      }

      case "rotate-rt": {
        const auth = AUTH.read();
        AUTH.replace({ token: crypto.randomBytes(32).toString("hex"), key: crypto.randomBytes(32).toString("hex") }, auth.revision);
        res.setHeader("Set-Cookie", sessionCookie(A, newSession(A.cookieDays)));
        let url = "";
        try { url = writeUrlFile(A); } catch {}
        logLine("设置页：rt 口令已轮换");
        return sendJson(res, 200, { ok: true, csrf: settingsCsrf(), accessUrl: url, message: "rt 口令已轮换；旧 rt 链接失效。" });
      }

      case "restart": {
        const cfg = loadConfig();
        let nA = null;
        try { nA = makeOptions({}, cfg); } catch {}
        sendJson(res, 200, { ok: true, restarting: true, newUrl: nA ? settingsUrlFor(req, nA.publicHost, nA.port) : "", csrf: settingsCsrf(), message: "正在重启…" });
        const t = setTimeout(() => spawnDetached([MANAGER, "restart"]), 250);
        if (t.unref) t.unref();
        return;
      }

      case "stop": {
        sendJson(res, 200, { ok: true, stopping: true, message: "正在停止…" });
        const t = setTimeout(() => spawnDetached([MANAGER, "stop"]), 250);
        if (t.unref) t.unref();
        return;
      }

      case "autostart-install":
        await installAutostart({});
        return sendJson(res, 200, { ok: true, csrf: settingsCsrf(), status: settingsStatus(A), message: "已安装；下次网关启动生效。" });

      case "autostart-repair":
        repairAutostart({});
        return sendJson(res, 200, { ok: true, csrf: settingsCsrf(), status: settingsStatus(A), message: "已 repair。" });

      case "autostart-uninstall":
        uninstallAutostart({});
        return sendJson(res, 200, { ok: true, csrf: settingsCsrf(), status: settingsStatus(A), message: "已卸载；当前代理仍在运行。" });

      case "logout":
        res.setHeader("Set-Cookie", `${A.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        return sendJson(res, 200, { ok: true, loggedOut: true, message: "已退出。" });

      case "logs": {
        let logs = "";
        try { const b = fs.readFileSync(F.log); logs = b.slice(Math.max(0, b.length - 16000)).toString("utf8"); } catch {}
        return sendJson(res, 200, { ok: true, logs });
      }

      default:
        return sendJson(res, 400, { ok: false, error: "unknown action" });
    }
  } catch (e) {
    logLine("设置页：" + (e.message || e));
    return sendJson(res, e.status === 409 ? 409 : 400, { ok: false, error: e.message || String(e) });
  }
}

// ── HTTP 转发 ─────────────────────────────────────────────────────────
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "trailers", "transfer-encoding", "upgrade"]);
function cleanHeaders(h) {
  const o = {};
  for (const [k, v] of Object.entries(h)) if (!HOP.has(k.toLowerCase())) o[k] = v;
  return o;
}
function stripCookie(cookie, name) {
  return String(cookie || "").split(/;\s*/).filter((p) => p && !p.startsWith(name + "=")).join("; ");
}
function head(res, code, msg, headers) {
  if (msg) res.writeHead(code, msg, headers);
  else res.writeHead(code, headers);
}
function rewritePreviewUrl(url, host) {
  const m = /^http:\/\/(?:localhost|127\.0\.0\.1):(\d+)(\/[\s\S]*)$/.exec(String(url || ""));
  if (!m) return url;
  return `http://${host}/__p/${m[1]}${m[2]}`;
}
function refererPreviewPort(referer) {
  try {
    const u = new URL(String(referer || ""));
    const m = /^\/__p\/(\d+)(\/|$)/.exec(u.pathname);
    if (!m) return 0;
    const p = Number(m[1]);
    return p >= 1 && p <= 65535 ? p : 0;
  } catch { return 0; }
}
function refererForPreview(referer, port) {
  try {
    const u = new URL(String(referer || ""));
    u.pathname = u.pathname.replace(new RegExp(`^/__p/${port}`), "");
    return `http://localhost:${port}${u.pathname}${u.search}`;
  } catch { return ""; }
}
function refererForGateway(referer, host, GW_ORIGIN) {
  try {
    const u = new URL(String(referer || ""));
    if (lower(u.host) !== lower(host)) return "";
    return `${GW_ORIGIN}${u.pathname}${u.search}`;
  } catch { return ""; }
}
function gatewayToken(A) {
  try {
    const t = fs.readFileSync(A.tokenFile, "utf8").trim();
    return /^[0-9a-f]{64}$/.test(t) ? t : "";
  } catch { return ""; }
}

function injectAppMeta(html) {
  if (/apple-mobile-web-app-capable/i.test(html)) return html;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>\n${APP_META}`);
  return APP_META + "\n" + html;
}

function forward(req, res, target, A, UP, UP_HOST, GW_ORIGIN) {
  const headers = { ...req.headers };
  for (const k of Object.keys(headers)) if (HOP.has(k)) delete headers[k];
  delete headers["x-cc-remote"];
  delete headers["x-cc-token"];
  const left = stripCookie(headers.cookie, A.cookieName);
  if (left) headers.cookie = left; else delete headers.cookie;

  if (headers.origin !== undefined) {
    headers.origin = target.gateway ? GW_ORIGIN : `http://localhost:${target.port}`;
  }
  if (target.preview) {
    const r = refererForPreview(headers.referer, target.port);
    if (r) headers.referer = r; else delete headers.referer;
  } else {
    const r = refererForGateway(headers.referer, req.headers.host, GW_ORIGIN);
    if (r) headers.referer = r; else delete headers.referer;
  }
  headers.host = target.gateway ? UP_HOST : `localhost:${target.port}`;
  if (target.gateway) {
    const t = gatewayToken(A);
    if (t) headers["x-cc-token"] = t;
  }

  const upHost = target.gateway ? UP.hostname : "127.0.0.1";
  const upPort = target.gateway ? (UP.port || (UP.protocol === "https:" ? 443 : 80)) : target.port;
  const upReq = http.request({
    protocol: target.gateway ? UP.protocol : "http:",
    hostname: upHost,
    port: upPort,
    method: req.method,
    path: target.path,
    headers,
  }, (upRes) => {
    const appHtml = target.gateway && req.method === "GET" && (() => {
      try {
        const pp = new URL(target.path, "http://x").pathname;
        return pp === "/" || pp === "/index.html";
      } catch { return false; }
    })();
    const isPreviewJson = A.preview && target.gateway && req.method === "POST" && target.path.split("?")[0] === "/api/preview";
    if (isPreviewJson) {
      const chunks = [];
      let n = 0;
      upRes.on("data", (c) => {
        n += c.length;
        if (n > 2 * 1024 * 1024) { upRes.destroy(); return; }
        chunks.push(c);
      });
      upRes.on("end", () => {
        let body = Buffer.concat(chunks);
        try {
          const j = JSON.parse(body.toString("utf8"));
          if (typeof j.url === "string") j.url = rewritePreviewUrl(j.url, req.headers.host);
          body = Buffer.from(JSON.stringify(j));
        } catch {}
        const h = cleanHeaders(upRes.headers);
        delete h["content-encoding"];
        h["content-length"] = body.length;
        h["cache-control"] = "no-store";
        head(res, upRes.statusCode || 502, upRes.statusMessage, h);
        res.end(body);
      });
      upRes.on("error", () => { try { res.destroy(); } catch {} });
      return;
    }
    // 网关的 index.html 不带 PWA meta；在这里注入，让 iPadOS 16 的主屏幕 Web App 也无框。
    if (appHtml && !upRes.headers["content-encoding"] && /\btext\/html\b/i.test(String(upRes.headers["content-type"] || ""))) {
      const chunks = [];
      let n = 0;
      upRes.on("data", (c) => {
        n += c.length;
        if (n > 4 * 1024 * 1024) { upRes.destroy(); return; }
        chunks.push(c);
      });
      upRes.on("end", () => {
        let body = Buffer.concat(chunks);
        try { body = Buffer.from(injectAppMeta(body.toString("utf8")), "utf8"); } catch {}
        const h = cleanHeaders(upRes.headers);
        delete h["content-encoding"];
        h["content-length"] = body.length;
        h["cache-control"] = "no-store";
        head(res, upRes.statusCode || 502, upRes.statusMessage, h);
        res.end(body);
      });
      upRes.on("error", () => { try { res.destroy(); } catch {} });
      return;
    }
    head(res, upRes.statusCode || 502, upRes.statusMessage, cleanHeaders(upRes.headers));
    res.flushHeaders();
    upRes.pipe(res);
    upRes.on("error", () => { try { res.destroy(); } catch {} });
  });

  upReq.on("error", (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`上游连不上：${e.message}\n`);
    } else try { res.destroy(); } catch {}
  });
  res.on("close", () => { if (!res.writableEnded) { try { upReq.destroy(); } catch {} } });
  req.on("aborted", () => { try { upReq.destroy(); } catch {} });
  req.pipe(upReq);
}

// ── 服务 ──────────────────────────────────────────────────────────────
function startServer(A) {
  const UP = new URL(A.upstream);
  const UP_HOST = `${UP.hostname}:${UP.port || (UP.protocol === "https:" ? 443 : 80)}`;
  const GW_ORIGIN = `${UP.protocol}//${UP_HOST}`;
  LOCAL_LISTEN.ok = false;
  LOCAL_LISTEN.error = "";
  let localServer = null;

  const handle = async (req, res) => {
    try {
    let u;
    try { u = new URL(req.url, `http://${req.headers.host || "x"}`); } catch { return deny(res, 400, "bad"); }
    const host = req.headers.host || "";
    const p = u.pathname;

    // 登录页永远不需要先登录
    if (p === "/__login") return serveLogin(req, res, u, host, A);

    // Web App 清单：公开（不含秘密），供 iPadOS 主屏幕 Web App 使用
    if (p === APP_MANIFEST_PATH && req.method === "GET") {
      const b = Buffer.from(JSON.stringify(APP_MANIFEST));
      res.writeHead(200, {
        "content-type": "application/manifest+json; charset=utf-8",
        "content-length": b.length,
        "cache-control": "no-store",
      });
      return res.end(b);
    }

    // rt 兼容/恢复入口
    const rt = u.searchParams.get("rt");
    if (rt !== null) {
      const auth = AUTH.read();
      const allowed = auth.allowRt || auth.mode === "rt";
      const q = new URLSearchParams(u.searchParams);
      q.delete("rt");
      const rest = q.toString();
      const next = u.pathname + (rest ? "?" + rest : "");
      if (!allowed) return redirectLogin(res, next, "rt");
      if (!eq(rt, auth.token)) return deny(res, 401, "auth");
      res.setHeader("Set-Cookie", sessionCookie(A, newSession(A.cookieDays)));
      res.writeHead(302, { location: next, "cache-control": "no-store", "referrer-policy": "no-referrer" });
      return res.end();
    }

    // 未登录：页面跳登录页，API 回 401（页面刷新后就会进登录页）
    if (!authOk(req, A)) {
      if (wantsHtml(req, p)) return redirectLogin(res, req.url, "");
      return sendJson(res, 401, { error: "unauthorized" });
    }

    // 挡 CSRF：带 Origin 的请求必须来自本代理自己的页面
    if (!originOk(req.headers.origin, host, A, req, { authed: true })) {
      logLine(`403 origin=${req.headers.origin ?? "-"} host=${host} sfs=${req.headers["sec-fetch-site"] || "-"} path=${req.url}`);
      return deny(res, 403, "origin");
    }
    if (!host) return deny(res, 400, "bad");

    // 设置页：/__settings 和 /__settings/api
    if (p === SETTINGS_PATH || p === SETTINGS_PATH + "/") {
      if (req.method !== "GET") return deny(res, 405, "bad");
      return serveSettings(req, res);
    }
    if (p === SETTINGS_API) return serveSettingsApi(req, res, u, A);

    // 预览（默认关）
    if (!A.preview) {
      if (/^\/__p\//.test(req.url) || refererPreviewPort(req.headers.referer)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        return res.end("preview disabled\n");
      }
    } else {
      const pm = /^\/__p\/(\d+)(\/[^]*)?$/.exec(req.url);
      if (pm) {
        const port = Number(pm[1]);
        if (port < 1 || port > 65535) return deny(res, 400, "bad");
        return forward(req, res, { gateway: false, preview: true, port, path: pm[2] || "/" }, A, UP, UP_HOST, GW_ORIGIN);
      }
      const rp = refererPreviewPort(req.headers.referer);
      if (rp) return forward(req, res, { gateway: false, preview: true, port: rp, path: req.url }, A, UP, UP_HOST, GW_ORIGIN);
    }

    return forward(req, res, { gateway: true, preview: false, path: req.url }, A, UP, UP_HOST, GW_ORIGIN);
    } catch (e) {
      logLine("请求处理异常：" + (e.message || e));
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else try { res.destroy(); } catch {}
    }
  };

  const server = http.createServer(handle);
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 65000;
  server.timeout = 0;
  server.on("clientError", (e, sock) => { try { sock.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {} });
  server.on("error", (e) => {
    logLine(e.code === "EADDRINUSE" ? `端口 ${A.port} 已被占用` : `服务错误：${e.message}`);
    process.exit(1);
  });

  server.listen({ port: A.port, host: A.host, ipv6Only: false }, () => {
    const rt = { authProtocol: 1, pid: process.pid, host: A.host, port: A.port, publicHost: A.publicHost, cookieDays: A.cookieDays, preview: A.preview, allowRt: A.allowRt, urlFile: A.urlFile, upstream: A.upstream, tokenFile: A.tokenFile, startedAt: Date.now() };
    atomicWrite(F.pid, String(process.pid) + "\n", 0o600);
    writeJson(F.runtime, rt);
    let url = "";
    try { url = writeUrlFile(A); } catch {}
    console.log(`[cc-remote] 监听 ${A.host}:${A.port} → ${A.upstream}`);
    console.log(`[cc-remote] 对外地址 ${A.publicHost}:${A.port}  认证=${readPass() ? "口令" : "rt"}`);
    console.log(`[cc-remote] 地址文件 ${A.urlFile}`);
    if (url && !url.includes("?rt=")) console.log(`[cc-remote] ${url}`);
    if (A.host === "127.0.0.1" || A.host === "localhost" || A.host === "0.0.0.0" || A.host === "::") LOCAL_LISTEN.ok = true;
  });

  // 手机本机设置入口：绑 127.0.0.1 的同一个端口；只给本机应用/浏览器用。
  if (A.host !== "127.0.0.1" && A.host !== "localhost" && A.host !== "0.0.0.0" && A.host !== "::") {
    const local = http.createServer(handle);
    local.requestTimeout = 0;
    local.headersTimeout = 60000;
    local.keepAliveTimeout = 65000;
    local.timeout = 0;
    local.on("clientError", (e, sock) => { try { sock.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {} });
    local.on("error", (e) => { LOCAL_LISTEN.ok = false; LOCAL_LISTEN.error = e.message; logLine(`本地设置监听失败：${e.message}`); });
    local.listen(A.port, "127.0.0.1", () => {
      LOCAL_LISTEN.ok = true;
      LOCAL_LISTEN.error = "";
      console.log(`[cc-remote] 本机设置 http://127.0.0.1:${A.port}/__settings`);
    });
    localServer = local;
  }

  function bye() {
    try { server.close(); } catch {}
    if (localServer) { try { localServer.close(); } catch {} }
    try {
      if (readPid() === process.pid) fs.unlinkSync(F.pid);
      const r = readRuntime();
      if (r && Number(r.pid) === process.pid) fs.unlinkSync(F.runtime);
    } catch {}
    setTimeout(() => process.exit(0), 300).unref();
  }
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

// ── 启动 / 停止 ───────────────────────────────────────────────────────
function spawnDetached(argv) {
  const nc = nodeCmd(argv);
  try {
    const sp = spawn(nc.cmd, nc.args, { detached: true, stdio: "ignore", env: process.env, cwd: path.dirname(MANAGER) });
    sp.unref();
  } catch {}
}

function spawnRun(A, { quiet = false } = {}) {
  const opts = [
    "run",
    "--host", A.host,
    "--port", String(A.port),
    "--public-host", A.publicHost,
    "--cookie-days", String(A.cookieDays),
    "--url-file", A.urlFile,
    "--upstream", A.upstream,
    "--token-file", A.tokenFile,
    A.preview ? "--preview" : "--no-preview",
    A.allowRt ? "--allow-rt" : "--no-allow-rt",
  ];
  const nc = nodeCmd([MANAGER, ...opts]);
  let fd = -1;
  try { fd = fs.openSync(F.log, "a"); } catch {}
  const sp = spawn(nc.cmd, nc.args, {
    detached: true,
    stdio: fd >= 0 ? ["ignore", fd, fd] : "ignore",
    env: process.env,
    cwd: path.dirname(MANAGER),
  });
  sp.unref();
  if (fd >= 0) { try { fs.closeSync(fd); } catch {} }
  return sp.pid;
}

async function startProxy(args, { quiet = false } = {}) {
  const cfg = loadConfig();
  const A = makeOptions(args, cfg, { fallbackLocal: true });
  const rt = running();
  if (rt) {
    if (!quiet) console.log(`已在运行：pid=${rt.pid}  http://${urlHost(rt.publicHost || A.publicHost)}:${rt.port || A.port}/`);
    return true;
  }
  if (A.degraded) {
    if (!quiet) console.log("没有 Wi-Fi 的 IPv4 地址：先只监听 127.0.0.1（本机设置页可用）；连上 Wi-Fi 后看门狗会自动切到局域网地址。");
  }
  if (A.host === "0.0.0.0" && !quiet) {
    console.log("注意：监听所有接口（0.0.0.0）——包括蜂窝 / 热点 / VPN。口令要够强，网络要可信。");
  }
  if (await portInUse(A.host, A.port)) {
    if (!quiet) console.log(`端口 ${A.port} 已被占用（可能是旧实例）；先 stop 或换端口。`);
    else logLine(`ensure: 端口 ${A.port} 已被占用，跳过`);
    return false;
  }
  spawnRun(A, { quiet });
  for (let i = 0; i < 50; i++) {
    await sleep(60);
    if (running()) break;
    if (await portInUse(A.host, A.port)) break;
  }
  // 端口可能先开、PID/runtime 后写；再等一小会儿，避免把已启动误报成失败
  let now = running();
  if (!now) {
    for (let i = 0; i < 40 && !now; i++) { await sleep(50); now = running(); }
  }
  if (!quiet) {
    if (now) console.log(`已启动：pid=${now.pid}  http://${urlHost(A.publicHost)}:${A.port}/`);
    else console.log(`启动失败，看看日志：${F.log}`);
    if (!readPass()) console.log(`认证方式：rt（还没设置口令）。地址文件：${A.urlFile}`);
    else console.log(`认证方式：口令。地址文件：${A.urlFile}`);
  }
  return !!now;
}

async function killProxy() {
  const rt = running();
  const pid = rt ? rt.pid : readPid();
  if (!pid || !isAlive(pid)) {
    try { fs.unlinkSync(F.pid); } catch {}
    try { fs.unlinkSync(F.runtime); } catch {}
    return false;
  }
  try { process.kill(pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 30; i++) {
    if (!isAlive(pid)) break;
    await sleep(100);
  }
  if (isAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} await sleep(150); }
  try { if (readPid() === pid) fs.unlinkSync(F.pid); } catch {}
  try { const r = readRuntime(); if (r && Number(r.pid) === pid) fs.unlinkSync(F.runtime); } catch {}
  return true;
}

// ── 自启 ──────────────────────────────────────────────────────────────
function appServerPath() { return path.join(APP_DIR, "server.mjs"); }
function autostartInfo() {
  const a = readJson(F.autostart, null);
  let appended = false;
  try { appended = fs.readFileSync(appServerPath(), "utf8").includes(MARK); } catch {}
  return { a, appended };
}
function checkServerSyntax(file) {
  const nc = nodeCmd(["--check", file]);
  const r = spawnSync(nc.cmd, nc.args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "server.mjs 语法检查失败").trim().slice(0, 800));
}
const OLD_BLOCK_RE = /\/\/ ===== cc-remote autostart v\d+[\s\S]*$/;
function appendAutostart() {
  const file = appServerPath();
  if (!fs.existsSync(file)) throw new Error(`找不到 ${file}（不是 cccodroid 环境？）`);
  let src = fs.readFileSync(file, "utf8");
  if (src.includes(MARK)) return "unchanged";
  const had = OLD_BLOCK_RE.test(src);
  const before = src;
  const mode = (() => { try { return fs.statSync(file).mode & 0o777; } catch { return 0o600; } })();
  if (!had) { try { atomicWrite(file + ".ccremote-orig", src, mode); } catch {} }
  // 旧版本的看门狗块整段替换掉，避免两份块各跑一个定时器
  src = src.replace(OLD_BLOCK_RE, "").replace(/\s*$/, "") + "\n" + AUTOSTART_BLOCK + "\n";
  atomicWrite(file, src, mode);
  try { checkServerSyntax(file); }
  catch (e) {
    try { atomicWrite(file, before, mode); } catch {}
    throw e;
  }
  return had ? "updated" : "added";
}
function removeAutostart() {
  const file = appServerPath();
  try {
    const src = fs.readFileSync(file, "utf8");
    const i = src.search(/\/\/ ===== cc-remote autostart v\d+/);
    if (i >= 0) {
      const mode = fs.statSync(file).mode & 0o777;
      atomicWrite(file, src.slice(0, i).replace(/\s*$/, "") + "\n", mode);
      checkServerSyntax(file);
    }
  } catch {}
  try { fs.unlinkSync(file + ".ccremote-orig"); } catch {}
}

// ── 口令输入 ──────────────────────────────────────────────────────────
function readLineStdin() {
  return new Promise((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    const onData = (d) => {
      s += d;
      const i = s.indexOf("\n");
      if (i >= 0) { cleanup(); resolve(s.slice(0, i).replace(/\r$/, "")); }
    };
    const onEnd = () => { cleanup(); resolve(s.replace(/\r?\n$/, "")); };
    const cleanup = () => { process.stdin.off("data", onData); process.stdin.off("end", onEnd); };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}
function readHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return readLineStdin().then(resolve);
    process.stdout.write(prompt);
    let s = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch) => {
      for (const c of String(ch)) {
        if (c === "\r" || c === "\n") { cleanup(); process.stdout.write("\n"); resolve(s); return; }
        if (c === "\u0003") { cleanup(); process.stdout.write("\n"); process.exit(130); }
        if (c === "\u007f" || c === "\b") { s = s.slice(0, -1); continue; }
        if (c < " " || c === "\u001b") continue;
        s += c;
      }
    };
    const cleanup = () => { try { stdin.setRawMode(false); } catch {}; stdin.pause(); stdin.off("data", onData); };
    stdin.on("data", onData);
  });
}

// ── 命令 ──────────────────────────────────────────────────────────────
async function cmdSetPassword(args) {
  let pw, pw2;
  if (args.stdin || !process.stdin.isTTY) {
    pw = await readLineStdin();
    pw2 = pw;
  } else {
    pw = await readHidden("新口令: ");
    pw2 = await readHidden("再输一次: ");
  }
  pw = String(pw);
  if (!pw) throw new Error("口令不能为空");
  if (pw.length < 6) throw new Error("口令至少 6 位");
  if (pw !== pw2) throw new Error("两次输入不一致");
  savePassword(pw);
  let url = "";
  try { url = writeUrlFile(currentOptions()); } catch {}
  logLine("口令已设置，旧会话失效");
  console.log("口令已设置（只存 scrypt 哈希，0600）。旧会话和旧 rt Cookie 已失效。");
  if (pw.length < 12) console.log("提示：口令较短，建议之后换成更长的短语。");
  if (url) console.log("访问地址：" + (url.includes("?rt=") ? "（仍含 rt；可 set-allow-rt off + restart 关掉）" : url));
}

function cmdClearPassword() {
  clearPassword();
  let url = "";
  try { url = writeUrlFile(currentOptions()); } catch {}
  logLine("口令已清除");
  console.log("口令已清除；所有会话失效。现在回到 rt 模式。");
  if (url) console.log("rt 地址已写入地址文件。");
}

function cmdStatus() {
  const cfg = loadConfig();
  const run = running();
  const rt = (run && run.host) ? run : (readRuntime() || null);
  const alive = !!run;
  const pid = run ? run.pid : 0;
  const paused = fs.existsSync(F.paused);
  const pass = !!readPass();
  const { a, appended } = autostartInfo();
  const mode = pass ? "口令" : "rt";
  const auto = !cfg.host || cfg.host === "auto";
  const noLan = auto && !lanIP();
  console.log(`代理：${alive ? "运行中 pid=" + pid : "未运行"}`);
  const listenLabel = rt ? (rt.host === "0.0.0.0" ? "所有接口 (0.0.0.0)" : rt.host) : "";
  if (rt) console.log(`监听：${listenLabel}:${rt.port}  对外 http://${rt.publicHost}:${rt.port}/${alive && noLan && isLoopback(rt.host) ? "  （未连 Wi-Fi，仅本机；连上后自动切到局域网地址）" : ""}`);
  if (noLan) console.log(`提示：host=auto 但当前没有 Wi-Fi IPv4（没连 Wi-Fi？）；${alive ? "现只监听本机" : "看门狗会先只监听 127.0.0.1"}，Wi-Fi 恢复后自动切回局域网地址`);
  console.log(`认证：${mode}   Cookie：${rt ? rt.cookieDays : cfg.cookieDays} 天   预览：${(rt ? rt.preview : cfg.preview) ? "开" : "关"}   rt 恢复链接：${(rt ? rt.allowRt : cfg.allowRt) ? "开" : "关"}`);
  console.log(`暂停：${paused ? "是（看门狗不会拉起）" : "否"}`);
  console.log(`自启：${a && appended ? "已安装（网关启动 + 60 秒看门狗）" : a && !appended ? "需要 repair（App 更新覆盖了 server.mjs）" : !a && appended ? "server.mjs 里有块但配置缺失，重跑 install-autostart" : "未安装"}`);
  console.log(`地址文件：${(rt ? rt.urlFile : cfg.urlFile)}`);
  console.log(`日志：${F.log}`);
  if (!alive) {
    const h = rt ? rt.host : resolveHost(cfg.host);
    if (h) portInUse(h, rt ? rt.port : cfg.port).then((used) => { if (used) console.log(`注意：端口 ${rt ? rt.port : cfg.port} 仍被其他进程占用`); });
  }
}

async function cmdStart(args) {
  try { fs.unlinkSync(F.paused); } catch {}
  await startProxy(args);
}

async function cmdStop() {
  atomicWrite(F.paused, String(Date.now()) + "\n", 0o600);
  const had = await killProxy();
  console.log(had ? "已停止；看门狗暂停。下次 start 会恢复。" : "没有在跑的代理；已写入暂停标记。");
}

async function cmdRestart(args) {
  try { fs.unlinkSync(F.paused); } catch {}
  await killProxy();
  await sleep(200);
  await startProxy(args);
}

async function cmdEnsure() {
  if (fs.existsSync(F.paused)) return;
  const cfg = loadConfig();
  const auto = !cfg.host || cfg.host === "auto";
  const rt = running();
  if (rt) {
    // A proxy can survive a gateway-only upgrade. Load the new shared auth
    // reader once before enabling the new authentication controls.
    if (rt.authProtocol !== 1) {
      logLine("ensure: 更新认证代理，保留已有认证状态");
      await killProxy();
      await sleep(200);
      spawnRun(makeOptions({}, cfg, { fallbackLocal: true }), { quiet: true });
      return;
    }
    // host=auto：Wi-Fi 地址会变（连上 / 断开 / 换网）。地址配不上就重启，让监听跟着走。
    if (auto) {
      const want = lanIP() || "127.0.0.1";
      const cur = String(rt.host || "");
      // 只有明确的 IPv4 地址消失时才认为过期；主机名/手动 --host 不在这里覆盖
      const stale = net.isIP(cur) === 4 && !interfaceHasIPv4(cur);
      if (cur && want !== cur && (isLoopback(cur) || stale)) {
        logLine(`ensure: 监听地址 ${cur} → ${want}，重启代理`);
        await killProxy();
        await sleep(200);
        try { spawnRun(makeOptions({}, cfg, { fallbackLocal: true }), { quiet: true }); }
        catch (e) { logLine("ensure: " + e.message); }
      }
    }
    return;
  }
  let A;
  try { A = makeOptions({}, cfg, { fallbackLocal: true }); } catch (e) { logLine("ensure: " + e.message); return; }
  if (A.degraded) logLine("ensure: 没有 Wi-Fi 的 IPv4 地址，先只监听 127.0.0.1；连上 Wi-Fi 后自动切到局域网地址");
  if (await portInUse(A.host, A.port)) { logLine("ensure: 端口已被占用，跳过"); return; }
  spawnRun(A, { quiet: true });
}

function cmdUrl() {
  const A = currentOptions();
  const url = writeUrlFile(A);
  console.log(url.includes("?rt=") ? url + "\n（含 rt 口令）" : url);
}

function cmdLogs() {
  try {
    const b = fs.readFileSync(F.log);
    const s = b.slice(Math.max(0, b.length - 12000)).toString("utf8");
    process.stdout.write(s);
  } catch { console.log("还没有日志：" + F.log); }
}

function setCfg(fn) {
  const c = loadConfig();
  fn(c);
  saveConfig(c);
  console.log("已保存。正在运行的代理需要 restart 才生效。");
}
function onOff(v, name) {
  const s = String(v || "").toLowerCase();
  if (["on", "1", "true", "yes"].includes(s)) return true;
  if (["off", "0", "false", "no"].includes(s)) return false;
  throw new Error(`${name} 要 on 或 off`);
}

async function installAutostart(args) {
  if (args["app-dir"]) APP_DIR = path.resolve(args["app-dir"]);
  const created = appendAutostart();
  writeJson(F.autostart, { enabled: true, manager: MANAGER, appDir: APP_DIR, installedAt: Date.now() });
  console.log(created === "added" ? "已把看门狗挂到 cccodroid 的 server.mjs 末尾。"
    : created === "updated" ? "已把旧版看门狗替换成 v2（会跟踪 Wi-Fi 地址变化）。"
    : "看门狗已经是最新的。");
  console.log("下次 cccodroid 网关启动时生效（重开 App / 重启手机）。当前代理不受影响。");
  if (!running() && !fs.existsSync(F.paused)) {
    console.log("正在顺手启动代理…");
    try { await startProxy(args); } catch (e) { console.log("代理没起来：" + e.message); }
  }
  console.log("App 更新覆盖 server.mjs 后运行：node " + MANAGER + " repair");
}
function uninstallAutostart(args) {
  if (args["app-dir"]) APP_DIR = path.resolve(args["app-dir"]);
  try { const a = readJson(F.autostart, null); if (a && a.appDir && !args["app-dir"]) APP_DIR = a.appDir; } catch {}
  removeAutostart();
  try { fs.unlinkSync(F.autostart); } catch {}
  // 已启动的网关进程里可能还留着内存中的旧看门狗；写暂停标记让它立刻停手
  atomicWrite(F.paused, String(Date.now()) + "\n", 0o600);
  console.log("已卸载自启；已写入暂停标记，让还在内存里的旧看门狗停手。当前代理进程如果还在，用 stop 停掉。");
}
function repairAutostart(args) {
  const a = readJson(F.autostart, null);
  if (!a) throw new Error("还没安装自启；先 install-autostart");
  APP_DIR = args["app-dir"] ? path.resolve(args["app-dir"]) : (a.appDir || DEFAULT_APP_DIR);
  const created = appendAutostart();
  writeJson(F.autostart, { ...a, enabled: true, manager: MANAGER, appDir: APP_DIR, repairedAt: Date.now() });
  console.log(created === "added" ? "已重新挂上；下次网关启动生效。"
    : created === "updated" ? "已把旧版看门狗替换成 v2（会跟踪 Wi-Fi 地址变化）；下次网关启动生效。"
    : "不需要 repair，server.mjs 里的看门狗已经是最新的。");
  if (created !== "unchanged") console.log("正在运行的网关进程里还是旧块：重开 cccodroid / 下次网关启动后生效。");
}

function help() {
  console.log(`cc-remote —— cccodroid 远程访问工具链

  node ${MANAGER} set-password          设置/修改口令（隐藏输入；--stdin 从管道读）
  node ${MANAGER} start [选项]          启动代理（后台）
  node ${MANAGER} stop                  停止代理；同时暂停看门狗
  node ${MANAGER} restart [选项]        重启代理（不暂停看门狗）
  node ${MANAGER} status                查看状态
  node ${MANAGER} url                   打印/刷新 iPad 访问地址
  node ${MANAGER} logs                  看最近日志
  node ${MANAGER} config                看配置
  node ${MANAGER} install-autostart     挂到 cccodroid 网关启动处 + 60 秒看门狗
  node ${MANAGER} repair                App 更新后重新挂上
  node ${MANAGER} uninstall-autostart   卸掉自启
  node ${MANAGER} clear-password        清除口令，回到 rt 模式

  选项：--host <auto|IP|主机名>  --port <端口>  --cookie-days <天数>
        --preview / --no-preview   --allow-rt / --no-allow-rt
        --public-host <主机名>     --url-file <路径>     --app-dir <路径>

  配置文件：${F.config}
  认证状态：${AUTH.file}（口令仅存 scrypt 哈希，0600）
  地址文件：${loadConfig().urlFile}
`);
}

// ── 入口 ──────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["app-dir"]) APP_DIR = path.resolve(args["app-dir"]);
  const cmd = args._[0] || (args.help ? "help" : "help");
  switch (cmd) {
    case "help":
    case "--help":
      return help();
    case "run": {
      const A = makeOptions(args);
      return startServer(A);
    }
    case "start": return cmdStart(args);
    case "stop": return cmdStop();
    case "restart": return cmdRestart(args);
    case "ensure": return cmdEnsure();
    case "status": return cmdStatus();
    case "url": return cmdUrl();
    case "logs": return cmdLogs();
    case "set-password": return cmdSetPassword(args);
    case "clear-password": return cmdClearPassword();
    case "install-autostart": return installAutostart(args);
    case "uninstall-autostart": return uninstallAutostart(args);
    case "repair": return repairAutostart(args);
    case "config": console.log(JSON.stringify(loadConfig(), null, 1)); return;
    case "set-host": return setCfg((c) => { c.host = args._[1] || "auto"; });
    case "set-port": return setCfg((c) => { const p = Number(args._[1]); if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("端口不对"); c.port = p; });
    case "set-cookie-days": return setCfg((c) => { const d = Number(args._[1]); if (!Number.isFinite(d) || d <= 0) throw new Error("天数不对"); c.cookieDays = d; });
    case "set-preview": return setCfg((c) => { c.preview = onOff(args._[1], "preview"); });
    case "set-allow-rt": { const enabled = onOff(args._[1], "allow-rt"); const auth = AUTH.read(); AUTH.replace({ allowRt: enabled }, auth.revision); return setCfg((c) => { c.allowRt = enabled; }); }
    case "set-public-host": return setCfg((c) => { c.publicHost = args._[1] || ""; });
    case "set-url-file": return setCfg((c) => { c.urlFile = path.resolve(args._[1] || DEFAULT_URL_FILE); });
    default:
      console.error("未知命令：" + cmd);
      help();
      process.exit(2);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === MANAGER) main().catch((e) => { console.error("cc-remote: " + (e && e.message || e)); process.exit(1); });

// 网关内置入口：沿用宿主 token / Origin 校验，不要求用户再次输入远程口令。
let managedPending = Promise.resolve();
function managedSerial(fn) {
  const next = managedPending.then(fn, fn);
  managedPending = next.catch(() => {});
  return next;
}
export function startManagedRemote() {
  let busy = false;
  const tick = async () => {
    // 只记住远程服务的开关；旧自启配置仅用于首次兼容，页面不再管理第二套开关。
    const cfg = loadConfig();
    const enabled = typeof cfg.enabled === "boolean" ? cfg.enabled : !!readJson(F.autostart, null)?.enabled;
    if (busy || !enabled) return;
    busy = true;
    try { await managedSerial(() => cmdEnsure()); } catch (e) { logLine("内置看门狗：" + e.message); }
    finally { busy = false; }
  };
  tick();
  const timer = setInterval(tick, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
export async function managedRemoteRoute(req, res, u, p) {
  if (p === "/api/remote/page" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      "referrer-policy": "no-referrer",
    });
    return res.end(settingsHtml());
  }
  if (p !== "/api/remote/control") return false;
  // 全部操作仍由原设置 API 校验 CSRF。停代理不会停止网关上的管理页。
  return managedSerial(() => serveSettingsApi(req, res, u, currentOptions()));
}
