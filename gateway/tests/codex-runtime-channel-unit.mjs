import assert from "node:assert/strict";
import {CODEX_ALPHA_API,CODEX_RELEASE_ASSET,channelRelease,fetchCodexRelease,compareRuntimeVersions,runtimeVersion} from "../gw/codex/runtime-release.mjs";
const metadata=(version,preview=true)=>({tag_name:"rust-v"+version,draft:false,prerelease:preview,assets:[{name:CODEX_RELEASE_ASSET,size:123,digest:"sha256:"+"a".repeat(64),browser_download_url:"https://github.com/openai/codex/releases/download/rust-v"+version+"/"+CODEX_RELEASE_ASSET}]});
let n=0;async function check(name,fn){await fn();console.log("ok "+(++n)+" "+name);}
await check("稳定/预览版本独立校验，拒绝不受支持标签及目录写法",()=>{
 assert(runtimeVersion("0.171.0-alpha.11"));assert(runtimeVersion("0.170.0-alpha.4.1"));
 for(const version of["../0.1.0","0.1.0-beta.1","0.1.0-alpha.x","0.1.0-alpha.01"])assert(!runtimeVersion(version));
 assert.throws(()=>channelRelease(metadata("0.171.0-alpha.11"),"stable"));
 assert.throws(()=>channelRelease(metadata("0.169.0",false),"alpha"));
});
await check("预览号按数字排序，同主版本正式版大于预览版",()=>{
 assert(compareRuntimeVersions("0.171.0-alpha.11","0.171.0-alpha.9")>0);
 assert(compareRuntimeVersions("0.171.0","0.171.0-alpha.11")>0);
 assert(compareRuntimeVersions("0.171.0-alpha.1","0.169.0")>0);
});
await check("alpha 跟随官方 npm 标签并核对同版本 GitHub 完整包，不拉发布列表",async()=>{
 let calls=0;
 const result=await fetchCodexRelease({channel:"alpha",fetchImpl:async url=>{
  calls++;if(url===CODEX_ALPHA_API)return new Response(JSON.stringify({name:"@openai/codex",version:"0.171.0-alpha.11"}));
  assert.equal(url,"https://api.github.com/repos/openai/codex/releases/tags/rust-v0.171.0-alpha.11");return new Response(JSON.stringify(metadata("0.171.0-alpha.11")));
 }});
 assert.equal(result.version,"0.171.0-alpha.11");assert.equal(result.channel,"alpha");assert.equal(calls,2);
});
await check("预览标签与发行版本不符或缺少完整包时明确报错，不回退旧包",async()=>{
 for(const entry of[{...metadata("0.171.0-alpha.11"),assets:[]},metadata("0.171.0-alpha.10")])
  await assert.rejects(fetchCodexRelease({channel:"alpha",fetchImpl:async url=>new Response(JSON.stringify(url===CODEX_ALPHA_API?{name:"@openai/codex",version:"0.171.0-alpha.11"}:entry))}),/完整环境包|不一致/);
});
await check("alpha 仍拒绝任意下载地址、摘要缺失、无效频道元数据与未知频道",async()=>{
 assert.throws(()=>channelRelease({...metadata("0.171.0-alpha.11"),assets:[{...metadata("0.171.0-alpha.11").assets[0],digest:null}]},"alpha"));
 assert.throws(()=>channelRelease({...metadata("0.171.0-alpha.11"),assets:[{...metadata("0.171.0-alpha.11").assets[0],browser_download_url:"https://example.invalid/pkg"}]},"alpha"));
 await assert.rejects(fetchCodexRelease({channel:"alpha",fetchImpl:async()=>new Response("{}")}),/频道版本/);
 await assert.rejects(fetchCodexRelease({channel:"latest"}),/频道/);
});
console.log(n+"/"+n+" passed");
