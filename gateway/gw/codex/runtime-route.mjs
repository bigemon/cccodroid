import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {CFG,PREFIX,LIVE} from "../config.mjs";
import {onShutdown} from "../crashguard.mjs";
import {termEnv} from "../terminal.mjs";
import {NEXT,readBody,sendJson} from "../http.mjs";
import {privCall} from "../usage.mjs";
import {SETTINGS,saveSettings} from "../settings-store.mjs";
import {RUNS} from "../runs.mjs";
import {CODEX_OPERATIONS} from "./operation-lock.mjs";
import {codexAvailable,codexConfig} from "./config.mjs";
import {createCodexRuntime} from "./runtime.mjs";
import {configuredCodexVersion} from "./runtime-info.mjs";
import {runtimeVersion,runtimeChannel,compareRuntimeVersions,fetchCodexRelease,fetchCodexVersions} from "./runtime-release.mjs";
import {probeCodexRuntime} from "./runtime-smoke.mjs";
import {codexRuntimeBusy,disposeAllCodexSessions} from "./run.mjs";
import {codexAgentRuntimeBusy,disposeAgent} from "./agent.mjs";
import {codexRuntimePaths} from "./runtime-paths.mjs";
import {invalidateCatalog} from "./catalog.mjs";

let instance=null,retry=null,autoEnabled=false,lastAutoAttempt=0,loop=null,initial=null;
let controlBusy=false,prepared=null;
let adoption=null,versionJob=null,versionAbort=null,versionInfo={};
const channel=()=>runtimeChannel(SETTINGS.codex?.channel);
const custom=()=>SETTINGS.codex?.useManagedRuntime!==true&&!!(SETTINGS.codex?.bin||process.env.CCAPP_CODEX_BIN);
const supported=()=>process.arch==="arm64"&&process.env.CCAPP_EXEC!=="loader";
function configurationToken(){
 const c=codexConfig(),s=SETTINGS.codex||{};
 return crypto.createHash("sha256").update(JSON.stringify([c.bin,c.home,s.bin||null,s.home||null,s.useManagedRuntime===true,channel(),s.pin||null])).digest("hex");
}
function activationReason(){
 if(adoption&&adoption.token!==configurationToken())throw Error("Codex 路径已更改，请重新确认更新；原配置保留");
 if(custom()&&!adoption)return "自定义环境保留，请手动确认后切换到官方程序";
 if([...RUNS.values()].some(r=>r.backend==="codex")||CODEX_OPERATIONS.size||codexRuntimeBusy()||codexAgentRuntimeBusy())
  return "已准备好，等待 Codex 会话、登录和后台命令空闲后切换";
 return "";
}
function activated(){
 if(!adoption)return;
 const previous=SETTINGS.codex;
 SETTINGS.codex={...previous,bin:null,home:adoption.home,useManagedRuntime:true};
 if(!saveSettings()){SETTINGS.codex=previous;throw Error("保存 Codex 路径失败，仍使用原配置；可重试切换");}
 adoption=null;versionInfo={};
}
function changed(phase){
 clearTimeout(retry);retry=null;
 if(instance?.snapshot().busy)return;
 if(["ready","error","cancelled"].includes(phase))adoption=null;
 if(phase==="ready")invalidateCatalog();
 if(phase!=="waiting")return;
 retry=setTimeout(async()=>{
  const s=instance.snapshot();
  if(s.phase!=="waiting")return;
  if(s.automated){
   const policy=await privCall({op:"upd_status"},5000);
   if(!policy?.ok||policy.auto!==true){syncAuto(false);return;}
  }
  if(custom()&&!adoption){instance.cancel();return;}
  instance.start("install",{automated:s.automated,allowDowngrade:s.confirmedDowngrade});
 },20000);retry.unref?.();
}
const runtime=()=>instance||=createCodexRuntime({home:CFG.home,env:termEnv(),probe:probeCodexRuntime,getChannel:channel,getPinnedVersion:()=>SETTINGS.codex?.pin||null,
 canActivate:activationReason,isAdopting:()=>!!adoption,onActivated:activated,onState:changed});
