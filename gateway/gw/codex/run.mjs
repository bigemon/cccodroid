import {randomUUID} from "node:crypto";
import {userBookmarkAnchor} from "./message-anchors.mjs";
// Codex 的 "跑一轮"：接在宿主 run/queue 后面
//
// 与 Claude 的 startRun 平级，但共用：
//   - run 对象与 RUNS 表（车道、并行、abort、endRun 都在宿主）
//   - runEmit / SSE / run.log
//   - 会话列表与 /api/session/:id
//
// 本文件只做三件事：拿会话、跑 turn、把结果落进宿主与索引。

import fs from "node:fs";
import path from "node:path";
import { CFG, log } from "../config.mjs";
import { SETTINGS } from "../settings-store.mjs";
import { validCodexMode } from "./permissions.mjs";
import { projectById, projectDefaults,projectOfDir } from "../projects.mjs";
import {syncProjectSkillReuse} from "./project-skill-reuse.mjs";
import { codexTaskPolicy } from "./task-policy.mjs";
import { codexAvailable, codexConfig } from "./config.mjs";
import { CodexSession, DEFAULT_SERVER_ARGS } from "./session.mjs";
import { mcpConfigured, readMcpInventory } from "./extensions-view.mjs";
import { CODEX_DIR, getCodexSession, readItems, saveItems, touchCodexSession, upsertCodexSession } from "./store.mjs";
import { checkModel, learnWindow,codexEffective,newSessionModelDefaults } from "./catalog.mjs";
import { mapTokenUsage } from "./model-view.mjs";
import { codexInput } from "./attachments.mjs";
import {TextAttachmentAccess,ImageAttachmentAccess,attachmentText} from "./text-attachments.mjs";
import {skillInput,skillNames} from "./skills.mjs";
import {codexSlash,parseCodexCommand} from "./slash.mjs";
import { CODEX_OPERATIONS } from "./operation-lock.mjs";
import {parseReviewTarget,resolveReviewTarget} from "./review-target.mjs";
import { commandHistory } from "./commands.mjs";
import {publish} from "../bus.mjs";
import { planTasks } from "./progress.mjs";
import { codexQuestions } from "./questions.mjs";
import { QUEUE, saveRunMark, publishState } from "../queue.mjs";

export { codexAvailable, codexConfig };

const POOL = new Map();          // sessionId → CodexSession（app-server 常驻）
const IDLE_MS = Number(process.env.CCAPP_CODEX_IDLE_MS) || 10 * 60 * 1000;  // 空闲回收（测试可用环境变量缩短）

function watchCodexCommands(s){
  s.onCommandState ||=()=>{
    const commands=codexCommandState(s.sessionId).map(({output,outputStart,nextCursor,durationMs,...r})=>r);
    const signature=JSON.stringify(commands);if(s.commandStateSignature===signature)return;s.commandStateSignature=signature;
    if(POOL.get(s.sessionId)===s&&!s.turn&&getCodexSession(s.sessionId))saveItems(s.sessionId,s.items);
    publish({type:"codex_commands",sessionId:s.sessionId,commands});
  };
  s.onCommandState();
}

function pickCwd(item, run) {
  const directory=p=>{try{return fs.statSync(p).isDirectory();}catch{return false;}};
  if(run.sessionId){
    const rec=getCodexSession(run.sessionId);
    if(!rec?.cwd||!directory(rec.cwd))throw new Error("原工作目录不可用，未切换到其他目录。");
    if(item.cwd&&fs.realpathSync(item.cwd)!==fs.realpathSync(rec.cwd))throw new Error("任务目录与原会话不同，请新建会话。");
    return rec.cwd;
  }
  if(item.cwd){if(!directory(item.cwd))throw new Error("任务工作目录不可用。");return item.cwd;}
  if(item.projectId){
    const p=projectById(item.projectId);
    if(!p||!directory(p.path))throw new Error("项目目录不可用，未切换到工作区。");
    return p.path;
  }
  const cwd=directory(CFG.workspace)?CFG.workspace:CFG.home;
  if(!directory(cwd))throw new Error("工作目录不可用。");
  return cwd;
}

function titleOf(text, prev) {
  if (prev) return prev;
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 90) || "(无标题)";
}

