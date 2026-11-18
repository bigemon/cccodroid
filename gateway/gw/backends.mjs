// Backend Registry：会话绑定后端，不与全局设置联动
//
// 规则（P6-B1 §3、P6-B2 §1）：
//   1. 已有会话以**持久化归属**为准；
//   2. 请求里显式的 backend 与已有归属冲突 → 明确报错，不静默切换；
//   3. 只有新会话（没有 sessionId）才接受显式选择；
//   4. follow 的消息继承前一轮的 backend；
//   5. 未知 sessionId 不当成已有 Claude 会话 —— 报错，由调用方决定怎么处理。

import { isCodexSession, codexTrashMeta } from "./codex/store.mjs";

export const BACKEND_IDS = ["claude", "codex"];

export function normalizeBackend(v) {
  return v === "codex" ? "codex" : v === "claude" ? "claude" : null;
}

function conflict(actual, asked) {
  return {
    error: {
      code: "backend_conflict",
      status: 409,
      message: `这个会话属于 ${actual === "codex" ? "Codex" : "Claude"}，不能按 ${asked === "codex" ? "Codex" : "Claude"} 运行。请新建会话。`,
      backend: actual,
    },
  };
}

/**
 * 决定这一轮用哪个后端。
 *
 * @param {object} item  队列项：{ backend?, sessionId?, follow? }
 * @param {object} ctx
 * @param {(runId:string)=>({sessionId:string|null, backend:string}|null)} [ctx.runInfo]  follow 场景解析前一轮
 * @param {(sid:string)=>boolean} [ctx.isKnownClaudeSession]                               Claude 会话是否真实存在
 * @returns {{backend:string, sessionId?:string|null, follow?:boolean} | {error:object}}
 */
export function resolveBackend(item, ctx = {}) {
  const explicit = normalizeBackend(item?.backend);
  const follow = item?.follow ? ctx.runInfo?.(item.follow) || null : null;
  const sid = item?.sessionId ? String(item.sessionId) : follow?.sessionId || null;

  if (sid) {
    if (codexTrashMeta(sid)) return {error:{code:"session_trashed",status:409,message:"这个会话在回收站中，请先恢复。"}};
    if (isCodexSession(sid)) {
      if (explicit === "claude") return conflict("codex", explicit);
      return { backend: "codex", sessionId: sid };
    }
    if (ctx.isKnownClaudeSession?.(sid)) {
      if (explicit === "codex") return conflict("claude", explicit);
      return { backend: "claude", sessionId: sid };
    }
    return {
      error: {
        code: "unknown_session",
        status: 400,
        message: "这个会话不存在或已不属于任何后端，请新建会话。",
      },
    };
  }

  // 新会话：跟在还没拿到会话号的那一轮后面 → 继承它的后端
  if (follow) {
    const inherited = normalizeBackend(follow.backend) || "claude";
    if (explicit && explicit !== inherited) return conflict(inherited, explicit);
    return { backend: inherited, follow: true, sessionId: null };
  }

  return { backend: explicit || "claude", sessionId: null };
}

/** 旧接口：只要结果不关心错误时用（默认 claude）。新代码请用 resolveBackend。 */
export function backendOf(item, runInfo = null) {
  const r = resolveBackend(item, { runInfo });
  return r.error ? "claude" : r.backend;
}
