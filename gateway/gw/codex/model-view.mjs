// Codex → 原 CCCDroid UI 的视图层映射（纯函数，P6-E1 调查产出，P6-E2 接入）
//
// 目的：把 Codex App Server 的原始数据，映射成原前端已经在用的那几种形状
// （/api/models、/api/session-model、SSE usage 事件、账号与额度卡片）。
// 只做映射：不发请求、不读凭据、不落盘。
//
// 口径约定（P6-E2 任务书 §2）：
//   - model/list 的 Model 类型**没有** context_window 字段（schema 与实测都如此）；
//   - 上下文窗口只在 thread/tokenUsage/updated 的 modelContextWindow 里出现；
//   - 因此「还没跑过一轮」时窗口是 0，界面必须显示「不可用」，不能编；
//   - pct_used 是**按 Codex TUI 公式算的估算值**，不是模型返回的权威值：
//     原始 last / total / modelContextWindow 一律原样保留，前端可以只展示原始值。

export const CTX_BASELINE_TOKENS = 12000;   // codex-rs: TokenUsage::percent_of_context_window_remaining

/** 单个 Model → 前端模型项（形状同 gw/models.mjs 的 normalizeModels 输出） */
export function mapModel(m, learnedWindows = {}) {
  if (!m || !m.id) return null;
  const levels = (m.supportedReasoningEfforts || [])
    .map((x) => (x && x.reasoningEffort) || "")
    .filter(Boolean);
  const win = Number(learnedWindows[m.id]) || 0;   // 只在「曾经观察到」时才有值
  return {
    id: m.id,
    name: m.displayName || m.id,
    description: m.description || "",
    context_window: win,
    max_output_tokens: 0,                       // model/list 不提供输出上限
    context_window_source: win ? "observed" : "unavailable",
    input_modalities: Array.isArray(m.inputModalities) ? m.inputModalities.slice() : ["text"],
    effort: levels.length ? { supported_levels: levels, default_level: m.defaultReasoningEffort || levels[0] } : null,
    hidden: !!m.hidden,
    isDefault: !!m.isDefault,
    upgrade: m.upgrade || null,
    service_tiers: (m.serviceTiers || []).map((t) => t.id).filter(Boolean),
  };
}

/**
 * model/list 响应 → /api/models 的 Codex 分支形状。
 * @param {object} res  ModelListResponse（{data, nextCursor}）
 * @param {{includeHidden?:boolean, learnedWindows?:object}} opts
 */
export function mapModelList(res, opts = {}) {
  const { includeHidden = false, learnedWindows = {} } = opts;
  const raw = Array.isArray(res && res.data) ? res.data : [];
  const models = raw
    .filter((m) => includeHidden || !m.hidden)
    .map((m) => mapModel(m, learnedWindows))
    .filter(Boolean);
  const def = models.find((m) => m.isDefault) || models[0] || null;
  const cur = def;
  const levels = (cur && cur.effort && cur.effort.supported_levels) || [];
  return {
    backend: "codex",
    models,
    current: cur ? cur.id : null,
    provider: "codex",
    listProvider: "codex",
    globalProvider: "codex",
    providers: [{ id: "codex", label: "Codex", labelEn: "Codex" }],
    nativeModels: true,
    defaultModel: def ? def.id : null,
    effort: (cur && cur.effort && cur.effort.default_level) || null,
    effortLevels: levels,
    effortDefault: (cur && cur.effort && cur.effort.default_level) || null,
    // 关键：模型列表里没有窗口。曾经观察到才填，否则 0 + source 标注。
    contextWindow: cur ? cur.context_window : 0,
    maxOutputTokens: 0,
    autoCompactWindow: null,          // Codex 的压缩阈值由它自己管，客户端没有可配值
    contextWindowSource: cur ? cur.context_window_source : "unavailable",
    source: { models: "app-server:model/list", capturedAt: new Date().toISOString() },
  };
}

