import {syncClaudeSkillReuse} from "./skill-reuse.mjs";
import {syncClaudeInstructionReuse} from "./instruction-reuse.mjs";
// 「账号代理」：一个按需启动、空闲自动回收的 app-server，处理账号、目录查询与用户显式技能开关。
//
// 为什么不复用每个会话各自的 app-server：
//   - 会话池里的进程属于某个 cwd / thread，随会话空闲回收；设置页打开时不一定有；
//   - 设备码登录需要 app-server **持续存活**（P3-B：杀掉进程，轮询就断了）。
//
// 生命周期：第一次用到时启动；登录进行中不回收；其余情况空闲 5 分钟后关掉。
// 它不创建 thread、不发 turn；账号、模型、技能与配置等请求共用这条连接。

import fs from "node:fs";
import { CFG, CHILD_ENV_KEY, INSTANCE_ID, log } from "../config.mjs";
import { registerChild, unregisterChild } from "../instances.mjs";
import { AppServerClient } from "./rpc.mjs";
import { DEFAULT_SERVER_ARGS, ProxyManager } from "./session.mjs";
import { codexConfig } from "./config.mjs";
import { invalidateCatalog } from "./catalog.mjs";
import { accountIdentity, authChanged, identityChanged } from "./model-view.mjs";

const IDLE_MS = Number(process.env.CCAPP_CODEX_AGENT_IDLE_MS) || 5 * 60 * 1000;

let A = null;          // { client, proxy, lastUsed, login, timer, startedAt }
// 账号状态与身份跨「代理进程」保留：代理空闲回收再启动时，重复的通知不该清模型目录缓存。
// 账号只可能通过我们（登录/退出）改变，所以这份快照在网关进程内是可信的。
let LAST_AUTH = null;
let LAST_IDENTITY = null;
let STARTING = null;   // 并发调用只启动一次

function cfgOk(c) {
  return Boolean(c.bin && c.home && fs.existsSync(c.bin) && fs.existsSync(c.home));
}

