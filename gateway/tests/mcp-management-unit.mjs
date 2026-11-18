import fs from "node:fs";import os from "node:os";import path from "node:path";import assert from "node:assert/strict";const root=fs.mkdtempSync(path.join(os.tmpdir(),"mcp-management-unit-")),cwd=root+"/repo",home=root+"/core";fs.mkdirSync(cwd);fs.mkdirSync(home);Object.assign(process.env,{CCAPP_TEST:"1",CCAPP_HOME:root,CCAPP_WORKSPACE:cwd,CCAPP_SHARED:"",CCAPP_LOG:root+"/log"});
const {mcpManagementView:view,mcpConfigEntries:entries}=await import("../gw/codex/mcp-config.mjs"),{writeMcpEnabled:write}=await import("../gw/codex/mcp-settings.mjs"),{reloadMcpSession:reload}=await import("../gw/codex/mcp-reload.mjs");let n=0;const check=async(name,fn)=>{await fn();console.log("ok "+(++n)+" "+name);},scope={cwd,codexHome:home};
const server={enabled:true,command:"SECRET_COMMAND",env:{TOKEN:"SECRET_TOKEN"}},user={name:{type:"user",file:home+"/config.toml",profile:null},version:"v1",config:{mcp_servers:{fixture:server}},disabledReason:null};const response=()=>({config:{mcp_servers:{fixture:structuredClone(server)}},layers:[structuredClone(user)]});
await check("目录只公开名称、开关、范围和修订，不泄露命令凭据或原生配置",()=>{const v=view(response(),scope);assert(v.servers[0].writable);assert.equal(v.servers[0].scope,"user");assert(!JSON.stringify(v).includes("SECRET"));assert(!Object.hasOwn(v.servers[0],"file"));assert(/^[a-f0-9]{64}$/.test(v.servers[0].revision));});
await check("配置对象键顺序变化不会制造过期修订",()=>{const a=response(),b=response();b.config.mcp_servers.fixture={env:{TOKEN:"SECRET_TOKEN"},command:"SECRET_COMMAND",enabled:true};assert.equal(view(a,scope).servers[0].revision,view(b,scope).servers[0].revision);});
await check("内置工具连接和不支持的来源只读",()=>{const r=response();r.config.mcp_servers.cccodroid_reads_fixture=server;r.layers[0].config.mcp_servers.cccodroid_reads_fixture=server;assert(!view(r,scope).servers.find(s=>s.scope==="host").writable);r.layers[0].name.type="system";assert(!view(r,scope).servers[0].writable);});
await check("项目配置按原生接口边界保持只读，不回写其他文件",()=>{const r=response();r.layers.unshift({name:{type:"project",dotCodexFolder:cwd+"/.codex"},version:"p1",disabledReason:null,config:{mcp_servers:{fixture:{enabled:false}}}});r.config.mcp_servers.fixture.enabled=false;const v=entries(r,scope).servers[0];assert.equal(v.scope,"project");assert.equal(v.writable,false);assert.equal(v.file,null);r.layers[0].name.dotCodexFolder=root+"/outside/.codex";assert(!view(r,scope).servers[0].writable);});
await check("配置层缺失、profile 和截断目录不会假报可安全修改",()=>{const r=response();r.layers=[];assert(!view(r,scope).servers[0].writable);r.layers=[structuredClone(user)];r.layers[0].name.profile="named";assert(!view(r,scope).servers[0].writable);r.config.mcp_servers=Object.fromEntries(Array.from({length:201},(_,i)=>["s"+i,server]));assert(view(r,scope).truncated);assert.throws(()=>view({config:{mcp_servers:[]}},scope));});
function client(control={}){
 let raw=response(),readCount=0;const calls=[];return {codexHome:home,calls,call:async(method,p)=>{
  calls.push({method,p});if(method==="config/read"){if(control.afterError&&readCount++)throw Error("SECRET");return structuredClone(raw);}
  assert.equal(method,"config/value/write");if(control.delay)await new Promise(r=>setTimeout(r,control.delay));
  if(control.conflict)throw {rpc:{data:{config_write_error_code:"configVersionConflict"}}};
  if(control.writeError)throw Error("SECRET");
  const selected=Object.keys(raw.config.mcp_servers).find(name=>p.keyPath==="mcp_servers."+JSON.stringify(name)+".enabled");assert(selected);
  raw.config.mcp_servers[selected].enabled=p.value;raw.layers[0].config.mcp_servers[selected].enabled=p.value;raw.layers[0].version="v2";return control.badResponse?{}:{status:"ok",filePath:home+"/config.toml",version:"v2",overriddenMetadata:null};
 }};
}
const body=()=>({name:"fixture",enabled:false,expectedEnabled:true,revision:view(response(),scope).servers[0].revision});
await check("写入只含选中 enabled 和原生版本，保存后重读核验",async()=>{const c=client(),r=await write(c,scope,body());assert(r.saved&&!r.enabled&&r.requiresReload);assert.deepEqual(c.calls.map(x=>x.method),["config/read","config/value/write","config/read"]);assert.deepEqual(c.calls[1].p,{keyPath:'mcp_servers."fixture".enabled',value:false,mergeStrategy:"upsert",filePath:home+"/config.toml",expectedVersion:"v1"});});
await check("过期状态、修订、伪造服务和内部连接不写入",async()=>{for(const b of [{...body(),revision:"a".repeat(64)},{...body(),expectedEnabled:false},{...body(),name:"missing"},{...body(),name:"cccodroid_reads_fixture"}]){const c=client();await assert.rejects(write(c,scope,b),e=>e.status===409);assert(!c.calls.some(x=>x.method==="config/value/write"));}});
await check("格式错误在核心调用前拒绝，无变化则不写",async()=>{for(const b of [{...body(),name:"bad\0"},{...body(),enabled:"false"},{...body(),revision:null}]){const c=client();await assert.rejects(write(c,scope,b),e=>e.status===400);assert.equal(c.calls.length,0);}const c=client(),r=await write(c,scope,{...body(),enabled:true});assert(!r.saved);assert.equal(c.calls.length,1);});
await check("原生 CAS 冲突、写入未知和重读失败均保留明确失败状态",async()=>{for(const options of [{conflict:true},{writeError:true},{afterError:true},{badResponse:true}]){await assert.rejects(write(client(options),scope,body()),e=>[409,502].includes(e.status)&&!e.message.includes("SECRET"));}});
await check("同一配置目录重复保存被拒绝，完成后锁释放",async()=>{const first=write(client({delay:30}),scope,body());await assert.rejects(write(client(),scope,body()),e=>e.status===409);await first;assert((await write(client(),scope,body())).saved);});
function session(control={}){
 const calls=[];let detached=false;const c={inflightServerRequests:new Set(),call:async(method,p)=>{
  calls.push({method,p});if(control.fail===method)throw Error("SECRET");
  if(method==="thread/loaded/list")return {data:detached?[]:control.other?["s","child"]:["s"],nextCursor:null};
  if(method==="thread/read")return {thread:{id:"s",status:{type:control.active?"active":"idle"}}};
  if(method==="config/read")return {config:{mcp_servers:{fixture:{...server,default_tools_approval_mode:"approve"}}}};
  if(method==="thread/unsubscribe"){detached=true;return {status:"unsubscribed"};}
  if(method==="mcpServerStatus/list")return {data:[{name:"fixture",runtimeStatus:"connected",tools:{read:{}}}],nextCursor:null};
  if(method==="config/mcpServer/reload")return {};
  throw Error(method);
 }};const s={ready:true,cwd,sessionId:"s",client:c,autoMode:!!control.auto,resumeThread:async id=>{assert.equal(id,"s");calls.push({method:"host-resume"});detached=false;}};return {s,calls};
}
await check("显式重载按顺序解除订阅、恢复同线程、重载并读取状态",async()=>{const {s,calls}=session(),r=await reload(s);assert(r.ok);assert.equal(r.sessionId,"s");assert.deepEqual(calls.map(x=>x.method),["thread/loaded/list","thread/read","config/read","thread/unsubscribe","thread/loaded/list","host-resume","config/mcpServer/reload","mcpServerStatus/list"]);assert.equal(s.nativePolicy.snapshot.minimum,"writes");assert.equal(s.nativePolicy.overrides["mcp_servers.fixture.default_tools_approval_mode"],"writes");});
await check("运行、等待、任务隔离和其他已加载线程均不被停止或重载",async()=>{for(const options of [{turn:{}},{taskIsolated:true},{commands:{running:1}},{pending:true},{other:true},{active:true}]){const {s,calls}=session(options);Object.assign(s,options);if(options.pending)s.client.inflightServerRequests.add("pending");await assert.rejects(reload(s),e=>e.status===409);assert(!calls.some(x=>x.method==="thread/unsubscribe"||x.method==="config/mcpServer/reload"));}});
await check("断开之后失败要求重新连接，断开之前失败不吊销现有连接",async()=>{for(const method of ["config/read","config/mcpServer/reload","mcpServerStatus/list"]){const {s}=session({fail:method});await assert.rejects(reload(s),e=>method==="config/read"?!e.reconnectRequired:e.status===502&&e.reconnectRequired&&!e.message.includes("SECRET"));}});
await check("自动判断连接恢复后仍采用原生自动审核基线",async()=>{const {s}=session({auto:true});await reload(s);assert.equal(s.nativePolicy.snapshot.reviewer,"auto_review");assert.equal(s.nativePolicy.overrides.approvals_reviewer,"auto_review");});
console.log(n+"/"+n+" passed");process.exit(0);