function readVersion(){
 if(!custom()||versionJob)return;
 const key=configurationToken(),bin=codexConfig().bin;
 versionAbort=new AbortController();
 versionJob=configuredCodexVersion(bin,{env:termEnv(),signal:versionAbort.signal})
  .then(version=>{if(key===configurationToken())versionInfo={key,version};})
  .catch(e=>{if(key===configurationToken())versionInfo={key,error:e.message};})
  .finally(()=>{versionJob=null;versionAbort=null;});
}
export function codexRuntimeStatus(){
 const s=runtime().snapshot(),c=codexConfig(),isCustom=custom(),token=configurationToken();
 const info=versionInfo.key===token?versionInfo:{};
 const reading=isCustom&&!!versionJob;
 return {...s,...(isCustom?{currentVersion:info.version||"",versionError:info.error||""}:{}),
  ...(reading&&!s.busy?{phase:"checking",message:"正在读取当前 Codex 版本…"}:{}),
  ...(controlBusy?{phase:"checking",message:"正在处理 Codex 版本选择…"}:{}),
  busy:s.busy||reading||controlBusy,available:codexAvailable(),custom:isCustom,supported:supported(),configurationToken:token,
  supportMessage:process.arch!=="arm64"?"此环境包仅支持 ARM64 设备":process.env.CCAPP_EXEC==="loader"?"此环境包需要直接执行方式；请先在设置中切换执行方式并重启网关":"",
  configuredBin:c.bin,configuredHome:c.home};
}
function syncAuto(enabled){
 autoEnabled=enabled===true;
 if(!autoEnabled&&instance?.snapshot().automated){clearTimeout(retry);retry=null;instance.cancel();}
}
export function codexUpdateItem(){
 const s=codexRuntimeStatus();
 let state=s.busy?({downloading:"downloading",verifying:"verifying",extracting:"installing",checking:"checking"}[s.phase]||"verifying")
  :({available:"available",ready:"uptodate",waiting:"waiting",error:"error",cancelled:"available"}[s.phase]||(s.installed?"unknown":"missing"));
 let message=!s.supported?s.supportMessage:s.message;
 if(s.custom&&!s.busy&&!["error","waiting"].includes(s.phase)){
  state=s.latestVersion?(s.currentVersion===s.latestVersion?"uptodate":"available"):"unknown";
  message=s.versionError||(!s.latestVersion?"自定义环境，可检查官方 "+channel():"手动更新后使用官方程序，登录与会话目录保留");
 }
 if(!s.supported&&!s.installed)state="unsupported";
 if(!s.busy&&s.phase!=="waiting"&&s.phase!=="error"&&s.latestVersion&&s.currentVersion&&s.currentVersion!==s.latestVersion)state="available";
 if(!s.busy&&s.currentVersion===s.latestVersion&&s.latestVersion&&s.phase!=="error")message=channel()==="pinned"?"已固定 "+s.latestVersion:"";
 return {id:"codex",name:"Codex",current:s.currentVersion,latest:s.latestVersion,state,custom:s.custom,
  done:s.done,total:s.total,message};
}
export function startCodexRuntimeAction(action,expectedConfig){
 const s=codexRuntimeStatus();
 if(action==="cancel"){versionAbort?.abort();runtime().cancel();return {ok:true,message:"已请求取消",...codexRuntimeStatus()};}
 if(s.busy||s.phase==="waiting")return {ok:false,message:"Codex 更新任务正在进行，请等待或先取消"};
 if(action==="adopt"){
  if(!s.custom||expectedConfig!==s.configurationToken)return {ok:false,message:"Codex 路径已更改，请重新确认更新"};
  adoption={token:s.configurationToken,home:s.configuredHome};
 }else if(action==="install"&&s.custom)return {ok:false,message:"自定义环境需先确认切换到官方程序；未覆盖原环境"};
 if(action!=="check"&&!s.supported){adoption=null;return {ok:false,message:s.supportMessage};}
 if(action==="check")readVersion();
 runtime().start(action==="adopt"?"install":action);
 return {ok:true,message:action==="check"?"正在检查 Codex 官方 "+channel():"正在准备 Codex 官方 "+channel()+" 更新",...codexRuntimeStatus()};
}
export function setCodexRuntimeChannel(next){
 if(!["stable","alpha"].includes(next))return {ok:false,message:"Codex 更新频道无效"};
 const s=codexRuntimeStatus();
 if(s.busy||s.phase==="waiting")return {ok:false,message:"请等待当前 Codex 更新完成，或先取消再切换频道"};
 const previous=SETTINGS.codex;
 SETTINGS.codex={...previous,channel:next,pin:null};
 if(!saveSettings()){SETTINGS.codex=previous;return {ok:false,message:"频道保存失败，原设置保留"};}
 runtime().resetChannel();lastAutoAttempt=0;
 return startCodexRuntimeAction("check");
}
// Shared update operations keep the existing native global switch authoritative.
export function noteCodexUpdateOperation(op,body,result){
 if(result?.ok===false)return result;
 if(typeof result?.auto==="boolean")syncAuto(result.auto);
 if(op==="upd_set"&&typeof body.auto==="boolean")syncAuto(body.auto);
 if(op==="upd_check")startCodexRuntimeAction("check");
 if(op==="upd_status"&&Array.isArray(result?.items)){
  return {...result,codexCheckedAt:runtime().snapshot().checkedAt,codexChannel:channel(),codexPin:SETTINGS.codex?.pin||"",items:[...result.items.filter(i=>i.id!=="codex"),codexUpdateItem()]};
 }
 return result;
}
async function autoTick(){
 if(!supported()||custom()||controlBusy||channel()==="pinned"||(prepared&&prepared.expires>Date.now()))return;
 const policy=await privCall({op:"upd_status"},5000);
 if(!policy?.ok)return;
 syncAuto(policy.auto);
 const s=runtime().snapshot();
 if(!autoEnabled||!s.installed||s.busy||s.phase==="waiting"||Date.now()-lastAutoAttempt<6*3600e3)return;
 lastAutoAttempt=Date.now();runtime().start("install",{automated:true});
}
export function startCodexAutoUpdates(){
 if(!LIVE||!PREFIX||loop)return;
 initial=setTimeout(()=>autoTick().catch(()=>{}),20000);initial.unref?.();
 loop=setInterval(()=>autoTick().catch(()=>{}),30*60e3);loop.unref?.();
}
onShutdown("Codex 环境更新",()=>{clearTimeout(initial);clearTimeout(retry);clearInterval(loop);versionAbort?.abort();instance?.cancel();});
export async function prepareCodexSelection({channel:next,version=null,install=true}){
 if(!["stable","alpha","pinned"].includes(next)||typeof install!=="boolean"||(next==="pinned"?(!runtimeVersion(version)||compareRuntimeVersions(version,"0.166.0")<0):version!==null))return {ok:false,message:"Codex 通道或版本无效"};
 const s=codexRuntimeStatus();
 if(s.busy||s.phase==="waiting")return {ok:false,message:"请等待当前更新完成，或先取消"};
 if(install&&!s.supported)return {ok:false,message:s.supportMessage};
 controlBusy=true;prepared=null;
 try{
  let current=s.currentVersion;
  if(s.custom&&!current)try{current=await configuredCodexVersion(s.configuredBin,{env:termEnv()});}catch{}
  const release=await fetchCodexRelease({channel:next,version:next==="pinned"?version:null});
  if(configurationToken()!==s.configurationToken)throw Error("Codex 配置已更改，请重新选择");
  const downgrade=!!current&&runtimeVersion(current)&&compareRuntimeVersions(release.version,current)<0;
  const token=crypto.randomBytes(24).toString("hex");
  prepared={token,configurationToken:s.configurationToken,channel:next,pin:next==="pinned"?version:null,
   release,currentVersion:current,custom:s.custom,home:s.configuredHome,install,downgrade,expires:Date.now()+5*60e3};
  return {ok:true,selectionToken:token,channel:next,version:release.version,currentVersion:current,custom:s.custom,
   configuredHome:s.configuredHome,install,downgrade};
 }catch(e){return {ok:false,message:e.message||"无法读取官方版本"};}
 finally{controlBusy=false;}
}
export function commitCodexSelection({selectionToken,acceptDowngrade=false,adopt=false}){
 const p=prepared,s=codexRuntimeStatus();
 if(s.busy||s.phase==="waiting")return {ok:false,message:"Codex 更新任务正在进行"};
 if(!p||p.token!==selectionToken||p.expires<Date.now()||p.configurationToken!==s.configurationToken)return {ok:false,message:"版本选择已过期或配置已更改，请重新选择"};
 if(p.install&&p.downgrade&&acceptDowngrade!==true)return {ok:false,message:"需要先确认降级，原设置保留"};
 if(p.install&&p.custom&&adopt!==true)return {ok:false,message:"需要先确认切换自定义程序，原设置保留"};
 const previous=SETTINGS.codex;
 SETTINGS.codex={...previous,channel:p.channel,pin:p.pin};
 if(!saveSettings()){SETTINGS.codex=previous;return {ok:false,message:"版本选择保存失败，原设置保留"};}
 prepared=null;runtime().resetChannel();lastAutoAttempt=0;
 if(p.custom&&p.currentVersion)versionInfo={key:configurationToken(),version:p.currentVersion};
 if(p.install&&p.custom)adoption={token:configurationToken(),home:p.home};
 runtime().start(p.install?"install":"check",{target:p.release,allowDowngrade:p.install&&p.downgrade});
 return {ok:true,...codexRuntimeStatus()};
}
export async function uninstallCodexRuntime(expectedConfig){
 const s=codexRuntimeStatus();
 if(s.custom)return {ok:false,message:"自定义程序请在原 Codex 高级配置中管理，未删除文件"};
 if(s.busy||s.phase==="waiting"||activationReason())return {ok:false,message:"Codex 正在使用或更新，请空闲后再卸载"};
 if(expectedConfig!==s.configurationToken)return {ok:false,message:"Codex 配置已更改，请重新确认卸载"};
 const root=codexRuntimePaths(CFG.home).root;
 if(!fs.existsSync(root))return {ok:true,...s};
 if(fs.lstatSync(root).isSymbolicLink())return {ok:false,message:"运行环境目录为自定义链接，未删除文件"};
 const real=fs.realpathSync(root),data=fs.existsSync(s.configuredHome)?fs.realpathSync(s.configuredHome):path.resolve(s.configuredHome);
 if(data===real||data.startsWith(real+path.sep))return {ok:false,message:"账号目录位于运行环境内，请先在高级配置迁出，未删除文件"};
 const moved=[],suffix=".uninstall-"+crypto.randomBytes(8).toString("hex");
 controlBusy=true;prepared=null;
 try{
  // Detach only owned program/cache paths. Other files under the runtime root stay intact.
  try{for(const name of["releases","downloads","active.json"]){
   const from=path.join(root,name),to=path.join(root,name+suffix);
   if(fs.existsSync(from)){fs.renameSync(from,to);moved.push({from,to});}
  }}catch(e){for(const {from,to} of moved.reverse())fs.renameSync(to,from);throw e;}
  await Promise.all([disposeAllCodexSessions(),disposeAgent()]);
  runtime().resetChannel();invalidateCatalog();
  let message="已卸载 Codex 程序，登录、会话与设置保留";
  for(const {to} of moved)try{fs.rmSync(to,{recursive:true,force:true});}catch{message+="；旧文件清理未完成";}
  controlBusy=false;return {ok:true,...codexRuntimeStatus(),message};
 }catch(e){return {ok:false,message:e.message||"卸载失败"};}
 finally{controlBusy=false;}
}

