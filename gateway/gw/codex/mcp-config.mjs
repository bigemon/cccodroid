import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const object=v=>v&&typeof v==="object"&&!Array.isArray(v);
const own=(o,k)=>object(o)&&Object.hasOwn(o,k);
const canonical=p=>{try{return fs.realpathSync(p);}catch{return path.resolve(p);}};
export const managedMcpName=name=>typeof name==="string"&&name.length>0&&name.length<=200&&!/[\0-\x1f\x7f]/.test(name);
const internal=name=>name==="codex_apps"||/^cccodroid_/.test(name);
const ordered=v=>Array.isArray(v)?v.map(ordered):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
const hash=v=>crypto.createHash("sha256").update(JSON.stringify(ordered(v))).digest("hex");
export function mcpConfigEntries(response,{cwd,codexHome}){
 const all=response?.config?.mcp_servers??{};
 if(!object(all))throw new Error("Invalid MCP configuration");
 const layers=Array.isArray(response.layers)?response.layers.filter(l=>l&&l.disabledReason==null):[];
 const entries=Object.entries(all),servers=entries.slice(0,200).map(([name,settings])=>{
  const enabled=settings?.enabled!==false;
  const definitions=layers.filter(l=>own(l.config?.mcp_servers,name));
  const layer=definitions.find(l=>own(l.config.mcp_servers[name],"enabled"))||definitions[0];
  let file=null,scope=layer?.name?.type||"unknown",reason="此配置来源暂不支持界面修改。";
  if(internal(name)){scope="host";reason="这是内置工具连接，由应用管理。";}
  else if(managedMcpName(name)&&object(settings)&&layer&&typeof layer.version==="string"&&layer.version){
   if(layer.name.type==="user"&&layer.name.profile==null&&typeof layer.name.file==="string"&&canonical(layer.name.file)===canonical(path.join(codexHome,"config.toml"))){
    file=canonical(layer.name.file);scope="user";reason=null;
   }else if(layer.name.type==="project"&&typeof layer.name.dotCodexFolder==="string"&&canonical(layer.name.dotCodexFolder)===canonical(path.join(cwd,".codex"))){
    scope="project";reason="此开关由项目配置控制，暂不支持在此修改。";
   }
  }
  return {name,enabled,writable:!!file,scope,reason,revision:file?hash([canonical(codexHome),cwd,name,file,layer.version,enabled,settings]):null,
   file,version:file?layer.version:null};
 });
 return {state:"available",truncated:entries.length>200,servers};
}
export function mcpManagementView(response,scope){
 const result=mcpConfigEntries(response,scope);
 return {...result,servers:result.servers.map(({file,version,...row})=>row)};
}