async function sessionFor(rec, cwd, scheduled = false,permissionMode="default") {
  if(rec.historyMutation)throw new Error("历史删除尚未完成同步，请先恢复界面历史再继续。");
  const cached = POOL.get(rec.id);
  if (cached && cached.ready && cached.bin === codexConfig().bin && cached.codexHome === codexConfig().home && cached.cwd === cwd && !!cached.taskIsolated===scheduled&&cached.autoMode===(permissionMode==="auto")) {
    // 记录里换了模型/强度：下一轮按新的跑（thread 不用重建，turn/start 会覆盖）
    cached.model = rec.model || cached.model;
    cached.effort = rec.effort ?? cached.effort;
    return cached;
  }
  if(cached?.commands?.backgroundRunning)throw new Error("后台命令仍在运行，请先停止后再更换连接或权限模式。");
  if (cached) {
    await cached.dispose();
    POOL.delete(rec.id);
  }
  const s = new CodexSession({
    cwd,
    bin: codexConfig().bin,
    codexHome: codexConfig().home,
    sslCertFile: codexConfig().sslCertFile || null,
    sessionId: rec.id,
    model: rec.model || null,
    effort: rec.effort ?? null,
    dataDir: CODEX_DIR,
    approvalPolicy: { allowedCwds: [cwd] },permissionMode,
    serverArgs:[...DEFAULT_SERVER_ARGS,...(scheduled?["--disable","apps"]:[])],
  });
  s.taskIsolated=scheduled;
  s.declaredTools = Array.isArray(rec.hostTools) ? rec.hostTools : null;
  s.items = commandHistory(readItems(rec.id), false); // 恢复界面历史；核心历史仍由 thread/resume 管理，不能重放为用户消息。
  POOL.set(rec.id, s);
  return s;
}

/** 这一轮用哪个模型 / 强度：本轮指定 → 新会话 pin → 会话记录 → 目录默认 */
function pickModel(item, existing, pd = {}) {
  const pin = item && item.pin && typeof item.pin === "object" ? item.pin : {};
  const model = (item && item.model) || pin.model || (existing && existing.model) || pd.model || null;
  const effort = (item && item.effort) || pin.effort || (existing && existing.effort) || pd.effort || null;
  return { model: model || null, effort: effort || null };
}

/**
 * @param {object} run       宿主 run 对象（已有 id / lane / log）
 * @param {object} item      队列 item（message / sessionId / projectId / timeoutMs）
 * @param {{emit:(ev:object)=>void, finish:(fields:object)=>void}} ctx
 */
