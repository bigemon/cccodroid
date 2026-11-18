// Codex 账号：状态、设备码登录、取消、退出、订阅额度、用量（P6-E2）
//
// 全部走官方 App Server 的 account/* 方法：
//   - 网关不读取、不保存、不转发任何 Token；
//   - 设备码只在 POST 的响应里回给本机界面，不写日志、不进 SSE、不进事件总线；
//   - 登录成功后由 account/login/completed 通知驱动，前端下一次轮询就能看到状态变化。

import { stopCodexCommand, codexCommandState, codexSubagentSource } from "./run.mjs";
import { createSubagentControl } from "./subagent-control.mjs";
import { getCodexSession, readItems } from "./store.mjs";
import { agentClient } from "./agent.mjs";
const subagentControl=createSubagentControl({getRecord:getCodexSession,getSource:codexSubagentSource,readItems,coldClient:agentClient});
import { codexDiagnostics } from "./diagnostics.mjs";
import { codexExtensions } from "./extensions.mjs";
import {codexSlash,CODEX_COMMANDS} from "./slash.mjs";
import {codexSkills,resolveSkillScope} from "./skill-catalog.mjs";
import {projectSkillReuse,setProjectSkillReuse,projectSkillAutomation,setProjectSkillAutomation} from "./project-skill-reuse.mjs";
import {setCodexSkillEnabled} from "./skill-settings.mjs";
import {setCodexMcpEnabled,reloadCodexMcp} from "./mcp-settings.mjs";
import {codexPreferences,setCodexPreferences} from "./preferences.mjs";
import {claudeSkillReuse,setClaudeSkillReuse} from "./skill-reuse.mjs";
import {claudeInstructionReuse,setClaudeInstructionReuse} from "./instruction-reuse.mjs";
import { NEXT, readBody, sendJson } from "../http.mjs";
import { log } from "../config.mjs";
import { agentLoginState, cancelLogin, logout, noteAccountIdentity, readAccount, readRateLimits, readUsage, startDeviceLogin } from "./agent.mjs";
import { mapAccount, mapRateLimits, mapThreadUsage } from "./model-view.mjs";

function errJson(res, err) {
  const code = err && err.code === "codex_not_logged_in" ? "codex_not_logged_in"
    : err && err.code === "codex_not_configured" ? "codex_not_configured"
      : "codex_backend_error";
  const status = code === "codex_not_logged_in" ? 401 : code === "codex_not_configured" ? 409 : 502;
  return sendJson(res, status, { error: code, message: String((err && err.message) || err) });
}

export async function codexAccountState() {
  const login = agentLoginState();
  try {
    const r = await readAccount({ refreshToken: false });
    noteAccountIdentity(r && r.account);
    const m = mapAccount(r, login && !login.done ? login : null);
    // 登录流程的终态优先于 account/read 的旧快照（token 落盘可能有几秒延迟）
    if (login && login.done) {
      if (login.success) m.state = "logged_in";
      else if (login.cancelled) m.state = "logged_out";
      else if (login.error) { m.state = "failed"; m.message = String(login.error); }
    }
    return {
      ...m,
      pending: !!(login && !login.done),
      loginId: (login && !login.done && login.loginId) || m.loginId || null,
      last: login ? { done: !!login.done, success: !!login.success, cancelled: !!login.cancelled, error: login.error || null } : null,
    };
  } catch (err) {
    if (err && err.code === "codex_not_configured") {
      return { state: "error", message: String(err.message || err), code: "codex_not_configured", requiresOpenaiAuth: true };
    }
    log(`[codex] account/read 失败: ${err.message}`);
    return { state: "error", message: String(err.message || err), code: "codex_backend_error" };
  }
}

