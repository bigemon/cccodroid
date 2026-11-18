// 动态工具注册表
//
// 职责：
//   - 生成 thread/start 需要的 DynamicToolSpec[]
//   - 处理 item/tool/call：按 callId 并发分发、参数校验、超时、审计
//   - 把工具结果包装成 { contentItems, success }
//
// 失败一律返回 success:false + 错误文本，不抛到协议层：
// 服务端会把这些文本回灌给模型，模型能看到“为什么失败”。

import fs from "node:fs";
import path from "node:path";
import { toolContext } from "./context.mjs";

/** 最小 JSON Schema 校验（够用即可：type / required / properties / enum / additionalProperties / items / maxLength） */
export function validateSchema(schema, value, pathName = "$") {
  if (!schema || typeof schema !== "object") return [];
  const errors = [];

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const ok = types.some((t) => (t === "integer" ? Number.isInteger(value) : t === actual));
    if (!ok) {
      errors.push(`${pathName}: 期望 ${types.join("|")}，实际 ${actual}`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathName}: 必须是 ${schema.enum.join(" / ")} 之一`);
  }

  if (typeof value === "string" && schema.maxLength && value.length > schema.maxLength) {
    errors.push(`${pathName}: 长度超过 ${schema.maxLength}`);
  }

  if (schema.type === "object" || (schema.properties && typeof value === "object")) {
    const props = schema.properties || {};
    for (const req of schema.required || []) {
      if (value[req] === undefined || value[req] === null) errors.push(`${pathName}.${req}: 必填`);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!(k in props)) errors.push(`${pathName}.${k}: 不允许的字段`);
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (value[k] !== undefined && value[k] !== null) errors.push(...validateSchema(sub, value[k], `${pathName}.${k}`));
    }
  }

  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    value.forEach((v, i) => errors.push(...validateSchema(schema.items, v, `${pathName}[${i}]`)));
  }

  return errors;
}

export class ToolRegistry {
  constructor({ log = () => {}, audit = null, defaultTimeoutMs = 20000, beforeCall = null, processHooks = {} } = {}) {
    this.log = log;
    this.audit = audit;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.beforeCall = beforeCall;
    this.processHooks = processHooks;
    this.tools = new Map();
    this.active = new Map(); // callId -> { name, startedAt }
    this.stats = new Map(); // name -> { calls, ok, fail, totalMs }
  }

  register({ name, description, inputSchema, handler, timeoutMs = null, meta = {} }) {
    if (!name || !/^[a-z][a-z0-9_]{1,60}$/.test(name)) throw new Error(`invalid tool name: ${name}`);
    if (this.tools.has(name)) throw new Error(`duplicate tool: ${name}`);
    if (typeof handler !== "function") throw new Error(`tool ${name} has no handler`);
    this.tools.set(name, {
      name,
      description: description || "",
      inputSchema: inputSchema || { type: "object", properties: {}, additionalProperties: false },
      handler,
      timeoutMs: timeoutMs ?? this.defaultTimeoutMs,
      meta,
    });
    return this;
  }

  has(name) {
    return this.tools.has(name);
  }

  names() {
    return [...this.tools.keys()];
  }

  /** thread/start 的 dynamicTools 参数 */
  specs() {
    return [...this.tools.values()].map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  #record(name, ok, ms) {
    const s = this.stats.get(name) || { calls: 0, ok: 0, fail: 0, totalMs: 0 };
    s.calls += 1;
    s[ok ? "ok" : "fail"] += 1;
    s.totalMs += ms;
    this.stats.set(name, s);
  }

  /** 处理 item/tool/call 的 params，返回 DynamicToolCallResponse */
  async handleCall(params) {
    const name = params?.tool;
    const namespace = params?.namespace ?? null;
    const callId = params?.callId ?? null;
    const args = params?.arguments ?? {};
    const started = Date.now();

    if (namespace !== null && namespace !== undefined) {
      return this.#fail(callId, name, "unsupported-namespace", `不支持 namespace: ${namespace}`, started);
    }

    const tool = this.tools.get(name);
    if (!tool) {
      return this.#fail(callId, name, "unknown-tool", `未知工具: ${name}`, started);
    }

    const errors = validateSchema(tool.inputSchema, args);
    if (errors.length) {
      return this.#fail(callId, name, "invalid-arguments", `参数不合法:\n- ${errors.join("\n- ")}`, started, { args });
    }

    const controller = new AbortController(), processes = new Set();
    this.active.set(callId, { name, startedAt: started, phase: "waiting", controller, processes });
    this.audit?.({ event: "tool_call", callId, tool: name, arguments: args, at: new Date().toISOString() });

    const ctx = {
      callId,
      signal: controller.signal,
      ...this.processHooks,
      trackProcess: promise => { processes.add(promise); promise.then(() => processes.delete(promise)); },
      log: (m) => this.log(`[tool:${name}] ${m}`),
    };

    let timer = null;
    try {
      await this.beforeCall?.({ name, args, callId });
      if (controller.signal.aborted) throw Object.assign(new Error("Tool cancelled"), { code: "cancelled" });
      this.active.get(callId).phase = "running";
      const result = await Promise.race([
        Promise.resolve().then(() => toolContext.run(ctx, () => tool.handler(args, ctx))),
        new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error("tool timeout"), { code: "timeout" })); }, tool.timeoutMs);
        }),
      ]);
      if (controller.signal.aborted) throw Object.assign(new Error("Tool cancelled"), { code: "cancelled" });
      clearTimeout(timer);
      const ms = Date.now() - started;
      this.#record(name, true, ms);
      this.audit?.({ event: "tool_result", callId, tool: name, ok: true, ms, at: new Date().toISOString() });
      return {
        contentItems: toContentItems(result),
        success: true,
      };
    } catch (err) {
      clearTimeout(timer);
      controller.abort();
      await Promise.allSettled([...processes]);
      const ms = Date.now() - started;
      this.#record(name, false, ms);
      this.audit?.({
        event: "tool_result",
        callId,
        tool: name,
        ok: false,
        code: err?.code ?? null,
        error: String(err?.message || err).slice(0, 500),
        ms,
        at: new Date().toISOString(),
      });
      return {
        contentItems: [{ type: "inputText", text: `工具 ${name} 执行失败 (${err?.code || "error"}): ${err?.message || err}` }],
        success: false,
      };
    } finally {
      this.active.delete(callId);
    }
  }

  #fail(callId, name, code, message, started, extra = {}) {
    const ms = Date.now() - started;
    this.#record(String(name), false, ms);
    this.audit?.({ event: "tool_result", callId, tool: name ?? null, ok: false, code, error: message, ms, ...extra, at: new Date().toISOString() });
    return { contentItems: [{ type: "inputText", text: `${message}` }], success: false };
  }

  cancel(callId) {
    const entry = this.active.get(callId);
    if (!entry) return Promise.resolve();
    entry.controller.abort();
    return Promise.allSettled([...entry.processes]);
  }

  cancelAll() {
    const pending = [];
    for (const entry of this.active.values()) { entry.controller.abort(); pending.push(...entry.processes); }
    return Promise.allSettled(pending);
  }

  summary() {
    return Object.fromEntries([...this.stats.entries()].map(([k, v]) => [k, { ...v, avgMs: v.calls ? Math.round(v.totalMs / v.calls) : 0 }]));
  }
}

function toContentItems(result) {
  if (typeof result === "string") return [{ type: "inputText", text: result }];
  if (result && Array.isArray(result.contentItems)) return result.contentItems;
  if (result && typeof result === "object" && typeof result.text === "string") {
    const items = [{ type: "inputText", text: result.text }];
    if (result.imageUrl) items.push({ type: "inputImage", imageUrl: result.imageUrl });
    return items;
  }
  return [{ type: "inputText", text: JSON.stringify(result ?? null) }];
}

/** 审计日志：JSONL，一行一条，0600 */
export function createAuditLog(file, log = () => {}) {
  let dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return (record) => {
    try {
      fs.appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
    } catch (err) {
      log(`[audit] 写入失败: ${err.message}`);
    }
  };
}