export async function codexStartRun(run, item, ctx) {
  let lastError="";
  const emit=ev=>{if(ev.type==="error")lastError=String(ev.message||"");ctx.emit(ev);};
  const finish=fields=>ctx.finish({...fields,...(run.sched&&fields.failed&&!fields.finalText&&lastError?{finalText:lastError.slice(0,4000)}:{})});
  if(CODEX_OPERATIONS.has(run.sessionId)){emit({type:"error",message:"会话正在分叉，请稍后重试。"});return finish({failed:true,durationMs:0});}
  const command=parseCodexCommand(item.message);
  if(command&&!["compact","review"].includes(command.name)){
    if(run.unattended){emit({type:"error",message:"定时任务不执行交互命令，请在任务设置中指定模型和权限。"});return finish({failed:true,durationMs:0});}
    try{
      const result=await codexSlash({text:item.message,sessionId:run.sessionId,projectId:item.projectId,pin:item.pin,attachments:item.attachments});
      return finish({localCommand:result.command,resultText:result.text,commandSelection:result.changed?{patch:result.patch,reset:result.reset,scope:result.scope}:null,durationMs:0,costUsd:0});
    }catch(err){emit({type:"error",message:err.status?err.message:"Codex 命令读取失败，请稍后重试。"});return finish({failed:true,durationMs:0});}
  }
  const cfg = codexConfig();
  if (!cfg.bin || !cfg.home) {
    emit({ type: "error", message: "Codex 未配置：缺少 codex 可执行文件或 CODEX_HOME。" });
    return finish({ failed: true, durationMs: 0 });
  }
  if (!fs.existsSync(cfg.bin)) {
    emit({ type: "error", message: `Codex 可执行文件不存在：${cfg.bin}` });
    return finish({ failed: true, durationMs: 0 });
  }

  const compact=command?.name==="compact";
  if (compact && (command.arg || item.attachments?.length)) {
    emit({ type: "error", message: "Codex 的 /compact 暂不接受参数，请单独发送 /compact。" });
    return finish({ failed: true, durationMs: 0 });
  }

  const review=command?.name==="review";
  let reviewTarget=null;
  if(review)try{
    if(item.attachments?.length)throw new Error("原生审查不接受附件，请先移除附件。");
    reviewTarget=parseReviewTarget(command.arg);
  }catch(err){emit({type:"error",message:err.message});return finish({failed:true,durationMs:0});}
  let cwd;try{cwd=pickCwd(item,run);}catch(err){emit({type:"error",message:err.message});return finish({failed:true,durationMs:0});}
  const sharedProject=run.sessionId?projectOfDir(cwd):item.projectId?projectById(item.projectId):null;
  if(review)try{reviewTarget=await resolveReviewTarget(cwd,reviewTarget);}
  catch(err){emit({type:"error",message:err.message});return finish({failed:true,durationMs:0});}
  run.cwd = cwd;
  const startedAt = Date.now();

  const existing = run.sessionId ? getCodexSession(run.sessionId) : null;
  const pd=!existing?projectDefaults(projectById(item.projectId),"codex"):{};
  let chosen = pickModel(item, existing, pd);
  if(!existing||existing.model===null&&existing.effort===null&&existing.modelPicked===false)try{const configured=await newSessionModelDefaults({...item.pin,...(typeof item.model==="string"?{model:item.model}:{}),...(typeof item.effort==="string"?{effort:item.effort}:{})},pd);if(configured)chosen={model:configured.model,effort:configured.effort};}
  catch(err){emit({type:"error",message:err.message});return finish({failed:true,durationMs:0});}
  // 显式恢复默认时，不能让缓存或 thread/resume 再把旧型号/强度带回来。
  const needDefaultModel=existing?.model===null&&!chosen.model,needDefaultEffort=existing?.effort===null&&!chosen.effort;
  if(needDefaultModel||needDefaultEffort){
    const defaults=await codexEffective(existing.id,{model:chosen.model,effort:chosen.effort});
    if(defaults.error){emit({type:"error",message:"默认模型设置暂不可读取，未沿用旧设置启动。"});return finish({failed:true,durationMs:0});}
    if(needDefaultModel)chosen.model=defaults.model;
    if(needDefaultEffort)chosen.effort=defaults.effortRun;
  }
  const scheduled=run.unattended;
  let taskPolicy=null;
  if(scheduled)try{taskPolicy=codexTaskPolicy(item.codexTaskPolicy?.perm||"ro",item.codexTaskPolicy?.tools||"");}
  catch(err){emit({type:"error",message:err.message});return finish({failed:true,durationMs:0});}
  const permissionMode = scheduled ? "default" : validCodexMode(item.permissionMode) ? item.permissionMode
    : existing ? (validCodexMode(existing.permissionMode) ? existing.permissionMode : "default")
    : validCodexMode(pd.perm) ? pd.perm
    : (validCodexMode(SETTINGS.codex?.permissionMode) ? SETTINGS.codex.permissionMode : "default");
  const executionMode=review&&permissionMode==="auto"?"plan":permissionMode;
  // 目录维护不在只读计划、原生审查或无人值守任务中额外写入项目。
  if(sharedProject&&!scheduled&&!review&&executionMode!=="plan")syncProjectSkillReuse(sharedProject.path);
  if (chosen.model) {
    // 清单已经在内存里才校验：不为了一条消息去起账号代理
    const v = await checkModel(chosen.model, { cachedOnly: true }).catch(() => ({ ok: true }));
    if (!v.ok) {
      emit({ type: "error", message: v.message || "Codex 没有这个模型", code: v.code });
      return finish({ failed: true, durationMs: Date.now() - startedAt });
    }
  }

  let session = null, turnStarted=false;
  let questions = null;
  const steering = new Set();
  let lastUsage = null;
  try {
    const attachmentAccess=new TextAttachmentAccess({cwd,uploadDir:path.join(CFG.workspace,"uploads"),paths:existing?.textAttachments});
    const imageAccess=new ImageAttachmentAccess({cwd,uploadDir:path.join(CFG.workspace,"uploads"),paths:existing?.imageAttachments});
    if(!compact&&!review){
      const files=attachmentAccess.prepare(String(item.message||""),item.attachments),images=imageAccess.prepare(String(item.message||""),item.attachments);
      attachmentAccess.grant(files);imageAccess.grant(images);item.message=attachmentText(String(item.message||""),[...files,...images]);run.text=item.message;
    }
    if (existing) {
      if (chosen.model) existing.model = chosen.model;
      if (chosen.effort) existing.effort = chosen.effort;
      session = await sessionFor(existing, cwd, scheduled,executionMode);
      if (!session.setPermissionMode(executionMode)) throw new Error("工具正在执行，暂时无法切换权限模式");
      await session.start();
      if(scheduled)await checkTaskConfig(session,cwd);
      await session.resumeThread(existing.id);
      // resume 会把 thread 当前模型读回来；但这一轮如果选了新模型，要以选择为准，
      // 否则 init 事件会把旧模型报给界面（第一轮就会显示错）
      if (chosen.model) session.model = chosen.model;
      if (chosen.effort) session.effort = chosen.effort;
    } else {
      // 新会话：先建一个临时对象，拿到 threadId 后再登记
      session = new CodexSession({
        cwd,
        bin: cfg.bin,
        codexHome: cfg.home,
        sslCertFile: cfg.sslCertFile || null,
        model: chosen.model,
        effort: chosen.effort,
        dataDir: CODEX_DIR,
        approvalPolicy: { allowedCwds: [cwd] },
        permissionMode:executionMode,
        serverArgs:[...DEFAULT_SERVER_ARGS,...(scheduled?["--disable","apps"]:[])],
      });
      session.taskIsolated=scheduled;
      await session.start();
      if(scheduled)await checkTaskConfig(session,cwd);
      await session.ensureThread();
      POOL.set(session.sessionId, session);
    }

    watchCodexCommands(session);
    if (run.aborted) {
      if (!existing) { POOL.delete(session.sessionId); await session.dispose(); }
      return finish({aborted:true,durationMs:Date.now()-startedAt});
    }
    if(scheduled){
      const inventory=await readMcpInventory(session.client,session.sessionId).catch(()=>{throw new Error("无法核验原生扩展状态，未启动无人值守轮次。");});
      if(inventory.servers.some(server=>server.status!=="disabled"))throw new Error("无人值守任务暂不使用原生 MCP 或 Apps，请在隔离配置中停用后再运行。");
    }
    session.textAttachments=attachmentAccess;
    session.imageAttachments=imageAccess;
    session.taskPolicy=taskPolicy;
    session.onTaskDenied=name=>(run.denied||(run.denied=[])).push(name);
    run.codexHistoryStart=session.items.length;
    session.historyStartedAt=run.startedAt || startedAt;
    run.sessionId = session.sessionId;
    const userBookmarkId=randomUUID();
    emit({
      type: "init",
      userUuid:userBookmarkAnchor(userBookmarkId),
      sessionId: session.sessionId,
      model: session.model,
      permissionMode,
      nativePlanSupported: session.nativePlanSupported,
      outputStyle: null,
      version: "codex",
    });

    const agentsAt=Math.max(Date.now(),(existing?.subagentsAt||0)+1);
    const rec = upsertCodexSession({
      id: session.sessionId,
      threadId: session.sessionId,
      cwd,
      model: session.model,                       // requestedModel，不因改道改变
      // 新会话首条就选了模型/强度，算用户选择（面板才会出现「改回跟随默认」）
      ...(item.pin && (item.pin.model || item.pin.effort) ? { modelPicked: true } : {}),
      // 只有真的改道时才写；下一轮没改道会把它清掉（undefined 不落 JSON）
      effectiveModel: session.effectiveModel || undefined,
      ...(session.effort ? { effort: session.effort } : {}),
      title: titleOf(item.message, existing?.title),
      permissionMode: scheduled && existing ? existing.permissionMode : permissionMode,
      plan: null,subagents:[],subagentsAt:agentsAt,recordBackup:false,
      ...(attachmentAccess.paths().length||existing?.textAttachments?.length?{textAttachments:attachmentAccess.paths()}:{}),
      ...(imageAccess.paths().length||existing?.imageAttachments?.length?{imageAttachments:imageAccess.paths()}:{}),
      ...(!existing ? { hostTools: session.declaredTools } : {}),
    });
    const savedAccess=getCodexSession(session.sessionId);
    for(const [key,access]of [["textAttachments",attachmentAccess],["imageAttachments",imageAccess]]){
      if(access.paths().length&&JSON.stringify(savedAccess?.[key])!==JSON.stringify(access.paths()))throw new Error("附件读取许可无法保存，未启动模型，请检查存储空间。");
    }
    // Codex uses its persisted index, not Claude JSONL discovery. Notify only after it is readable.
    if (!existing && savedAccess) emit({type:"session_created",backend:"codex",sessionId:session.sessionId,runId:run.id,cwd});
    run.codexRecord = rec;
    const observed = { ...(existing?.observed || {}) };
    run.codexPlan = null;run.codexAgents=[];run.codexAgentsAt=agentsAt;
    emit({type:"subagents",agents:[],agentsAt});
    emit({ type: "tasks", backend: "codex", tasks: null, plan: null });

    questions = codexQuestions(run, { emit, publishState, timeoutMs: Number(item.timeoutMs) > 0 ? Number(item.timeoutMs) : 15 * 60 * 1000 });
    run.permMode = permissionMode;
    run.setMode = mode => {
      if(scheduled)return false;
      if (!session.setPermissionMode(mode)) return false;
      run.permMode = mode;
      questions.cancelTools();
      return true;
    };
    session.onToolApproval = p => questions.confirmTool(p);
    session.onNativeApproval = p => questions.confirmNative(p);
    session.onNativeForm = p => questions.form(p);
    session.onUserInput = msg => questions.ask(msg);
    session.onUserInputResolved = id => questions.resolved(id);
    run.abort = () => { questions.close(); return session.interrupt(); };
    run.pendingInject = [];
    run.steer = candidate => {
      if (run.ended || run.aborted || run.codexFinishing) return Promise.resolve(false);
      const operation = (async () => {
        let input;
        const activeTurn=session.turn;let files,images,message;
        try { files=attachmentAccess.prepare(candidate.message,candidate.attachments);images=imageAccess.prepare(candidate.message,candidate.attachments);message=attachmentText(candidate.message,[...files,...images]);input = [...codexInput(message, candidate.attachments, { cwd, uploadDir: path.join(CFG.workspace, "uploads") }),...(candidate.skills?.length||skillNames(candidate.message).length?await skillInput(session.client,cwd,candidate.message,candidate.skills):[])]; }
        catch { return false; } // 明确的附件校验失败交给普通排队轮次报告，不伪装成送达不明。
        if(run.ended||run.aborted||run.codexFinishing||session.turn!==activeTurn)return false;
        attachmentAccess.grant(files);imageAccess.grant(images);
        if(files.length||images.length){
          const patch={textAttachments:attachmentAccess.paths(),imageAttachments:imageAccess.paths()};touchCodexSession(session.sessionId,patch);
          const saved=getCodexSession(session.sessionId);
          if(Object.keys(patch).some(key=>JSON.stringify(saved?.[key])!==JSON.stringify(patch[key])))return false;
        }
        candidate.message=message;
        run.pendingInject.push(candidate);
        saveRunMark();
        try {
          const bookmarkId=randomUUID();
          const accepted = await session.steer(candidate.message, input, {bookmarkId});
          if (accepted) {
            saveItems(session.sessionId, session.items, existing ? {} : {complete:true});
            emit({ type: "inject", text: candidate.message, cid: candidate.cid, itemId: candidate.id, uuid:userBookmarkAnchor(bookmarkId) });
          }
          run.pendingInject = run.pendingInject.filter(x => x !== candidate);
          saveRunMark();
          return accepted;
        } catch (err) {
          // 超时/断线不能假定未送达。保留为挂起项，避免自动重发造成重复执行。
          candidate.held = true;
          run.pendingInject = run.pendingInject.filter(x => x !== candidate);
          QUEUE.unshift(candidate);
          publishState();
          throw err;
        }
      })();
      steering.add(operation);
      operation.then(() => steering.delete(operation), () => steering.delete(operation));
      return operation;
    };

    const input=compact||review?null:[...codexInput(String(item.message||""),item.attachments,{cwd,uploadDir:path.join(CFG.workspace,"uploads")}),...(item.skills?.length||skillNames(item.message).length?await skillInput(session.client,cwd,item.message,item.skills):[])];
    if(run.aborted)return finish({aborted:true,durationMs:Date.now()-startedAt});
    turnStarted=true;
    const result = await session.runTurn({
      bookmarkId:userBookmarkId,
      text: String(item.message || ""),
      compact, review, reviewTarget,
      input,
      timeoutMs: Number(item.timeoutMs) > 0 ? Number(item.timeoutMs) : 0,
      model: chosen.model || undefined,
      effort: chosen.effort || undefined,
      onEvent: (ev) => {
        if(ev.type==="subagent"){
          const agentsAt=Math.max(Date.now(),(run.codexAgentsAt||0)+1);run.codexAgents=ev.agents;run.codexAgentsAt=agentsAt;touchCodexSession(session.sessionId,{subagents:ev.agents,subagentsAt:agentsAt});publishState();emit({...ev,agentsAt});return;
        }
        if(ev.key==="skills-submitted")touchCodexSession(session.sessionId,{lastSkillInputs:{skills:ev.skills,turnId:ev.turnId,evidence:"core-accepted-input"}});
        const seen = ev.type === "plan" ? "planProgress" : ev.codexItem && ev.summaryOnly ? "reasoningSummary"
          : ev.codexItem && ev.phase ? "messagePhases" : null;
        if (seen && !observed[seen] && ev.type !== "plan") {
          observed[seen] = true;
          touchCodexSession(session.sessionId, { observed: { ...observed } });
        }
        if (ev.type === "plan") {
          observed.planProgress = true;
          observed[ev.plan.source === "host-tool" ? "hostPlanProgress" : "nativePlanProgress"] = true;
          run.codexPlan = ev.plan;
          touchCodexSession(session.sessionId, { plan: ev.plan, observed: { ...observed } });
          emit({ type: "tasks", backend: "codex", tasks: planTasks(ev.plan), plan: ev.plan });
          return;
        }
        if (ev.type === "compacting") lastUsage = null;
        if (ev.type === "compacted") {
          lastUsage = ev.usage ? mapTokenUsage(ev.usage).usage : null;
          emit({ type: "compacted", post: lastUsage?.context_tokens ?? null,
            window: lastUsage?.context_window ?? null, pct: lastUsage?.pct_used ?? null });
          return;
        }
        if (ev.type === "usage") {
          // 原始 last / total / modelContextWindow 全部保留；pct 只是按 TUI 公式的估算。
          const u = mapTokenUsage(ev.usage).usage;
          lastUsage = u;
          if (u.context_window && (u.context_tokens != null)) learnWindow(session.model, u.context_window);
          // 两个消费点形状不同（见 06e1 §7.3）：顶层给流式进度条，嵌套给 run_end / 将来口径
          emit({ type: "usage", contextTokens: u.context_tokens, contextWindow: u.context_window, usage: u });
          return;
        }
        emit(ev);
      },
    });

    if (run.codexPlan) {
      run.codexPlan = { ...run.codexPlan, status: result.status, updatedAt: new Date().toISOString() };
      touchCodexSession(session.sessionId, { plan: run.codexPlan });
      emit({ type: "tasks", backend: "codex", tasks: planTasks(run.codexPlan), plan: run.codexPlan });
    }
    run.codexFinishing = true;
    await Promise.allSettled([...steering]);
    questions.close();
    if(!saveItems(session.sessionId, session.items, existing ? {} : {complete:true}))emit({type:"error",message:"界面历史保存失败，核心对话已完成，请检查存储空间。"});
    touchCodexSession(session.sessionId, {
      cwd,
      model: session.model,                       // requestedModel，不因改道改变
      // 新会话首条就选了模型/强度，算用户选择（面板才会出现「改回跟随默认」）
      ...(item.pin && (item.pin.model || item.pin.effort) ? { modelPicked: true } : {}),
      // 只有真的改道时才写；下一轮没改道会把它清掉（undefined 不落 JSON）
      effectiveModel: session.effectiveModel || undefined,
      ...(session.effort ? { effort: session.effort } : {}),
      // 压缩完成但尚无新用量时清除旧值，不能把压缩前数据当成压缩后数据。
      ...(result.compacted && !lastUsage ? { usage: null } : {}),
      // 最近一次可信的上下文状态：重开会话时先按它显示，避免「打开就是空白」
      ...(lastUsage ? {
        usage: {
          context_tokens: lastUsage.context_tokens,
          context_window: lastUsage.context_window,
          pct_used: lastUsage.pct_used,
          at: new Date().toISOString(),
        },
      } : {}),
    });

    const ms = Date.now() - startedAt;
    const failed = !["completed", "interrupted"].includes(result.status);
    log(`[codex] turn ${result.status} ${ms}ms thread=${session.sessionId}${result.terminationReason ? " reason=" + result.terminationReason : ""}`);
    if (failed && result.error) emit({ type: "error", message: String(result.error).slice(0, 1000) });
    const messages=session.items.slice(run.codexHistoryStart).filter(m=>m.role==="assistant");
    const finals=messages.filter(m=>m.phase==="final_answer");
    const finalText=(finals.length?finals:messages.slice(-1)).map(m=>m.text||"").join("\n\n");
    if(result.terminationReason==="timeout"||result.status==="timeout")run.timedOut=true;
    finish({ failed, finalText:finalText.slice(0,4000), durationMs: ms, usage: lastUsage, terminationReason: result.terminationReason || null });
  } catch (err) {
    if (session?.sessionId && run.codexPlan) {
      run.codexPlan = { ...run.codexPlan, status: "failed", updatedAt: new Date().toISOString() };
      touchCodexSession(session.sessionId, { plan: run.codexPlan });
      emit({ type: "tasks", backend: "codex", tasks: planTasks(run.codexPlan), plan: run.codexPlan });
    }
    log(`[codex] run 异常: ${err.stack || err.message}`);
    emit({ type: "error", message: `Codex 运行失败：${err.message}` });
    finish({ failed: true, durationMs: Date.now() - startedAt });
  } finally {
    questions?.close();
    if(session&&!turnStarted){if(POOL.get(session.sessionId)===session)POOL.delete(session.sessionId);await session.dispose();}
    if (session) { session.taskPolicy=null;session.onTaskDenied=null;session.onUserInput = null; session.onUserInputResolved = null; session.onToolApproval = null; session.onNativeApproval=null; session.onNativeForm=null; }
    if (run.pendingInject?.length) { QUEUE.unshift(...run.pendingInject.map(x => ({ ...x, held: true }))); run.pendingInject = []; publishState(); }
    run.setMode = null;
    run.steer = null;
    run.abort = null;
  }
}

