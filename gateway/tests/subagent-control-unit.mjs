import assert from "node:assert/strict";
import {createSubagentControl,subagentRoster} from "../gw/codex/subagent-control.mjs";
const row=(child="child",extra={})=>({role:"subagent",agentThreadId:child,parentThreadId:"root",label:child,status:"running",...extra});
function setup(){
 const items=[row(),row("sibling")],calls=[],states={child:{id:"child",parentThreadId:"root",status:{type:"active"},turn:{id:"t-child",status:"inProgress"}},sibling:{id:"sibling",parentThreadId:"root",status:{type:"active"},turn:{id:"t-sibling",status:"inProgress"}}};
 let live=true,behavior="normal",backend="codex",interruptHook=null,after=false;
 const client={async call(method,p){calls.push({method,p});const s=states[p.threadId];if(!s)throw new Error("missing");
  if(method==="thread/read"){if(after&&behavior==="post-error")throw new Error("offline");return {thread:{id:s.id,parentThreadId:s.parentThreadId,status:live?s.status:{type:"notLoaded"}}};}
  if(method==="thread/turns/list")return {data:s.turn?[{...s.turn}]:[],nextCursor:null};
  if(method==="turn/interrupt"){if(interruptHook)await interruptHook();if(behavior==="timeout")throw new Error("timeout");after=true;
   if(behavior==="new-turn"){s.turn={id:"new-turn",status:"inProgress"};}
   else if(behavior!=="pending"&&behavior!=="post-error"){s.turn.status="interrupted";s.status={type:"idle"};}return {};}
  throw new Error("Forbidden RPC "+method);
 }};
 const c=createSubagentControl({getRecord:id=>id==="root"?{backend}:null,getSource:()=>live?{client,items}:null,readItems:()=>items,coldClient:async()=>client});
 return {c,items,calls,states,setLive:v=>live=v,setBehavior:v=>behavior=v,setBackend:v=>backend=v,setHook:v=>interruptHook=v};
}
let n=0;async function check(label,fn){await fn();console.log("ok "+(++n)+" "+label);}
await check("会话列表不查询核心，合并跨轮次的同一子代理",()=>{const x=setup();x.items.push(row("child",{status:"completed"}));const r=x.c.list("root");assert.equal(r.agents.length,2);assert.equal(r.agents[1].observedStatus,"completed");assert.equal(x.calls.length,0);});
await check("列表有界，只保留同根的最近 64 个直接子代理",()=>{const rows=Array.from({length:70},(_,i)=>row("c"+i));rows.push(row("root"),row("foreign",{parentThreadId:"other"}),row("bad id"));const a=subagentRoster(rows,"root");assert.equal(a.length,64);assert.equal(a[0].agentThreadId,"c6");});
await check("Claude 会话和不存在的会话不能触发 Codex RPC",async()=>{const x=setup();x.setBackend("claude");assert.throws(()=>x.c.list("root"),e=>e.status===404);await assert.rejects(x.c.read("missing","child"),e=>e.status===404);assert.equal(x.calls.length,0);});
await check("不能查询主线程、未记录子线程或其他会话的线程",async()=>{const x=setup();for(const id of ["root","foreign"])await assert.rejects(x.c.read("root",id),e=>e.status===404);assert.equal(x.calls.length,0);});
await check("核心归属必须匹配，伪造宿主记录也不能控制别的会话",async()=>{const x=setup();x.states.child.parentThreadId="foreign";await assert.rejects(x.c.stop("root","child","t-child"),e=>e.status===409);assert(!x.calls.some(x=>x.method==="turn/interrupt"));});
await check("查询仅用 metadata 和一页摘要，返回精确子轮次",async()=>{const x=setup(),r=await x.c.read("root","child");assert.equal(r.agent.status,"running");assert(r.agent.canStop);assert.equal(r.agent.childTurnId,"t-child");assert.deepEqual(x.calls,[{method:"thread/read",p:{threadId:"child",includeTurns:false}},{method:"thread/turns/list",p:{threadId:"child",limit:1,sortDirection:"desc",itemsView:"summary"}}]);});
await check("只有运行连接和有效活动轮次同时存在才可停止",async()=>{const x=setup();x.states.child.turn.status="completed";assert.equal((await x.c.read("root","child")).agent.status,"unconfirmed");await assert.rejects(x.c.stop("root","child","t-child"),e=>e.status===409);assert(!x.calls.some(x=>x.method==="turn/interrupt"));});
await check("冷连接未加载不能当作已停止，历史终态也不冒充现场",async()=>{const x=setup();x.setLive(false);for(const state of ["inProgress","completed","interrupted"]){x.states.child.turn.status=state;const r=await x.c.read("root","child");assert.equal(r.agent.status,"unconfirmed");assert(!r.agent.canStop);assert.equal(r.agent.lastTurnStatus,state);}await assert.rejects(x.c.stop("root","child","t-child"),e=>e.status===409);});
await check("停止前重新查询，轮次已经变化时拒绝旧按钮",async()=>{const x=setup();await x.c.read("root","child");x.states.child.turn.id="changed";await assert.rejects(x.c.stop("root","child","t-child"),e=>e.status===409);assert(!x.calls.some(x=>x.method==="turn/interrupt"));});
await check("单独停止只向所选子线程及轮次发送一次中断",async()=>{const x=setup(),r=await x.c.stop("root","child","t-child");assert(r.accepted);assert.equal(r.agent.status,"interrupted");assert.equal(x.states.sibling.status.type,"active");assert.deepEqual(x.calls.filter(x=>x.method==="turn/interrupt"),[{method:"turn/interrupt",p:{threadId:"child",turnId:"t-child"}}]);});
await check("核心只接受请求但未确认终态时显示正在停止",async()=>{const x=setup();x.setBehavior("pending");const r=await x.c.stop("root","child","t-child");assert.equal(r.agent.status,"stopping");assert(!r.agent.canStop);});
await check("停止后读取失败保留待确认，不声称已停止",async()=>{const x=setup();x.setBehavior("post-error");const r=await x.c.stop("root","child","t-child");assert(r.accepted);assert.equal(r.agent.status,"unconfirmed");assert(!r.agent.canStop);});
await check("接受中断后启动了新轮次不会继续中断新任务",async()=>{const x=setup();x.setBehavior("new-turn");const r=await x.c.stop("root","child","t-child");assert.equal(r.agent.childTurnId,"new-turn");assert.equal(r.agent.status,"running");assert.equal(x.calls.filter(x=>x.method==="turn/interrupt").length,1);});
await check("中断超时不自动重试，不销毁或归档线程",async()=>{const x=setup();x.setBehavior("timeout");await assert.rejects(x.c.stop("root","child","t-child"),e=>e.status===502);assert.equal(x.calls.filter(x=>x.method==="turn/interrupt").length,1);assert(x.calls.every(x=>["thread/read","thread/turns/list","turn/interrupt"].includes(x.method)));});
await check("同一目标的并发停止只发一次请求",async()=>{const x=setup();let release,entered;const gate=new Promise(r=>release=r),begin=new Promise(r=>entered=r);x.setHook(async()=>{entered();await gate;});const pending=x.c.stop("root","child","t-child");await begin;await assert.rejects(x.c.stop("root","child","t-child"),e=>e.status===409);release();await pending;assert.equal(x.calls.filter(x=>x.method==="turn/interrupt").length,1);});
await check("已经确认完成或失败的子任务不能再停止",async()=>{const x=setup();for(const status of ["completed","interrupted","failed"]){x.states.child.status={type:"idle"};x.states.child.turn.status=status;assert.equal((await x.c.read("root","child")).agent.status,status);await assert.rejects(x.c.stop("root","child","t-child"),e=>e.status===409);}assert(!x.calls.some(x=>x.method==="turn/interrupt"));});
await check("缺少预期轮次时直接拒绝",async()=>{const x=setup();await assert.rejects(x.c.stop("root","child",null),e=>e.status===400);assert.equal(x.calls.length,0);});
await check("缺失或非法目标在取得核心连接前被拒绝",async()=>{const x=setup();for(const child of [null,undefined,"","bad id",{}]){await assert.rejects(x.c.read("root",child),e=>e.status===400);await assert.rejects(x.c.stop("root",child,"t-child"),e=>e.status===400);}assert.equal(x.calls.length,0);});
console.log(n+"/"+n+" passed");
