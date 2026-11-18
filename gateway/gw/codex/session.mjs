import {syncClaudeSkillReuse} from "./skill-reuse.mjs";
import {syncClaudeInstructionReuse} from "./instruction-reuse.mjs";
import {screenToken,bindScreenToken,registerScreenClient} from "./screen-witness.mjs";
import {deviceMcp,deviceApprovalBypass} from "./device.mjs";
import {GeneratedImages,GeneratedImageStore} from "./generated-images.mjs";
import {CodexSleep} from "./sleep.mjs";
// 一个 Codex 会话：app-server 进程 + 本地代理 + 动态工具 + 历史规范化
//
// 与 P6-A 的区别（见 docs/reports/06b1）：
//   - 事件不再自己画，交给宿主 runEmit / SSE / 聊天 UI；
//   - 历史按「Turn + Item」组织，增量和最终消息去重，不存两遍；
//   - usage 保留原始值（totalTokens 与上下文占用不是一回事，不在这里混用）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { AppServerClient } from "./rpc.mjs";
import { DIFF_LIMIT, coreDiff, workspaceDiff } from "./diff.mjs";
import { CommandSessions } from "./commands.mjs";
import { commandEnvironment } from "./command-env.mjs";
import { makePathGuard } from "./paths.mjs";
import { buildToolRegistry } from "./tools/index.mjs";
import { ApprovalBroker, DEFAULT_POLICY, buildApprovalResponse } from "./approvals.mjs";
import { CHILD_ENV_KEY, INSTANCE_ID, log } from "../config.mjs";
import { registerChild, unregisterChild } from "../instances.mjs";
import { CodexProgress, normalizePlan } from "./progress.mjs";
import { codexToolPolicy, validCodexMode, toolEffect } from "./permissions.mjs";
import { taskToolAllowed } from "./task-policy.mjs";
import {HOST_INTERACTION_INSTRUCTIONS} from "./async-questions.mjs";
import { sharedDocFallbacks } from "../project-instructions.mjs";
import {nativeToolApproval,nativeApprovalResponse,nativeToolResult} from "./native-approvals.mjs";
import {nativePolicyOverrides} from "./native-policy.mjs";
import {nativeFormRequest} from "./native-forms.mjs";
import {submittedSkills} from "./skills.mjs";
import {AutoMcpBridge} from "./auto-mcp.mjs";
import {AutoReviewState} from "./auto-review.mjs";
import {validateReviewTarget} from "./review-target.mjs";
import {FileMcpBridge} from "./file-mcp.mjs";
import {InteractionCalls,INTERACTION_TOOLS} from "./interaction-calls.mjs";
import {COMMAND_TOOLS,COMMAND_WRITES} from "./tools/commands.mjs";
import {toolContext} from "./tools/context.mjs";
import {FileEditApprovals,SCOPED_HOST_TOOLS} from "./file-edit-approvals.mjs";
import {CodexSubagents} from "./subagents.mjs";

const PARENT_WRITES=new Set([...COMMAND_WRITES,"cccodroid_open_browser"]);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY_SCRIPT = path.join(HERE, "proxy.mjs");

export const DEFAULT_SERVER_ARGS = [
  "--disable", "shell_tool",
  "--disable", "view_image",
  "--enable", "sleep_tool",
  "--enable", "image_generation",
  "--disable", "browser_use",
  "--disable", "computer_use",
  "--disable", "plugins",
  "--disable", "plugin_discovery_prefetch",
  "--disable", "in_app_updates",
];

