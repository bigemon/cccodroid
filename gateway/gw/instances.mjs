// 实例与子进程归属（P6-B2）
//
// 背景：旧版启动时按「PPID=1 + 环境里有 CCAPP_RUN=1 或命令行含 claude 路径」清理孤儿，
// 这套判据不区分是哪个网关拉起的。同一台设备跑两个实例（正式 8791 + 开发 8795）时，
// 开发实例启动会把它自己那一版的 P6-A 网关、代理进程一起杀掉（实测）。
//
// 现在的做法：
//   1. 每个网关启动时写 <home>/.ccapp-instance.json：{homeId, instanceId, pid, startTime, port}
//   2. 它拉起的每个子进程登记到 <home>/.ccapp-children.json：{pid, startTime, instanceId, kind}
//   3. 子进程环境里带 CCAPP_INSTANCE_ID=<instanceId>，子孙都继承
//   4. 下次启动只清「本 home 上一任实例登记过」的进程，且必须同时满足：
//        · 登记里的 homeId 等于本 home
//        · /proc/<pid> 存在、同 uid
//        · startTime 与登记一致（防 PID 复用）
//        · 环境里的 CCAPP_INSTANCE_ID 与登记一致（防串到别的实例）
//      任何一条对不上就跳过并记日志 —— 宁可留一个孤儿，也不误杀。
//   5. 没有登记信息的进程一律不碰（旧版遗留的孤儿不自动清，留给用户或后续版本处理）

import fs from "node:fs";
import path from "node:path";
import { CFG, HOME_ID, INSTANCE_ID, INSTANCE_FILE, CHILDREN_FILE, log } from "./config.mjs";

const CHILD_ENV_KEY = "CCAPP_INSTANCE_ID";

