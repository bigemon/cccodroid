// 当前主线程的交互入口；可扩展到命令和预览。共享目录可见不代表子代理获得父线程控制权。
import {actionFingerprint} from "./auto-mcp.mjs";
export const INTERACTION_TOOLS=new Set(["cccodroid_update_plan","cccodroid_ask_user"]);
const valid=v=>typeof v==="string"&&v.length>0&&v.length<=256&&!/[\x00-\x20]/.test(v);
export class InteractionCalls{
 constructor({context,server,active,tools=INTERACTION_TOOLS}){Object.assign(this,{context,server,active});this.tools=new Set(tools);this.targets=new Map();this.waiters=new Map();this.closed=false;}
 handles(name){return this.tools.has(name);}
 matches(origin){const c=this.context();return !this.closed&&this.active()&&origin?.threadId===c.threadId&&origin.turnId===c.turnId;}
 observe({method,params:p={}}){
  if(this.closed||(method!=="item/started"&&method!=="item/completed"))return;const c=this.context(),it=p.item;
  for(const [id,t]of this.targets)if(t.turnId!==c.turnId)this.targets.delete(id);
  if(!this.active()||p.threadId!==c.threadId||p.turnId!==c.turnId||!valid(c.turnId)||!valid(it?.id))return;
  if(method==="item/completed"){this.targets.delete(it.id);return;}
  if(it.type!=="mcpToolCall"||it.server!==this.server()||!this.handles(it.tool)||this.targets.has(it.id)||this.targets.size>=64)return;
  this.targets.set(it.id,{threadId:c.threadId,turnId:c.turnId,name:it.tool,fingerprint:actionFingerprint(it.tool,it.arguments??{}),used:false});
  this.waiters.get(it.id)?.();
 }
 #origin(name,meta){
  const c=this.context();if(this.closed||!this.active()||!this.handles(name)||meta?.threadId!==c.threadId||meta.sessionId!==c.sessionId||!valid(meta.callId))return null;
  let turn=meta["x-codex-turn-metadata"];if(typeof turn==="string")try{turn=JSON.parse(turn);}catch{return null;}
  if(!valid(c.turnId)||turn?.thread_id!==c.threadId||turn.turn_id!==c.turnId)return null;
  return {threadId:c.threadId,turnId:c.turnId,callId:meta.callId};
 }
 take(name,args,meta){
  if(!this.#origin(name,meta))return null;
  const t=this.targets.get(meta.callId);if(!t||t.used||!this.matches(t)||t.name!==name||t.fingerprint!==actionFingerprint(name,args))return null;
  t.used=true;return {threadId:t.threadId,turnId:t.turnId,callId:meta.callId};
 }
 async takeWhenReady(name,args,meta){
  const origin=this.#origin(name,meta);if(!origin)return null;
  // MCP HTTP 与 app-server 通知分别传输；只等本次目标到达，不使用元数据替代实际事件。
  if(!this.targets.has(origin.callId)){
   if(this.waiters.has(origin.callId)||this.waiters.size>=64)return null;
   await new Promise(resolve=>{
    const finish=()=>{clearTimeout(timer);this.waiters.delete(origin.callId);resolve();};
    const timer=setTimeout(finish,1000);this.waiters.set(origin.callId,finish);
   });
  }
  return this.matches(origin)?this.take(name,args,meta):null;
 }
 close(){this.closed=true;this.targets.clear();for(const finish of this.waiters.values())finish();}
}
