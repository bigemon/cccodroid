import fs from "node:fs";
import crypto from "node:crypto";
import {CodexSession} from "./session.mjs";
import {codexConfig} from "./config.mjs";
import {getCodexSession,readHistory,saveItems,backupHistory,setHistoryMutation,CODEX_DIR} from "./store.mjs";
import {mergeRecoveredHistory} from "./history-view.mjs";
import {CODEX_OPERATIONS} from "./operation-lock.mjs";
import {hasRunningCommands} from "./commands.mjs";
import {runOfSession} from "../runs.mjs";
import {QUEUE,RUN_SESSIONS} from "../queue.mjs";
const fail=(message,status=409,extra={})=>{throw Object.assign(new Error(message),{status,...extra});};
const ids=turns=>turns.map(t=>t.id);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const recoveryMessage="历史删除尚未完成同步，请先使用“恢复界面历史”核对核心记录，再继续操作。";
export function deletionBoundary(history,{itemIndex,historyEpoch,userText}){
 if(typeof userText!=="string"||!userText)fail("删除位置无效，请重新打开会话。");
 if(historyEpoch!=null&&historyEpoch!==history.epoch)fail("历史位置已变化，请重新打开会话后再删除。");
 let index=itemIndex;
 if(index!=null){
  if(!Number.isSafeInteger(index)||index<0||historyEpoch!==history.epoch)fail("历史位置已变化，请重新打开会话后再删除。");
 }else{
  const matches=history.items.map((m,i)=>({m,i})).filter(x=>x.m.role==="user"&&x.m.text===userText);
  if(matches.length!==1)fail("这条消息缺少唯一的历史位置，请重新打开会话后再删除。");
  index=matches[0].i;
 }
 const target=history.items[index];if(target?.role!=="user"||target.text!==userText||typeof target.turnId!=="string"||!target.turnId)fail("消息缺少可靠的核心轮次标识，请先恢复界面历史。");
 return {index,turnId:target.turnId};
}
const userTexts=items=>items.filter(m=>m.type==="userMessage").map(m=>(m.content||[]).filter(c=>c.type==="text").map(c=>c.text||"").join("\n"));
export async function deletionTurns(client,id,targetTurnId=null,expectedUsers=null){
 const turns=[],seen=new Set(),cursors=new Set();let cursor=null,bytes=0;const deadline=Date.now()+90000;
 do{
  if(Date.now()>deadline)fail("历史读取超时，未确认删除范围。");
  const page=await client.call("thread/turns/list",{threadId:id,sortDirection:"asc",itemsView:"notLoaded",limit:100,...(cursor?{cursor}:{})},20000);
  if(!Array.isArray(page.data)||!("nextCursor"in page))fail("核心未返回完整历史，无法确认删除范围。");
  bytes+=Buffer.byteLength(JSON.stringify(page.data));
  if(turns.length+page.data.length>50000||bytes>16*1024*1024)fail("历史较大，删除范围读取已停止，原记录保留。");
  for(const t of page.data){if(!t?.id||seen.has(t.id)||t.itemsView!=="notLoaded"||!Array.isArray(t.items)||t.status!=="completed"&&t.status!=="interrupted"&&t.status!=="failed")fail("核心历史尚未完整或包含重复轮次，请稍后重试。");seen.add(t.id);turns.push(t);}
  if(targetTurnId&&page.data.some(t=>t.id===targetTurnId)){
   // 只取所选页的摘要来核对提问；不会读取其他轮次的工具正文。
   const summary=await client.call("thread/turns/list",{threadId:id,sortDirection:"asc",itemsView:"summary",limit:100,...(cursor?{cursor}:{})},20000);
   const selected=summary.data?.find(t=>t.id===targetTurnId);
   if(!same(ids(summary.data||[]),ids(page.data))||selected?.itemsView!=="summary"||!Array.isArray(selected.items))fail("所选轮次摘要已变化，请重新预览。");
   const pos=turns.findIndex(t=>t.id===targetTurnId);let users=selected.items.filter(i=>i.type==="userMessage");
   if(expectedUsers&&!same(userTexts(users),expectedUsers)){
    // summary 可能只含首条提问，省略已持久化的插话；只补读目标轮次，不扩大到其他轮次。
    const entries=[],itemIds=new Set(),itemCursors=new Set();let itemCursor=null;
    do{
     if(Date.now()>deadline)fail("所选轮次读取超时，未确认删除范围。");
     const detail=await client.call("thread/items/list",{threadId:id,turnId:targetTurnId,sortDirection:"asc",limit:100,...(itemCursor?{cursor:itemCursor}:{})},20000);
     if(!Array.isArray(detail.data)||!("nextCursor"in detail))fail("核心未返回完整轮次条目，未执行删除。");
     bytes+=Buffer.byteLength(JSON.stringify(detail.data));
     if(entries.length+detail.data.length>50000||bytes>16*1024*1024)fail("所选轮次较大，删除范围读取已停止，原记录保留。");
     for(const e of detail.data){
      if(e?.turnId!==targetTurnId||typeof e.item?.id!=="string"||!e.item.id||itemIds.has(e.item.id))fail("核心轮次条目无法核对，未执行删除。");
      itemIds.add(e.item.id);entries.push(e.item.type==="userMessage"?e.item:null);
     }
     itemCursor=detail.nextCursor;
     if(itemCursor!=null&&(typeof itemCursor!=="string"||!itemCursor||itemCursors.has(itemCursor)))fail("核心轮次条目分页位置无效，未执行删除。");
     if(itemCursor)itemCursors.add(itemCursor);
    }while(itemCursor);
    users=entries.filter(Boolean);
   }
   turns[pos]={...turns[pos],items:users};
  }
  cursor=page.nextCursor;if(cursor!=null&&(typeof cursor!=="string"||!cursor||cursors.has(cursor)))fail("核心历史分页位置无效，未执行删除。");if(cursor)cursors.add(cursor);
 }while(cursor);
 return turns;
}
export function deletionHostPrefix(history,boundary,turns){
 const target=turns.find(t=>t.id===boundary.turnId);if(!target)fail("所选轮次已不在核心历史中，请重新打开会话。");
 const first=history.items.findIndex(m=>m.role==="user"&&m.turnId===boundary.turnId);
 const nativeUsers=userTexts(target.items);
 const hostUsers=history.items.filter(m=>m.role==="user"&&m.turnId===boundary.turnId).map(m=>m.text);
 if(first<0||!nativeUsers.length||!same(nativeUsers,hostUsers))fail("所选轮次的提问边界无法与核心核对，请重新打开会话或恢复该记录。");
 const positions=new Map(turns.map((t,i)=>[t.id,i])),index=positions.get(boundary.turnId);
 for(let i=0;i<history.items.length;i++){
  const m=history.items[i];if(m.turnId&&positions.has(m.turnId)&&(i<first?positions.get(m.turnId)>=index:positions.get(m.turnId)<index))fail("所选位置与已记录的核心轮次顺序冲突，未执行删除。");
 }
 return history.items.slice(0,first);
}
function hostDigest(items){return digest("host-items",items);}
function digest(header,...lists){const h=crypto.createHash("sha256").update(JSON.stringify(header));for(const list of lists){h.update("[");for(const item of list)h.update(JSON.stringify(item)).update(",");h.update("]");}return h.digest("hex");}
export function retainedHostItems(items,turnIds){
 const keep=new Set(turnIds),result=[];let group=[];
 const flush=()=>{if(!group.length)return;const found=new Set(group.map(m=>m.turnId).filter(Boolean));if(found.size!==1)fail("旧记录缺少可靠轮次边界，无法安全同步。");if(keep.has([...found][0]))result.push(...group);group=[];};
 for(const m of items){if(m.role==="user")flush();if(group.length||m.role==="user")group.push(m);}
 flush();return result;
}
export function reconcileDeletion(turns,local,journal){
 if(!journal||!Array.isArray(journal.originalIds)||!Array.isArray(journal.retainedIds))fail(recoveryMessage);
 const actual=ids(turns),deleted=same(actual,journal.retainedIds);
 if(!deleted&&!same(actual,journal.originalIds))fail("核心历史与删除前后的记录均不一致，已保留备份；请检查后再恢复。");
 if(journal.version===2){
  const value=hostDigest(local),original=value===journal.originalHostDigest,retained=value===journal.retainedHostDigest;
  if(!original&&!retained||!deleted&&!original)fail("本机记录与删除备份不一致，已保留恢复状态。");
  const items=deleted?(original?local.slice(0,journal.hostCut):local):local;
  if(deleted&&hostDigest(items)!==journal.retainedHostDigest)fail("本机保留范围校验失败，未覆盖记录。");
  return {items,deleted,complete:journal.hostComplete===true};
 }
 const items=mergeRecoveredHistory(turns,retainedHostItems(local,actual));
 return {items,deleted};
}
export async function deleteCodexHistory(id,options){
 if(hasRunningCommands(id))fail("后台命令仍在运行，请先停止后再删除历史。");
 if(CODEX_OPERATIONS.has(id))fail("会话正在操作中，请稍后重试。");
 CODEX_OPERATIONS.add(id);let helper,discard=false;
 try{
  if(runOfSession(id)||QUEUE.some(q=>q.sessionId===id||q.follow&&RUN_SESSIONS.get(q.follow)===id))fail("会话正在运行或排队，请等任务结束后再删除。");
  const rec=getCodexSession(id);if(!rec)fail("找不到 Codex 会话。");
  if(rec.historyMutation)fail(recoveryMessage,409,{recoveryRequired:true});
  if(typeof options.dryRun!=="boolean"||!options.dryRun&&(!/^[a-f0-9]{64}$/.test(options.confirmation||"")))fail("请先预览并确认删除范围。",400);
  const local=readHistory(id),boundary=deletionBoundary(local,options);
  const {codexDiagnosticSource}=await import("./run.mjs");
  const source=codexDiagnosticSource(id);if(source?.snapshot.active)fail("会话仍在运行，请稍后删除。");
  let client=source?.client;
  if(!client){
   if(!rec.cwd||!fs.existsSync(rec.cwd)||!fs.statSync(rec.cwd).isDirectory())fail("工作目录不可用，无法核对删除范围。");
   const cfg=codexConfig();
   if(options.dryRun){
    // 预览只读，不获取 writer；沿用已有目录代理的启动/空闲回收，不等待临时会话退出。
    const shared=await (await import("./agent.mjs")).agentClient();
    if(shared.bin===cfg.bin&&shared.codexHome===cfg.home)client=shared;
   }
   // 代理尚未跟上配置切换时沿用原冷连接；正式删除仍取得独立 writer。
   if(!client){helper=new CodexSession({cwd:rec.cwd,bin:cfg.bin,codexHome:cfg.home,sslCertFile:cfg.sslCertFile,dataDir:CODEX_DIR});await helper.start();client=helper.client;}
  }
  const expectedUsers=local.items.filter(m=>m.role==="user"&&m.turnId===boundary.turnId).map(m=>m.text);
  const turns=await deletionTurns(client,id,boundary.turnId,expectedUsers),index=turns.findIndex(t=>t.id===boundary.turnId);if(index<0)fail("所选轮次已不在核心历史中，请先恢复界面历史。");
  // 删除只依赖所选轮次。较早的缺失/无 ID 记录按原样保留，不要求先恢复整段历史。
  const prefix=deletionHostPrefix(local,boundary,turns);
  const originalIds=ids(turns),retainedIds=originalIds.slice(0,index),confirmation=digest([id,local.epoch,boundary.turnId],local.items,turns);
  const preview={ok:true,backend:"codex",scope:"turn-and-later",turnId:boundary.turnId,keptTurns:index,removedTurns:turns.length-index,totalTurns:turns.length,confirmation,filesReverted:false,undoAvailable:false};
  if(options.dryRun)return preview;
  if(options.confirmation!==confirmation)fail("确认期间历史已变化，请重新预览删除范围。");
  // read 不获取 writer；冷连接必须在执行前 resume。已有池连接直接复用，不争夺 writer。
  if(helper)await helper.resumeThread(id);
  const currentLocal=readHistory(id),currentTurns=await deletionTurns(client,id,boundary.turnId,expectedUsers);
  if(digest([id,currentLocal.epoch,boundary.turnId],currentLocal.items,currentTurns)!==confirmation)fail("取得会话连接后历史已变化，请重新预览删除范围。");
  const backup=backupHistory(id);if(!backup)fail("无法创建界面历史备份，未执行删除。",500);
  setHistoryMutation(id,{version:2,state:"pending",originalIds,retainedIds,beforeTurnId:boundary.turnId,backup,hostCut:prefix.length,hostComplete:local.complete,originalHostDigest:hostDigest(local.items),retainedHostDigest:hostDigest(prefix),startedAt:new Date().toISOString()});
  discard=true;
  try{
   const result=await client.call("thread/revert",{threadId:id,beforeTurnId:boundary.turnId},30000);if(result.thread?.id!==id)fail("核心未确认目标会话，需恢复界面历史。");
  }catch(err){
   // 只有明确的 RPC 拒绝且历史未变，才可撤销操作标记。超时/断线保留恢复标记。
   if(err.rpc){const current=await deletionTurns(client,id).catch(()=>null);if(current&&same(ids(current),originalIds)){
    setHistoryMutation(id,null);discard=false;
    if(err.code===-32601||/only supports paginated|legacy/i.test(err.message))fail("这个会话的原生历史格式暂不支持删除此轮及后续对话；原记录已保留。");
    fail("核心拒绝删除，原记录已保留；请重新预览或稍后重试。");
   }}
   fail("核心删除结果尚未完成核验，请先恢复界面历史；不要重复删除。",502,{recoveryRequired:true,coreChanged:"unknown"});
  }
  let coreChanged="unknown";
  try{
   const retained=await deletionTurns(client,id);if(!same(ids(retained),retainedIds))fail("核心返回的保留范围与确认不一致。");
   coreChanged=true;
   const items=prefix;
   if(!saveItems(id,items,{complete:local.complete,newEpoch:true,source:"host-prefix-deleted"}))fail("界面历史保存失败。",500);
   const savedEpoch=readHistory(id).epoch;
   setHistoryMutation(id,null,{clearDerived:true});
   return {...preview,confirmation:undefined,removedTurns:originalIds.length-retainedIds.length,historyEpoch:savedEpoch};
  }catch{
   fail(coreChanged===true?"核心历史已删除，但界面记录未同步完成；请使用“恢复界面历史”后再继续。":"核心删除范围尚未通过核验，请先恢复界面历史；不要重复删除。",502,{recoveryRequired:true,coreChanged});
  }
 }finally{
  if(discard){const {discardCodexSession}=await import("./run.mjs");await discardCodexSession(id).catch(()=>{});}
  await helper?.dispose().catch(()=>{});CODEX_OPERATIONS.delete(id);
 }
}