/** 网关退出时统一收掉 app-server 与代理 */
export async function disposeAllCodexSessions() {
  const all = [...POOL.values()];
  POOL.clear();
  await Promise.all(all.map((s) => s.dispose().catch(() => {})));
}

/** 空闲回收：网关里没有跑着的会话且超过 IDLE_MS 就关掉，保留磁盘索引 */
export function startCodexIdleReaper(getActiveSessionIds) {
  const interval = Number(process.env.CCAPP_CODEX_REAP_MS) || 60 * 1000;
  const timer = setInterval(async () => {
    const active = new Set(getActiveSessionIds());
    for (const [id, s] of POOL) {
      if (active.has(id)||s.commands?.backgroundRunning) continue;
      const rec = getCodexSession(id,{includeTrashed:true});
      const updated = rec ? Date.parse(rec.updatedAt) || 0 : 0;
      if (Date.now() - updated < IDLE_MS) continue;
      log(`[codex] 空闲回收 ${id}`);
      POOL.delete(id);
      await s.dispose().catch(() => {});
    }
  }, interval);
  timer.unref?.();
  return timer;
}

/** 设置页/状态栏用：后端是否可用、路径、现场会话与账号 */
export function codexStatus() {
  const cfg = codexConfig();
  const live = [...POOL.values()].map((x) => ({
    sessionId: x.sessionId,
    model: x.model,
    account: x.account ? { type: x.account.type ?? null, planType: x.account.planType ?? null } : null,
    cwd: x.cwd,
  }));
  return {
    available: codexAvailable(),
    bin: cfg.bin || "",
    home: cfg.home || "",
    sslCertFile: cfg.sslCertFile || "",
    live,
    account: live.find((x) => x.account)?.account || null,
  };
}

