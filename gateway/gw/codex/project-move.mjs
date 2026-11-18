// 只更新本会话下轮工作目录；复用缓存重建，不移动历史/项目文件或中止子代理。
import fs from "node:fs";
import {getCodexSession,moveCodexRecordCwd} from "./store.mjs";
import {CODEX_OPERATIONS} from "./operation-lock.mjs";
import {subagentRoster} from "./subagent-control.mjs";
import {runOfSession} from "../runs.mjs";
import {QUEUE,RUN_SESSIONS} from "../queue.mjs";
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
export function codexMoveBusy(sid){
 return !!runOfSession(sid)||QUEUE.some(q=>q.sessionId===sid||(q.follow&&RUN_SESSIONS.get(q.follow)===sid));
}
export async function checkMoveSubagents(source,sid){
 if(!source)return;
 const agents=subagentRoster(source.items,sid);
 await Promise.all(agents.map(async agent=>{
  let thread;
  try{thread=(await source.client.call("thread/read",{threadId:agent.agentThreadId,includeTurns:false},10000))?.thread;}
  catch{fail("暂时无法确认子代理状态，请稍后再移动会话。");}
  if(thread?.id!==agent.agentThreadId||thread.parentThreadId!==sid)fail("子代理归属无法核验，未移动会话。");
  if(thread.status?.type==="active")fail("子代理仍在运行，请等任务结束后再移动会话。");
  if(!["idle","notLoaded"].includes(thread.status?.type))fail("暂时无法确认子代理状态，请稍后再移动会话。");
 }));
}
export async function moveCodexProject(sid,target){
 if(CODEX_OPERATIONS.has(sid)||codexMoveBusy(sid))fail("这个会话正在运行、排队或操作中，请稍后再移动。");
 const rec=getCodexSession(sid);if(!rec)fail("找不到可移动的 Codex 会话。",404);
 let cwd;try{cwd=fs.realpathSync(target);if(!fs.statSync(cwd).isDirectory())throw new Error();}catch{fail("目标工作目录不可用，未移动会话。",400);}
 let old;try{old=fs.realpathSync(rec.cwd);}catch{old=rec.cwd;}
 if(old===cwd)return {ok:true,same:true,backend:"codex",cwd};
 CODEX_OPERATIONS.add(sid);
 try{
  const {codexSubagentSource,codexCommandState}=await import("./run.mjs");
  if(codexCommandState(sid).some(c=>c.running))fail("后台命令仍在运行，请先停止后再移动会话。");
  await checkMoveSubagents(codexSubagentSource(sid),sid);
  if(codexMoveBusy(sid))fail("这个会话正在运行或排队，请稍后再移动。");
  moveCodexRecordCwd(sid,cwd,rec.cwd);
  return {ok:true,backend:"codex",cwd};
 }finally{CODEX_OPERATIONS.delete(sid);}
}
