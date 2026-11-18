import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { CFG, HERE, LIVE, PREFIX, log } from "./config.mjs";
import { termEnv } from "./terminal.mjs";
import { privCall } from "./usage.mjs";
import { createShizukuTcp } from "./shizuku-tcp-core.mjs";
import { localAdbTls, localPortOpen } from "./shizuku-adb-probe.mjs";
import { adbCommand } from "./shizuku-adb-command.mjs";

const file = path.join(CFG.home, "shizuku-tcp.json");
function run(binary, args, timeout = 12000, env = termEnv()) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { env, cwd: CFG.home, timeout, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => error
        ? reject(new Error(String(stderr || stdout || error.message).trim().slice(0, 300)))
        : resolve(String(stdout)));
  });
}
export const shizukuTcp = createShizukuTcp({
  read() { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } },
  write(value) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  },
  status: () => privCall({ op: "status" }, 5000),
  adb: args => {
    if (!PREFIX) throw new Error("当前实例没有 Android ADB 工具包");
    const binary = path.join(PREFIX, "bin", "adb");
    const env = termEnv();
    if (shizukuTcp.snapshot().listenerType === "unix") {
      const dir = path.join(CFG.home, ".adb-control");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("ADB 私有目录不能是符号链接");
      fs.chmodSync(dir, 0o700);
      env.ADB_SERVER_SOCKET = "localfilesystem:" + path.join(dir, "server.sock");
    } else {
      env.ADB_SERVER_SOCKET = "tcp:localhost:5037";
    }
    const command = adbCommand(binary, args, env);
    return run(command.binary, command.args, 12000, command.env);
  },
  shell: command => run(process.execPath, [path.join(HERE, "bin", "priv.mjs"), command]),
  async openWireless() {
    const shell = command => run(process.execPath, [path.join(HERE, "bin", "priv.mjs"), command]);
    const original = (await shell("settings get global adb_wifi_enabled")).trim();
    if (original === "1") return async () => {};
    if (original !== "0") throw new Error("无法读取无线调试状态，未改动设置");
    const restore = () => shell("settings put global adb_wifi_enabled 0");
    try {
      await shell("settings put global adb_wifi_enabled 1");
      if ((await shell("settings get global adb_wifi_enabled")).trim() !== "1")
        throw new Error("系统未允许临时开启无线调试，请在开发者选项中检查");
    } catch (e) { await restore(); throw e; }
    return restore;
  },
  reachable: localPortOpen,
  tlsPort: localAdbTls,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
});
let timer = null;
export function startShizukuTcp() {
  if (!LIVE || !PREFIX || timer) return;
  timer = setInterval(() => shizukuTcp.tick().catch(e => log("Shizuku TCP:", e.message)), 15000);
  timer.unref();
}
export function stopShizukuTcp() {
  clearInterval(timer); timer = null;
}
export async function activateWithTcp() {
  const st = shizukuTcp.snapshot();
  if (st.enabled && await localPortOpen(st.port)) {
    try { await shizukuTcp.recover(); return privCall({ op: "status" }); }
    catch (e) { log("Shizuku TCP 激活失败，回退无线调试:", e.message); }
  }
  return privCall({ op: "shz_activate" });
}
