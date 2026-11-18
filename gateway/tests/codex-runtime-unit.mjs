import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {execFileSync} from "node:child_process";
import {createCodexRuntime,downloadCodexArchive,CODEX_RUNTIME_PIN} from "../gw/codex/runtime.mjs";
import {codexRuntimePaths} from "../gw/codex/runtime-paths.mjs";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"codex-runtime-unit-"));
let n=0;async function check(name,fn){await fn();console.log("ok "+(++n)+" "+name);}
const src=path.join(root,"source"),archive=path.join(root,"fixture.tar.zst");
fs.mkdirSync(path.join(src,"bin"),{recursive:true});
for(const name of ["codex","codex-exec-server","codex-code-mode-host"])fs.writeFileSync(path.join(src,"bin",name),"#!"+(fs.existsSync("/system/bin/sh")?"/system/bin/sh":"/bin/sh")+"\necho 'codex-cli 0.166.0'\n",{mode:0o700});
fs.writeFileSync(path.join(src,"codex-package.json"),JSON.stringify({version:"0.166.0",target:CODEX_RUNTIME_PIN.target}));
execFileSync("tar",["--zstd","-cf",archive,"-C",src,"."]);
const bytes=fs.readFileSync(archive),pin={...CODEX_RUNTIME_PIN,size:bytes.length,sha256:crypto.createHash("sha256").update(bytes).digest("hex")};
let copies=0;
const copy=async(p,file,signal,progress)=>{copies++;fs.copyFileSync(archive,file);progress(p.size,p.size);};
try{
 await check("固定官方版本、HTTPS 来源和 SHA-256 清单",()=>{
  assert.match(CODEX_RUNTIME_PIN.url,/^https:\/\/github.com\/openai\/codex\/releases\/download\//);
  assert.match(CODEX_RUNTIME_PIN.sha256,/^[0-9a-f]{64}$/);assert.equal(CODEX_RUNTIME_PIN.size,136246047);
 });
 await check("安装真实压缩包，校验/解压/检查后原子启用，保留已有账号目录",async()=>{
  const home=path.join(root,"success"),paths=codexRuntimePaths(home);fs.mkdirSync(paths.home,{recursive:true});
  fs.writeFileSync(path.join(paths.home,"auth.json"),"fixture-existing-account");
  const r=createCodexRuntime({home,pin,fetchArchive:copy});
  assert.equal(r.snapshot().installed,false);r.start();r.start();
  const s=await r.settled();assert.equal(s.phase,"ready");assert(s.installed);assert(!s.busy);
  assert.equal(copies,1);assert.equal(fs.readFileSync(path.join(paths.home,"auth.json"),"utf8"),"fixture-existing-account");
  r.start();assert.equal((await r.settled()).phase,"ready");assert.equal(copies,1);
  assert.equal(fs.statSync(paths.bin).mode&0o777,0o700);
 });
 await check("SHA-256 不匹配不启用环境且删除坏下载",async()=>{
  const home=path.join(root,"hash"),r=createCodexRuntime({home,pin:{...pin,sha256:"0".repeat(64)},fetchArchive:copy});
  r.start();const s=await r.settled();assert.equal(s.phase,"error");assert(!s.installed);assert(!fs.existsSync(codexRuntimePaths(home).archive));
 });
 await check("取消后保留下载部分，重试可继续，取消不产生已安装标记",async()=>{
  const home=path.join(root,"cancel");let attempt=0;
  const r=createCodexRuntime({home,pin,fetchArchive:async(p,file,signal,progress)=>{
   if(++attempt===1){fs.writeFileSync(file,bytes.subarray(0,20));await new Promise((resolve,reject)=>signal.addEventListener("abort",()=>reject(Error("cancel")),{once:true}));}
   else {assert.equal(fs.statSync(file).size,20);await copy(p,file,signal,progress);}
  }});
  r.start();while(attempt===0)await new Promise(r=>setTimeout(r,5));
  r.cancel();const cancelled=await r.settled();assert.equal(cancelled.phase,"cancelled");assert(!cancelled.installed);
  r.start();assert.equal((await r.settled()).phase,"ready");
 });
 await check("解压后程序检查失败不启用、清理 staging，错误可见",async()=>{
  const home=path.join(root,"smoke"),r=createCodexRuntime({home,pin,fetchArchive:copy,run:async(bin,args)=>bin==="tar"&&args.includes("-tf")?"bin/codex":bin==="tar"&&args.includes("-xf")?Promise.reject(Error("extract failed")):"version"});
  r.start();const s=await r.settled();assert.equal(s.phase,"error");assert.match(s.message,/extract failed/);assert(!s.installed);
  assert.deepEqual(fs.readdirSync(path.dirname(codexRuntimePaths(home).release)),[]);
 });
 await check("异常发生在下载前也落入可重试错误状态",async()=>{
  const home=path.join(root,"badpin"),r=createCodexRuntime({home,pin:{...pin,version:"wrong"},fetchArchive:copy});
  r.start();const s=await r.settled();assert.equal(s.phase,"error");assert.match(s.message,/版本/);
 });
 await check("越界归档成员拒绝解压",async()=>{
  let extracted=false;const r=createCodexRuntime({home:path.join(root,"traversal"),pin,fetchArchive:copy,run:async(bin,args)=>{
   if(args.includes("-tf"))return "../outside";if(args.includes("-xf"))extracted=true;return "version";
  }});r.start();const s=await r.settled();assert.equal(s.phase,"error");assert(!extracted);
 });
 await check("断点下载使用 Range 并追加，整包缓存无需网络",async()=>{
  const file=path.join(root,"partial");fs.writeFileSync(file,bytes.subarray(0,20));let last=0,calls=0;
  const fake=async(url,opts)=>{
   calls++;assert.equal(opts.headers.range,"bytes=20-");
   const r=new Response(bytes.subarray(20),{status:206,headers:{"content-range":"bytes 20-"+(bytes.length-1)+"/"+bytes.length}});
   Object.defineProperty(r,"url",{value:pin.url});return r;
  };
  await downloadCodexArchive(pin,file,new AbortController().signal,d=>last=d,fake);
  assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(last,pin.size);
  await downloadCodexArchive(pin,file,new AbortController().signal,()=>{},fake);assert.equal(calls,1);
 });
 await check("服务器忽略 Range 时从头覆盖，错误范围不混入原下载",async()=>{
  const file=path.join(root,"range");fs.writeFileSync(file,bytes.subarray(0,20));
  const fake=(status,range)=>async()=>{
   const r=new Response(bytes,{status,headers:range?{"content-range":range}:{}});Object.defineProperty(r,"url",{value:pin.url});return r;
  };
  await assert.rejects(downloadCodexArchive(pin,file,new AbortController().signal,()=>{},fake(206,"bytes 0-9/10")),/断点/);
  assert.equal(fs.statSync(file).size,20);
  await downloadCodexArchive(pin,file,new AbortController().signal,()=>{},fake(200));assert.deepEqual(fs.readFileSync(file),bytes);
 });
 console.log(n+"/"+n+" passed");
}finally{fs.rmSync(root,{recursive:true,force:true});}
