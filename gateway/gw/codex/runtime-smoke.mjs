import fs from "node:fs";
import path from "node:path";
import {AppServerClient} from "./rpc.mjs";
import {DEFAULT_SERVER_ARGS} from "./session.mjs";
// No account, model turn, or user configuration is used during the compatibility probe.
export async function probeCodexRuntime(bin,{signal,env,staging}){
 const home=fs.mkdtempSync(path.join(staging,".smoke-"));
 const client=new AppServerClient({bin,codexHome:home,cwd:home,extraEnv:{...env,CODEX_HOME:home,HOME:home},
  serverArgs:DEFAULT_SERVER_ARGS,label:"codex-runtime-probe"});
 const abort=()=>client.dispose().catch(()=>{});
 try{
  signal.throwIfAborted();signal.addEventListener("abort",abort,{once:true});client.start();
  await client.call("initialize",{clientInfo:{name:"cccodroid_runtime_check",version:"1.0.0"},
   capabilities:{experimentalApi:true,requestAttestation:false}},15000);
  client.notify("initialized",{});
  const config=await client.call("config/read",{includeLayers:false},10000);
  if(!config||typeof config.config!=="object")throw Error("Codex App Server 配置接口不兼容");
  signal.throwIfAborted();
 }finally{
  signal.removeEventListener("abort",abort);await client.dispose().catch(()=>{});
  fs.rmSync(home,{recursive:true,force:true});
 }
}
