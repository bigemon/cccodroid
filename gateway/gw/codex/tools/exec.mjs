// 宿主进程引擎：argv 默认不经 shell；自由命令由已授权工具显式传给 shell。
// 同一套输出限额、取消、超时及子进程清理供固定工具与命令会话使用。
import { spawn } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { toolContext } from "./context.mjs";

export function procInfo(pid) {
  try {
    const raw = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { pid: Number(pid), state: f[0], ppid: Number(f[1]), group: Number(f[2]), start: f[19] };
  } catch { return null; }
}

export function startProcess({ cmd, args = [], cwd, env = null, timeoutMs = 15000, maxBytes = 256 * 1024,
  stdin = null, control = false, signal = toolContext.getStore()?.signal, inheritEnv = true, onOutput = () => {}, onPid = toolContext.getStore()?.onPid || (() => {}), onReap = toolContext.getStore()?.onReap || (() => {}) } = {}) {
  const started = Date.now(), marker = crypto.randomUUID();
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  let output = { stdout: "", stderr: "" }, total = { stdout: 0, stderr: 0 }, truncated = false;
  let reason = null, settled = false, root = null, timer = null, killer = null, monitor = null, lastScan = 0;
  const known = new Map();
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  toolContext.getStore()?.trackProcess?.(done);
  function remember(p) {
    if (p && known.get(p.pid)?.start !== p.start) { known.set(p.pid, p); onPid(p.pid); }
  }
  const owns = p => {
    try { return ("\0" + fs.readFileSync("/proc/" + p.pid + "/environ", "latin1")).includes("\0CCAPP_COMMAND_ID=" + marker + "\0"); }
    catch { return false; }
  };
  function discover() {
    // 以不可猜测的命令标记识别 setsid 后或已被 reparent 的普通子进程。
    let ids = []; try { ids = fs.readdirSync("/proc"); } catch {}
    const all = ids.filter(x => /^\d+$/.test(x)).map(procInfo).filter(Boolean);
    const rootAlive = root && procInfo(root.pid)?.start === root.start;
    for (const p of all) if ((rootAlive && p.group === root.pid) || owns(p)) remember(p);
    // argv 工具可能清空环境；父子链作为额外识别依据。
    const byPid = new Map(all.map(p => [p.pid, p]));
    let changed = true;
    while (changed) { changed = false; for (const p of all) if (known.get(p.pid)?.start !== p.start && known.has(p.ppid) && byPid.get(p.ppid)?.start === known.get(p.ppid).start) { remember(p); changed = true; } }
  }
  function killOwned(sig) {
    discover();
    for (const p of [...known.values()].reverse()) {
      const current = procInfo(p.pid);
      if (current?.start !== p.start || current.state === "Z") continue;
      try { process.kill(p.pid, sig); } catch {}
    }
  }
  function stop(why = "cancelled") {
    if (settled || reason) return done;
    reason = why;
    killOwned("SIGTERM");
    killer = setTimeout(() => killOwned("SIGKILL"), 300); killer.unref?.();
    return done;
  }
  function take(kind, text) {
    if (!text) return;
    total[kind] += Buffer.byteLength(text);
    output[kind] += text;
    const b = Buffer.from(output[kind]);
    if (b.length > maxBytes) {
      let cut = b.length - maxBytes;
      while (cut < b.length && (b[cut] & 0xc0) === 0x80) cut++;
      output[kind] = b.subarray(cut).toString("utf8"); truncated = true;
    }
    // 首次输出前登记已出现的子进程：宿主崩溃会使管道 EPIPE，根进程可能先退出。
    if (!settled && Date.now() - lastScan > 250) { discover(); lastScan = Date.now(); }
    onOutput(kind, text);
  }
  function finish(code, sig, error = null) {
    if (settled) return;
    killOwned("SIGKILL"); // 命令退出不允许留下重定向到 /dev/null 的隐式 daemon。
    settled = true; clearTimeout(timer); clearTimeout(killer); clearInterval(monitor);
    signal?.removeEventListener("abort", abort);
    for (const kind of ["stdout", "stderr"]) take(kind, decoders[kind].end());
    for (const p of known.values()) { const current = procInfo(p.pid); if (!current || current.start === p.start) onReap(p.pid); }
    resolveDone({ cmd, args, code, signal: sig, timedOut: reason === "timeout", aborted: reason != null && reason !== "timeout",
      terminationReason: reason, truncated, ...output, stdoutBytes: total.stdout, stderrBytes: total.stderr,
      ms: Date.now() - started, error: error ? String(error.message || error) : null });
  }
  function abort() { stop("cancelled"); }
  if (signal?.aborted) {
    settled = true;
    resolveDone({ cmd, args, code: null, signal: null, timedOut: false, aborted: true, terminationReason: "cancelled",
      truncated: false, stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, ms: 0, error: "cancelled before spawn" });
    return { done, stop: () => done, write: () => { throw new Error("Process is not running"); }, get pid() { return null; } };
  }
  const child = spawn(cmd, args, {
    cwd, env: { ...(inheritEnv ? process.env : {}), ...env, ...toolContext.getStore()?.processEnv, CCAPP_COMMAND_ID: marker }, detached: true,
    stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe", ...(control?["pipe"]:[])],
  });
  root = procInfo(child.pid); remember(root);
  child.stdout?.on("data", b => take("stdout", decoders.stdout.write(b)));
  child.stderr?.on("data", b => take("stderr", decoders.stderr.write(b)));
  child.stdin?.on("error", () => {});
  child.stdio[3]?.on("error",()=>{});
  if (typeof stdin === "string" || Buffer.isBuffer(stdin)) child.stdin?.end(stdin);
  child.once("exit", () => discover());
  child.once("error", err => finish(null, null, err));
  child.once("close", (code, sig) => finish(code, sig));
  if(timeoutMs!==null){timer = setTimeout(() => stop("timeout"), Math.max(1, timeoutMs)); timer.unref?.();}
  // 即使 shell 提前退出，仍登记继承输出管道的子进程，以供网关重启清理。
  monitor = setInterval(discover, 1000); monitor.unref?.();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    done, stop,
    get pid() { return child.pid || null; },
    resize(rows,cols){if(!control||settled||reason||!child.stdio[3]?.writable)throw new Error("PTY is not running");child.stdio[3].write(rows+" "+cols+"\n");},
    write(text, eof = false) {
      if (settled || reason || child.stdin?.destroyed || !child.stdin?.writable) throw new Error("Process stdin is closed");
      if (eof) child.stdin.end(text); else child.stdin.write(text);
    },
  };
}

export function runProcess(options) { return startProcess(options).done; }

/** 在 PATH 里找可执行文件（不调用 shell 的 which） */
export function which(cmd, pathEnv = process.env.PATH || "") {
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const full = dir + "/" + cmd;
    try { fs.accessSync(full, fs.constants.X_OK); return full; } catch {}
  }
  return null;
}
