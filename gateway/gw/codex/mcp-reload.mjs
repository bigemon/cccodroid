import {nativePolicyOverrides} from "./native-policy.mjs";
import {sharedDocFallbacks} from "../project-instructions.mjs";
import {readMcpInventory} from "./extensions-view.mjs";
const fail=message=>{throw Object.assign(new Error(message),{status:409});};
// 用户显式重载时按需核验，不轮询、不停止子代理或其他线程。
export async function reloadMcpSession(session){
 const s=session,c=s.client,id=s.sessionId;
 if(!s.ready||!id||s.taskIsolated)fail("当前 Codex 会话尚未加载，请开始一轮后再重载。");
 if(s.turn||s.commands?.running||c.inflightServerRequests?.size)fail("当前会话正在执行或等待操作，请等任务结束后再重载。");
 const loaded=await c.call("thread/loaded/list",{},10000);
 if(!Array.isArray(loaded.data)||loaded.nextCursor!==null||loaded.data.length!==1||loaded.data[0]!==id)fail("当前连接还加载了其他线程，本批暂不重载；保存的配置可在新会话中应用。");
 const thread=await c.call("thread/read",{threadId:id,includeTurns:false},10000);
 if(thread.thread?.id!==id||thread.thread.status?.type!=="idle")fail("核心会话尚未空闲，请稍后再重载。");
 const config=await c.call("config/read",{cwd:s.cwd,includeLayers:false},10000);
 const policy=nativePolicyOverrides(config,{reviewer:s.autoMode?"auto_review":"user"}),fallbacks=sharedDocFallbacks(config);
 let detached=false;
 try{
  // 已加载线程会保留旧覆盖；显式解除订阅再恢复同一线程，重新应用审批基线和 MCP 配置。
  detached=true;
  const unsubscribed=await c.call("thread/unsubscribe",{threadId:id},20000);
  if(unsubscribed?.status!=="unsubscribed")throw new Error("unsubscribe not confirmed");
  const after=await c.call("thread/loaded/list",{},10000);
  // 解除订阅不保证移出加载列表；允许本线程仍在列表，不轮询或清理其他线程。
  if(!Array.isArray(after.data)||after.nextCursor!==null||after.data.some(t=>t!==id))throw new Error("other thread loaded");
  s.nativePolicy=policy;s.nativePolicyError=null;s.projectDocFallbacks=fallbacks;
  await s.resumeThread(id);
  await c.call("config/mcpServer/reload",undefined,30000);
  const inventory=await readMcpInventory(c,id);
  for(const [name,value]of Object.entries(config.config?.mcp_servers||{})){
   const actual=inventory.servers.find(x=>x.name===name);
   if(value.enabled===false?actual?.status!=="disabled":actual?.status==="disabled")throw new Error("configuration not applied");
  }
  const bridge=s.autoMcp?.name||s.readMcp?.name;
  if(bridge&&!inventory.servers.some(x=>x.name===bridge&&x.status==="connected"))throw new Error("host bridge unavailable");
  return {ok:true,backend:"codex",sessionId:id,scope:"current-connection",mcp:inventory};
 }catch{
  throw Object.assign(new Error("MCP 重载未完成，将在下次运行重新连接；保存的配置已保留。"),{status:502,reconnectRequired:detached});
 }
}
