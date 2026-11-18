import fs from "node:fs";import path from "node:path";import os from "node:os";import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {buildToolRegistry} from "../gw/codex/tools/index.mjs";
import {codexToolPolicy} from "../gw/codex/permissions.mjs";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"codex-policy-"));
fs.writeFileSync(path.join(root,"read.txt"),"readable");
fs.writeFileSync(path.join(root,"effect.mjs"),'import fs from "node:fs";fs.writeFileSync("effect-marker","executed");');
let seq=0,passed=0;
const check=async(name,fn)=>{await fn();console.log("ok "+name);passed++;};
const call=(registry,tool,args={})=>registry.handleCall({callId:String(++seq),tool,arguments:args});
function setup(mode,confirm){const policy=codexToolPolicy({mode,confirm});const{registry}=buildToolRegistry({roots:[root],cwd:root,beforeCall:p=>policy.authorize(p)});return{policy,registry};}
await check("计划允许读取，阻止写文件和编辑",async()=>{
 const{registry}=setup("plan");
 assert.equal((await call(registry,"cccodroid_read_file",{path:"read.txt"})).success,true);
 for(const[tool,args]of [["cccodroid_write_file",{path:"new.txt",content:"bad"}],["cccodroid_edit_file",{path:"read.txt",oldText:"readable",newText:"bad"}]]){
  assert.equal((await call(registry,tool,args)).success,false);
 }
 assert.equal(fs.existsSync(path.join(root,"new.txt")),false);assert.equal(fs.readFileSync(path.join(root,"read.txt"),"utf8"),"readable");
});
await check("计划阻止已有脚本与未知工具的副作用",async()=>{
 const{registry}=setup("plan");
 assert.equal((await call(registry,"cccodroid_run_tests",{runner:"node",path:"effect.mjs"})).success,false);
 registry.register({name:"new_mutation",description:"test",inputSchema:{type:"object"},handler:()=>{fs.writeFileSync(path.join(root,"unknown-marker"),"bad");}});
 assert.equal((await call(registry,"new_mutation",{})).success,false);
 assert.equal(fs.existsSync(path.join(root,"effect-marker")),false);assert.equal(fs.existsSync(path.join(root,"unknown-marker")),false);
});
await check("逐项确认拒绝后不执行，批准只执行原参数",async()=>{
 let prompts=0,allow=false;
 const{registry}=setup("default",async()=>{prompts++;return allow;});
 assert.equal((await call(registry,"cccodroid_write_file",{path:"confirmed.txt",content:"one"})).success,false);
 assert.equal(fs.existsSync(path.join(root,"confirmed.txt")),false);
 allow=true;
 assert.equal((await call(registry,"cccodroid_write_file",{path:"confirmed.txt",content:"two"})).success,true);
 assert.equal(prompts,2);assert.equal(fs.readFileSync(path.join(root,"confirmed.txt"),"utf8"),"two");
});
await check("自动编辑只放行文件编辑，脚本仍需批准",async()=>{
 let prompts=0;
 const{registry}=setup("acceptEdits",async()=>{prompts++;return false;});
 assert.equal((await call(registry,"cccodroid_write_file",{path:"automatic.txt",content:"ok"})).success,true);
 assert.equal(prompts,0);
 assert.equal((await call(registry,"cccodroid_run_tests",{runner:"node",path:"effect.mjs"})).success,false);assert.equal(prompts,1);
 assert.equal(fs.existsSync(path.join(root,"effect-marker")),false);
});
await check("模式切换使等待中的旧批准失效",async()=>{
 let release;const{policy,registry}=setup("default",()=>new Promise(r=>{release=r;}));
 const task=call(registry,"cccodroid_write_file",{path:"raced.txt",content:"bad"});
 await new Promise(r=>setImmediate(r));policy.setMode("plan");release(true);
 assert.equal((await task).success,false);assert.equal(fs.existsSync(path.join(root,"raced.txt")),false);
});
await check("自动执行只放行现有工具，不改变路径边界",async()=>{
 const{registry}=setup("bypassPermissions",()=>{throw new Error("must not ask");});
 assert.equal((await call(registry,"cccodroid_run_tests",{runner:"node",path:"effect.mjs"})).success,true);
 assert.equal(fs.existsSync(path.join(root,"effect-marker")),true);
 assert.equal((await call(registry,"cccodroid_write_file",{path:"../escape.txt",content:"bad"})).success,false);
});
await check("计划中的 Git 查看不执行仓库配置的外部程序",async()=>{
 const dir=path.join(root,"git-view");fs.mkdirSync(dir);
 const git=args=>{const r=spawnSync("git",args,{cwd:dir,encoding:"utf8"});if(r.status)throw new Error(r.stderr);};
 git(["init"]);fs.writeFileSync(path.join(dir,"a.txt"),"first");git(["add","a.txt"]);git(["-c","user.name=test","-c","user.email=test@invalid","commit","-m","seed"]);
 const marker=path.join(root,"git-hook-marker"),script=path.join(root,"hook.mjs"),wrapper=path.join(root,"hook");
 fs.writeFileSync(script,'import fs from "node:fs";fs.writeFileSync('+JSON.stringify(marker)+',"executed");');
 const shell=fs.existsSync("/system/bin/sh")?"/system/bin/sh":"/bin/sh";
 fs.writeFileSync(wrapper, ["#!"+shell, "exec '"+process.execPath+"' '"+script+"'", ""].join(String.fromCharCode(10)), {mode:0o700});
 git(["config","diff.external",wrapper]);git(["config","core.fsmonitor",wrapper]);
 fs.writeFileSync(path.join(dir,"a.txt"),"second");
 const{registry}=setup("plan");
 assert.equal((await call(registry,"cccodroid_git_diff",{cwd:"git-view"})).success,true);
 assert.equal((await call(registry,"cccodroid_git_status",{cwd:"git-view"})).success,true);
 assert.equal(fs.existsSync(marker),false);
});
console.log(passed+"/"+passed+" passed");
