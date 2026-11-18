import fs from "node:fs";import os from "node:os";import path from "node:path";import assert from "node:assert/strict";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"managed-capabilities-"));Object.assign(process.env,{CCAPP_TEST:"1",CCAPP_HOME:root,CCAPP_WORKSPACE:root,CCAPP_LOG:root+"/log"});
const {CommandSessions,hasRunningCommands,commandHistory}=await import("../gw/codex/commands.mjs"),{makePathGuard}=await import("../gw/codex/paths.mjs"),{which}=await import("../gw/codex/tools/exec.mjs"),{deviceMcp,deviceApprovalBypass}=await import("../gw/codex/device.mjs"),{registerBrowserTool}=await import("../gw/codex/tools/browser.mjs"),{ToolRegistry}=await import("../gw/codex/tools/registry.mjs"),{FileEditApprovals}=await import("../gw/codex/file-edit-approvals.mjs"),{COMMAND_WRITES}=await import("../gw/codex/tools/commands.mjs");
let n=0;const test=async(name,fn)=>{await fn();console.log("ok "+(++n)+" "+name);},quote=s=>"'"+s.replaceAll("'","'\\''")+"'",node=s=>quote(process.execPath)+" -e "+quote(s),shell=which("bash");
const c=new CommandSessions({guard:makePathGuard([root]),shell,owner:()=>"owner",env:{PATH:process.env.PATH,HOME:root}}),other=new CommandSessions({guard:makePathGuard([root]),shell,owner:()=>"other",env:{PATH:process.env.PATH,HOME:root}});
try{
 c.begin({id:"first"});other.begin({id:"other"});
 await test("显式后台命令跨轮次保留，默认命令仍被结束清理",async()=>{
  const b=await c.start({command:node("console.log('BACKGROUND');setInterval(()=>{},1000)"),background:true,yield_time_ms:100});
  const f=await c.start({command:node("setInterval(()=>{},1000)"),yield_time_ms:20});
  await c.endTurn();assert(c.require(b.id).running);assert(!c.require(f.id).running);assert.equal(c.backgroundRunning,1);assert(hasRunningCommands("owner"));assert(!hasRunningCommands("other"));
  c.begin({id:"second"});assert.equal(c.list().length,1);assert.equal(c.list()[0].turnId,"first");
  await assert.rejects(other.stop({command_id:b.id}),/Unknown/);
  await c.stop({command_id:b.id});assert(!hasRunningCommands("owner"));
 });
 await test("两个服务跨轮次可访问，可单独停止而不互相影响",async()=>{
  const servers=[];
  for(let i=0;i<2;i++){let r=await c.start({command:node("const s=require('http').createServer((q,r)=>r.end('SERVICE_"+i+"'));s.listen(0,'127.0.0.1',()=>console.log('READY:'+s.address().port))"),background:true,yield_time_ms:1000});assert(r.running);const port=Number(/READY:(\d+)/.exec(r.output)?.[1]);assert(port);servers.push({id:r.id,port});}
  await c.endTurn();c.begin({id:"third"});for(const s of servers)assert((await fetch("http://127.0.0.1:"+s.port)).ok);
  await c.stop({command_id:servers[0].id});await assert.rejects(fetch("http://127.0.0.1:"+servers[0].port));assert((await fetch("http://127.0.0.1:"+servers[1].port)).ok);
  await c.close();await assert.rejects(fetch("http://127.0.0.1:"+servers[1].port));
 });
 await test("实时快照覆盖过期历史，重启没有现场则标记中断",()=>{
  const history=[{role:"command",id:"x",running:true,status:"running"}];assert.equal(commandHistory(history,false)[0].status,"interrupted");
  assert.equal(commandHistory(history,false,[{id:"x",running:true,background:true,status:"running",output:"now"}])[0].output,"now");
 });
 await test("原设备总开关与无人值守限制保持，不修改源配置",async()=>{
  const script=root+"/device.mjs";fs.writeFileSync(script,"");
  const off=await deviceMcp({script,status:async()=>({ok:true,on:false})});assert.equal(off.state,"disabled");assert.deepEqual(off.args,[]);
  const isolated=await deviceMcp({script,isolated:true,status:()=>{throw new Error("must not query");}});assert.equal(isolated.state,"unavailable");
  const on=await deviceMcp({script,status:async()=>({ok:true,on:true})});assert.equal(on.state,"enabled");assert(on.args[1].includes("default_tools_approval_mode=\"writes\""));assert(Number(/tool_timeout_sec=(\d+)/.exec(on.args[1])?.[1])>70,"outer device budget must exceed native 60s approval and MCP 70s transport");assert(on.args[1].includes(process.execPath));assert.equal(fs.readFileSync(script,"utf8"),"");
 });
 await test("仅受管设备 MCP 在全部放行时无需人工确认，其他服务与模式不变",()=>{
  const device={state:"enabled",name:"cccodroid_device_0123abcd"},a={serverName:device.name};
  assert(deviceApprovalBypass(a,{device,mode:"bypassPermissions"}));
  for(const mode of ["default","acceptEdits","plan","auto"])assert(!deviceApprovalBypass(a,{device,mode}));
  assert(!deviceApprovalBypass({serverName:"ordinary_mcp"},{device,mode:"bypassPermissions"}));
  assert(!deviceApprovalBypass(a,{device:{...device,state:"disabled"},mode:"bypassPermissions"}));
  assert(!deviceApprovalBypass(null,{device,mode:"bypassPermissions"}));
 });
 await test("浏览器请求只接受 HTTP(S)，不把发出请求当作加载成功",async()=>{
  const opened=[],r=new ToolRegistry();registerBrowserTool(r,url=>opened.push(url));assert.equal((await r.handleCall({callId:"bad",tool:"cccodroid_open_browser",arguments:{url:"javascript:alert(1)"}})).success,false);assert.equal(opened.length,0);
  const good=await r.handleCall({callId:"good",tool:"cccodroid_open_browser",arguments:{url:"http://127.0.0.1:3000/"}});assert(good.success);assert.equal(opened[0],"http://127.0.0.1:3000/");assert(good.contentItems[0].text.includes("Verify"));
 });
 await test("父线程命令不能借用子代理编辑批准",()=>{
  const a=new FileEditApprovals({parent:()=>"parent",hostTurn:()=>"pt",server:()=>"host",active:()=>true,mode:()=>"bypassPermissions",generation:()=>0,authorize:async()=>{},tools:COMMAND_WRITES,parentOnlyTools:COMMAND_WRITES});
  a.observe({method:"item/started",params:{threadId:"parent",turnId:"pt",item:{type:"subAgentActivity",kind:"started",agentThreadId:"child"}}});
  a.observe({method:"turn/started",params:{threadId:"child",turn:{id:"ct"}}});
  a.observe({method:"item/started",params:{threadId:"child",turnId:"ct",item:{type:"mcpToolCall",id:"call",server:"host",tool:"cccodroid_exec_command",arguments:{command:"true"}}}});
  assert.equal(a.targets.size,0);assert.equal(a.take("cccodroid_exec_command",{command:"true"},{sessionId:"parent",threadId:"child",callId:"call","x-codex-turn-metadata":{thread_id:"child",turn_id:"ct"}}),null);a.close();
 });
 const helper=process.env.CCAPP_PTYHOST||"/data/user/0/cc.codroid/files/app/lib/ptyhost";
 if(fs.existsSync(helper))await test("真实 PTY 跨轮次输入、缩放、Ctrl-C 与清理",async()=>{
  process.env.CCAPP_PTYHOST=helper;c.begin({id:"pty"});
  const r=await c.start({command:"test -t 0 && test -t 1 && echo TTY_OK; stty size; read x; printf 'INPUT:%s\\n' \"$x\"; stty size; sleep 30",tty:true,background:true,yield_time_ms:500});
  assert(r.output.includes("TTY_OK"));await c.endTurn();c.begin({id:"pty-next"});
  await c.resize({command_id:r.id,rows:37,cols:101});const echoed=await c.input({command_id:r.id,chars:"HELLO\n",wait_ms:500});assert(echoed.output.includes("INPUT:HELLO"));assert(echoed.output.includes("37 101"));
  await c.input({command_id:r.id,chars:"\x03",wait_ms:500});await c.stop({command_id:r.id});assert.equal(c.running,0);
 });
}finally{await c.close();await other.close();}
console.log(n+"/"+n+" passed");process.exit(0);
