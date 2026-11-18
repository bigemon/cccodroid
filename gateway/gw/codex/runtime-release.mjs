// Only official release metadata may select the artifact URL, target and digest.
export const CODEX_RELEASE_API="https://api.github.com/repos/openai/codex/releases/latest";
export const CODEX_VERSION_REFS_API="https://api.github.com/repos/openai/codex/git/matching-refs/tags/rust-v";
export const CODEX_ALPHA_API="https://registry.npmjs.org/@openai/codex/alpha";
export const CODEX_RELEASE_TARGET="aarch64-unknown-linux-musl";
export const CODEX_RELEASE_ASSET="codex-package-"+CODEX_RELEASE_TARGET+".tar.zst";
export const stableVersion=v=>typeof v==="string"&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v);
export const alphaVersion=v=>typeof v==="string"&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/.test(v);
export const runtimeVersion=v=>stableVersion(v)||alphaVersion(v);
export const runtimeChannel=c=>["alpha","pinned"].includes(c)?c:"stable";
export const channelMatches=(v,c)=>c==="stable"?stableVersion(v):c==="alpha"?alphaVersion(v):c==="pinned"&&runtimeVersion(v);
export function compareRuntimeVersions(a,b){
 if(!runtimeVersion(a)||!runtimeVersion(b))throw Error("Codex 版本号无效");
 const [ac,ap]=a.split("-alpha."),[bc,bp]=b.split("-alpha.");
 const compare=(x,y)=>{for(let i=0;i<Math.max(x.length,y.length);i++){const d=(x[i]??0)-(y[i]??0);if(d)return d>0?1:-1;}return 0;};
 const core=compare(ac.split(".").map(Number),bc.split(".").map(Number));
 if(core)return core;
 if(ap===undefined||bp===undefined)return ap===bp?0:ap===undefined?1:-1;
 return compare(ap.split(".").map(Number),bp.split(".").map(Number));
}
export function channelRelease(j,channel="stable"){
 const version=String(j?.tag_name||"").replace(/^rust-v/,"");
 if(j?.draft!==false||j?.prerelease!==(channel==="alpha")||j.tag_name!=="rust-v"+version||!channelMatches(version,channel))
  throw Error("官方响应不是可用的 Codex "+channel+" 版本");
 const assets=(j.assets||[]).filter(a=>a.name===CODEX_RELEASE_ASSET);
 if(assets.length!==1)throw Error("官方 "+channel+" 尚未提供 ARM64 musl 完整环境包");
 const a=assets[0],url="https://github.com/openai/codex/releases/download/"+j.tag_name+"/"+CODEX_RELEASE_ASSET;
 if(a.browser_download_url!==url||!Number.isSafeInteger(a.size)||a.size<=0||a.size>1024**3||!/^sha256:[a-f0-9]{64}$/.test(a.digest||""))
  throw Error("官方环境包的地址、大小或 SHA-256 信息不完整");
 return {version,channel,target:CODEX_RELEASE_TARGET,url,size:a.size,sha256:a.digest.slice(7),
  releaseUrl:"https://github.com/openai/codex/releases/tag/"+j.tag_name};
}
export const stableRelease=j=>channelRelease(j,"stable");
async function readOfficialJson(endpoint,signal,fetchImpl,limit=2*1024*1024){
 const response=await fetchImpl(endpoint,{signal,headers:{"accept":"application/json","user-agent":"CCCDroid-Codex-Updater"}});
 if(!response.ok)throw Error("检查官方 Codex 失败：HTTP "+response.status);
 if((response.url||endpoint)!==endpoint)throw Error("官方 Codex 版本接口重定向异常");
 let text="";const decoder=new TextDecoder();
 for await(const chunk of response.body){text+=decoder.decode(chunk,{stream:true});if(text.length>limit)throw Error("官方版本响应过大");}
 return JSON.parse(text+decoder.decode());
}
export async function fetchCodexRelease({signal,fetchImpl=fetch,channel="stable",version=null}={}){
 if(version!==null){
  if(!runtimeVersion(version))throw Error("Codex 版本号无效");
  const signal2=AbortSignal.any([AbortSignal.timeout(20000),...(signal?[signal]:[])]);
  const endpoint="https://api.github.com/repos/openai/codex/releases/tags/rust-v"+version;
  const r=channelRelease(await readOfficialJson(endpoint,signal2,fetchImpl),alphaVersion(version)?"alpha":"stable");
  if(r.version!==version)throw Error("官方发行与指定版本不一致");
  return r;
 }
 if(!["stable","alpha"].includes(channel))throw Error("Codex 更新频道无效");
 const combined=AbortSignal.any([AbortSignal.timeout(20000),...(signal?[signal]:[])]);
 let endpoint=CODEX_RELEASE_API;
 if(channel==="alpha"){
  // Follow OpenAI's published npm alpha tag, then verify its full GitHub package.
  // Avoid loading the enormous GitHub release history and its unrelated assets.
  const info=await readOfficialJson(CODEX_ALPHA_API,combined,fetchImpl,256*1024);
  if(info?.name!=="@openai/codex"||!alphaVersion(info.version))throw Error("官方 alpha 频道版本无效");
  endpoint="https://api.github.com/repos/openai/codex/releases/tags/rust-v"+info.version;
  const release=channelRelease(await readOfficialJson(endpoint,combined,fetchImpl),channel);
  if(release.version!==info.version)throw Error("官方 alpha 频道与发行包版本不一致");
  return release;
 }
 return channelRelease(await readOfficialJson(endpoint,combined,fetchImpl),channel);
}
export const fetchStableCodex=options=>fetchCodexRelease({...options,channel:"stable"});

let versionsCache=null,versionsAt=0,versionsJob=null;
export async function fetchCodexVersions({refresh=false,fetchImpl=fetch}={}){
 if(!refresh&&versionsCache&&Date.now()-versionsAt<10*60e3)return versionsCache;
 if(versionsJob)return versionsJob;
 versionsJob=(async()=>{
  const [refs,stable,alpha]=await Promise.all([
   readOfficialJson(CODEX_VERSION_REFS_API,AbortSignal.timeout(20000),fetchImpl),
   fetchCodexRelease({fetchImpl,channel:"stable"}),
   fetchCodexRelease({fetchImpl,channel:"alpha"}).catch(()=>null)
  ]);
  if(!Array.isArray(refs))throw Error("官方版本列表无效");
  const versions=[...new Set(refs.map(r=>String(r.ref||"").replace(/^refs\/tags\/rust-v/,"")).filter(v=>runtimeVersion(v)&&compareRuntimeVersions(v,"0.166.0")>=0))].sort((a,b)=>compareRuntimeVersions(b,a));
  for(const v of[stable.version,alpha?.version])if(v&&!versions.includes(v))versions.push(v);
  versions.sort((a,b)=>compareRuntimeVersions(b,a));
  versionsCache={ok:true,stable:stable.version,alpha:alpha?.version||"",versions,minimumVersion:"0.166.0"};versionsAt=Date.now();return versionsCache;
 })().finally(()=>{versionsJob=null;});return versionsJob;
}
