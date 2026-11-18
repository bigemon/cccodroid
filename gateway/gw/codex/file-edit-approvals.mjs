// 宿主文件编辑、固定测试及同步短命令的原生 MCP 关联。已观测直接子线程跨父轮次保留；不控制其生命周期。
import {actionFingerprint} from "./auto-mcp.mjs";
import {nativeToolApproval,nativeApprovalResponse,nativeToolResult} from "./native-approvals.mjs";
export const FILE_EDIT_TOOLS=new Set(["cccodroid_write_file","cccodroid_edit_file"]);
export const SCOPED_HOST_TOOLS=new Set([...FILE_EDIT_TOOLS,"cccodroid_run_tests","cccodroid_run_command"]);
const valid=v=>typeof v==="string"&&v.length>0&&v.length<=256&&!/[\x00-\x20]/.test(v);
const key=(thread,turn,call)=>JSON.stringify([thread,turn,call]);
export class FileEditApprovals{
 constructor({parent,hostTurn,server,active,mode,generation,authorize,emit=()=>{},push=()=>{},tools=FILE_EDIT_TOOLS,parentOnlyTools=[],onTurnEnd=()=>{}}){Object.assign(this,{parent,hostTurn,server,active,mode,generation,authorize,emit,push,onTurnEnd});this.tools=new Set(tools);this.parentOnlyTools=new Set(parentOnlyTools);this.children=new Map();this.turns=new Map();this.targets=new Map();this.reviews=new Map();this.closed=false;}
 enabled(){return !this.closed&&this.active()&&this.mode()!=="plan";}
 known(thread){return thread===this.parent()||this.children.has(thread);}
 context(meta){
  if(!meta||meta.sessionId!==this.parent()||!valid(meta.threadId)||!valid(meta.callId)||!this.known(meta.threadId))return null;
  let data=meta["x-codex-turn-metadata"];if(typeof data==="string")try{data=JSON.parse(data);}catch{return null;}
  if(!data||data.thread_id!==meta.threadId||!valid(data.turn_id)||this.turns.get(meta.threadId)!==data.turn_id)return null;
  return {threadId:meta.threadId,turnId:data.turn_id,callId:meta.callId};
 }
 target(context){return context?this.targets.get(key(context.threadId,context.turnId,context.callId)):null;}
 source(thread){return thread===this.parent()?{}:{agentId:thread,agentThreadId:thread};}
 observe({method,params:p={}}){
  if(this.closed)return;
  const it=p.item,parent=this.parent(),child=p.threadId!==parent;
  if(p.threadId===parent&&p.turnId===this.hostTurn()&&it?.type==="subAgentActivity"&&it.kind==="started"&&valid(it.agentThreadId)&&it.agentThreadId!==parent&&this.children.size<64)this.children.set(it.agentThreadId,String(it.agentPath||"").slice(0,512));
  if(!this.known(p.threadId))return;
  if(method==="turn/started"&&valid(p.turn?.id))this.turns.set(p.threadId,p.turn.id);
  if(method==="turn/completed"&&valid(p.turn?.id)&&this.turns.get(p.threadId)===p.turn.id){this.turns.delete(p.threadId);this.onTurnEnd(p.threadId,p.turn.id);}
  if(this.turns.get(p.threadId)!==p.turnId)return;
  const k=it&&key(p.threadId,p.turnId,it.id);
  if(method==="item/started"&&it?.type==="mcpToolCall"&&it.server===this.server()&&this.tools.has(it.tool)&&(!child||!this.parentOnlyTools.has(it.tool))&&valid(it.id)&&!this.targets.has(k)){
   // 回收已终结条目，不回收待批准请求。到达上限时明确拒绝新操作。
   if(this.targets.size>=256)for(const [id,t]of this.targets)if(t.done){this.targets.delete(id);this.reviews.delete(id);}
   if(this.targets.size>=256)return;
   let args;try{args=JSON.parse(JSON.stringify(it.arguments??{}));}catch{return;}
   const t={threadId:p.threadId,turnId:p.turnId,callId:it.id,name:it.tool,args,fingerprint:actionFingerprint(it.tool,args),generation:this.generation(),requested:false,manual:false,used:false,done:false};
   this.targets.set(k,t);
   if(child&&this.active()){const data={role:"tool_use",id:"child-edit:"+p.threadId+":"+it.id,name:it.tool,input:args,...this.source(p.threadId)};this.push(data);this.emit({type:"tool_use",...data});}
  }
  if(method==="item/autoApprovalReview/completed"&&valid(p.targetItemId)&&valid(p.reviewId)){
   if(this.reviews.size>=256)for(const [id]of this.reviews)if(!this.targets.has(id)||this.targets.get(id).done)this.reviews.delete(id);
   if(this.reviews.size>=256)return;
   const rk=key(p.threadId,p.turnId,p.targetItemId);
   if(!this.reviews.has(rk))this.reviews.set(rk,{status:p.review?.status,generation:this.generation()});
   if(child&&this.targets.has(rk)&&this.active()){
    const status=p.review?.status,rationale=typeof p.review?.rationale==="string"?p.review.rationale.slice(0,3000):"";
    const labels={approved:"已允许",denied:"已拒绝",timedOut:"审核超时",aborted:"已取消"};
    const note={role:"note",key:"child-review:"+p.threadId+":"+p.reviewId,text:"子代理自动判断："+(labels[status]||"未批准")+(rationale?"\n"+rationale:""),...this.source(p.threadId)};
    if(!this.targets.get(rk).reviewShown){this.targets.get(rk).reviewShown=true;this.push(note);this.emit({type:"note",...note,autoReview:{id:p.reviewId,status,rationale,reviewer:"auto_review",threadId:p.threadId}});}
   }
  }
  if(method==="item/completed"&&this.targets.has(k)){
   const t=this.targets.get(k);if(t.done)return;t.done=true;
   if(child&&this.active()){const data={role:"tool_result",id:"child-edit:"+p.threadId+":"+it.id,name:t.name,ok:it.status==="completed"&&!it.error,text:nativeToolResult(it),...this.source(p.threadId)};this.push(data);this.emit({type:"tool_result",...data});}
  }
 }
 ownsRequest(msg){return msg?.method==="mcpServer/elicitation/request"&&msg.params?.serverName===this.server();}
 async approve(msg){
  const p=msg.params||{},decline=()=>nativeApprovalResponse("decline");
  if(!this.ownsRequest(msg)||!this.enabled()||!this.known(p.threadId)||this.turns.get(p.threadId)!==p.turnId)return decline();
  const approval=nativeToolApproval(msg,{threadId:p.threadId,turnId:p.turnId,maxArgumentBytes:1024*1024+16384});
  if(!approval)return decline();
  const candidates=[...this.targets.values()].filter(t=>!t.done&&!t.used&&!t.requested&&t.threadId===p.threadId&&t.turnId===p.turnId&&t.generation===this.generation()&&t.fingerprint===actionFingerprint(t.name,approval.arguments));
  // 核心采集请求未提供目标调用 ID。同线程同参并发不可区分时不猜测批准归属。
  if(candidates.length!==1)return decline();
  const t=candidates[0];t.requested=true;
  try{await this.authorize({name:t.name,args:t.args,callId:t.callId,requestId:msg.id,...this.source(t.threadId)});}catch{return decline();}
  if(!this.enabled()||t.done||t.used||t.generation!==this.generation()||this.turns.get(t.threadId)!==t.turnId)return nativeApprovalResponse("cancel");
  t.manual=true;return nativeApprovalResponse("accept");
 }
 take(name,args,meta){
  if(!this.enabled()||!this.tools.has(name))return null;
  const context=this.context(meta);if(this.parentOnlyTools.has(name)&&context?.threadId!==this.parent())return null;const t=this.target(context),generation=this.generation(),review=context?this.reviews.get(key(context.threadId,context.turnId,context.callId)):null;
  if(!t||t.used||t.done||t.generation!==generation||t.name!==name||t.fingerprint!==actionFingerprint(name,args))return null;
  if(!t.manual&&!(this.mode()==="auto"&&review?.status==="approved"&&review.generation===generation))return null;
  t.used=true;return {...context,generation,...this.source(t.threadId)};
 }
 close(){this.closed=true;this.targets.clear();this.reviews.clear();this.turns.clear();this.children.clear();}
}