/** codex-rs 的「剩余百分比」算法（逐项照抄，便于对齐官方 TUI） */
export function percentLeft(contextWindow, lastTotalTokens) {
  const win = Number(contextWindow) || 0;
  const used0 = Number(lastTotalTokens) || 0;
  if (win <= CTX_BASELINE_TOKENS) return null;     // 不知道窗口 → 不可用
  const eff = win - CTX_BASELINE_TOKENS;
  const used = Math.max(used0 - CTX_BASELINE_TOKENS, 0);
  const left = Math.round(Math.max(0, Math.min(100, ((eff - used) / eff) * 100)));
  return left;
}

/** rollout JSONL 的 token_count 内部事件（snake_case）→ app-server v2 ThreadTokenUsage（camelCase） */
export function normalizeTokenCountEvent(info) {
  const conv = (u) => (u ? {
    inputTokens: u.input_tokens ?? null,
    cachedInputTokens: u.cached_input_tokens ?? 0,
    cacheWriteInputTokens: u.cache_write_input_tokens ?? 0,
    outputTokens: u.output_tokens ?? null,
    reasoningOutputTokens: u.reasoning_output_tokens ?? null,
    totalTokens: u.total_tokens ?? null,
  } : null);
  return {
    last: conv(info && info.last_token_usage),
    total: conv(info && info.total_token_usage),
    modelContextWindow: info && info.model_context_window != null ? Number(info.model_context_window) : null,
  };
}

/**
 * thread/tokenUsage/updated 的 tokenUsage → SSE usage 事件 + 前端刻度。
 * 语义边界：
 *   - last  = 最近一次模型请求实际占用的上下文（官方 TUI 的「context left」就用它）；
 *   - total = 本 thread 累计用量，**不是**上下文占用，绝不用它算百分比。
 */
export function mapTokenUsage(tu, meta = {}) {
  const last = (tu && tu.last) || null;
  const total = (tu && tu.total) || null;
  const win = tu && tu.modelContextWindow != null ? Number(tu.modelContextWindow) : null;
  const lastTotal = last ? Number(last.totalTokens) || 0 : null;
  const left = lastTotal == null ? null : percentLeft(win, lastTotal);
  const pick = (b) => (b ? {
    input_tokens: b.inputTokens ?? null,
    cached_input_tokens: b.cachedInputTokens ?? null,
    cache_write_input_tokens: b.cacheWriteInputTokens ?? 0,
    output_tokens: b.outputTokens ?? null,
    reasoning_output_tokens: b.reasoningOutputTokens ?? null,
    total_tokens: b.totalTokens ?? null,
  } : null);
  return {
    type: "usage",
    usage: {
      context_tokens: lastTotal,            // 前端 updateCtx 的第一个参数
      context_window: win,                  // 前端 state.ctxTotal
      // 估算值：照 Codex TUI 的算法，输入是 last_token_usage；不是模型返回的权威字段。
      // 未来 Codex 改公式时，原始 last/total/modelContextWindow 仍然在，不会丢数据。
      pct_left: left,
      pct_used: left == null ? null : 100 - left,
      pct_used_source: left == null ? null : "codex-tui-formula",
      pct_baseline_tokens: CTX_BASELINE_TOKENS,
      last: pick(last),
      total: pick(total),
      source: "app-server:thread/tokenUsage/updated",
      formula: "codex-rs percent_of_context_window_remaining（baseline 12000，取 last_token_usage）",
      threadId: meta.threadId ?? null,
      turnId: meta.turnId ?? null,
    },
  };
}

/** 账号状态是否值得清空模型目录缓存：只认 authMode / planType 的**变化**
 *  （真实 app-server 每次启动都会发一次 account/updated，重复通知不该清缓存） */
export function authChanged(prev, next) {
  // 没有基线就没有「变化」可言：目录本来就是在这个账号下取的。
  // 登录完成 / 退出由调用方显式失效；换账号由 identityChanged 兜底。
  if (!prev) return false;
  const a = prev.authMode ?? null, b = (next && next.authMode) ?? null;
  const c = prev.planType ?? null, d = (next && next.planType) ?? null;
  return a !== b || c !== d;
}

