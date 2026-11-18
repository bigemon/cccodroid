// 用户按需查询/停止已观测到的直接子代理；不恢复线程，不增加轮询或生命周期清理。
const validId = v => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\x00-\x20]/.test(v);
const text = (v, n = 200) => typeof v === "string" ? v.slice(0, n) : "";
const terminal = new Set(["completed", "interrupted", "failed"]);
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };

export function subagentRoster(items, sessionId) {
  const agents = new Map();
  for (const r of items || []) {
    if (r?.role !== "subagent" || r.parentThreadId !== sessionId || !validId(r.agentThreadId) || r.agentThreadId === sessionId) continue;
    const a = {agentThreadId:r.agentThreadId, parentThreadId:sessionId, label:text(r.label) || "子代理",
      observedStatus:text(r.status,32), model:text(r.model), effort:text(r.effort,32)};
    agents.delete(a.agentThreadId); agents.set(a.agentThreadId, a);
    if (agents.size > 64) agents.delete(agents.keys().next().value);
  }
  return [...agents.values()];
}

export function createSubagentControl({getRecord, getSource, readItems, coldClient}) {
  const stopping = new Set();
  function context(sid, child = null) {
    if (!validId(sid) || getRecord(sid)?.backend !== "codex") fail(404, "找不到 Codex 会话。");
    const source = getSource(sid);
    let items;
    try { items = source?.items || readItems(sid); }
    catch { fail(409, "会话记录暂不可读取，无法核对子代理。"); }
    const agents = subagentRoster(items, sid);
    if (child !== null && (!validId(child) || child === sid || !agents.some(a => a.agentThreadId === child)))
      fail(404, "这项子代理不属于当前会话的已记录列表。");
    return {source, agents, agent:agents.find(a => a.agentThreadId === child)};
  }
  async function inspect(client, sid, agent, live) {
    let thread, page;
    try {
      thread = (await client.call("thread/read", {threadId:agent.agentThreadId, includeTurns:false}, 10000))?.thread;
    } catch { fail(502, "子代理状态查询失败，请稍后重试。"); }
    if (thread?.id !== agent.agentThreadId || thread.parentThreadId !== sid)
      fail(409, "核心返回的子代理归属不匹配，未进行控制。");
    try {
      page = await client.call("thread/turns/list", {threadId:agent.agentThreadId, limit:1, sortDirection:"desc", itemsView:"summary"}, 10000);
    } catch { fail(502, "核心无法读取子代理当前轮次，未进行控制。"); }
    if (!Array.isArray(page?.data)) fail(502, "核心未返回有效的子代理轮次。");
    const last = page.data[0], runtime = thread.status?.type;
    const loaded = !!live && ["idle", "active", "systemError"].includes(runtime);
    let status = "unconfirmed";
    if (loaded && runtime === "active" && last?.status === "inProgress" && validId(last.id)) status = "running";
    else if (loaded && runtime === "idle" && terminal.has(last?.status)) status = last.status;
    const canStop = status === "running";
    return {...agent, status, runtimeStatus:runtime || "unknown", lastTurnStatus:text(last?.status,32),
      childTurnId:validId(last?.id) ? last.id : null, canStop, queriedAt:Date.now(),
      reason:!loaded ? "当前连接没有该子代理的运行现场，最近记录不能证明它已停止。" :
        status === "unconfirmed" ? "核心尚未提供可确认的任务状态，请稍后查询。" : ""};
  }
  return {
    list(sid) {
      const {agents} = context(sid);
      return {backend:"codex", sessionId:sid, agents, limit:64, scope:"observed-direct-children"};
    },
    async read(sid, child) {
      if (!validId(child)) fail(400, "请选择已记录的子代理。");
      const {source, agent} = context(sid, child);
      const client = source?.client || await coldClient();
      return {backend:"codex", sessionId:sid, agent:await inspect(client, sid, agent, !!source)};
    },
    async stop(sid, child, expectedTurnId) {
      if (!validId(child)) fail(400, "请选择已记录的子代理。");
      const key = sid + ":" + child;
      if (stopping.has(key)) fail(409, "正在请求停止这项任务，请稍后查询状态。");
      if (!validId(expectedTurnId)) fail(400, "请先查询状态，再停止对应的子代理任务。");
      const {source, agent} = context(sid, child);
      if (!source?.client) fail(409, "当前会话没有可控制的运行连接，请先查询状态。");
      stopping.add(key);
      try {
        const current = await inspect(source.client, sid, agent, true);
        if (!current.canStop || current.childTurnId !== expectedTurnId) fail(409, "子代理任务已变化，请重新查询状态。");
        try { await source.client.call("turn/interrupt", {threadId:child, turnId:expectedTurnId}, 10000); }
        catch { fail(502, "停止请求未获核心确认，请先查询状态，勿重复发送。"); }
        let after;
        try { after = await inspect(source.client, sid, agent, true); }
        catch { after = {...current, status:"unconfirmed", canStop:false, queriedAt:Date.now(), reason:"已请求停止指定任务，最终状态待确认。"}; }
        if (after.childTurnId === expectedTurnId && after.status === "running")
          after = {...after, status:"stopping", canStop:false, reason:"已请求停止指定任务，最终状态待确认。"};
        if (after.childTurnId !== expectedTurnId)
          after = {...after, reason:"已请求停止先前任务；子代理的轮次已变化。"};
        return {backend:"codex", sessionId:sid, accepted:true, requestedTurnId:expectedTurnId, agent:after};
      } finally { stopping.delete(key); }
    },
  };
}
