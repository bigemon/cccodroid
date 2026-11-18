import assert from "node:assert/strict";import {AutoReviewState} from "../gw/codex/auto-review.mjs";import {AutoMcpBridge} from "../gw/codex/auto-mcp.mjs";import {nativePolicyOverrides} from "../gw/codex/native-policy.mjs";
let n=0;async function check(name,fn){await fn();console.log("ok "+(++n)+" "+name);}
const item={type:"mcpToolCall",server:"host",id:"i",tool:"cccodroid_write_file",arguments:{path:"x",content:"a"}};
const notification=(status="approved",id="r")=>({reviewId:id,targetItemId:"i",turnId:"turn",review:{status,rationale:"public rationale"}});
await check("批准绑定原始参数且只消费一次",()=>{const s=new AutoReviewState({server:"host"});s.target(item);s.handle("item/autoApprovalReview/completed",notification());assert(!s.take(item.tool,{...item.arguments,content:"tampered"}));assert(s.take(item.tool,item.arguments));assert(!s.take(item.tool,item.arguments));});
await check("重复完成与乱序通知不重复批准",()=>{const s=new AutoReviewState({server:"host"});s.handle("item/autoApprovalReview/completed",notification());s.target(item);s.handle("item/autoApprovalReview/completed",notification());assert(s.take(item.tool,item.arguments));assert(!s.take(item.tool,item.arguments));});
await check("拒绝、超时和取消都不执行",()=>{for(const status of ["denied","timedOut","aborted"]){const s=new AutoReviewState({server:"host"});s.target(item);s.handle("item/autoApprovalReview/completed",notification(status));assert(!s.take(item.tool,item.arguments));}});
await check("其他服务器的批准不授权宿主",()=>{const s=new AutoReviewState({server:"host"});s.target({...item,server:"external"});s.handle("item/autoApprovalReview/completed",notification());assert(!s.take(item.tool,item.arguments));});
await check("结束撤销所有未用批准并终结等待状态",()=>{const s=new AutoReviewState({server:"host"});s.target(item);s.handle("item/autoApprovalReview/started",notification("inProgress"));s.close();assert.equal(s.snapshot()[0].status,"aborted");assert(!s.take(item.tool,item.arguments));});
await check("原生策略保持 writes 与禁用，独立选择 auto_review",()=>{const p=nativePolicyOverrides({config:{apps:{app:{enabled:false,default_tools_approval_mode:"prompt"}}}},{reviewer:"auto_review"});assert.equal(p.overrides.approvals_reviewer,"auto_review");assert.equal(p.overrides["apps.app.approvals_reviewer"],"auto_review");assert.equal(p.overrides["apps.app.default_tools_approval_mode"],"prompt");});
await check("轮次关闭后迟到的批准不能重新授权",()=>{const s=new AutoReviewState({server:"host"});s.target(item);s.close();s.handle("item/autoApprovalReview/completed",notification());assert(!s.take(item.tool,item.arguments));});
let executed=0,active=true,approved=false;
const registry={specs:()=>[{name:"cccodroid_read_file",description:"r",inputSchema:{}},{name:"cccodroid_write_file",description:"w",inputSchema:{}},{name:"cccodroid_stop_command",description:"parent process control",inputSchema:{}}],has:name=>["cccodroid_read_file","cccodroid_write_file","cccodroid_stop_command"].includes(name),handleCall:async()=>{executed++;return {success:true,contentItems:[{type:"inputText",text:"ok"}]};}};
const bridge=await new AutoMcpBridge({registry,active:()=>active,authorize:()=>{const ok=approved;approved=false;return ok;}}).start(),url=bridge.config().url;
const call=async(method,params={},auth=true)=>{const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json",...(auth?{authorization:"Bearer "+bridge.token}:{})},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})});return {status:r.status,body:await r.json()};};
try{
await check("本机 MCP 需要随机 bearer，不接受未认证调用",async()=>assert.equal((await call("tools/list",{},false)).status,401));
await check("工具声明按实际宿主分类标记只读",async()=>{const r=await call("tools/list");assert.equal(r.body.result.tools[0].annotations.readOnlyHint,true);assert.equal(r.body.result.tools[1].annotations.readOnlyHint,false);});
await check("原生通道不暴露或接受父进程控制工具",async()=>{assert(!(await call("tools/list")).body.result.tools.some(t=>t.name==="cccodroid_stop_command"));assert((await call("tools/call",{name:"cccodroid_stop_command",arguments:{command_id:"parent"}})).body.result.isError);assert.equal(executed,0);});
await check("未获原生批准不调用宿主写工具",async()=>{const r=await call("tools/call",{name:"cccodroid_write_file",arguments:{}});assert(r.body.result.isError);assert.equal(executed,0);});
await check("有批准执行一次，重放被拒绝",async()=>{approved=true;assert.equal((await call("tools/call",{name:"cccodroid_write_file",arguments:{}})).body.result.isError,false);assert((await call("tools/call",{name:"cccodroid_write_file",arguments:{}})).body.result.isError);assert.equal(executed,1);});
await check("无活动轮次即使有批准也不执行",async()=>{active=false;approved=true;assert((await call("tools/call",{name:"cccodroid_write_file",arguments:{}})).body.result.isError);assert.equal(executed,1);});
}finally{await bridge.close();}
console.log(n+"/"+n+" passed");