// ── 路由 ────────────────────────────────────────────────────────────────
export async function routeCodexAccount(req, res, u, p) {
  if(p==="/api/codex/project-skill-automation"&&["GET","POST"].includes(req.method)){
    try{
      if(req.method==="GET")return sendJson(res,200,projectSkillAutomation());
      let body;try{body=JSON.parse((await readBody(req))||"{}");}catch{return sendJson(res,400,{message:"请求格式无效。"});}
      return sendJson(res,200,setProjectSkillAutomation(body));
    }catch(e){return sendJson(res,e.status||502,{message:e.status?e.message:"项目自动共享设置暂不可用。"});}
  }
  if(p==="/api/codex/project-skill-reuse"&&["GET","POST"].includes(req.method)){
    try{
      let body;
      if(req.method==="GET")body={sessionId:u.searchParams.get("sid")||null,projectId:u.searchParams.get("project")||null};
      else try{body=JSON.parse((await readBody(req))||"{}");}catch{return sendJson(res,400,{message:"请求格式无效。"});}
      if(!body||typeof body!=="object"||Array.isArray(body)||[body.sessionId,body.projectId].some(v=>v!=null&&(typeof v!=="string"||!v)))return sendJson(res,400,{message:"项目共享范围无效。"});
      const scope=resolveSkillScope({sid:body.sessionId,projectId:body.projectId});
      if(scope.status)return sendJson(res,scope.status,{message:scope.message});
      const project=scope.project;
      if(!project)return sendJson(res,req.method==="POST"?400:200,{eligible:false,writable:false,message:"请在项目中设置技能共享。"});
      const result=req.method==="POST"?setProjectSkillReuse(project.path,body):projectSkillReuse(project.path);
      return sendJson(res,200,{eligible:true,projectId:project.id,projectName:project.name,...result});
    }catch(e){return sendJson(res,e.status||502,{message:e.status?e.message:"项目技能共享暂不可用，请重新检查。"});}
  }
  if(p==="/api/codex/instruction-reuse"&&["GET","POST"].includes(req.method)){
    try{
      if(req.method==="GET")return sendJson(res,200,claudeInstructionReuse());
      let body;try{body=JSON.parse((await readBody(req))||"{}");}catch{return sendJson(res,400,{message:"请求格式无效。"});}
      return sendJson(res,200,setClaudeInstructionReuse(body));
    }catch(e){return sendJson(res,e.status||502,{message:e.status?e.message:"全局指令共享暂不可用，请检查目录后重试。"});}
  }
  if(p==="/api/codex/skill-reuse"&&["GET","POST"].includes(req.method)){
    try{
      if(req.method==="GET")return sendJson(res,200,claudeSkillReuse());
      let body;try{body=JSON.parse((await readBody(req))||"{}");}catch{return sendJson(res,400,{message:"请求格式无效。"});}
      return sendJson(res,200,setClaudeSkillReuse(body));
    }catch(e){return sendJson(res,e.status||502,{message:e.status?e.message:"技能共享设置暂不可用，请检查目录后重试。"});}
  }
  if(p==="/api/codex/preferences"&&["GET","POST"].includes(req.method)){
    try{
      if(req.method==="GET")return sendJson(res,200,await codexPreferences());
      let b;try{b=JSON.parse((await readBody(req))||"{}");}catch{return sendJson(res,400,{message:"请求格式无效。"});}
      return sendJson(res,200,await setCodexPreferences(b));
    }catch(e){return sendJson(res,e.status||502,{message:e.status?e.message:"Codex 偏好暂不可核验，请登录后刷新重试。"});}
  }
  if(req.method==="GET"&&p==="/api/codex/subagents"){
    try{return sendJson(res,200,subagentControl.list(u.searchParams.get("sid")));}
    catch(e){return sendJson(res,e.status||502,{message:e.status?e.message:"子代理列表读取失败。"});}
  }
  if(req.method==="GET"&&p==="/api/codex/subagent/status"){
    try{return sendJson(res,200,await subagentControl.read(u.searchParams.get("sid"),u.searchParams.get("agent")));}
    catch(e){return sendJson(res,e.status||502,{message:e.status?e.message:"子代理状态查询失败。"});}
  }
  if(req.method==="POST"&&p==="/api/codex/subagent/stop"){
    let b;try{b=JSON.parse((await readBody(req))||"{}");if(!b||typeof b!=="object"||Array.isArray(b))throw new Error();}catch{return sendJson(res,400,{message:"请求格式无效。"});}
    try{return sendJson(res,200,await subagentControl.stop(b.sessionId,b.agentThreadId,b.turnId));}
    catch(e){return sendJson(res,e.status||502,{message:e.status?e.message:"子代理停止请求失败。"});}
  }
  if(req.method==="POST"&&["/api/codex/mcp/config","/api/codex/mcp/reload"].includes(p)){
    let b;try{b=JSON.parse((await readBody(req))||"{}");if(!b||typeof b!=="object"||Array.isArray(b))throw new Error();}catch{return sendJson(res,400,{message:"请求格式无效。"});}
    try{return sendJson(res,200,await (p.endsWith("/reload")?reloadCodexMcp(b):setCodexMcpEnabled(b)));}
    catch(e){return sendJson(res,e.status||502,{message:e.status?e.message:"MCP 操作暂不可用，请重新检查后再操作。"});}
  }
  if(req.method==="POST"&&p==="/api/codex/skills/config"){
    let b;try{b=JSON.parse((await readBody(req))||"{}");if(!b||typeof b!=="object"||Array.isArray(b))throw new Error();}catch{return sendJson(res,400,{message:"请求格式无效。"});}
    try{return sendJson(res,200,await setCodexSkillEnabled(b));}
    catch(e){return sendJson(res,e.status||502,{message:e.status?e.message:"技能设置暂不可用，请重新检查后再操作。"});}
  }
  if(req.method==="GET"&&p==="/api/codex/skills"){
    const r=await codexSkills({sid:u.searchParams.get("sid"),projectId:u.searchParams.get("project"),refresh:u.searchParams.get("refresh")==="1"});return sendJson(res,r.status||200,r);
  }
  if(req.method==="GET"&&p==="/api/codex/commands")return sendJson(res,200,{backend:"codex",slashCommands:CODEX_COMMANDS});
  if(req.method==="POST"&&p==="/api/codex/slash"){
    let b;try{b=JSON.parse((await readBody(req))||"{}");if(!b||typeof b!=="object"||Array.isArray(b))throw new Error();}catch{return sendJson(res,400,{message:"请求格式无效。"});}
    try{return sendJson(res,200,await codexSlash(b));}
    catch(err){return sendJson(res,err.status||502,{message:err.status?err.message:"Codex 命令读取失败，请稍后重试。"});}
  }
  if(req.method==="GET"&&p==="/api/codex/command/list"){
    const sid=u.searchParams.get("sessionId");if(!sid||!getCodexSession(sid))return sendJson(res,404,{error:"unknown_codex_session"});
    return sendJson(res,200,{commands:codexCommandState(sid)});
  }
  if (req.method === "POST" && p === "/api/codex/command/stop") {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || "{}"); } catch {}
    if (typeof body.sessionId !== "string" || typeof body.commandId !== "string") return sendJson(res, 400, { error: "invalid_command" });
    const result = await stopCodexCommand(body.sessionId, body.commandId);
    return sendJson(res, result ? 200 : 404, result || { error: "unknown_command" });
  }
  if(req.method==="GET"&&p==="/api/codex/extensions"){
    const result=await codexExtensions({sid:u.searchParams.get("sid")||null,projectId:u.searchParams.get("project")||null,scope:u.searchParams.get("scope"),refresh:u.searchParams.get("refresh")==="1"});
    return sendJson(res,result.status||200,result);
  }
  if (req.method === "GET" && p === "/api/codex/diagnostics") {
    const result = await codexDiagnostics(u.searchParams.get("sid") || null);
    return sendJson(res, result.error ? 404 : 200, result);
  }
  if (req.method === "GET" && p === "/api/codex/account") {
    return sendJson(res, 200, await codexAccountState());
  }

  if (req.method === "POST" && p === "/api/codex/login/start") {
    let b = {};
    try { b = JSON.parse((await readBody(req)) || "{}"); } catch {}
    if (b.method && b.method !== "device") {
      return sendJson(res, 400, { error: "unsupported_method", message: "只支持设备码登录（device）。" });
    }
    try {
      const r = await startDeviceLogin();
      // 设备码只回给调用它的本机界面；日志里只记 loginId
      return sendJson(res, 200, { ok: true, loginId: r.loginId, userCode: r.userCode, verificationUrl: r.verificationUrl });
    } catch (err) {
      return errJson(res, err);
    }
  }

  if (req.method === "POST" && p === "/api/codex/login/cancel") {
    let b = {};
    try { b = JSON.parse((await readBody(req)) || "{}"); } catch {}
    const r = await cancelLogin(b.loginId);
    return sendJson(res, 200, { ok: true, status: r.status });
  }

  if (req.method === "POST" && p === "/api/codex/logout") {
    try {
      await logout();
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return errJson(res, err);
    }
  }

  if (req.method === "GET" && p === "/api/codex/limits") {
    try {
      return sendJson(res, 200, mapRateLimits(await readRateLimits()));
    } catch (err) {
      if (err && err.code === "codex_not_logged_in") return sendJson(res, 200, { state: "logged_out" });
      return errJson(res, err);
    }
  }

  if (req.method === "GET" && p === "/api/codex/usage") {
    try {
      return sendJson(res, 200, mapThreadUsage(await readUsage(u.searchParams.get("threadId") || null)));
    } catch (err) {
      if (err && err.code === "codex_not_logged_in") return sendJson(res, 200, { state: "logged_out" });
      return errJson(res, err);
    }
  }

  return NEXT;
}
