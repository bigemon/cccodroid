import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {spawn} from "node:child_process";
import {pipeline} from "node:stream/promises";
import {Readable,Transform} from "node:stream";
import {codexRuntimePaths} from "./runtime-paths.mjs";
import {fetchCodexRelease,runtimeChannel,channelMatches,compareRuntimeVersions} from "./runtime-release.mjs";

export const CODEX_RUNTIME_PIN=JSON.parse(fs.readFileSync(new URL("./runtime-pin.json",import.meta.url),"utf8"));
function command(bin,args,{signal,env=process.env}={}) {
  return new Promise((resolve,reject)=>{
    const p=spawn(bin,args,{env,signal,stdio:["ignore","pipe","pipe"]});
    let text="",error="";
    const timer=setTimeout(()=>p.kill("SIGKILL"),120000);
    p.stdout.on("data",b=>{text+=b;if(text.length>4*1024*1024)p.kill("SIGKILL");});
    p.stderr.on("data",b=>{error=(error+b).slice(-2000);});
    p.on("error",e=>{clearTimeout(timer);reject(e);});
    p.on("exit",code=>{clearTimeout(timer);code===0?resolve(text):reject(Error(error||"工具退出："+code));});
  });
}
async function hash(file) {
  const h=crypto.createHash("sha256");
  for await (const b of fs.createReadStream(file))h.update(b);
  return h.digest("hex");
}
export async function downloadCodexArchive(pin,file,signal,progress,fetchImpl=fetch) {
  let have=0;try{have=fs.statSync(file).size;}catch{}
  if(have===pin.size){progress(have,pin.size);return;}
  if(have>pin.size){fs.unlinkSync(file);have=0;}
  const r=await fetchImpl(pin.url,{signal,headers:have?{range:"bytes="+have+"-"}:{}});
  if(!r.ok||![200,206].includes(r.status))throw Error("下载失败 HTTP "+r.status);
  if(new URL(r.url).protocol!=="https:")throw Error("下载重定向必须保持 HTTPS");
  if(r.status===206 && !String(r.headers.get("content-range")).startsWith("bytes "+have+"-"))throw Error("服务器断点响应无效");
  if(r.status===200)have=0;
  let done=have;
  const meter=new Transform({transform(chunk,_,cb){
    done+=chunk.length;
    if(done>pin.size)return cb(Error("下载大小超过固定清单"));
    progress(done,pin.size);cb(null,chunk);
  }});
  await pipeline(Readable.fromWeb(r.body),meter,fs.createWriteStream(file,{flags:have?"a":"w",mode:0o600}),{signal});
  if(done!==pin.size)throw Error("下载未完成，可重试续传");
}
function receiptAt(paths){
 try{
  const r=JSON.parse(fs.readFileSync(path.join(paths.release,"cccodroid-runtime.json"),"utf8"));
  return r.version===paths.version&&/^[a-f0-9]{64}$/.test(r.sha256)&&fs.lstatSync(paths.bin).isFile()?r:null;
 }catch{return null;}
}
export function createCodexRuntime({home,pin=null,resolveRelease=fetchCodexRelease,getChannel=()=>"stable",getPinnedVersion=()=>null,fetchArchive=downloadCodexArchive,
 run=command,probe=null,canActivate=()=>"",isAdopting=()=>false,onActivated=()=>{},onState=()=>{},env=process.env}={}){
 let job=null,abort=null,latest=null,checkedAt=0,originAuto=false,explicitTarget=null,confirmedDowngrade=false;
 const channel=()=>runtimeChannel(getChannel());
 let state={phase:"idle",message:"尚未检查 Codex 更新",done:0,total:0};
 const installed=()=>receiptAt(codexRuntimePaths(home));
 const snapshot=()=>{
  const paths=codexRuntimePaths(home),current=installed();
  return {...state,busy:!!job,automated:originAuto,installed:!!current,currentVersion:current?.version||"",
   version:latest?.version||pin?.version||"",latestVersion:latest?.version||"",checkedAt,
   channel:channel(),pinVersion:getPinnedVersion()||"",confirmedDowngrade,downloadSize:latest?.size||pin?.size||0,bin:paths.bin,home:paths.home};
 };
 function set(phase,message,extra={}){state={...state,phase,message,...extra};onState(phase);}
 async function resolve(force,signal){
  if(!latest||force||Date.now()-checkedAt>6*3600e3){
   set("checking","正在检查官方 Codex "+channel()+"…");
   const next=explicitTarget||pin||await resolveRelease({signal,channel:channel(),version:channel()==="pinned"?getPinnedVersion():null});
   if((channel()==="pinned"?next.version!==getPinnedVersion():!channelMatches(next.version,channel()))||next.target!==CODEX_RUNTIME_PIN.target||!/^https:\/\/github\.com\/openai\/codex\/releases\/download\//.test(next.url)||!Number.isSafeInteger(next.size)||next.size<=0||!/^[a-f0-9]{64}$/.test(next.sha256))throw Error("Codex 环境包版本或校验信息无效");
   latest={...next};checkedAt=Date.now();
  }
  return latest;
 }
 async function operate(action){
  const signal=abort.signal;let staging=null;
  try{
   const target=await resolve(action==="check",signal),current=installed();signal.throwIfAborted();
   if(current&&current.version===target.version&&current.sha256!==target.sha256)throw Error("同一版本的官方校验信息发生变化，原核心保留");
   const comparison=current?compareRuntimeVersions(current.version,target.version):null;
   if(comparison===0&&!isAdopting()){if(action!=="check")fs.mkdirSync(codexRuntimePaths(home).home,{recursive:true,mode:0o700});set("ready",channel()==="pinned"?"已固定 "+target.version:"",{done:0,total:0});return;}
   if(comparison>0&&action!=="check"&&(!confirmedDowngrade||originAuto)){set("available","目标版本比当前旧，需手动确认后切换",{done:0,total:0});return;}
   if(action==="check"){set(current?"available":"missing",!current?"尚未安装 Codex，可从官方安装":comparison>0?"切换到 "+channel()+" 的 "+target.version+"（比当前版本旧），需手动确认":"发现 Codex "+channel()+" 新版本");return;}
   const paths=codexRuntimePaths(home,target.version);
   let cached=receiptAt(paths);
   if(cached&&cached.sha256!==target.sha256)throw Error("同一版本的官方校验信息发生变化，未覆盖原环境");
   if(!cached){
    fs.mkdirSync(path.dirname(paths.archive),{recursive:true,mode:0o700});
    set("checking","正在检查基础工具与存储空间…",{done:0,total:target.size});
    await run("tar",["--version"],{env,signal});await run("zstd",["--version"],{env,signal});
    const disk=fs.statfsSync(paths.root);
    if(disk.bavail*disk.bsize<Math.max(1024**3,target.size*5))throw Error("安装 Codex 的内部存储空间不足，需至少 1 GiB 且能容纳下载与解压");
    set("downloading","正在下载官方 Codex "+channel()+"…");
    await fetchArchive(target,paths.archive,signal,(done,total)=>{state={...state,done,total};});
    set("verifying","正在校验 Codex 环境包…");
    if(fs.statSync(paths.archive).size!==target.size||await hash(paths.archive)!==target.sha256){fs.unlinkSync(paths.archive);throw Error("环境包 SHA-256 校验失败，已删除下载文件");}
    signal.throwIfAborted();
    const entries=(await run("tar",["--zstd","-tf",paths.archive],{env,signal})).trim().split("\n");
    if(!entries.length||entries.some(n=>!n||n.startsWith("/")||n.split("/").includes("..")||n.includes("\\")))throw Error("环境包包含非法路径");
    fs.mkdirSync(path.dirname(paths.release),{recursive:true,mode:0o700});
    staging=fs.mkdtempSync(path.join(path.dirname(paths.release),".install-"));
    set("extracting","正在解压 Codex 运行环境…");
    await run("tar",["--zstd","-xf",paths.archive,"-C",staging],{env,signal});
    const metadata=JSON.parse(fs.readFileSync(path.join(staging,"codex-package.json"),"utf8"));
    if(metadata.version!==target.version||metadata.target!==target.target)throw Error("环境包目标或版本不匹配");
    for(const name of["codex","codex-exec-server","codex-code-mode-host"]){
     const file=path.join(staging,"bin",name);if(!fs.lstatSync(file).isFile())throw Error("缺少环境程序："+name);fs.chmodSync(file,0o700);
    }
    set("checking","正在检查 Codex 程序与 App Server 兼容性…");
    const version=await run(path.join(staging,"bin/codex"),["--version"],{env,signal});
    if(version.trim()!=="codex-cli "+target.version)throw Error("Codex 程序版本检查失败");
    if(probe)await probe(path.join(staging,"bin/codex"),{signal,env,staging});
    signal.throwIfAborted();
    fs.writeFileSync(path.join(staging,"cccodroid-runtime.json"),JSON.stringify({version:target.version,sha256:target.sha256,installedAt:Date.now(),source:target.url})+"\n",{mode:0o600});
    if(fs.existsSync(paths.release))throw Error("安装目录已有未完成环境，未覆盖原目录");
    fs.renameSync(staging,paths.release);staging=null;
    // The installed version is durable; the compressed download is no longer needed.
    try{fs.unlinkSync(paths.archive);}catch{}
   }
   signal.throwIfAborted();
   const reason=canActivate({automated:originAuto});
   if(reason){set("waiting",String(reason),{done:target.size,total:target.size});return;}
   // No await between the final busy check and the atomic pointer switch.
   fs.mkdirSync(paths.home,{recursive:true,mode:0o700});
   const tmp=paths.active+".tmp-"+process.pid;
   try{
    fs.writeFileSync(tmp,JSON.stringify({version:target.version,previousVersion:current?.version||null,activatedAt:Date.now()})+"\n",{mode:0o600});
    fs.renameSync(tmp,paths.active);
   }catch(e){try{fs.unlinkSync(tmp);}catch{}throw e;}
   onActivated(paths);
   set("ready","Codex "+channel()+" 已就绪，新连接使用新版本",{done:target.size,total:target.size});
  }catch(e){set(signal.aborted?"cancelled":"error",signal.aborted?"已取消，原核心保留，可重试续传":String(e.message||e));}
  finally{if(staging)fs.rmSync(staging,{recursive:true,force:true});}
 }
 return {
  snapshot,
  resetChannel(){if(job)return false;latest=null;checkedAt=0;state={phase:"idle",message:"尚未检查 Codex "+channel(),done:0,total:0};return true;},
  start(action="install",{automated=false,target=null,allowDowngrade=false}={}){
   if(job)return snapshot();
   originAuto=automated;explicitTarget=target||(!automated&&state.phase==="waiting"?explicitTarget:null);confirmedDowngrade=!automated&&allowDowngrade===true;abort=new AbortController();
   job=operate(action).finally(()=>{job=null;abort=null;onState(state.phase);});return snapshot();
  },
  cancel(){abort?.abort();if(!job&&state.phase==="waiting")set("cancelled","已取消等待切换，原核心保留");return snapshot();},
  async settled(){await job;return snapshot();}
 };
}
