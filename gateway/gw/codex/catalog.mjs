// Codex 模型目录 + 会话级模型选择（P6-E2）
//
// 数据来源只有一个：App Server 的 model/list（【登录态】目录，由账号代理去取）。
// 不要拿匿名/内置清单当「这个账号能用的模型」—— 未登录时 app-server 会回一份内置目录，
// 它和登录后的服务端目录并不相同（P6-E1 §3.5 有对比）。
//
// 上下文窗口：model/list 不提供。窗口只在 thread/tokenUsage/updated 里出现，
// 这里只负责把「按模型观察到的窗口」记下来，供下次打开会话时显示刻度；
// 没观察过就是 0 + unavailable，界面显示「不可用」。

import fs from "node:fs";
import { projectById, projectDefaults } from "../projects.mjs";
import path from "node:path";
import { CFG, log } from "../config.mjs";
import { SETTINGS } from "../settings-store.mjs";
import { CODEX_PERMISSION_MODES, validCodexMode } from "./permissions.mjs";
import { agentClient, noteAccountIdentity } from "./agent.mjs";
import {codexConfig} from "./config.mjs";
import {validDefaults,selectDefaultValues,resolveModelDefaults} from "./model-defaults.mjs";
import { codexStateFile } from "./config.mjs";
import { getCodexSession, touchCodexSession } from "./store.mjs";
import { mapModelList, validateModel } from "./model-view.mjs";

const CACHE_MS = Number(process.env.CCAPP_CODEX_CATALOG_MS) || 10 * 60 * 1000;
const WINDOWS_FILE = codexStateFile("ccapp-codex-windows.json");
// 目录落盘：网关重启后第一次打开面板不用干等 app-server 启动
const CATALOG_FILE = codexStateFile("ccapp-codex-catalog.json");

let LIST = null, LIST_AT = 0;
let REFRESHING = null;   // 后台刷新的 in-flight promise
let CATALOG_EPOCH=0;
export const catalogEpoch=()=>CATALOG_EPOCH;
let FORCE = false;       // 账号变化等：即使磁盘缓存还新，也必须重拉一次
let WINDOWS = null;      // { modelId: windowTokens }

function loadWindows() {
  if (WINDOWS) return WINDOWS;
  try {
    WINDOWS = JSON.parse(fs.readFileSync(WINDOWS_FILE, "utf8")) || {};
  } catch {
    WINDOWS = {};
  }
  return WINDOWS;
}

function saveWindows() {
  try {
    const tmp = `${WINDOWS_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(WINDOWS, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, WINDOWS_FILE);
  } catch (err) {
    log(`[codex] 窗口缓存写盘失败: ${err.message}`);
  }
}

/** 收到 usage 事件时调用：只记窗口数字，不记任何用量 */
export function learnWindow(model, windowTokens) {
  const w = Number(windowTokens) || 0;
  if (!model || w <= 0) return;
  const all = loadWindows();
  if (all[model] === w) return;
  all[model] = w;
  saveWindows();
  log(`[codex] 记下窗口 ${model}=${w}`);
}

export function knownWindows() {
  return { ...loadWindows() };
}

export function invalidateCatalog() {
  CATALOG_EPOCH++;
  LIST = null;
  LIST_AT = 0;
  FORCE = true;          // 磁盘上那份也可能来自旧账号，不能按「还新鲜」直接用
}

function loadDiskCatalog() {
  if (LIST) return;
  try {
    const j = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
    if (Array.isArray(j.data) && j.data.length) {
      LIST = { data: j.data, at: Number(j.at) || 0 };
      LIST_AT = LIST.at;
      log(`[codex] 目录缓存：${LIST.data.length} 个模型（${new Date(LIST_AT).toISOString()}）`);
    }
  } catch {}
}

function saveDiskCatalog(list) {
  try {
    const tmp = `${CATALOG_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ data: list.data, at: list.at }), { mode: 0o600 });
    fs.renameSync(tmp, CATALOG_FILE);
  } catch (err) {
    log(`[codex] 目录缓存写盘失败: ${err.message}`);
  }
}

