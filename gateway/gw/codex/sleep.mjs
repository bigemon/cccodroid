// 原生 clock.sleep 复用工具卡；只为已报告的有限等待预留闲置宽限，不创建轮询或后台服务。
export const MAX_SLEEP_GRACE_MS = 24 * 60 * 60 * 1000;
const validId = id => typeof id === "string" && id.length > 0 && id.length <= 200;
const duration = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const label = ms => ms == null ? "等待" : ms < 60000 ? "等待 " + (ms / 1000) + " 秒" : "等待 " + (Math.round(ms / 6000) / 10) + " 分钟";
export function sleepRecords(item, {turnId = null, status = "completed"} = {}) {
  if (!validId(item?.id)) return [];
  const ms = duration(item.durationMs), base = {turnId, itemId: item.id, nativeSleep: true};
  const use = {role: "tool_use", id: "codex-sleep:" + item.id, name: "Sleep", input: {description: label(ms), ...(ms == null ? {} : {duration_ms: ms})}, ...base};
  const ok = status === "completed", stopped = ["interrupted", "cancelled", "canceled"].includes(status);
  const result = {role: "tool_result", id: use.id, name: use.name, ok, text: ok ? "等待已结束。" : stopped ? "等待已停止。" : "等待未正常结束。", sleepStatus: ok ? "completed" : stopped ? "interrupted" : "failed", ...base};
  return [use, result];
}
export function historicalSleepRecords(item, turn) {
  // 新核心带完成时间；已结束的等待不因同轮后续中断变成“已停止”。
  const complete = Number.isFinite(item.completedAtMs) && item.completedAtMs >= 0;
  const status = complete ? "completed" : item.completedAtMs === null && turn.status === "completed" ? "failed" : turn.status;
  return sleepRecords(item, {turnId: turn.id, status});
}
export class CodexSleep {
  constructor({emit, push, turnId, now = Date.now}) {
    Object.assign(this, {emit, push, turnId, now});
    this.started = new Map();
    this.done = new Set();
  }
  handle(method, p) {
    const item = p.item;
    if (item?.type !== "sleep" || !validId(item.id)) return false;
    if (!["item/started", "item/completed"].includes(method) || this.done.has(item.id)) return true;
    if (!this.started.has(item.id)) {
      const ms = duration(item.durationMs);
      this.started.set(item.id, {item, until: method === "item/started" && ms != null ? this.now() + Math.min(ms, MAX_SLEEP_GRACE_MS) : 0});
      const use = sleepRecords(item, {turnId: this.turnId()})[0];
      this.push(use); this.emit({type: "tool_use", ...use});
    }
    if (method === "item/completed") this.complete(item.id, "completed");
    return true;
  }
  complete(id, status) {
    if (this.done.has(id)) return;
    this.done.add(id);
    const result = sleepRecords(this.started.get(id).item, {turnId: this.turnId(), status})[1];
    this.push(result); this.emit({type: "tool_result", ...result});
  }
  idleActivityAt() {
    let until = 0;
    for (const [id, wait] of this.started) if (!this.done.has(id)) until = Math.max(until, wait.until);
    return until;
  }
  finish(status = "failed") {
    for (const id of this.started.keys()) if (!this.done.has(id)) this.complete(id, status === "completed" ? "failed" : status);
  }
}
