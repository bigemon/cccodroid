// 组装工具集：一个 registry + 一个路径守卫

import { makePathGuard } from "../paths.mjs";
import { ToolRegistry, createAuditLog } from "./registry.mjs";
import { registerFileTools } from "./files.mjs";
import { registerSearchTools } from "./search.mjs";
import { registerGitTools } from "./git.mjs";
import { registerCommandTools } from "./commands.mjs";
import { registerShellTools } from "./shell.mjs";
import {registerBrowserTool} from "./browser.mjs";
import {registerShortCommandTool} from "./short-command.mjs";

/**
 * @param {object} opts
 * @param {string[]} opts.roots   允许访问的根目录（至少一个）
 * @param {string} [opts.cwd]     相对路径解析基准，默认 roots[0]
 * @param {string} [opts.auditFile]
 * @param {(s:string)=>void} [opts.log]
 */
export function buildToolRegistry({ roots, cwd = null, auditFile = null, log = () => {}, limits = {}, readAttachment = null, readImageAttachment = null, askUser = null, updatePlan = null, openBrowser = null, commands = null, shortCommandEnv = null, processHooks = {}, beforeCall = null } = {}) {
  const guard = makePathGuard(roots, cwd || roots[0]);
  const audit = auditFile ? createAuditLog(auditFile, log) : null;
  const registry = new ToolRegistry({ log, audit, beforeCall, processHooks });
  registerFileTools(registry, { guard, limits, readAttachment, readImageAttachment });
  registerSearchTools(registry, { guard });
  registerGitTools(registry, { guard });
  registerShellTools(registry, { guard, env: shortCommandEnv?.env || null });
  registerCommandTools(registry, commands);
  registerBrowserTool(registry,openBrowser);
  if(shortCommandEnv)registerShortCommandTool(registry,{guard,...shortCommandEnv});
  if (askUser) registry.register({
    name: "cccodroid_ask_user",
    description: "Show CCCDroid's on-screen question/choice card and WAIT for the user's submitted answer. Prefer this tool whenever a user decision is needed before continuing, in both normal and plan modes. An asynchronous accepted acknowledgement is not an answer. Ask 1-3 questions; not for execution permissions, passwords or tokens.",
    inputSchema: {
      type: "object", required: ["questions"], additionalProperties: false,
      properties: { questions: { type: "array", items: {
        type: "object", required: ["id", "question"], additionalProperties: false,
        properties: { id: { type: "string" }, question: { type: "string" },
          options: { type: "array", items: { type: "object", required: ["label"], additionalProperties: false,
            properties: { label: { type: "string" }, description: { type: "string" } } } },
          isOther: { type: "boolean" } },
      } } },
    },
    timeoutMs: 16 * 60 * 1000,
    handler: async ({ questions }, ctx) => {
      if (!questions.length || questions.length > 3) throw new Error("Ask 1-3 questions");
      const response = await askUser(questions, ctx.callId);
      return Object.keys(response.answers || {}).length ? JSON.stringify(response) : "The user did not answer. Do not assume a choice; explain what remains unresolved.";
    },
  });
  if (updatePlan) registry.register({
    name: "cccodroid_update_plan",
    description: "Update the visible task plan for a multi-step task. Send the full current plan with step statuses pending, in_progress, or completed, and optional explanation. Keep at most one step in_progress. Use this to report real progress; it does not execute work or grant permissions.",
    inputSchema: { type: "object", required: ["plan"], additionalProperties: false, properties: {
      explanation: { type: "string" },
      plan: { type: "array", items: { type: "object", required: ["step", "status"], additionalProperties: false,
        properties: { step: { type: "string", maxLength: 4000 }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } } } },
    } },
    handler: async (args) => {
      if (args.plan.length > 1000 || args.plan.some(x => !x.step.trim()) || args.plan.filter(x => x.status === "in_progress").length > 1) throw new Error("Use nonempty steps and at most one in_progress step");
      await updatePlan(args);
      return "Plan updated.";
    },
  });
  return { registry, guard };
}

export { ToolRegistry } from "./registry.mjs";