/** 真去拉一次（并发去重）；成功后更新内存与磁盘 */
function fetchCatalog() {
  if (REFRESHING) return REFRESHING;
  REFRESHING = (async () => {
    const epoch=CATALOG_EPOCH;
    const client = await agentClient();
    const data = [];
    const seen=new Set();
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      // 一次取全（含隐藏项），要不要显示由调用方过滤：只缓存一份，避免两套清单对不上
      const r = await client.call("model/list", cursor ? { cursor, includeHidden: true } : { includeHidden: true }, 20000);
      if(!Array.isArray(r?.data)||!("nextCursor" in r)||r.data.some(m=>!m||typeof m.id!=="string"||!m.id))throw new Error("模型目录格式不完整。");
      data.push(...r.data);
      cursor = r.nextCursor;
      if(cursor===null)break;
      if(typeof cursor!=="string"||!cursor||seen.has(cursor))throw new Error("模型目录分页无效。");
      seen.add(cursor);
    }
    if(cursor!==null||epoch!==CATALOG_EPOCH||new Set(data.map(m=>m.id)).size!==data.length)throw new Error("模型目录未完整更新，请重新刷新。");
    LIST = { data, at: Date.now() };
    LIST_AT = LIST.at;
    saveDiskCatalog(LIST);
    return LIST;
  })().finally(() => { REFRESHING = null; });
  return REFRESHING;
}

/**
 * 取模型目录（原始 Model 数组）。stale-while-revalidate：
 *   - 有缓存（内存或磁盘）且没过期 → 直接给；
 *   - 有缓存但过期 / 被失效 → **先给旧清单**，后台刷新，返回 refreshing:true；
 *   - 完全没有 → 只能等一次（冷启动）。
 * 返回值多两个字段：stale / refreshing，界面据此显示「正在拉取最新模型」。
 */
export async function modelList({ refresh = false, fresh = false } = {}) {
  if(fresh){const r=await fetchCatalog();FORCE=false;return {...r,stale:false,refreshing:false};}
  loadDiskCatalog();
  const cachedFresh = !FORCE && LIST && Date.now() - LIST_AT < CACHE_MS;
  if (!refresh && cachedFresh) return { ...LIST, stale: false, refreshing: false };
  if (LIST && LIST.data.length) {
    fetchCatalog().catch((err) => log(`[codex] 后台刷新目录失败: ${err.message}`));
    FORCE = false;
    return { ...LIST, stale: true, refreshing: true };
  }
  const r = await fetchCatalog();
  FORCE = false;
  return { ...r, stale: false, refreshing: false };
}

/** 专属偏好校验：完整读目录并核验账号，不读取或转发凭据。 */
export async function preferenceModelCatalog(){
 const client=await agentClient(),cfg=codexConfig();
 if(client.bin!==cfg.bin||client.codexHome!==cfg.home)throw new Error("Codex 路径已变化，请重启网关后再修改偏好。");
 const account=await client.call("account/read",{refreshToken:false},20000);
 if(!account?.account)throw new Error("请先登录 Codex，再核验模型偏好。");
 noteAccountIdentity(account.account);
 const epoch=CATALOG_EPOCH,raw=await modelList({fresh:true});
 if(raw.data.some(m=>typeof m.isDefault!=="boolean"||!Array.isArray(m.supportedReasoningEfforts)||m.supportedReasoningEfforts.some(e=>typeof e?.reasoningEffort!=="string"||!e.reasoningEffort)||typeof m.defaultReasoningEffort!=="string"||m.supportedReasoningEfforts.length&&!m.defaultReasoningEffort))throw new Error("模型能力目录不完整，未重置偏好。");
 if(epoch!==CATALOG_EPOCH)throw new Error("Codex 账号已变化，请重新刷新。");
 return {models:mapModelList(raw,{includeHidden:true}).models,epoch,capturedAt:raw.at};
}
export function configuredModelDefaults(){const d=SETTINGS.codex?.defaults;return validDefaults(d)?d:null;}
export async function newSessionModelDefaults(over,project){
 const defaults=configuredModelDefaults();if(!defaults)return null;
 const {models}=await preferenceModelCatalog(),r=resolveModelDefaults(selectDefaultValues(defaults,project,over),models);
 if(r.error)throw new Error(r.error);
 return r;
}