export async function routeCodexRuntime(req,res,u,p){
 if(p==="/api/codex/versions"&&req.method==="GET"){
  try{return sendJson(res,200,{...await fetchCodexVersions({refresh:u.searchParams.get("refresh")==="1"}),channel:channel(),pin:SETTINGS.codex?.pin||"",current:codexRuntimeStatus().currentVersion});}
  catch(e){return sendJson(res,502,{ok:false,message:e.message||"取不到 Codex 版本列表",versions:[]});}
 }
 if(p!=="/api/codex/runtime")return NEXT;
 if(req.method==="GET"){
  // Read a legacy/custom program's actual version without querying an update channel.
  if(custom()&&codexAvailable()&&!controlBusy&&!runtime().snapshot().busy&&versionInfo.key!==configurationToken())readVersion();
  if(versionJob)await versionJob;
  return sendJson(res,200,codexRuntimeStatus());
 }
 if(req.method!=="POST")return sendJson(res,405,{message:"不支持的请求方式"});
 let b;try{b=JSON.parse((await readBody(req))||"{}");}catch{return sendJson(res,400,{message:"请求格式无效"});}
 if(!b||typeof b!=="object"||Array.isArray(b))return sendJson(res,400,{message:"请求格式无效"});
 const fields={prepare:["action","channel","version","install"],commit:["action","selectionToken","acceptDowngrade","adopt"],discard:["action","selectionToken"],uninstall:["action","expectedConfig"],install:["action"],check:["action"],cancel:["action"],adopt:["action","expectedConfig"],channel:["action","channel"]};
 if(typeof b.action!=="string"||!Object.hasOwn(fields,b.action)||Object.keys(b).some(k=>!fields[b.action].includes(k)))return sendJson(res,400,{message:"不支持的 Codex 更新请求"});
 let result;
 if(b.action==="prepare")result=await prepareCodexSelection(b);
 else if(b.action==="commit")result=commitCodexSelection(b);
 else if(b.action==="discard"){if(prepared?.token===b.selectionToken)prepared=null;result={ok:true,...codexRuntimeStatus()};}
 else if(b.action==="uninstall")result=await uninstallCodexRuntime(b.expectedConfig);
 else if(b.action==="adopt"&&!/^[a-f0-9]{64}$/.test(b.expectedConfig||""))return sendJson(res,400,{message:"配置摘要无效"});
 else if(b.action==="channel"&&!["stable","alpha"].includes(b.channel))return sendJson(res,400,{message:"通道无效"});
 else result=b.action==="channel"?setCodexRuntimeChannel(b.channel):startCodexRuntimeAction(b.action,b.expectedConfig);
 return sendJson(res,result.ok===false?409:200,result);
}