/** 显式设置操作：只复用当前已加载、空闲且没有其他线程的连接。 */
export async function reloadCodexSessionMcp(id){
 const s=POOL.get(id),cfg=codexConfig();
 if(!s?.ready||s.bin!==cfg.bin||s.codexHome!==cfg.home)throw Object.assign(new Error("当前 Codex 连接不可用或配置已变化，请在会话中开始一轮后再重载。"),{status:409});
 try{return await (await import("./mcp-reload.mjs")).reloadMcpSession(s);}
 catch(e){if(e.reconnectRequired)await discardCodexSession(id).catch(()=>{});throw e;}
}

/** 内部只读诊断来源；client/registry 不序列化给浏览器。 */
export function codexDiagnosticSource(sid) {
  const s = sid ? POOL.get(sid) : null;
  if (!s?.ready) return null;
  return {
    client: s.client, registry: s.registry,
    snapshot: {
      active: !!s.turn,subagents:{observed:!!s.items.some(i=>i.role==="subagent"),readToolsBridge:!!(s.readMcp||s.autoMcp),writeApprovalScope:"parent-thread"},autoReview:{enabled:s.autoMode,transport:s.autoMcp?"native-mcp":"dynamic-tools",reviews:s.turn?.autoReview?.snapshot()||s.lastAutoReviews||[]}, nativePolicy:s.nativePolicy?.snapshot||{state:"unavailable"},projectDocFallbacks:s.projectDocFallbacks||null,taskIsolated:!!s.taskIsolated,model: s.effectiveModel || (s.turn?.review ? null : s.model), requestedModel: s.model, effort: s.turn?.review ? null : s.effort,
      reviewReadOnly: !!s.turn?.review,
      permissionMode: s.toolPolicy.mode, coreMode: s.turn?.coreMode || null,
      deviceTools:s.device?.state||"unavailable",commandToolsAvailable: !!s.commands, runningCommands: s.commands?.running || 0, backgroundCommands:s.commands?.backgroundRunning||0,
      nativePlanSupported: !!s.nativePlanSupported, declaredTools: s.declaredTools || null,
    },
  };
}