/** 账号身份：协议里能拿到的只有 email / workspaceName（GetAccountResponse.account）。
 *  account/updated 通知不带身份，所以身份变化只能在 account/read 时才发现——这是已知限制。 */
export function accountIdentity(account) {
  if (!account || account.type !== "chatgpt") return null;
  return { email: account.email ?? null, workspaceName: account.workspaceName ?? null };
}

/** 同一个套餐下换了账号，也要清模型目录缓存 */
export function identityChanged(prev, next) {
  if (!prev || !next) return false;         // 一侧未知：不凭猜测清缓存（见 authChanged 的登录/退出路径）
  return (prev.email ?? null) !== (next.email ?? null)
    || (prev.workspaceName ?? null) !== (next.workspaceName ?? null);
}

/** GetAccountResponse → 前端账号状态 */
export function mapAccount(res, login = null) {
  const a = (res && res.account) || null;
  const requires = !!(res && res.requiresOpenaiAuth);
  const pending = !!(login && !login.done);
  if (!a) {
    return {
      state: pending ? "pending" : "logged_out",
      authMode: null, planType: null, email: null, workspaceName: null,
      requiresOpenaiAuth: requires,
      loginId: pending ? login.loginId || null : null,
      source: "app-server:account/read",
    };
  }
  return {
    state: "logged_in",
    authMode: a.type || null,
    planType: a.planType || null,
    email: a.email ?? null,
    workspaceName: a.workspaceName ?? null,
    requiresOpenaiAuth: requires,
    loginId: null,
    source: "app-server:account/read",
  };
}

/** 登录状态机：idle → pending → (done | canceled | expired | failed) */
export function reduceLogin(prev, ev) {
  const s = prev || { state: "logged_out" };
  switch (ev && ev.type) {
    case "start":
      return { state: "pending", loginId: ev.loginId, userCode: ev.userCode, verificationUrl: ev.verificationUrl, startedAt: ev.at };
    case "completed":
      return ev.success
        ? { state: "logged_in", loginId: ev.loginId ?? s.loginId }
        : { state: "failed", loginId: ev.loginId ?? s.loginId, error: ev.error || "登录失败" };
    case "cancelled":
      return { state: "logged_out", loginId: s.loginId, cancelledAt: ev.at, cancelStatus: ev.status || "canceled" };
    case "expired":
      return { state: "expired", loginId: s.loginId, expiredAt: ev.at, error: ev.error || "设备码已过期" };
    case "logout":
      return { state: "logged_out" };
    default:
      return s;
  }
}

/** 窗口时长 → 人类可读标签（数据驱动，不写死「5 小时 / 每周」） */
export function windowLabel(mins) {
  const m = Number(mins) || 0;
  if (m <= 0) return "";
  if (m % 10080 === 0) return `${m / 10080} 周`;
  if (m % 1440 === 0) return `${m / 1440} 天`;
  if (m % 60 === 0) return `${m / 60} 小时`;
  return `${m} 分钟`;
}

/**
 * account/rateLimits/read 或 token_count.rate_limits → 前端额度卡。
 * 注意：Credits 余额默认不外传（只在 includeBalance 时给出），避免进入日志与交接包。
 */
