import {assistantBookmarkAnchor} from "./message-anchors.mjs";
import {normalizeAsyncQuestions} from "./async-questions.mjs";
// Codex 公开进度投影：只消费计划、消息阶段和 reasoning.summary；不读取 reasoning.content。
const PHASES = new Set(["commentary", "partial_answer", "final_answer", "plan"]);
const STATUSES = new Set(["pending", "in_progress", "completed"]);

export function normalizePlan(params, source = "core") {
  if (!params?.turnId || !Array.isArray(params.plan)) return null;
  return {
    turnId: params.turnId, source,
    explanation: typeof params.explanation === "string" ? params.explanation : null,
    steps: params.plan.filter(x => typeof x?.step === "string" && x.step.trim()).map(x => ({
      step: x.step, status: x.status === "inProgress" ? "in_progress" : STATUSES.has(x.status) ? x.status : "pending",
    })),
    status: "running", updatedAt: new Date().toISOString(),
  };
}

export function planTasks(plan) {
  return plan?.steps?.map((s, i) => ({
    id: plan.turnId + ":" + i, subject: s.step, active: s.step,
    status: s.status, blocked: [],
  })) || null;
}

// running 快照但没有活跃宿主轮次：上次任务已中断，不能继续显示为正在执行。
export function visiblePlan(plan, live = false) {
  return plan ? { ...plan, status: plan.status === "running" && !live ? "interrupted" : plan.status } : null;
}

export class CodexProgress {
  constructor({ turnId, emit, push }) {
    this.turnId = turnId;
    this.emit = emit;
    this.push = push;
    this.streams = new Map();
    this.phases = new Map();
  }
  stream(kind, id, index = 0) {
    const key = kind + ":" + id + ":" + index;
    let s = this.streams.get(key);
    if (!s) {
      s = { kind, itemId: id, index, text: "", record: null };
      this.streams.set(key, s);
    }
    return s;
  }
  write(kind, id, text, { replace = false, phase = null, index = 0, questions } = {}) {
    if (typeof text !== "string" || !id) return;
    const s = this.stream(kind, id, index);
    if (phase && PHASES.has(phase)) this.phases.set(id, phase);
    const currentPhase = kind === "plan" ? "plan" : this.phases.get(id) || null;
    const next = replace ? text : s.text + text;
    if (!next && !s.record && !questions?.length) return;
    const unchanged = next === s.text && s.record?.phase === currentPhase && (questions === undefined || JSON.stringify(questions) === JSON.stringify(s.record?.questions || []));
    s.text = next;
    if (!s.record) {
      s.record = { role: kind === "summary" ? "thinking" : "assistant", itemId: id, turnId: this.turnId(),
        ...(kind === "summary" ? { summaryIndex: index, summaryOnly: true } : {}), phase: currentPhase, text: next };
      this.push(s.record);
    } else Object.assign(s.record, { text: next, phase: currentPhase });
    if (questions !== undefined) s.record.questions = questions;
    if (unchanged) return;
    this.emit({ type: kind === "summary" ? (replace ? "thinking" : "thinking_delta") : (replace ? "assistant_text" : "delta"),
      codexItem: true, itemId: id, turnId: this.turnId(), uuid:assistantBookmarkAnchor(this.turnId(),id), phase: currentPhase,
      ...(kind === "summary" ? { summaryIndex: index, summaryOnly: true } : {}), ...(questions !== undefined ? {questions} : {}), replace, text });
  }
  handle(method, p) {
    const it = p.item || {}, id = p.itemId || it.id;
    if (method === "item/agentMessage/delta" || method === "item/plan/delta") {
      this.write(method === "item/plan/delta" ? "plan" : "message", id, p.delta);
      return true;
    }
    if (method === "item/reasoning/summaryTextDelta") {
      if (Number.isInteger(p.summaryIndex) && p.summaryIndex >= 0) this.write("summary", id, p.delta, { index: p.summaryIndex });
      return true;
    }
    if (method !== "item/started" && method !== "item/completed") return false;
    if (it.type === "agentMessage" || it.type === "plan") {
      if (PHASES.has(it.phase)) this.phases.set(id, it.phase);
      // 最终 item 是权威全文，特别是 plan delta 不保证与最终文本一致。
      if (method === "item/completed") this.write(it.type === "plan" ? "plan" : "message", id, it.text || "", { replace: true, phase: it.phase, ...(it.type === "agentMessage" ? {questions:normalizeAsyncQuestions(it.questions)} : {}) });
      else this.emit({ type: "phase", phase: it.type === "plan" ? "plan" : it.phase === "final_answer" ? "final" : it.phase === "commentary" ? "commentary" : "text", itemId: id });
      return true;
    }
    if (it.type === "reasoning") {
      if (method === "item/started") this.emit({ type: "phase", phase: "think", itemId: id });
      else if (Array.isArray(it.summary)) it.summary.forEach((text, index) => this.write("summary", id, text, { replace: true, index }));
      return true;
    }
    return false;
  }
}