/** 子代理控制仅使用原会话连接；按需读取已观测历史，不启动或恢复核心轮次。 */
export function codexSubagentSource(sid) {
 const s=POOL.get(sid);return s?.ready?{client:s.client,items:s.items}:null;
}

/** 用户停止按钮只控制当前会话已存在的命令，支持空闲时停止后台任务，不启动执行。 */
export function codexCommandState(sid){return POOL.get(sid)?.commands?.list()||[];}

export async function stopCodexCommand(sid, id) {
  const session = POOL.get(sid);
  if (!session?.commands?.records.has(id)) return null;
  const result=await session.commands.stop({command_id:id},"user");
  return result;
}

/** 恢复历史时丢弃空闲缓存；调用方持有同源操作锁。 */
export async function discardCodexSession(id) {
 const session=POOL.get(id);if(!session)return;
 if(session.turn||session.commands?.backgroundRunning)throw Object.assign(new Error("会话或后台命令正在运行，请先停止后再操作。"),{status:409});
 POOL.delete(id);await session.dispose();
}

async function checkTaskConfig(session,cwd){
  const config=await session.client.call("config/read",{cwd,includeLayers:false},10000).catch(()=>{throw new Error("无法核验原生扩展配置，未启动无人值守轮次。");});
  if(!config?.config||mcpConfigured(config).some(server=>server.enabled))throw new Error("无人值守任务暂不使用原生 MCP，请在隔离配置中停用后再运行。");
}

/** A prepared update waits for native turns, RPCs and retained background commands. */
export function codexRuntimeBusy(){
 return [...POOL.values()].some(s=>s.turn||s.commands?.backgroundRunning||s.client?.pending?.size||s.client?.inflightServerRequests?.size);
}