/** 本地 CONNECT 代理：Codex 的 musl 在 Android 上解析不了域名，由宿主代解析 */
export class ProxyManager {
  constructor({ logPath = null } = {}) {
    this.logPath = logPath;
    this.proc = null;
    this.port = null;
    this.stderr = "";
  }
  get running() {
    return Boolean(this.proc && this.proc.exitCode === null && this.port);
  }
  start({ timeoutMs = 10000 } = {}) {
    if (this.running) return Promise.resolve({ port: this.port });
    return new Promise((resolve, reject) => {
      const args = [PROXY_SCRIPT, "--port", "0"];
      if (this.logPath) args.push("--log", this.logPath);
      const proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, [CHILD_ENV_KEY]: INSTANCE_ID } });
      this.proc = proc;
      registerChild(proc.pid, "codex-proxy");
      let buf = "";
      let settled = false;
      const finish = (err, port) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else {
          this.port = port;
          resolve({ port });
        }
      };
      const timer = setTimeout(() => finish(new Error(`proxy start timeout: ${this.stderr.slice(0, 300)}`)), timeoutMs);
      proc.stdout.on("data", (d) => {
        buf += String(d);
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          try {
            const j = JSON.parse(line);
            if (j.listening) finish(null, Number(j.listening));
          } catch {}
        }
      });
      proc.stderr.on("data", (d) => {
        this.stderr = (this.stderr + String(d)).slice(-2000);
      });
      proc.on("exit", (code) => {
        unregisterChild(proc.pid);
        this.port = null;
        if (!settled) finish(new Error(`proxy exited (code=${code})`));
      });
      proc.on("error", (e) => finish(e));
    });
  }
  env(sslCertFile) {
    const e = {
      HTTPS_PROXY: `http://127.0.0.1:${this.port}`,
      HTTP_PROXY: `http://127.0.0.1:${this.port}`,
      ALL_PROXY: `http://127.0.0.1:${this.port}`,
    };
    if (sslCertFile) {
      e.SSL_CERT_FILE = sslCertFile;
      e.SSL_CERT_DIR = path.dirname(sslCertFile);
    }
    return e;
  }
  async stop() {
    const p = this.proc;
    this.proc = null;
    this.port = null;
    if (!p || p.exitCode !== null) return;
    try {
      p.kill("SIGTERM");
    } catch {}
    await new Promise((r) => {
      const t = setTimeout(r, 3000);
      p.once("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  }
}

export class CodexSession {
  constructor({ cwd, bin, codexHome, sslCertFile = null, sessionId = null, model = null, effort = null, proxyLog = null, dataDir = null, approvalPolicy = DEFAULT_POLICY, serverArgs = DEFAULT_SERVER_ARGS, permissionMode = "default", deviceMcpScript = undefined }) {
    this.deviceMcpScript=deviceMcpScript;
    this.cwd = cwd;
    this.serverArgs = serverArgs;
    this.toolPolicy = codexToolPolicy({ mode: permissionMode, confirm: p => this.onToolApproval ? this.onToolApproval(p) : Promise.resolve(false) });
    this.autoMode=permissionMode==="auto";
    this.nativePlanSupported = false;
    this.permissionGeneration=0;
    this.dataDir = dataDir;
    this.bin = bin;
    this.codexHome = codexHome;
    this.generatedImageStore=new GeneratedImageStore({codexHome});
    this.sslCertFile = sslCertFile;
    this.sessionId = sessionId;      // = Codex threadId
    this.model = model;              // requestedModel：用户/会话选择的模型
    this.effectiveModel = null;      // 本轮实际使用的模型（服务端改道后才有值，null=同 requested）
    this.effort = effort;            // 思考强度：随 turn/start 发，粘性
    this.proxyLog = proxyLog;
    this.broker = new ApprovalBroker({ policy: { ...approvalPolicy, allowedCwds: [cwd] } });

    this.client = null;
    this.proxy = new ProxyManager({ logPath: proxyLog });
    this.registry = null;
    this.account = null;
    this.commandItems=new Map();
    this.items = [];                 // 历史：与 /api/session/:id 同形状
    this.onEvent = () => {};
    this.turn = null;
    this.started = false;
  }

  get ready() {
    return this.started && this.client && !this.client.exited && !this.needRestart;
  }

  #checkInteraction(callId){
    const origin=(this.autoMcp||this.readMcp)?.ownsInteraction(callId);
    if(origin&&!this.interactions?.matches(origin))throw Object.assign(new Error("主会话交互已过期，未更新计划或提问。"),{code:"interaction-expired"});
  }

  async start() {
    if (this.started) return this;
    syncClaudeSkillReuse();
    syncClaudeInstructionReuse();
    await this.proxy.start();
    const processHooks = { onPid: pid => registerChild(pid, "codex-command"), onReap: unregisterChild, processEnv: { [CHILD_ENV_KEY]: INSTANCE_ID } };
    let commandEnv=null;
    try {
      commandEnv = commandEnvironment();
      this.commands = new CommandSessions({ owner:()=>this.sessionId, toolUseId:id=>(this.autoMcp||this.readMcp)?.ownsInteraction(id)?.callId||id, guard: makePathGuard([this.cwd], this.cwd), ...commandEnv,
        onPid: processHooks.onPid, onReap: processHooks.onReap,
        emit: ev => {
          if(this.turn&&ev.command.turnId===this.turn.id)this.turn.hostActivityAt=Date.now();
          let item=this.commandItems.get(ev.command.id);
          if(!item){item={role:"command",...ev.command};this.commandItems.set(item.id,item);this.#push(item);}else Object.assign(item,ev.command);
          this.onCommandState?.();
          if(this.turn&&ev.command.turnId===this.turn.id)this.onEvent(ev);
        } });
    } catch { this.commands = null; log("[codex] 命令工具不可用：未找到可用的 Bash 环境"); }
    const { registry } = buildToolRegistry({
      roots: [this.cwd],
      readAttachment: p => this.textAttachments?.read(p),
      readImageAttachment: p => this.imageAttachments?.read(p)||this.generatedImageStore.read(p,this.items),
      commands: this.commands, shortCommandEnv:commandEnv, processHooks,
      openBrowser:(url,callId)=>{this.#checkInteraction(callId);if(!this.turn||this.turn.finished||this.turn.stopping)throw new Error("No active turn");this.onEvent({type:"browser_open",url});},
      beforeCall: p => {
        this.#checkInteraction(p.callId);
        if(this.turn?.review && toolEffect(p.name)!=="read")throw Object.assign(new Error("原生审查期间不允许宿主写入或执行命令"),{code:"review-read-only"});
        if(this.taskPolicy){
          if(p.args?.background||p.args?.tty)throw new Error("无人值守任务暂不使用后台命令或 PTY");
          if(taskToolAllowed(this.taskPolicy,p.name))return;
          this.onTaskDenied?.(p.name);
          throw Object.assign(new Error("无人值守任务未允许这项工具操作。请说明受阻内容，不要换工具绕过。"),{code:"permission-denied"});
        }
        const edit=this.autoMcp?.ownsEdit(p.callId)||this.readMcp?.ownsEdit(p.callId);
        if(edit){if(!this.fileEdits?.enabled()||edit.generation!==this.permissionGeneration)throw Object.assign(new Error("宿主操作批准已失效。"),{code:"permission-denied"});return;}
        if(this.toolPolicy.mode==="auto"){
          if(this.autoMcp?.owns(p.callId))return;
          if(toolEffect(p.name)!=="read")throw Object.assign(new Error("此旧动态入口未执行操作，也尚未发生审核拒绝。请把本次操作的原始参数提交给原生 MCP "+this.autoMcp?.name+" 中的同名工具，交给 Codex 审核模型决定。这是正式的自动审核入口；不能改参数、改工具或运行脚本绕过真正的审核拒绝。"),{code:"auto-review-required"});
        }
        return this.toolPolicy.authorize(p);
      },
      updatePlan: p => {
        this.#checkInteraction(toolContext.getStore()?.callId);
        if (!this.turn?.id || this.turn.finished) throw new Error("No active turn");
        const plan = normalizePlan({ ...p, turnId: this.turn.id }, "host-tool");
        this.onEvent({ type: "plan", plan });
      },
      askUser: (questions, callId) => {this.#checkInteraction(callId);const id=(this.autoMcp||this.readMcp)?.ownsInteraction(callId)?.callId||callId;return this.onUserInput ? this.onUserInput({ id: "tool-" + id, params: { threadId: this.sessionId, turnId: this.turn?.id, itemId: id, questions } }) : Promise.resolve({ answers: {} });},
      cwd: this.cwd,
      auditFile: path.join(this.dataDir || path.dirname(PROXY_SCRIPT), "audit.jsonl"),
      log: (m) => log(`[codex] ${m}`),
    });
    this.registry = registry;

    this.fileEdits=new FileEditApprovals({parent:()=>this.sessionId,hostTurn:()=>this.turn?.id,server:()=>this.autoMcp?.name||this.readMcp?.name,
      active:()=>this.ready&&this.turn?.id&&!this.turn.finished&&!this.turn.stopping&&!this.turn.isCompact&&!this.turn.review&&!this.taskPolicy&&!this.taskIsolated,
      mode:()=>this.toolPolicy.mode,generation:()=>this.permissionGeneration,authorize:p=>this.toolPolicy.authorize(p),
      emit:ev=>this.onEvent(ev),push:item=>this.#push(item),tools:new Set([...SCOPED_HOST_TOOLS,...PARENT_WRITES]),parentOnlyTools:PARENT_WRITES,
      onTurnEnd:(thread,turn)=>{if(thread!==this.sessionId)(this.autoMcp||this.readMcp)?.cancelScoped(thread,turn);}});
    this.interactions=new InteractionCalls({tools:new Set([...INTERACTION_TOOLS,...COMMAND_TOOLS,"cccodroid_open_browser"]),context:()=>({threadId:this.sessionId,sessionId:this.nativeSessionId||this.sessionId,turnId:this.turn?.id}),server:()=>this.autoMcp?.name||this.readMcp?.name,
      active:()=>this.ready&&this.turn?.id&&!this.turn.finished&&!this.turn.stopping&&!this.turn.isCompact&&!this.turn.review&&!this.taskPolicy&&!this.taskIsolated});
    const interactions=this.interactions;
    const fileEdits={handles:(name,meta)=>(SCOPED_HOST_TOOLS.has(name)||PARENT_WRITES.has(name))&&(!this.autoMode||meta?.threadId!==this.sessionId),take:(...args)=>this.fileEdits.take(...args)};
    const onEditResult=({result})=>{if(result.success&&this.turn)this.turn.checkWorkspaceDiff=true;};
    if(this.autoMode)this.autoMcp=await new AutoMcpBridge({registry,fileEdits,onEditResult,interactions,active:()=>this.ready&&this.turn?.id&&!this.turn.finished&&!this.turn.stopping&&!this.turn.isCompact&&!this.turn.review&&!this.turn.autoReview.closed&&this.toolPolicy.mode==="auto",
      authorize:(name,args,meta)=>(!meta?.threadId||meta.threadId===this.sessionId)&&this.turn?.autoReview?.take(name,args)===true}).start();
    if(!this.autoMode&&!this.taskIsolated)this.readMcp=await new FileMcpBridge({registry,fileEdits,onEditResult,interactions,active:()=>this.ready&&this.turn?.id&&!this.turn.finished&&!this.turn.stopping&&!this.turn.isCompact}).start();
    const bridge=this.autoMcp||this.readMcp;
    const autoArgs=bridge?["-c","mcp_servers."+bridge.name+"="+("{"+Object.entries(bridge.config()).map(([k,v])=>k+"="+JSON.stringify(v)).join(",")+"}")]:[];
    this.device=await deviceMcp({script:this.deviceMcpScript,isolated:!!this.taskIsolated});
    this.screenPrivToken = this.device.state === "enabled" ? screenToken(this.sessionId) : "";
    const client = new AppServerClient({
      bin: this.bin,
      codexHome: this.codexHome,
      cwd: this.cwd,
      extraEnv: { ...this.proxy.env(this.sslCertFile), CCAPP_PRIV_SESS: this.screenPrivToken,...bridge?.env(),NO_PROXY:[process.env.NO_PROXY,"127.0.0.1","localhost"].filter(Boolean).join(","), [CHILD_ENV_KEY]: INSTANCE_ID },
      serverArgs: [...this.serverArgs,...autoArgs,...this.device.args,...(this.taskIsolated?["--disable","sleep_tool","--disable","image_generation"]:[])],
      label: "codex",
      onServerRequest: (msg) => this.#onServerRequest(msg),
    });
    client.on("notification", (msg) => this.#onNotification(msg));
    client.start();
    if (client.child?.pid) registerChild(client.child.pid, "codex-app-server");
    this.revokeScreenWitness = registerScreenClient(client.child, this.screenPrivToken);
    this.client = client;

    await client.call("initialize", {
      clientInfo: { name: "cccodroid_codex_gw", title: "CCCDroid Codex", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, 30000);
    client.notify("initialized", {});
    this.started = true;
    try {
      const modes = await client.call("collaborationMode/list", {}, 10000);
      this.nativePlanSupported = modes?.data?.some(m => m.mode === "plan") && modes.data.some(m => m.mode === "default");
    } catch (err) { log(`[codex] 原生模式探测不可用：${err.message}`); }

    // 通过核心原生备用文件名机制共用 CLAUDE.md，保留用户已有 fallback 顺序。
    // 只传线程参数，不写入 CODEX_HOME/config.toml，也不复制或注入提示词正文。
    try{
      const config=await client.call("config/read",{cwd:this.cwd,includeLayers:false},10000);
      this.projectDocFallbacks=sharedDocFallbacks(config);
      this.nativePolicy=nativePolicyOverrides(config,{reviewer:this.autoMode?"auto_review":"user"});this.nativePolicyError=null;
    }catch{
      this.projectDocFallbacks=null;this.nativePolicy=null;
      this.nativePolicyError="核心配置无法核验，未启动模型。请检查 Codex 版本和配置后重试。";
      log("[codex] 原生工具审批配置暂不可核验");
    }
    // 账号状态后台读，不阻塞会话启动
    client
      .call("account/read", { refreshToken: false }, 20000)
      .then((r) => {
        this.account = r?.account ?? null;
      })
      .catch((err) => log(`[codex] account/read 失败: ${err.message}`));
    return this;
  }

  async ensureThread(model = null) {
    if(this.nativePolicyError)throw new Error(this.nativePolicyError);
    if (this.sessionId) return this.sessionId;
    const res = await this.client.call("thread/start", {
      developerInstructions: HOST_INTERACTION_INSTRUCTIONS,
      cwd: this.cwd,
      ...(model || this.model ? { model: model || this.model } : {}),
      approvalPolicy: "on-request",
      sandbox: "read-only",
      dynamicTools: this.registry.specs().map(t=>this.autoMode&&toolEffect(t.name)!=="read"?{...t,description:"When the native CCCDroid host MCP provides this tool, use that MCP tool for automatic approval review. This legacy dynamic entry is for other permission modes. "+t.description}:t),
      ...(this.autoMode?{approvalsReviewer:"auto_review"}:{}),
      config:{...(this.projectDocFallbacks?{project_doc_fallback_filenames:this.projectDocFallbacks}:{}),...this.nativePolicy?.overrides},
    }, 60000);
    if(this.autoMode&&res.approvalsReviewer!=="auto_review")throw new Error("当前核心未确认自动审核，未启动模型；请检查版本或切换逐项确认。");
    const id = res?.thread?.id;
    if (!id) throw new Error("thread/start 未返回 thread.id");
    this.sessionId = id;
    bindScreenToken(id,this.screenPrivToken);
    this.nativeSessionId=res.thread?.sessionId||id;
    this.declaredTools = this.registry.specs().map(t => t.name);
    this.model = res.model ?? this.model;
    log(`[codex] 新建 thread ${id} model=${this.model}`);
    return id;
  }

  async resumeThread(threadId) {
    if(this.nativePolicyError)throw new Error(this.nativePolicyError);
    const res = await this.client.call("thread/resume", { threadId,developerInstructions:HOST_INTERACTION_INSTRUCTIONS,...(this.autoMode?{approvalsReviewer:"auto_review"}:{}), cwd: this.cwd, excludeTurns: true, config:{...(this.projectDocFallbacks?{project_doc_fallback_filenames:this.projectDocFallbacks}:{}),...this.nativePolicy?.overrides} }, 60000);
    if(this.autoMode&&res.approvalsReviewer!=="auto_review")throw new Error("当前核心未确认自动审核，未恢复模型；请检查版本或切换逐项确认。");
    this.sessionId = threadId;
    bindScreenToken(threadId,this.screenPrivToken);
    this.nativeSessionId=res.thread?.sessionId||threadId;
    // thread/resume 的 model / reasoningEffort 是「这个 thread 现在实际用什么」，
    // 比本地记录更可信：用户可能换过设备端，或者上一轮覆盖过。
    this.model = res?.model ?? this.model;
    this.effort = res?.reasoningEffort ?? this.effort;
    log(`[codex] 恢复 thread ${threadId} model=${this.model || "?"}`);
    return threadId;
  }

  async #onServerRequest(msg) {
    const method = String(msg?.method || "");
    const params = msg?.params || {};
    if (method === "item/tool/requestUserInput" && this.onUserInput) {
      if (params.turnId && this.turn?.id && params.turnId !== this.turn.id) return { answers: {} };
      return this.onUserInput(msg);
    }
    if (method === "item/tool/call") {
      if (!this.turn || this.turn.finished || this.turn.stopping || params.threadId !== this.sessionId || (params.turnId && this.turn.id && params.turnId !== this.turn.id)) {
        return { success: false, contentItems: [{ type: "inputText", text: "Tool call does not belong to the active turn." }] };
      }
      return this.registry.handleCall(params).then((res) => {
        if (res?.success && this.turn && ["cccodroid_write_file","cccodroid_edit_file","cccodroid_exec_command","cccodroid_run_command","cccodroid_run_tests"].includes(params.tool)) this.turn.checkWorkspaceDiff = true;
        const out = flattenContent(res?.contentItems);
        this.#push({ role: "tool_result", id: params.callId, ok: Boolean(res?.success), text: out });
        this.onEvent({ type: "tool_result", id: params.callId, name: params.tool, ok: Boolean(res?.success), text: out });
        return res;
      });
    }
    if(this.fileEdits?.ownsRequest(msg)&&(!this.autoMode||params.threadId!==this.sessionId))return this.fileEdits.approve(msg);
    if(method==="mcpServer/elicitation/request"){
      const turn=this.turn,decline=()=>nativeApprovalResponse("decline");
      if(!turn||turn.finished||turn.stopping||turn.review||this.taskPolicy||this.toolPolicy.mode==="plan")return decline();
      const approval=nativeToolApproval(msg,{threadId:this.sessionId,turnId:turn.id});
      const form=approval?null:nativeFormRequest(msg,{threadId:this.sessionId,turnId:turn.id});
      const deviceBypass=approval&&deviceApprovalBypass(approval,{device:this.device,mode:this.toolPolicy.mode});
      if(approval?(!deviceBypass&&!this.onNativeApproval):(!form||!this.onNativeForm))return decline();
      if(turn.nativeApprovalIds.has(String(msg.id)))return nativeApprovalResponse("cancel");
      turn.nativeApprovalIds.add(String(msg.id));
      const generation=this.permissionGeneration;
      // 应用注入的设备工具遵循宿主全部放行；其他原生服务仍保留自身明确的审批设置。
      let response;try{response=deviceBypass?nativeApprovalResponse("accept"):await (approval?this.onNativeApproval(approval):this.onNativeForm(form));}catch{return decline();}
      if(this.turn!==turn||turn.finished||turn.stopping||generation!==this.permissionGeneration||this.toolPolicy.mode==="plan"||this.taskPolicy)
        return nativeApprovalResponse("cancel");
      if(response?.action==="accept"){
        if(form)return response;
        turn.nativeApprovedExecuting=true;return nativeApprovalResponse("accept");
      }
      return nativeApprovalResponse(response?.action==="cancel"?"cancel":"decline");
    }
    const approvalMethods = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
      "account/chatgptAuthTokens/refresh",
      "attestation/generate",
    ]);
    if (approvalMethods.has(method)) {
      const decision = this.broker.handle(msg);
      // 其余原生权限升级保持保守回退；文件写入与命令执行走宿主工具。
      log(`[codex] 审批 ${method} → ${decision.decision} (${decision.category})`);
      return buildApprovalResponse(method, decision);
    }
    log(`[codex] 未处理的 server request: ${method}`);
    return null;
  }

  #push(item) {
    if(this.historyStartedAt)item.runStartedAt=this.historyStartedAt;
    this.items.push(item);
  }

  #compaction(phase) {
    const t = this.turn;
    if (!t) return;
    if (phase === "started") {
      if (t.compacting) return;
      t.compacting = true;
      t.compacted = false;
      t.usage = null;
      this.onEvent({ type: "compacting" });
    } else {
      if (t.compacted) return; // 新旧通知可能同时到达
      t.compacting = false;
      t.compacted = true;
      this.#push({ role: "note", text: "上下文已压缩", compact: true });
      this.onEvent({ type: "compacted", usage: t.usage });
    }
  }

  #onNotification(msg) {
    const method = msg?.method || "";
    const p = msg?.params || {};
    this.fileEdits?.observe(msg);
    this.interactions?.observe(msg);
    if(p.threadId!==this.sessionId&&this.fileEdits?.known(p.threadId)&&method==="serverRequest/resolved")this.onUserInputResolved?.(p.requestId);
    if (p.threadId && this.sessionId && p.threadId !== this.sessionId) return;
    const emit = (ev) => this.onEvent(ev);
    const t = this.turn;
    if (p.turnId && (!t || (t.id && p.turnId !== t.id))) return;
    if (method === "turn/started" && t?.id && p.turn?.id !== t.id) return;
    if (method.startsWith("item/") || method === "turn/plan/updated") {
      if (!t || t.finished || p.threadId !== this.sessionId) return;
      if (!t.id && p.turnId) t.id = p.turnId;
      if (t.sleep?.handle(method,p)) return;
      if (t.images?.handle(method,p)) return;
      if (t.subagents?.handle(method,p)) return;
      if (t.progress.handle(method, p)) return;
    }

    if(t&&p.item)t.autoReview?.target(p.item);
    switch (method) {
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
        if(t&&this.autoMode&&p.threadId===this.sessionId&&p.turnId===t.id)t.autoReview.handle(method,p);
        break;
      case "guardianWarning":
        if(t&&p.threadId===this.sessionId&&typeof p.message==="string")this.onEvent({type:"note",key:"auto-review-warning",text:p.message.slice(0,3000)});
        break;
      case "turn/started":
        if(t){t.id=p.turn?.id??t.id;if(t.userItem)t.userItem.turnId=t.id;}
        break;

      case "turn/diff/updated": {
        if (!t || p.threadId !== this.sessionId) break;
        const diff = coreDiff(t.id, p.diff);
        if (!t.diffRecord) { t.diffRecord = {role:"diff",...diff}; this.#push(t.diffRecord); }
        else Object.assign(t.diffRecord,diff);
        emit({type:"diff",diff}); break;
      }
      case "turn/plan/updated": {
        const plan = normalizePlan(p);
        if (t && plan) emit({ type: "plan", plan });
        break;
      }

      case "item/completed": {
        if(p.item?.type==="mcpToolCall"&&t){
          const it=p.item;if(t.nativeDone.has(it.id))break;t.nativeDone.add(it.id);
          if(!t.nativeItems.has(it.id)){const data={role:"tool_use",id:it.id,name:[this.autoMcp?.name,this.readMcp?.name].includes(it.server)?it.tool:it.server+"/"+it.tool,input:it.arguments??{}};this.#push(data);emit({type:"tool_use",...data});}
          t.nativeItems.delete(it.id);if(!t.nativeItems.size)t.nativeApprovedExecuting=false;
          const data={role:"tool_result",id:it.id,name:[this.autoMcp?.name,this.readMcp?.name].includes(it.server)?it.tool:it.server+"/"+it.tool,ok:it.status==="completed"&&!it.error,text:nativeToolResult(it)};
          this.#push(data);emit({type:"tool_result",...data});break;
        }
        if (t?.review && ["enteredReviewMode","exitedReviewMode"].includes(p.item?.type)) {
          const completed = p.item.type === "exitedReviewMode";
          t.reviewCompleted = completed || t.reviewCompleted;
          const data = {role:"review",id:t.id+":review",...(t.reviewTarget?{target:t.reviewTarget}:{}),status:completed?"finishing":"running",text:completed?String(p.item.review||"").slice(0,DIFF_LIMIT):"",truncated:String(p.item.review||"").length>DIFF_LIMIT};
          if (!t.reviewRecord) {t.reviewRecord=data;this.#push(data);} else Object.assign(t.reviewRecord,data);
          emit({type:"review",review:data});
        }
        if (p.item?.type === "contextCompaction") this.#compaction("completed");
        break;
      }

      case "item/started": {
        const it = p.item || {};
        if(it.type==="mcpToolCall"&&t&&!t.nativeItems.has(it.id)&&!t.nativeDone.has(it.id)){
          t.nativeItems.add(it.id);
          const data={role:"tool_use",id:it.id,name:[this.autoMcp?.name,this.readMcp?.name].includes(it.server)?it.tool:it.server+"/"+it.tool,input:it.arguments??{}};
          this.#push(data);emit({type:"tool_use",...data});
        }
        if (it.type === "contextCompaction") this.#compaction("started");
        if (it.type === "dynamicToolCall") {
          this.#push({ role: "tool_use", id: it.id, name: it.tool, input: it.arguments ?? {} });
          emit({ type: "tool_use", id: it.id, name: it.tool, input: it.arguments ?? {} });
        }
        break;
      }

      case "item/updated": {
        const it = p.item || {};
        if (it.type === "dynamicToolCall" && it.status === "completed") {
          // 结果由 item/tool/call 的返回值决定，这里只补 host 侧没拿到的情况
        }
        break;
      }

      case "turn/completed": {
        if (t && p.turn?.id === t.id) t.finished = true;
        break;
      }

      case "serverRequest/resolved":
        this.onUserInputResolved?.(p.requestId);
        break;

      case "thread/compacted":
        this.#compaction("completed");
        break;

      case "thread/tokenUsage/updated": {
        // 保留原始 usage，不冒充上下文占用（见 06b1 §5）
        emit({ type: "usage", usage: p.tokenUsage ?? null });
        if (t) t.usage = p.tokenUsage ?? null;
        break;
      }

      case "model/rerouted":
        // 服务端按策略把这一轮改到别的模型。只记「本轮实际」，**不动**用户的选择：
        // 用户钉了 A、服务端临时改道到 B，不应该把偏好永久改成 B（P6-E3.1）。
        if (p.toModel && p.toModel !== this.model) this.effectiveModel = p.toModel;
        emit({
          type: "note",
          key: "model-rerouted",
          from: p.fromModel || null,
          to: p.toModel || null,
          text: `模型已自动改道：${p.fromModel || "?"} → ${p.toModel || "?"}${p.reason ? `（${p.reason}）` : ""}`,
        });
        log(`[codex] 模型改道 ${p.fromModel} → ${p.toModel}`);
        break;

      case "error":
        emit({ type: "error", message: p.message ?? p.error?.message ?? String(p.error ?? "未知错误") });
        break;

      case "configWarning":
        if (p.message) emit({ type: "note", text: String(p.message) });
        break;

      default:
        break;
    }
  }

  /**
   * 跑一轮。onEvent 由宿主提供；返回 turn 结果。
   */
  async runTurn({ text, onEvent, timeoutMs = 0, idleTimeoutMs = 15 * 60 * 1000, model = null, effort = null, compact = false, review = false, reviewTarget = null, input = null, bookmarkId = null }) {
    if(review)reviewTarget=validateReviewTarget(reviewTarget||{type:"uncommittedChanges"});
    if (!this.ready) await this.start();
    if (model) this.model = model;
    if (effort) this.effort = effort;
    this.effectiveModel = null;
    await this.ensureThread(this.model);
    this.onEvent = onEvent || (() => {});
    const turn = { id: null, usage: null, startedAt: Date.now(), compacting: false, compacted: false, isCompact: compact, review, reviewTarget };
    turn.sleep = new CodexSleep({turnId:()=>turn.id,emit:ev=>this.onEvent(ev),push:item=>this.#push(item)});
    turn.images = new GeneratedImages({turnId:()=>turn.id,emit:ev=>this.onEvent(ev),push:item=>this.#push(item),store:this.generatedImageStore});
    turn.progress = new CodexProgress({ turnId: () => turn.id, emit: ev => this.onEvent(ev), push: item => this.#push(item) });
    turn.coreMode = review ? "review" : this.nativePlanSupported ? (this.toolPolicy.mode === "plan" ? "plan" : "default") : null;
    turn.commandItems = new Map();turn.autoReview=new AutoReviewState({server:this.autoMcp?.name,emit:ev=>this.onEvent(ev),push:item=>this.#push(item)});
    turn.subagents=new CodexSubagents({threadId:()=>this.sessionId,turnId:()=>turn.id,emit:ev=>this.onEvent(ev),push:item=>this.#push(item)});
    turn.nativeItems=new Set();turn.nativeDone=new Set();turn.nativeApprovalIds=new Set();turn.nativeApprovedExecuting=false;
    this.turn = turn;
    this.commands?.begin(turn);
    turn.userItem={role:"user",text,turnId:null,...(bookmarkId?{bookmarkId}:{})};
    this.#push(turn.userItem);

    let timer, forceTimer, interrupted = false, finished = false, rpcDone = false;
    let interruptReason = null, lastActivityAt = Date.now();
    const deadline = Number(timeoutMs) > 0;
    const idleLimit = Math.max(1, Number(idleTimeoutMs) || 15 * 60 * 1000);
    let pendingCompletion = null;
    let resolveDone;
    const donePromise = new Promise(resolve => { resolveDone = resolve; });
    const finish = result => {
      if (finished) return;
      finished = true;
      resolveDone(result);
    };
    // 必须先订阅再发 RPC：压缩可能在 {} 回包前就发完生命周期。
    const listener = msg => {
      if (msg.params?.threadId && msg.params.threadId !== this.sessionId) return;
      if (msg.params?.threadId === this.sessionId && /^(turn\/|item\/|thread\/tokenUsage|model\/|serverRequest\/)/.test(msg.method)) lastActivityAt = Date.now();
      if (msg.method !== "turn/completed") return;
      const completed = msg.params?.turn;
      if (!completed) return;
      if (!rpcDone) { pendingCompletion = completed; return; }
      if (!turn.id || completed.id === turn.id) finish({ status: completed.status, error: completed.error ?? null });
    };
    const exited = () => finish({ status: "failed", error: "Codex app-server 已退出" });
    this.client.on("notification", listener);
    this.client.once("exit", exited);
    const interruptTurn = async (why = "user") => {
      if (interrupted || finished) return false;
      interrupted = true;
      turn.stopping=true;
      turn.autoReview.close();
      this.permissionGeneration++;
      interruptReason = why;
      this.commands?.close(why).catch(() => {});
      this.registry?.cancelAll();
      log(`[codex] 请求中断 reason=${why} thread=${this.sessionId}`);
      forceTimer = setTimeout(() => {
        this.needRestart = true;
        finish({ status: why === "timeout" || why === "idle-timeout" ? "timeout" : "interrupted", error: "interrupt-timeout", forced: true });
      }, 8000);
      forceTimer.unref?.();
      try {
        await this.client.call("turn/interrupt", { threadId: this.sessionId, ...(turn.id ? { turnId: turn.id } : {}) }, 20000);
      } catch (err) { log(`[codex] 中断请求失败: ${err.message}`); }
      return true;
    };
    this.interruptTurn = () => interruptTurn();
    // 普通交互轮次按“无进展”计时，不能在持续工作 15 分钟后强行中断。
    // 显式任务时限（例如定时任务）仍是硬截止。等待宿主工具/用户输入时暂停闲置计时。
    // 原生 sleep 仅按本次声明时长（最多 24 小时）预留宽限，重复 started 不续期；到期仍检查无进展。
    timer = deadline ? setTimeout(() => interruptTurn("timeout"), Number(timeoutMs)) : setInterval(() => {
      if (this.client.inflightServerRequests.size) lastActivityAt = Date.now();
      else if (Date.now() - Math.max(lastActivityAt, turn.hostActivityAt || 0, turn.sleep.idleActivityAt()) >= idleLimit) interruptTurn("idle-timeout");
    }, Math.min(1000, Math.max(10, idleLimit / 4)));
    timer.unref?.();
    try {
      const res = review
        ? await this.client.call("review/start", {threadId:this.sessionId,target:reviewTarget,delivery:"inline"},60000)
        : compact
        ? await this.client.call("thread/compact/start", { threadId: this.sessionId }, 60000)
        : await this.client.call("turn/start", {
          threadId: this.sessionId,
          input: input || [{ type: "text", text }],
          ...(this.model ? { model: this.model } : {}),
          ...(this.effort ? { effort: this.effort } : {}),
          approvalPolicy: "on-request",
          approvalsReviewer:this.autoMode?"auto_review":"user",
          ...(this.nativePlanSupported && this.model ? { collaborationMode: { mode: turn.coreMode, settings: { model: this.model, reasoning_effort: this.effort || null, developer_instructions: null } } } : {}),
          // 真实边界在宿主动态工具中；该声明避免核心把可用的写文件工具当成只读。
          sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
        }, 60000);
      if (review && res.reviewThreadId && res.reviewThreadId !== this.sessionId) {
        this.needRestart = true;
        await this.client.call("turn/interrupt",{threadId:res.reviewThreadId,...(res.turn?.id?{turnId:res.turn.id}:{})},10000).catch(()=>{});
        throw new Error("核心未使用当前线程执行审查，已请求停止");
      }
      turn.id = res?.turn?.id || turn.id;
      turn.userItem.turnId=turn.id;
      const skills=submittedSkills(input);
      if(skills.length){turn.userItem.skills=skills;const note={role:"note",text:"已向核心提交技能："+skills.map(s=>s.name).join("、"),key:"skills-submitted",skills,turnId:turn.id};this.#push(note);this.onEvent({...note,type:"note"});}
      rpcDone = true;
      if (pendingCompletion && (!turn.id || pendingCompletion.id === turn.id)) {
        finish({ status: pendingCompletion.status, error: pendingCompletion.error ?? null });
      }
      const done = await donePromise;
      turn.outcome = interrupted ? (interruptReason === "user" ? "interrupted" : "timeout") : done.status;
      if (review && done.status === "completed" && !turn.reviewCompleted) return {status:"failed",error:"审查轮次结束，但未收到原生审查结果",items:this.items};
      if (compact && done.status === "completed" && !turn.compacted) {
        return { status: "failed", error: "压缩轮次已结束，但未收到压缩完成事件", usage: turn.usage, items: this.items };
      }
      return {
        ...done,
        forced: Boolean(done.forced),
        text: "",
        status: interrupted ? (interruptReason === "user" ? "interrupted" : "timeout") : done.status,
        terminationReason: interruptReason,
        error: interruptReason === "idle-timeout" ? "Codex 长时间未报告进展，已中断；请检查网络或重试。"
          : interruptReason === "timeout" ? "这项任务已达到显式设置的运行时限。"
          : typeof done.error === "object" && done.error ? done.error.message || JSON.stringify(done.error) : done.error,
        usage: turn.usage,
        compacted: turn.compacted,
        items: this.items,
      };
    } catch (err) {
      return { status: "failed", error: err.message, usage: turn.usage, items: this.items };
    } finally {
      turn.sleep.finish(turn.outcome);
      turn.images.finish(turn.outcome);
      turn.subagents.finish(interruptReason||turn.outcome||"parent-ended");
      turn.autoReview.close();this.lastAutoReviews=turn.autoReview.snapshot();
      const remaining=(this.commands?.running||0)-(this.commands?.backgroundRunning||0);
      await this.commands?.endTurn(interruptReason || "turn-ended");
      await this.registry?.cancelAll();
      if (remaining && !interrupted) this.onEvent({ type: "note", key: "commands-cleanup", text: "本轮结束，尚在运行的命令已停止。" });
      if (turn.reviewRecord) {
        turn.reviewRecord.status = turn.outcome === "completed" && turn.reviewCompleted ? "completed" : turn.outcome === "interrupted" || interruptReason === "user" ? "interrupted" : interruptReason || "failed";
        this.onEvent({type:"review",review:turn.reviewRecord});
      }
      if (turn.checkWorkspaceDiff && !review) try {
        const diff=await workspaceDiff(this.cwd);
        if(diff){diff.id=(turn.id||"turn")+":workspace";this.#push({role:"diff",...diff});this.onEvent({type:"diff",diff});}
      } catch { this.onEvent({type:"note",key:"diff-unavailable",text:"工作区差异读取失败，请在 Git 页面核对。"}); }
      if (deadline) clearTimeout(timer); else clearInterval(timer);
      clearTimeout(forceTimer);
      this.client.off("notification", listener);
      this.client.off("exit", exited);
      this.turn = null;
      this.interruptTurn = null;
    }
  }

  setPermissionMode(mode) {
    if (!validCodexMode(mode)) return false;
    const changesAuto=(mode==="auto")!==this.autoMode;
    if(changesAuto&&this.started)return false;
    if(!this.started)this.autoMode=mode==="auto";
    if (mode !== this.toolPolicy.mode && (this.commands?.running||this.turn?.nativeApprovedExecuting)) return false;
    if (mode !== this.toolPolicy.mode && [...(this.registry?.active.values() || [])].some(t => t.phase === "running" && toolEffect(t.name) !== "read")) return false;
    const changed=mode!==this.toolPolicy.mode,result=this.toolPolicy.setMode(mode);
    if(result&&changed)this.permissionGeneration++;
    return result;
  }

  async steer(text, input = null, {bookmarkId=null} = {}) {
    const turn = this.turn;
    if (!this.ready || !turn?.id || turn.compacting || turn.finished || turn.isCompact || turn.review) return false;
    try {
      const result = await this.client.call("turn/steer", {
        threadId: this.sessionId,
        expectedTurnId: turn.id,
        input: input || [{ type: "text", text }],
      }, 15000);
      if (result?.turnId && result.turnId !== turn.id) throw new Error("steer 返回了不同轮次，送达状态未知");
      const skills=submittedSkills(input);
      this.#push({ role: "user", text, turnId:turn.id, injected:true,...(bookmarkId?{bookmarkId}:{}),...(skills.length?{skills}:{}) });
      if(skills.length){const note={role:"note",text:"已向核心提交技能："+skills.map(s=>s.name).join("、"),key:"skills-submitted",skills,turnId:turn.id};this.#push(note);this.onEvent({...note,type:"note"});}
      return true;
    } catch (err) {
      if (err.rpc) return false; // 核心明确拒绝，可以排队；超时/断线则送达状态不明。
      throw err;
    }
  }

  async interrupt() {
    if (this.interruptTurn) return this.interruptTurn();
    return false;
  }

  async dispose() {
    this.revokeScreenWitness?.(); this.revokeScreenWitness=null;
    this.started=false;
    this.fileEdits?.close();
    this.interactions?.close();
    if(this.turn){this.turn.stopping=true;this.turn.autoReview?.close();}
    this.permissionGeneration++;
    await this.commands?.close("disposed");
    await this.registry?.cancelAll();
    const pid = this.client?.child?.pid;
    try {
      await this.client?.dispose();
    } catch {}
    if (pid) unregisterChild(pid);
    this.client = null;
    this.started = false;
    await this.autoMcp?.close();this.autoMcp=null;
    await this.readMcp?.close();this.readMcp=null;
    await this.proxy.stop();
  }
}

function flattenContent(items) {
  if (!items) return "";
  if (typeof items === "string") return items;
  if (Array.isArray(items)) {
    return items.map((c) => (c && typeof c === "object" ? c.type === "inputImage" ? "[图片]" : c.text ?? JSON.stringify(c) : String(c))).join("\n");
  }
  return typeof items === "object" ? JSON.stringify(items) : String(items);
}