/** /proc/<pid>/stat 的第 22 列 starttime；读不到返回 null */
export function procStartTime(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    // 去掉 comm 与括号后，f[0] 是第 3 列（state），starttime 是第 22 列
    const v = Number(f[19]);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function procEnv(pid) {
  try {
    return "\0" + fs.readFileSync(`/proc/${pid}/environ`, "latin1");
  } catch {
    return "";
  }
}

function procCmd(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

function writeJson(file, obj) {
  try {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    log(`[instance] 写 ${path.basename(file)} 失败: ${err.message}`);
    return false;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadChildren() {
  const j = readJson(CHILDREN_FILE, null);
  if (j && j.version === 1 && Array.isArray(j.children)) return j;
  return { version: 1, homeId: HOME_ID, instanceId: INSTANCE_ID, children: [] };
}

function saveChildren(state) {
  writeJson(CHILDREN_FILE, state);
}

/** 登记一个子进程（spawn 之后立刻调用） */
export function registerChild(pid, kind = "child") {
  if (!pid) return;
  const st = procStartTime(pid);
  const state = loadChildren();
  state.children = state.children.filter((c) => c.pid !== pid);
  state.children.push({ pid, startTime: st, instanceId: INSTANCE_ID, homeId: HOME_ID, kind, cmd: procCmd(pid).slice(0, 120), at: Date.now() });
  saveChildren(state);
}

/** 子进程退出时注销（不是必须：下次启动会按 startTime 判定它已经不在） */
export function unregisterChild(pid) {
  if (!pid) return;
  const state = loadChildren();
  const before = state.children.length;
  state.children = state.children.filter((c) => c.pid !== pid);
  if (state.children.length !== before) saveChildren(state);
}

function descendants(root) {
  const kids = new Map();
  let names = [];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let st;
    try {
      st = fs.readFileSync(`/proc/${n}/stat`, "utf8");
    } catch {
      continue;
    }
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    const ppid = +f[1];
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(+n);
  }
  const out = [];
  const stack = [root];
  while (stack.length) {
    for (const k of kids.get(stack.pop()) || []) {
      out.push(k);
      stack.push(k);
    }
  }
  return out;
}

/**
 * 杀掉一棵属于某个实例的进程树。
 * 不再按进程组盲杀：逐个核对环境里的 CCAPP_INSTANCE_ID 才动手，
 * 避免「快照之后进程组被复用/改动」把无关进程带走。
 * 根进程在调用前已由 initInstance 校验过 startTime，这里再核对一次。
 */
function killPidTree(pid, instanceId, expectedStartTime) {
  const st = procStartTime(pid);
  if (st === null) return 0;
  if (expectedStartTime !== null && expectedStartTime !== undefined && st !== expectedStartTime) return 0;
  const tree = descendants(pid);
  const envOk = (p) => procEnv(p).includes(`\0${CHILD_ENV_KEY}=${instanceId}\0`);
  let n = 0;
  if (envOk(pid)) {
    try { process.kill(pid, "SIGKILL"); n += 1; } catch {}
  }
  for (const p of tree) {
    if (!envOk(p)) continue;
    try { process.kill(p, "SIGKILL"); n += 1; } catch {}
  }
  return n;
}

/** 这个实例文件是否指向一个仍然活着的网关进程 */
function liveInstance(rec) {
  if (!rec || !rec.pid) return false;
  const st = procStartTime(rec.pid);
  if (st === null) return false;
  if (rec.startTime != null && st !== rec.startTime) return false;
  const cmd = procCmd(rec.pid);
  return /server\.mjs/.test(cmd);
}

/** 启动时调用：清上一任登记的孤儿，然后登记本实例 */
export function initInstance({ port = null } = {}) {
  // 同一个 HOME 只允许一个网关：另一个还活着就拒绝启动，不覆盖登记（P6-B2.1 §2）
  const current = readJson(INSTANCE_FILE, null);
  if (current && current.homeId === HOME_ID && current.instanceId !== INSTANCE_ID && liveInstance(current)) {
    return { refused: true, holder: current };
  }

  const prev = loadChildren();
  const uid = process.getuid?.();

  if (prev.homeId && prev.homeId !== HOME_ID) {
    log(`[instance] 忽略其他 home 的子进程记录（${prev.homeId} ≠ ${HOME_ID}）`);
  } else {
    for (const c of prev.children) {
      const why = (() => {
        if (c.homeId !== HOME_ID) return "home-mismatch";
        const st = procStartTime(c.pid);
        if (st === null) return "gone";
        if (c.startTime !== null && st !== c.startTime) return "pid-reused";
        if (uid != null) {
          try {
            if (fs.statSync(`/proc/${c.pid}`).uid !== uid) return "uid-mismatch";
          } catch {
            return "gone";
          }
        }
        const env = procEnv(c.pid);
        if (!env.includes(`\0${CHILD_ENV_KEY}=${c.instanceId}\0`)) return "owner-mismatch";
        return null;
      })();
      if (why) {
        if (why !== "gone") log(`[instance] 跳过 pid=${c.pid}（${why}）：${c.cmd || ""}`);
        continue;
      }
      const n = killPidTree(c.pid, c.instanceId, c.startTime);
      log(`[instance] 清掉上一任留下的 ${c.kind || "child"} pid=${c.pid}（清理 ${n} 个）：${c.cmd || ""}`);
    }
  }

  // 本实例的子进程表重新开始
  saveChildren({ version: 1, homeId: HOME_ID, instanceId: INSTANCE_ID, children: [] });
  writeJson(INSTANCE_FILE, {
    homeId: HOME_ID,
    instanceId: INSTANCE_ID,
    pid: process.pid,
    startTime: procStartTime(process.pid),
    port,
    startedAt: new Date().toISOString(),
  });
  return { refused: false };
}

/** 正常退出时调用：删掉自己的登记（子进程表留给下一任做兜底） */
export function clearInstance() {
  try {
    const cur = readJson(INSTANCE_FILE, null);
    if (cur && cur.instanceId === INSTANCE_ID) fs.rmSync(INSTANCE_FILE, { force: true });
  } catch {}
}

/** 测试与诊断用 */
export function instanceSnapshot() {
  return {
    homeId: HOME_ID,
    instanceId: INSTANCE_ID,
    instanceFile: INSTANCE_FILE,
    childrenFile: CHILDREN_FILE,
    children: loadChildren().children,
  };
}
