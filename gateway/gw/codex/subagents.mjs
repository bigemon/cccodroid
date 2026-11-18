const active=new Set(["pending","running"]);
const terminal=new Set(["completed","failed","interrupted","closed","unavailable"]);
const statusMap={pendingInit:"pending",running:"running",interrupted:"interrupted",completed:"completed",errored:"failed",shutdown:"closed",notFound:"unavailable"};
const labelMap={pending:"正在启动",running:"运行中",completed:"已完成",failed:"失败",interrupted:"已中断",closed:"已关闭",unavailable:"不可用",unconfirmed:"状态待确认"};
const text=(v,n=200)=>typeof v==="string"?v.slice(0,n):"";
const id=v=>typeof v==="string"&&v.length>0&&v.length<=256&&!/[\x00-\x1f]/.test(v);
export function visibleSubagent(record,live=false){
 if(!record)return null;
 return {...record,...(!live&&active.has(record.status)?{status:"unconfirmed",reason:"会话不在运行，子代理状态待确认"}:{})};
}
export class CodexSubagents{
 constructor({threadId,turnId,emit,push}){this.threadId=threadId;this.turnId=turnId;this.emit=emit;this.push=push;this.agents=new Map();this.seen=new Set();this.closed=false;}
 handle(method,p){
  if(!["item/started","item/completed"].includes(method))return false;
  const it=p?.item;if(!["subAgentActivity","collabAgentToolCall"].includes(it?.type))return false;
  if(this.closed||p.threadId!==this.threadId()||!p.turnId||p.turnId!==this.turnId()||!id(it.id))return true;
  const key=method+":"+it.id;if(this.seen.has(key))return true;this.seen.add(key);
  if(it.type==="subAgentActivity"){
   if(!id(it.agentThreadId)||!["started","interacted","interrupted","completed"].includes(it.kind))return true;
   if(it.kind==="interacted")return true; // 交互调用完成不等于子任务完成或重新开始。
   const status=it.kind==="started"?"running":it.kind;
   this.update(it.agentThreadId,status,{path:text(it.agentPath,512),model:text(it.model),effort:text(it.reasoningEffort)},it.kind==="started"&&(method==="item/started"||!this.seen.has("item/started:"+it.id)),it.id);
   return true;
  }
  if(it.senderThreadId!==this.threadId())return true;
  const receivers=Array.isArray(it.receiverThreadIds)?it.receiverThreadIds.filter(id).slice(0,64):[];
  const states=it.agentsStates;
  if(states&&typeof states==="object"&&!Array.isArray(states)){
   for(const [child,state]of Object.entries(states).slice(0,64))if(id(child)&&statusMap[state?.status]){
    this.update(child,statusMap[state.status],{model:text(it.model),effort:text(it.reasoningEffort)},["spawnAgent","followupTask","resumeAgent","sendInput"].includes(it.tool)&&it.status==="completed",it.id);
   }
  }
  if(it.tool==="spawnAgent")for(const child of receivers)if(!states?.[child])this.update(child,it.status==="failed"?"failed":it.status==="inProgress"?"pending":"running",{model:text(it.model),effort:text(it.reasoningEffort)},false,it.id);
  return true; // wait/close 调用自身完成不能覆盖真实子任务状态。
 }
 update(child,status,meta={},restart=false,itemId=null){
  if(child===this.threadId())return;
  let r=this.agents.get(child);const created=!r;
  if(!r){if(this.agents.size>=64)return;r={role:"subagent",id:this.turnId()+":agent:"+child,agentThreadId:child,parentThreadId:this.threadId(),turnId:this.turnId(),status:"pending",label:"子代理",source:"core",lastItemId:itemId};this.agents.set(child,r);this.push(r);}
  if(terminal.has(r.status)&&(!restart||r.lastItemId===itemId)&&active.has(status))return;
  if(r.status==="completed"&&["closed","interrupted"].includes(status))return;
  const next={...r,status,lastItemId:itemId};
  for(const [k,v]of Object.entries(meta))if(v)next[k]=v;
  if(next.path)next.label=next.path.split("/").filter(Boolean).at(-1)||"子代理";
  if(!created&&JSON.stringify(next)===JSON.stringify(r))return;
  Object.assign(r,next);this.emit({type:"subagent",agent:{...r},agents:this.snapshot()});
 }
 snapshot(){return [...this.agents.values()].map(r=>({...r}));}
 finish(reason="parent-ended"){
  this.closed=true;
  for(const r of this.agents.values())if(active.has(r.status)){r.status="unconfirmed";r.reason=reason==="gateway-exited"?"核心已退出，子代理状态待确认":reason==="user"?"已请求停止主任务，子代理停止状态待确认":"主轮次已结束，子代理状态待确认";this.emit({type:"subagent",agent:{...r},agents:this.snapshot()});}
 }
 running(){return this.snapshot().filter(r=>active.has(r.status));}
}
export function subagentStatusLabel(status){return labelMap[status]||"状态未知";}