async function startAgent() {
  syncClaudeInstructionReuse();
  const cfg = codexConfig();
  if (!cfgOk(cfg)) {
    const err = new Error("Codex 环境尚未就绪：请到设置 → 接口与型号 → Codex 安装运行环境，或检查高级配置。");
    err.code = "codex_not_configured";
    throw err;
  }
  const proxy = new ProxyManager();
  await proxy.start();
  const client = new AppServerClient({
    bin: cfg.bin,
    codexHome: cfg.home,
    cwd: CFG.home,
    extraEnv: { ...proxy.env(cfg.sslCertFile), [CHILD_ENV_KEY]: INSTANCE_ID },
    serverArgs: DEFAULT_SERVER_ARGS,
    label: "codex-agent",
  });
  client.start();
  if (client.child?.pid) registerChild(client.child.pid, "codex-agent");
  try {
    await client.call("initialize", {
      clientInfo: { name: "cccodroid_codex_account", title: "CCCDroid Codex Account", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, 30000);
    client.notify("initialized", {});
  } catch (err) {
    try { await client.dispose(); } catch {}
    await proxy.stop();
    throw err;
  }
  const a = { client, proxy, runtimeBin:cfg.bin, runtimeHome:cfg.home, lastUsed: Date.now(), login: null, startedAt: Date.now(), timer: null };
  client.on("notification", (msg) => onNotification(a, msg));
  client.on("exit", () => {
    if (A === a) A = null;
  });
  touch(a);
  log("[codex] 账号代理已启动");
  return a;
}

function onNotification(a, msg) {
  const m = msg?.method || "";
  const p = msg?.params || {};
  if (m === "account/login/completed") {
    a.login = { ...(a.login || {}), done: true, success: !!p.success, error: p.error ?? null, loginId: p.loginId ?? a.login?.loginId ?? null, at: Date.now() };
    log(`[codex] 登录完成 success=${a.login.success}`);
    invalidateCatalog();          // 账号变了，模型目录可能也变了
  } else if (m === "account/updated") {
    // 注意：这个通知也会在启动时发（只是报告当前账号），**不能**因此认为有登录在进行。
    const nextAuth = { authMode: p.authMode ?? null, planType: p.planType ?? null };
    const prevAuth = LAST_AUTH;
    LAST_AUTH = nextAuth;
    a.auth = { ...nextAuth, at: Date.now() };
    if (a.login && !a.login.done) {
      a.login = { ...a.login, ...nextAuth, updatedAt: Date.now() };
    } else if (authChanged(prevAuth, nextAuth)) {
      // 只在账号真的变了时清缓存；代理重启重复发的同一状态不动它
      invalidateCatalog();
    }
  }
}

function touch(a) {
  if (!a) return;
  a.lastUsed = Date.now();
  if (a.timer) clearTimeout(a.timer);
  // 登录进行中不回收：设备码轮询在 app-server 里，杀了就断
  if (a.login && !a.login.done) return;
  a.timer = setTimeout(() => {
    if (A !== a) return;
    if (a.login && !a.login.done) return;
    log("[codex] 账号代理空闲回收");
    disposeAgent().catch(() => {});
  }, IDLE_MS);
  a.timer.unref?.();
}

export async function agent() {
  const cfg=codexConfig();
  if(A&&A.runtimeBin!==undefined&&(A.runtimeBin!==cfg.bin||A.runtimeHome!==cfg.home)&&!codexAgentRuntimeBusy()){
    await disposeAgent();return agent();
  }
  if (A && A.client && !A.client.exited) {
    touch(A);
    return A;
  }
  if (!STARTING) {
    STARTING = startAgent().finally(() => { STARTING = null; });
  }
  const a = await STARTING;
  A = a;
  touch(a);
  return a;
}

export async function agentClient() {
  syncClaudeSkillReuse();
  const a = await agent();
  return a.client;
}

export async function disposeAgent() {
  const a = A;
  A = null;
  if (!a) return;
  if (a.timer) clearTimeout(a.timer);
  try { await a.client.dispose(); } catch {}
  try { await a.proxy.stop(); } catch {}
}

/** 当前登录流程（给接口层读，不做缓存） */
export function agentLoginState() {
  if (!A) return null;
  return A.login ? { ...A.login } : null;
}

/** 每次 account/read 回来时记下身份；同套餐换账号也能清掉上一个账号的模型目录 */
export function noteAccountIdentity(account) {
  const next = accountIdentity(account);
  if (!next) return;
  const prev = LAST_IDENTITY;
  LAST_IDENTITY = next;
  if (A) A.identity = next;
  if (identityChanged(prev, next)) {
    log(`[codex] 账号身份变化 ${JSON.stringify(prev)} → ${JSON.stringify(next)}，清空模型目录缓存`);
    invalidateCatalog();
  }
}

export function agentAlive() {
  return Boolean(A && A.client && !A.client.exited);
}

// ── 账号操作 ─────────────────────────────────────────────────────────────

function notLoggedIn() {
  const e = new Error("Codex 未登录");
  e.code = "codex_not_logged_in";
  return e;
}

function isAuthError(err) {
  return err && (err.code === -32600 || /authentication required|not logged in|unauthorized/i.test(String(err.message || "")));
}

/** account/read；未登录时返回 account:null（不是错误） */
export async function readAccount({ refreshToken = false } = {}) {
  const client = await agentClient();
  return client.call("account/read", { refreshToken: !!refreshToken }, 20000);
}

/** 发起设备码登录。设备码只在返回值里，调用方负责只在本机界面显示。 */
export async function startDeviceLogin() {
  const client = await agentClient();
  const r = await client.call("account/login/start", { type: "chatgptDeviceCode" }, 30000);
  const a = await agent();
  a.login = { loginId: r.loginId, userCode: r.userCode, verificationUrl: r.verificationUrl, done: false, startedAt: Date.now() };
  touch(a);
  log("[codex] 已发起设备码登录（设备码不写日志）");
  return r;
}

export async function cancelLogin(loginId) {
  const a = A;
  if (!a) return { status: "notFound" };
  let status = "notFound";
  try {
    const r = await a.client.call("account/login/cancel", { loginId: String(loginId || "") }, 15000);
    status = r?.status || "notFound";
  } catch (err) {
    // 进程刚退出或没人认领这个 id：对界面来说都是「没有这个登录」
    log(`[codex] 取消登录失败: ${err.message}`);
    status = "notFound";
  }
  a.login = { ...(a.login || {}), done: true, success: false, cancelled: true, status };
  touch(a);
  return { status };
}

export async function logout() {
  const client = await agentClient();
  try {
    await client.call("account/logout", {}, 20000);
  } finally {
    if (A) A.login = { ...(A.login || {}), done: true, success: false, loggedOut: true };
    LAST_AUTH = null;             // 退出：下次读到什么都算「新状态」
    LAST_IDENTITY = null;
    invalidateCatalog();          // 退出后模型目录必然不同
  }
  return { ok: true };
}

/** 订阅额度；未登录时抛 codex_not_logged_in */
export async function readRateLimits() {
  try {
    const client = await agentClient();
    return await client.call("account/rateLimits/read", null, 20000);
  } catch (err) {
    if (isAuthError(err)) throw notLoggedIn();
    throw err;
  }
}

/** 账户 / 单 thread 用量；未登录时抛 codex_not_logged_in */
export async function readUsage(threadId = null) {
  try {
    const client = await agentClient();
    return await client.call("account/usage/read", threadId ? { threadId } : null, 25000);
  } catch (err) {
    if (isAuthError(err)) throw notLoggedIn();
    throw err;
  }
}

export function codexAgentRuntimeBusy(){
 return !!(STARTING||A?.client?.pending?.size||A?.client?.inflightServerRequests?.size||(A?.login&&!A.login.done));
}