/** 默认强度：取目录里该模型的 default_level */
function defaultEffortOf(models, id) {
  const m = (models || []).find((x) => x.id === id);
  return (m && m.effort && m.effort.default_level) || null;
}

function recOf(sid) {
  return sid ? getCodexSession(sid) : null;
}

/** Codex 会话「现在用什么」：会话记的 → 目录默认 */
export function codexSessionModel(sid, catalog = null, over = {}) {
  const rec = recOf(sid);
  const models = catalog ? catalog.models : null;
  // over：还没拿到会话号的新会话，前端暂存的选择（只用于展示，不写索引）
  const overModel = over.model != null && over.model !== "" ? String(over.model) : null;
  const overEffort = over.effort != null && over.effort !== "" ? String(over.effort) : null;
  const pd=!sid?projectDefaults(projectById(over.projectId),"codex"):{};
  const preference=(!sid||rec?.model===null&&rec?.effort===null&&rec?.modelPicked===false)&&catalog&&configuredModelDefaults()?resolveModelDefaults(selectDefaultValues(configuredModelDefaults(),pd,over),catalog.models||[]):null;
  const model = preference?preference.model:overModel || (rec && rec.model) || pd.model || (catalog && catalog.defaultModel) || null;
  const levels = (models || []).find((m) => m.id === model)?.effort?.supported_levels || [];
  const effort = preference?preference.effort:overEffort || (rec && rec.effort) || pd.effort || defaultEffortOf(models, model);
  return {
    backend: "codex",
    permissionMode: rec ? (validCodexMode(rec.permissionMode) ? rec.permissionMode : "default") : (validCodexMode(pd.perm) ? pd.perm : validCodexMode(SETTINGS.codex?.permissionMode) ? SETTINGS.codex.permissionMode : "default"),
    permissionModes: CODEX_PERMISSION_MODES,
    permissionScope: "host-tools",
    permissionSessionId: sid || null,
    model,
    effort: effort || "",
    // Codex 的强度在 turn/start 里和模型一起生效，不需要像 Claude 那样映射到「这家支不支持」
    effortRun: levels.length && effort && !levels.includes(effort) ? levels[0] : (effort || ""),
    provider: "codex",
    ownProvider: false,
    // own = 用户在这个会话里单独选过（区别于「跑过一轮后记下的当前模型」）
    own: !!(rec && rec.modelPicked),
    // 本轮实际使用的模型（仅改道时与 model 不同）
    effectiveModel: rec && rec.effectiveModel && rec.effectiveModel !== rec.model ? rec.effectiveModel : null,
    // 上次跑完时的上下文状态（只有窗口和占用，不含累计用量）
    usage: (rec && rec.usage) || null,
    defaultModel: preference?preference.defaultModel:(catalog && catalog.defaultModel) || null,
    ...(preference?.error?{defaultWarning:preference.error}:{}),
    // rec 只在这个会话真的单独选过东西时才有值（与 Claude 侧 session-model 的语义一致）
    rec: rec && rec.modelPicked
      ? { model: rec.model ?? null, effort: rec.effort ?? null, provider: "codex" }
      : null,
  };
}

/** /api/session-model 的 Codex 分支：目录取不到也返回一个形状完整的对象（带 error） */
export async function codexEffective(sid, { refresh = false, model = null, effort = null, projectId = null } = {}) {
  try {
    const raw = await modelList({ refresh });
    const catalog = mapModelList(raw, { learnedWindows: loadWindows(),includeHidden:true });
    return codexSessionModel(sid, catalog, { model, effort, projectId });
  } catch (err) {
    return {
      backend: "codex", model: null, effort: "", effortRun: "",
      permissionMode: codexSessionModel(sid).permissionMode,
      permissionModes: CODEX_PERMISSION_MODES, permissionScope: "host-tools", permissionSessionId: sid || null,
      provider: "codex", ownProvider: false, own: false, defaultModel: null, rec: null, usage: null,
      error: { code: err.code || "codex_backend_error", message: String(err.message || err) },
    };
  }
}

