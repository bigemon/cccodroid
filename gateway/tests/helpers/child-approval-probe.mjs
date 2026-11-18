// 仅用于隔离协议实验。未接入产品，不改变正式父/子线程授权。
import {actionFingerprint} from "../../gw/codex/auto-mcp.mjs";
const id=v=>typeof v==="string"&&v.length>0&&v.length<=256;
const key=(thread,turn,call)=>JSON.stringify([thread,turn,call]);
export class ChildApprovalProbe{
 constructor({parent,server,enabled=()=>true,generation=()=>0}){Object.assign(this,{parent,server,enabled,generation});this.children=new Set();this.turns=new Map();this.targets=new Map();this.reviews=new Map();}
 observe({method,params:p={}}){
  const it=p.item;
  if(p.threadId===this.parent&&it?.type==="subAgentActivity"&&it.kind==="started"&&id(it.agentThreadId)&&it.agentThreadId!==this.parent)this.children.add(it.agentThreadId);
  if(!this.children.has(p.threadId))return;
  if(method==="turn/started"&&id(p.turn?.id))this.turns.set(p.threadId,p.turn.id);
  if(method==="turn/completed"&&this.turns.get(p.threadId)===p.turn?.id)this.turns.delete(p.threadId);
  if(this.turns.get(p.threadId)!==p.turnId)return;
  if(method==="item/started"&&it?.type==="mcpToolCall"&&it.server===this.server&&id(it.id)&&this.targets.size<128){
   const k=key(p.threadId,p.turnId,it.id);if(!this.targets.has(k))this.targets.set(k,{name:it.tool,fingerprint:actionFingerprint(it.tool,it.arguments??{}),generation:this.generation(),used:false});
  }
  if(method==="item/autoApprovalReview/completed"&&id(p.targetItemId)&&id(p.reviewId)&&this.reviews.size<128){
   const k=key(p.threadId,p.turnId,p.targetItemId);if(!this.reviews.has(k))this.reviews.set(k,{status:p.review?.status,generation:this.generation()});
  }
 }
 take(name,args,meta){
  if(!this.enabled()||!meta||!this.children.has(meta.threadId)||meta.sessionId!==this.parent)return false;
  let turn=meta["x-codex-turn-metadata"];if(typeof turn==="string")try{turn=JSON.parse(turn);}catch{return false;}
  if(!turn||turn.thread_id!==meta.threadId||!id(turn.turn_id)||!id(meta.callId)||this.turns.get(meta.threadId)!==turn.turn_id)return false;
  // 实测 meta.callId 对应审批 targetItemId；meta.itemId 是另一个 ctc_* 标识。
  const k=key(meta.threadId,turn.turn_id,meta.callId),target=this.targets.get(k),review=this.reviews.get(k),generation=this.generation();
  if(!target||target.used||review?.status!=="approved"||target.generation!==generation||review.generation!==generation||target.name!==name||target.fingerprint!==actionFingerprint(name,args))return false;
  target.used=true;return true;
 }
}
