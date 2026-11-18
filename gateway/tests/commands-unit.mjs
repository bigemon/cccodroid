import assert from "node:assert/strict";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import { spawn } from "node:child_process";
import { CommandSessions, commandHistory } from "../gw/codex/commands.mjs";
import { startProcess, runProcess, which, procInfo } from "../gw/codex/tools/exec.mjs";
import { makePathGuard } from "../gw/codex/paths.mjs";
import { ToolRegistry } from "../gw/codex/tools/registry.mjs";
import { codexToolPolicy } from "../gw/codex/permissions.mjs";
import { registerCommandTools } from "../gw/codex/tools/commands.mjs";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"codex-commands-unit-"));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const node=code=>quote(process.execPath)+" -e "+quote(code);
const shell=which("bash");assert(shell,"Bash required");
const events=[];
const manager=()=>new CommandSessions({guard:makePathGuard([root]),shell,env:{PATH:process.env.PATH,HOME:root},emit:e=>events.push(e)});
let passed=0;async function test(name,fn){await fn();passed++;console.log("ok "+name);}
async function completed(manager,result){
 let output=result.output;const deadline=Date.now()+10000;
 while(result.running&&Date.now()<deadline){result=await manager.poll({command_id:result.id,wait_ms:1000});output+=result.output;}
 assert.equal(result.running,false,"Command did not finish within bounded wait");return {...result,output};
}
const c=manager(),other=manager();c.begin({id:"turn"});other.begin({id:"other"});
const outsider=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
try{
 await test("自由命令支持管道、工作目录与非零退出码",async()=>{
   let r=await c.start({command:"printf 'abc' | tr a-z A-Z",yield_time_ms:500});
   assert.equal(r.output,"ABC");assert.equal(r.exitCode,0);assert.equal(r.status,"completed");
   r=await c.start({command:"printf fail >&2; exit 7",yield_time_ms:500});
   assert.equal(r.exitCode,7);assert.equal(r.status,"failed");assert(r.output.includes("[stderr] fail"));
   await assert.rejects(c.start({command:"pwd",cwd:"../"}),/outside/);
 });
 await test("工具返回后命令继续，输出能增量消费且状态事件实时到达",async()=>{
   const r=await c.start({command:node("console.log('ONE');setTimeout(()=>console.log('TWO'),200)"),yield_time_ms:30});
   assert.equal(r.running,true);
   const after=await completed(c,await c.poll({command_id:r.id,wait_ms:500}));
   assert.equal(after.running,false);
   assert.equal((r.output+after.output).match(/ONE/g)?.length,1);assert((r.output+after.output).includes("TWO"));
   assert.equal((await c.poll({command_id:r.id})).output,"");
   assert(events.some(e=>e.command.id===r.id&&e.command.running));
 });
 await test("标准输入和 EOF 可用，命令 id 不能跨会话控制",async()=>{
   const r=await c.start({command:node("process.stdin.on('data',d=>process.stdout.write('ECHO:'+d));process.stdin.on('end',()=>process.exit(0));"),yield_time_ms:20});
   await assert.rejects(other.stop({command_id:r.id}),/Unknown/);
   const res=await completed(c,await c.input({command_id:r.id,chars:"hello\n",eof:true,wait_ms:500}));
   assert.equal(res.running,false);assert(res.output.includes("ECHO:hello"));
 });
 await test("UTF-8 分块输出正确，缓冲有上限且明确报告截断",async()=>{
   const r=await runProcess({cmd:process.execPath,args:["-e","const b=Buffer.from('中文');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),20)"],cwd:root});
   assert.equal(r.stdout,"中文");
   const v=await completed(c,await c.start({command:node("process.stdout.write('文'.repeat(100000))"),yield_time_ms:500}));
   const tail=c.read(v.id,0,32000);
   assert.equal(tail.truncated,true);assert(tail.output.length<=32000);assert(!tail.output.includes("�"));
 });
 await test("显式超时杀死父子进程，不影响无关进程",async()=>{
   const pidFile=path.join(root,"child-pid");
   const script="const{spawn}=require('node:child_process');const fs=require('node:fs');const ch=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync("+JSON.stringify(pidFile)+",String(ch.pid));setInterval(()=>{},1000)";
   const started=await c.start({command:node(script),timeout_ms:3000,yield_time_ms:1});
   const readyBy=Date.now()+2500;
   while(!fs.existsSync(pidFile)&&Date.now()<readyBy&&c.require(started.id).running)await sleep(20);
   assert(fs.existsSync(pidFile),"Child PID was not ready within startup budget; process cleanup has not yet been verified");
   const pid=Number(fs.readFileSync(pidFile,"utf8"));assert(Number.isInteger(pid)&&pid>0,"Invalid child PID fixture");
   const childBefore=procInfo(pid);assert(childBefore&&childBefore.state!=="Z","Child was not alive before timeout");
   const r=await completed(c,started);
   assert.equal(r.status,"timeout");assert.equal(r.terminationReason,"timeout");
   const reapedBy=Date.now()+1000;let child=procInfo(pid);
   while(child&&child.state!=="Z"&&Date.now()<reapedBy){await sleep(20);child=procInfo(pid);}
   assert(!child||child.state==="Z","Owned child survived command timeout");
   const unrelated=procInfo(outsider.pid);assert(unrelated&&unrelated.state!=="Z","Unrelated process was stopped");
 });
 await test("主动停止保留具体原因，停止后不能继续写入",async()=>{
   const r=await c.start({command:node("setInterval(()=>{},1000)"),yield_time_ms:10});
   const done=await c.stop({command_id:r.id},"user");assert.equal(done.status,"cancelled");assert.equal(done.terminationReason,"user");
   await assert.rejects(c.input({command_id:r.id,chars:"x"}),/not running/);
 });
 await test("执行器容量有上限，轮次关闭会清理全部后台命令",async()=>{
   const ids=[];for(let i=0;i<4;i++)ids.push((await c.start({command:node("setInterval(()=>{},1000)"),yield_time_ms:1})).id);
   await assert.rejects(c.start({command:"true"}),/capacity/);await c.close();
   assert.equal(c.running,0);assert(ids.every(id=>c.records.get(id).status==="cancelled"));
   await assert.rejects(c.start({command:"true"}),/ended/);
   assert.equal(commandHistory([{role:"command",running:true}],false)[0].status,"interrupted");
 });
 await test("权限在命令启动和 stdin 写入前检查，计划模式仍能停止读取",async()=>{
   c.begin({id:"permission-turn"});
   const policy=codexToolPolicy({mode:"plan"}),registry=new ToolRegistry({beforeCall:p=>policy.authorize(p)});
   registerCommandTools(registry,c);
   let r=await registry.handleCall({callId:"blocked",tool:"cccodroid_exec_command",arguments:{command:"touch must-not-exist"}});
   assert.equal(r.success,false);assert(!fs.existsSync(path.join(root,"must-not-exist")));
   policy.setMode("bypassPermissions");
   r=await registry.handleCall({callId:"allowed",tool:"cccodroid_exec_command",arguments:{command:node("setInterval(()=>{},1000)"),yield_time_ms:1}});
   const cmd=JSON.parse(r.contentItems[0].text);assert.equal(cmd.toolUseId,"allowed");
   policy.setMode("plan");
   r=await registry.handleCall({callId:"stdin",tool:"cccodroid_write_command",arguments:{command_id:cmd.id,chars:"x"}});
   assert.equal(r.success,false);
   r=await registry.handleCall({callId:"stop",tool:"cccodroid_stop_command",arguments:{command_id:cmd.id}});
   assert.equal(r.success,true);
 });
 await test("旧 argv 工具的注册表超时会传递到底层进程",async()=>{
   const marker=path.join(root,"must-not-run-later");
   const registry=new ToolRegistry();
   registry.register({name:"test_slow",timeoutMs:50,handler:()=>runProcess({cmd:process.execPath,args:["-e","setTimeout(()=>require('node:fs').writeFileSync("+JSON.stringify(marker)+",'oops'),400)"],cwd:root,timeoutMs:5000})});
   const result=await registry.handleCall({callId:"timeout",tool:"test_slow"});
   assert.equal(result.success,false);await sleep(600);assert(!fs.existsSync(marker));
 });
 await test("cancelAll 取消已有进程，批准等待期间取消也不会启动 handler",async()=>{
   const marker=path.join(root,"must-not-spawn");
   let release;const gate=new Promise(r=>release=r);
   const registry=new ToolRegistry({beforeCall:()=>gate});
   registry.register({name:"test_pending",handler:()=>fs.writeFileSync(marker,"oops")});
   const task=registry.handleCall({callId:"pending",tool:"test_pending"});
   registry.cancelAll();release();assert.equal((await task).success,false);assert(!fs.existsSync(marker));
   const active=new ToolRegistry();
   active.register({name:"test_active",handler:()=>runProcess({cmd:process.execPath,args:["-e","setTimeout(()=>require('node:fs').writeFileSync("+JSON.stringify(marker)+",'oops'),400)"],cwd:root,timeoutMs:5000})});
   const running=active.handleCall({callId:"active",tool:"test_active"});await sleep(50);active.cancelAll();
   assert.equal((await running).success,false);await sleep(450);assert(!fs.existsSync(marker));
 });
 await test("已消费的命令记录自动回收，长任务可执行超过 64 条命令",async()=>{
   for(let i=0;i<70;i++){const r=await c.start({command:"printf x",yield_time_ms:1000});assert.equal(r.exitCode,0);assert.equal(r.output,"x");}
   assert(c.records.size<=64);
 });
 await test("并行相同命令按调用 id 关联，后续状态保持原生 MCP id",async()=>{
   const mapped=new CommandSessions({guard:makePathGuard([root]),shell,env:{PATH:process.env.PATH,HOME:root},toolUseId:id=>"native-"+id});
   mapped.begin({id:"mapped"});
   try{
     const [a,b]=await Promise.all(["a","b"].map(id=>mapped.start({command:"printf same",yield_time_ms:500},null,id)));
     assert.notEqual(a.id,b.id);assert.equal(a.toolUseId,"native-a");assert.equal(b.toolUseId,"native-b");
     assert.equal(mapped.read(a.id,0).toolUseId,"native-a");assert.equal(mapped.read(b.id,0).toolUseId,"native-b");
   }finally{await mapped.close();}
 });
 await test("命令环境不继承其他核心的认证变量或启动脚本注入",async()=>{
   process.env.CCAPP_HOME=root;process.env.CCAPP_WORKSPACE=root;process.env.CCAPP_TEST="1";
   process.env.ANTHROPIC_API_KEY="fixture-secret";process.env.OPENAI_API_KEY="fixture-secret";process.env.BASH_ENV="/fixture/should-not-run";
   const {commandEnvironment}=await import("../gw/codex/command-env.mjs");const {env}=commandEnvironment();
   assert(!("ANTHROPIC_API_KEY" in env));assert(!("OPENAI_API_KEY" in env));assert(!("BASH_ENV" in env));assert.equal(env.HOME,root);
 });
}finally{await c.close();await other.close();outsider.kill("SIGKILL");}
console.log(passed+"/"+passed+" passed");
