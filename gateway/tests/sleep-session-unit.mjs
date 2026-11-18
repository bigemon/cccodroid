import fs from "node:fs";import os from "node:os";import assert from "node:assert/strict";import {fakeCodexBin} from "./helpers/fake-codex-bin.mjs";
const root=fs.mkdtempSync(os.tmpdir()+"/sleep-session-");Object.assign(process.env,{CCAPP_TEST:"1",CCAPP_HOME:root,CCAPP_WORKSPACE:root,CCAPP_LOG:root+"/log"});
const {CodexSession}=await import("../gw/codex/session.mjs"),opts={cwd:root,bin:fakeCodexBin(root+"/bin"),codexHome:root,dataDir:root,deviceMcpScript:root+"/missing"};
let s=new CodexSession(opts),n=0;const check=async(name,f)=>{await f();console.log("ok "+(++n)+" "+name);};
const run=(f,extra={})=>s.runTurn({text:"NATIVE_SLEEP_FIXTURE "+JSON.stringify(f),idleTimeoutMs:300,...extra});
try{
 await s.start();
 await check("超过闲置阈值的声明等待正常完成，重复事件仅一张卡",async()=>{const events=[],r=await run({durationMs:900,duplicate:true},{onEvent:e=>events.push(e)});assert.equal(r.status,"completed");assert.equal(events.filter(e=>e.nativeSleep&&e.type==="tool_use").length,1);assert.equal(events.filter(e=>e.nativeSleep&&e.type==="tool_result").length,1);assert(events.find(e=>e.nativeSleep&&e.type==="tool_result").ok);});
 await check("等待期限结束但核心不再报告时仍按闲置中断",async()=>{const t=Date.now(),r=await run({durationMs:350,actualMs:1500,stall:true});assert.equal(r.terminationReason,"idle-timeout");assert(Date.now()-t>=600);assert.equal(s.items.at(-1).sleepStatus,"failed");});
 await check("完成等待后卡住不保留原声明的未来宽限",async()=>{const t=Date.now(),r=await run({durationMs:10000,actualMs:50,afterStall:true});assert.equal(r.terminationReason,"idle-timeout");assert(Date.now()-t<2500);assert(s.items.findLast(i=>i.nativeSleep&&i.role==="tool_result").ok);});
 await check("用户停止立即关闭等待，随后同线程可继续",async()=>{let stop;const r=await run({durationMs:10000,actualMs:10000},{onEvent:e=>{if(e.nativeSleep&&e.type==="tool_use")stop=setTimeout(()=>s.interrupt(),50);}});clearTimeout(stop);assert.equal(r.status,"interrupted");assert.equal(r.terminationReason,"user");assert.equal(s.items.at(-1).sleepStatus,"interrupted");const next=await run({durationMs:30});assert.equal(next.status,"completed");});
 await check("显式硬截止不受原生等待宽限影响",async()=>{const r=await run({durationMs:10000,actualMs:10000},{timeoutMs:200});assert.equal(r.status,"timeout");assert.equal(r.terminationReason,"timeout");});
 await check("其他线程等待不产生卡片或延迟主轮次闲置",async()=>{const start=s.items.length,t=Date.now(),r=await run({durationMs:10000,actualMs:10000,foreign:true});assert.equal(r.terminationReason,"idle-timeout");assert(Date.now()-t<2500);assert(!s.items.slice(start).some(i=>i.nativeSleep));});
 await check("交互启用 sleep，无人值守保留原禁用策略",async()=>{assert(s.client.serverArgs.some((v,i,a)=>v==="sleep_tool"&&a[i-1]==="--enable"));await s.dispose();s=new CodexSession(opts);s.taskIsolated=true;await s.start();const args=s.client.serverArgs,last=args.lastIndexOf("sleep_tool");assert.equal(args[last-1],"--disable");assert.deepEqual(args.slice(-2),["--disable","image_generation"]);});
}finally{await s.dispose();}
console.log(n+"/"+n+" passed");process.exit(0);