/**
 * POST 的落点：只改这个会话的记录，不触达正在跑的 thread。
 * 下一轮 turn/start 带上 model/effort 即生效（字段语义是「本轮及后续轮」）。
 */
export function setCodexSessionModel(sid, patch = {}) {
  const p = {};
  if (patch.reset) {
    p.model = null;
    p.effort = null;
    p.modelPicked = false;
    p.effectiveModel = undefined;
  } else {
    if (patch.model !== undefined) p.model = patch.model === "" ? null : String(patch.model).slice(0, 200);
    if (patch.effort !== undefined) p.effort = patch.effort === "" ? null : String(patch.effort).slice(0, 32);
    p.modelPicked = true;
  }
  touchCodexSession(sid, p);
  return codexSessionModel(sid);
}

/** /api/models 的 Codex 分支：形状与 Claude 那边完全一致 */
export async function codexModelsResponse(sid, { refresh = false, includeHidden = false, model = null, effort = null, projectId = null } = {}) {
  let raw;
  try {
    raw = await modelList({ refresh });
  } catch (err) {
    return {
      backend: "codex",
      available: false,
      models: [],
      current: null,
      provider: "codex",
      listProvider: "codex",
      globalProvider: "codex",
      providers: [{ id: "codex", label: "Codex", labelEn: "Codex" }],
      nativeModels: true,
      defaultModel: null,
      effort: null,
      effortLevels: [],
      effortDefault: null,
      contextWindow: 0,
      maxOutputTokens: 0,
      autoCompactWindow: null,
      contextWindowSource: "unavailable",
      error: { code: err.code || "codex_backend_error", message: String(err.message || err) },
      source: { models: "app-server:model/list" },
    };
  }
  const catalog = mapModelList(raw, { includeHidden, learnedWindows: loadWindows() });
  const cur = codexSessionModel(sid, {...catalog,models:mapModelList(raw,{includeHidden:true}).models}, { model, effort, projectId });
  const cm = catalog.models.find((m) => m.id === cur.model) || catalog.models[0] || null;
  return {
    ...catalog,
    available: true,
    current: cur.model,
    effort: cur.effort || null,
    effortRun: cur.effortRun || null,
    defaultModel: cur.defaultModel,
    // 窗口：目录不知道，只有观察到过才有值（见文件头）
    contextWindow: cm ? cm.context_window : 0,
    contextWindowSource: cm ? cm.context_window_source : "unavailable",
    maxOutputTokens: 0,
    autoCompactWindow: null,
    stale: !!raw.stale,
    refreshing: !!raw.refreshing,
    catalogAt: LIST_AT ? new Date(LIST_AT).toISOString() : null,
    source: { models: "app-server:model/list", capturedAt: new Date(LIST_AT || Date.now()).toISOString() },
  };
}

/** 入队前校验：选了清单里没有的模型就明确报错，不静默换一个。
 *  cachedOnly：跑一轮时只在目录已经在内存里时校验，避免为了校验拖慢第一条消息。 */
export async function checkModel(id, { cachedOnly = false } = {}) {
  if (!id) return { ok: true, model: null };
  if (cachedOnly && !LIST) return { ok: true, model: id, skipped: "catalog-not-warm" };
  let raw;
  try {
    raw = await modelList();
  } catch {
    // 目录取不到时不阻塞发消息：交给 app-server 自己判
    return { ok: true, model: id };
  }
  const catalog = mapModelList(raw,{includeHidden:true});
  const v = validateModel(catalog, id);
  return v.ok ? { ok: true, model: v.model } : v;
}
