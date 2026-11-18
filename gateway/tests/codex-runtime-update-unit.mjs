import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createCodexRuntime,CODEX_RUNTIME_PIN} from "../gw/codex/runtime.mjs";
import {codexRuntimePaths} from "../gw/codex/runtime-paths.mjs";
import {stableRelease,fetchStableCodex,CODEX_RELEASE_API,CODEX_RELEASE_ASSET,compareRuntimeVersions} from "../gw/codex/runtime-release.mjs";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"codex-update-unit-"));let n=0;
async function check(name,fn){await fn();console.log("ok "+(++n)+" "+name);}
function bundle(version){
 const src=path.join(root,"source-"+version),archive=path.join(root,version+".tar.zst");fs.mkdirSync(path.join(src,"bin"),{recursive:true});
 for(const name of["codex","codex-exec-server","codex-code-mode-host"])fs.writeFileSync(path.join(src,"bin",name),"#!"+(fs.existsSync("/system/bin/sh")?"/system/bin/sh":"/bin/sh")+"\necho 'codex-cli "+version+"'\n",{mode:0o700});
 fs.writeFileSync(path.join(src,"codex-package.json"),JSON.stringify({version,target:CODEX_RUNTIME_PIN.target}));
 execFileSync("tar",["--zstd","-cf",archive,"-C",src,"."]);
 const bytes=fs.readFileSync(archive),pin={...CODEX_RUNTIME_PIN,version,url:CODEX_RUNTIME_PIN.url.replaceAll("0.166.0",version),size:bytes.length,sha256:crypto.createHash("sha256").update(bytes).digest("hex")};
 return {bytes,pin,copy:async(p,file,signal,progress)=>{fs.writeFileSync(file,bytes);progress(bytes.length,bytes.length);}};
}
const old=bundle("0.166.0"),next=bundle("0.169.0");
const home=name=>path.join(root,name);
async function legacy(h){
 const r=createCodexRuntime({home:h,pin:old.pin,fetchArchive:old.copy});r.start();assert.equal((await r.settled()).phase,"ready");
 // Match the v133 layout: receipt exists, active pointer does not yet exist.
 fs.unlinkSync(codexRuntimePaths(h).active);
 fs.writeFileSync(path.join(codexRuntimePaths(h).home,"auth.json"),"existing-auth-sentinel");
}
const metadata=()=>({tag_name:"rust-v0.169.0",draft:false,prerelease:false,assets:[{name:CODEX_RELEASE_ASSET,size:next.pin.size,digest:"sha256:"+next.pin.sha256,browser_download_url:next.pin.url}]});
try{
 await check("只接收官方 stable、匹配目标/大小及 SHA-256，拒绝预发布和任意 URL",()=>{
  assert.equal(stableRelease(metadata()).version,"0.169.0");
  for(const patch of[{draft:true},{prerelease:true},{tag_name:"rust-v0.170.0-alpha.1"},{assets:[]},{assets:[{...metadata().assets[0],digest:null}]},{assets:[{...metadata().assets[0],browser_download_url:"https://untrusted.invalid/package"}]}])
   assert.throws(()=>stableRelease({...metadata(),...patch}));
  assert(compareRuntimeVersions("0.169.0","0.99.0")>0);assert.throws(()=>compareRuntimeVersions("latest","0.1.0"));
 });
 await check("读取最新官方元数据，拒绝接口重定向和 HTTP 错误",async()=>{
  let calls=0;const p=await fetchStableCodex({fetchImpl:async(url,opts)=>{calls++;assert.equal(url,CODEX_RELEASE_API);assert(opts.signal);return new Response(JSON.stringify(metadata()),{status:200});}});
  assert.equal(p.sha256,next.pin.sha256);assert.equal(calls,1);
  await assert.rejects(fetchStableCodex({fetchImpl:async()=>new Response("{}",{status:503})}),/503/);
  await assert.rejects(fetchStableCodex({fetchImpl:async()=>{const r=new Response("{}");Object.defineProperty(r,"url",{value:"https://other.invalid"});return r;}}),/重定向/);
 });
 await check("首次安装解析最新 stable 而不是固定 0.166，检查本身不下载",async()=>{
  let fetched=0,downloaded=0;const h=home("new");
  const r=createCodexRuntime({home:h,resolveRelease:async()=>{fetched++;return next.pin;},fetchArchive:async(...args)=>{downloaded++;return next.copy(...args);}});
  r.start("check");let s=await r.settled();assert.equal(s.phase,"missing");assert.equal(s.version,"0.169.0");assert.equal(downloaded,0);
  r.start();s=await r.settled();assert.equal(s.currentVersion,"0.169.0");assert.equal(fetched,1);assert.equal(downloaded,1);
  assert.equal(codexRuntimePaths(h).version,"0.169.0");assert(!fs.existsSync(codexRuntimePaths(h).archive));
 });
 await check("旧布局无需迁移；忙时只准备，空闲后原子切换，保留 auth 和旧二进制",async()=>{
  const h=home("upgrade");await legacy(h);const before=fs.readFileSync(codexRuntimePaths(h).bin);let busy=true,copies=0,probes=0;
  const r=createCodexRuntime({home:h,resolveRelease:async()=>next.pin,fetchArchive:async(...args)=>{copies++;await next.copy(...args);},probe:async()=>{probes++;},canActivate:()=>busy?"等待会话空闲":""});
  r.start();let s=await r.settled();assert.equal(s.phase,"waiting");assert.equal(s.currentVersion,"0.166.0");
  assert.equal(fs.readFileSync(path.join(s.home,"auth.json"),"utf8"),"existing-auth-sentinel");assert.deepEqual(fs.readFileSync(s.bin),before);
  busy=false;r.start();s=await r.settled();assert.equal(s.currentVersion,"0.169.0");assert.equal(copies,1);assert.equal(probes,1);
  assert.deepEqual(fs.readFileSync(codexRuntimePaths(h,"0.166.0").bin),before);
  assert.equal(JSON.parse(fs.readFileSync(codexRuntimePaths(h).active)).previousVersion,"0.166.0");
 });
 await check("试启失败不切换、不改账号，清理 staging",async()=>{
  const h=home("probe-fail");await legacy(h);
  const r=createCodexRuntime({home:h,resolveRelease:async()=>next.pin,fetchArchive:next.copy,probe:async()=>{throw Error("incompatible app-server");}});
  r.start();const s=await r.settled();assert.equal(s.phase,"error");assert.match(s.message,/incompatible/);assert.equal(s.currentVersion,"0.166.0");
  assert(!fs.existsSync(codexRuntimePaths(h,"0.169.0").release));
  assert.equal(fs.readFileSync(path.join(s.home,"auth.json"),"utf8"),"existing-auth-sentinel");
 });
 await check("断网保留旧版本；不默默改成捆绑的固定版本安装",async()=>{
  const h=home("offline");await legacy(h);let copied=false;
  const r=createCodexRuntime({home:h,resolveRelease:async()=>{throw Error("network offline");},fetchArchive:async()=>{copied=true;}});
  r.start();const s=await r.settled();assert.equal(s.phase,"error");assert.equal(s.currentVersion,"0.166.0");assert(!copied);
 });
 await check("当前版本比 stable 新时不自动降级",async()=>{
  const h=home("no-downgrade"),r=createCodexRuntime({home:h,pin:next.pin,fetchArchive:next.copy});r.start();await r.settled();
  const update=createCodexRuntime({home:h,resolveRelease:async()=>old.pin,fetchArchive:async()=>{throw Error("must not download");}});
  update.start();const s=await update.settled();assert.equal(s.phase,"available");assert.equal(s.currentVersion,"0.169.0");
 });
 await check("同版本官方摘要发生变化时明确拒绝，当前版本保留",async()=>{
  const h=home("changed-digest");await legacy(h);
  const r=createCodexRuntime({home:h,resolveRelease:async()=>({...old.pin,sha256:"f".repeat(64)})});
  r.start();const s=await r.settled();assert.equal(s.phase,"error");assert.equal(s.currentVersion,"0.166.0");
 });
 await check("指针写入失败不会丢失旧版本，重试可复用已验证候选",async()=>{
  const h=home("pointer-fail");await legacy(h);const original=fs.renameSync;
  fs.renameSync=(a,b)=>{if(b===codexRuntimePaths(h).active)throw Error("pointer write failed");return original(a,b);};
  const r=createCodexRuntime({home:h,resolveRelease:async()=>next.pin,fetchArchive:next.copy});
  try{r.start();const s=await r.settled();assert.equal(s.phase,"error");assert.equal(s.currentVersion,"0.166.0");}finally{fs.renameSync=original;}
  r.start();assert.equal((await r.settled()).currentVersion,"0.169.0");
 });
 await check("等待切换可取消；重启后候选复用，不重复下载或覆盖 auth",async()=>{
  const h=home("resume");await legacy(h);
  const r=createCodexRuntime({home:h,resolveRelease:async()=>next.pin,fetchArchive:next.copy,canActivate:()=>"busy"});
  r.start();await r.settled();assert.equal(r.cancel().phase,"cancelled");
  const resumed=createCodexRuntime({home:h,resolveRelease:async()=>next.pin,fetchArchive:async()=>{throw Error("already prepared");}});
  resumed.start();assert.equal((await resumed.settled()).currentVersion,"0.169.0");
 });
 await check("同版本托管程序已就绪时，显式接管仍执行空闲检查与保存；失败可重试",async()=>{
  const h=home("adopt-cached"),r=createCodexRuntime({home:h,pin:next.pin,fetchArchive:next.copy});r.start();await r.settled();
  let blocked=true,failed=true,saves=0;
  const adopt=createCodexRuntime({home:h,pin:next.pin,isAdopting:()=>true,
   canActivate:()=>blocked?"active thread":"",
   fetchArchive:async()=>{throw Error("cached candidate must be reused");},
   onActivated:()=>{saves++;if(failed)throw Error("settings save failed");}});
  adopt.start();assert.equal((await adopt.settled()).phase,"waiting");assert.equal(saves,0);
  blocked=false;adopt.start();assert.equal((await adopt.settled()).phase,"error");
  failed=false;adopt.start();assert.equal((await adopt.settled()).phase,"ready");assert.equal(saves,2);
 });
 await check("手动选择等待很久后仍切换到已确认的精确版本，不重新选通道目标",async()=>{
  const h=home("exact-resume");await legacy(h);let busy=true;
  const r=createCodexRuntime({home:h,canActivate:()=>busy?"active conversation":"",resolveRelease:async()=>{throw Error("must keep the confirmed target");},fetchArchive:next.copy});
  r.start("install",{target:next.pin});assert.equal((await r.settled()).phase,"waiting");
  const now=Date.now;Date.now=()=>now()+7*3600e3;
  try{busy=false;r.start("install");const s=await r.settled();assert.equal(s.phase,"ready",s.message);assert.equal(s.currentVersion,next.pin.version);}finally{Date.now=now;}
 });
 console.log(n+"/"+n+" passed");
}finally{fs.rmSync(root,{recursive:true,force:true});}
