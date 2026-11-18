import {agentClient} from "./agent.mjs";
import {codexConfig} from "./config.mjs";
import {resolveSkillScope} from "./skill-catalog.mjs";
import {mcpConfigEntries,managedMcpName} from "./mcp-config.mjs";
import {CODEX_OPERATIONS} from "./operation-lock.mjs";
import {reloadCodexSessionMcp} from "./run.mjs";
import {runOfSession} from "../runs.mjs";
import {QUEUE,RUN_SESSIONS} from "../queue.mjs";
const writes=new Set();
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
export async function writeMcpEnabled(client,scope,{name,enabled,expectedEnabled,revision}){
 if(!managedMcpName(name)||typeof enabled!=="boolean"||typeof expectedEnabled!=="boolean"||!(/^[a-f0-9]{64}$/).test(revision||""))fail("MCP 设置无效，请重新检查。",400);
 const key=client.codexHome;
 if(writes.has(key))fail("MCP 设置正在保存，请稍后重试。");
 writes.add(key);
 try{
  const read=()=>client.call("config/read",{cwd:scope.cwd,includeLayers:true},10000);
  const before=mcpConfigEntries(await read(),scope);
  if(before.truncated)fail("MCP 清单已截断，暂不允许修改。");
  const target=before.servers.find(s=>s.name===name);
  if(!target?.writable)fail(target?.reason||"MCP 配置已移除或不属于当前目录，请重新检查。");
  if(target.revision!==revision||target.enabled!==expectedEnabled)fail("MCP 配置已变化，请重新检查后再修改。");
  if(target.enabled===enabled)return {ok:true,enabled,requestedEnabled:enabled,saved:false,requiresReload:false};
  let saved;
  try{saved=await client.call("config/value/write",{keyPath:"mcp_servers."+JSON.stringify(name)+".enabled",value:enabled,mergeStrategy:"upsert",filePath:target.file,expectedVersion:target.version},10000);}
  catch(e){
   if(e.rpc?.data?.config_write_error_code==="configVersionConflict")fail("MCP 配置已被其他操作修改，请重新检查后再保存。");
   fail("MCP 保存结果尚未核实，请重新检查后再操作。",502);
  }
  try{
   if(saved?.status!=="ok"||saved.filePath!==target.file||typeof saved.version!=="string")throw new Error();
   const after=mcpConfigEntries(await read(),scope),actual=after.servers.find(s=>s.name===name);
   if(after.truncated||!actual)throw new Error();
   return {ok:true,enabled:actual.enabled,requestedEnabled:enabled,saved:true,requiresReload:true,scope:target.scope};
  }catch{fail("MCP 配置可能已保存，但重新检查未完成；请先重新检查。",502);}
 }finally{writes.delete(key);}
}
function scopeOf(body){
 if([body.sessionId,body.projectId].some(v=>v!=null&&(typeof v!=="string"||!v)))fail("MCP 设置范围无效，请重新检查。",400);
 const scope=resolveSkillScope({sid:body.sessionId,projectId:body.projectId,scope:body.scope});
 if(scope.status)fail(scope.message,scope.status);
 return {...scope,codexHome:codexConfig().home};
}
export async function setCodexMcpEnabled(body){
 const scope=scopeOf(body),client=await agentClient(),cfg=codexConfig();
 if(client.bin!==cfg.bin||client.codexHome!==cfg.home)fail("Codex 配置已变化，请重启网关后再修改 MCP。");
 return {backend:"codex",...await writeMcpEnabled(client,scope,body)};
}
export async function reloadCodexMcp(body){
 scopeOf(body);
 const id=body.sessionId;if(!id||body.projectId)fail("请在已加载的 Codex 会话中重载 MCP。");
 if(CODEX_OPERATIONS.has(id)||runOfSession(id)||QUEUE.some(q=>q.sessionId===id||q.follow&&RUN_SESSIONS.get(q.follow)===id))fail("会话正在运行、排队或操作中，请稍后重载。");
 CODEX_OPERATIONS.add(id);
 try{return await reloadCodexSessionMcp(id);}finally{CODEX_OPERATIONS.delete(id);}
}