export function mapRateLimits(resp, opts = {}) {
  const rl = (resp && (resp.rateLimits || resp)) || {};
  const { includeBalance = false } = opts;
  // 两种形状都认：app-server v2（camelCase）与 rollout 里的内部事件（snake_case）
  const pick1 = (o, a, b) => (o && o[a] != null ? o[a] : (o && o[b] != null ? o[b] : null));
  const windows = [];
  const add = (w, id) => {
    if (!w) return;
    const used = pick1(w, "usedPercent", "used_percent");
    if (used == null) return;
    const mins = pick1(w, "windowDurationMins", "window_minutes");
    windows.push({
      id,
      usedPercent: Math.max(0, Math.min(100, Number(used) || 0)),
      windowDurationMins: mins,
      resetsAt: pick1(w, "resetsAt", "resets_at"),
      label: windowLabel(mins),
    });
  };
  add(rl.primary, "primary");
  add(rl.secondary, "secondary");
  windows.sort((a, b) => (a.windowDurationMins || 0) - (b.windowDurationMins || 0));
  const c = rl.credits || null;
  return {
    planType: pick1(rl, "planType", "plan_type"),
    limitId: pick1(rl, "limitId", "limit_id"),
    limitName: pick1(rl, "limitName", "limit_name"),
    windows,
    rateLimitReached: pick1(rl, "rateLimitReachedType", "rate_limit_reached_type"),
    spendControlReached: pick1(rl, "spendControlReached", "spend_control_reached"),
    credits: c ? {
      hasCredits: !!(c.hasCredits ?? c.has_credits),
      unlimited: !!c.unlimited,
      balanceAvailable: c.balance != null,
      ...(includeBalance ? { balance: c.balance } : {}),
    } : null,
    source: "app-server:account/rateLimits/read",
    capturedAt: new Date().toISOString(),
  };
}

/** account/usage/read → 用量卡（账户累计 + 单 thread 估算） */
export function mapThreadUsage(resp) {
  const s = (resp && resp.summary) || {};
  const t = (resp && resp.threadUsage) || null;
  return {
    summary: {
      lifetimeTokens: s.lifetimeTokens ?? null,
      peakDailyTokens: s.peakDailyTokens ?? null,
      currentStreakDays: s.currentStreakDays ?? null,
      longestStreakDays: s.longestStreakDays ?? null,
      longestRunningTurnSec: s.longestRunningTurnSec ?? null,
    },
    daily: Array.isArray(resp && resp.dailyUsageBuckets)
      ? resp.dailyUsageBuckets.map((b) => ({ date: b.startDate, tokens: b.tokens }))
      : null,
    thread: t ? {
      threadId: t.threadId,
      estimatedCreditsMicros: t.estimatedUsageCreditsMicros,
      estimatedUsdMicros: t.estimatedUsageUsdMicros ?? null,
      groups: (t.groups || []).map((g) => ({
        model: g.model ?? null,
        effort: g.reasoningEffort ?? null,
        speed: g.speed ?? null,
        inputTokens: g.inputTokens ?? null,
        cachedInputTokens: g.cachedInputTokens ?? null,
        outputTokens: g.outputTokens ?? null,
        totalTokens: g.totalTokens ?? null,
      })),
    } : null,
    source: "app-server:account/usage/read",
  };
}

/**
 * 新会话/会话的模型取值顺序（与 Claude 侧 run.mjs 一致，落到 Codex 上）：
 * 本轮请求指定 → 新会话 pin → 会话记录 → 厂商默认
 */
export function resolveCodexModel({ pin = null, rec = null } = {}, catalog = null) {
  const byId = new Map(((catalog && catalog.models) || []).map((m) => [m.id, m]));
  const candidates = [pin && pin.model, rec && rec.model].filter((v) => v != null && v !== "");
  for (const id of candidates) {
    if (byId.has(id)) return { model: id, valid: true, source: id === (pin && pin.model) ? "pin" : "session" };
  }
  const def = catalog && catalog.defaultModel;
  return { model: def || null, valid: !!def, source: "default" };
}

/** 选了一个不在清单里的模型：网关必须明确报错，不静默回落 */
export function validateModel(catalog, id) {
  const ids = ((catalog && catalog.models) || []).map((m) => m.id);
  if (!id) return { ok: true, model: catalog && catalog.defaultModel };
  if (ids.includes(id)) return { ok: true, model: id };
  return { ok: false, code: "codex_model_unavailable", message: `Codex 没有可用的模型：${id}`, available: ids };
}
