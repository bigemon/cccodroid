// 同步短命令：复用调用级进程清理，不创建可在代理间传递的命令 ID。
import fs from "node:fs";
import {runProcess} from "./exec.mjs";
let globalRunning=0;
export function registerShortCommandTool(registry,{guard,shell,env}){
 let running=0;
 registry.register({
  name:"cccodroid_run_command",
  description:"Run a short Bash command in the workspace and wait for its final result. Supports shell syntax and pipes; requires execution approval. Returns JSON with status, exitCode, stdout, stderr, timeout/cancellation and truncation fields; check these fields before claiming success. No command id, live stream, stdin, PTY or persistent background service. Default timeout 60000ms, maximum 180000ms. Owned descendants are cleaned up when the command exits, times out or is cancelled. Uses the app UID, not an OS sandbox.",
  inputSchema:{type:"object",required:["command"],additionalProperties:false,properties:{
   command:{type:"string",maxLength:20000},
   cwd:{type:"string",description:"Working directory relative to the workspace; default '.'."},
   timeout_ms:{type:"integer",description:"Deadline in ms, clamped to 100–180000; default 60000."}
  }},
  timeoutMs:200000,
  handler:async({command,cwd=".",timeout_ms=60000})=>{
   if(!command.trim()||command.includes("\0"))throw new Error("command must be nonempty and contain no NUL");
   const dir=guard.resolve(cwd);if(!fs.statSync(dir).isDirectory())throw new Error("cwd must be a directory");
   if(running>=4||globalRunning>=16)throw new Error("Short command capacity reached; wait for existing calls");
   running++;globalRunning++;
   try{
    const r=await runProcess({cmd:shell,args:["--noprofile","--norc","-c",command],cwd:dir,env,inheritEnv:false,timeoutMs:Math.max(100,Math.min(180000,timeout_ms||60000)),maxBytes:64*1024});
    return {status:r.timedOut?"timeout":r.aborted?"cancelled":r.error||r.code!==0?"failed":"completed",exitCode:r.code,signal:r.signal,
     timedOut:r.timedOut,aborted:r.aborted,terminationReason:r.terminationReason,truncated:r.truncated,
     stdout:r.stdout,stderr:r.stderr,stdoutBytes:r.stdoutBytes,stderrBytes:r.stderrBytes,durationMs:r.ms,error:r.error};
   }finally{running--;globalRunning--;}
  }
 });
}
