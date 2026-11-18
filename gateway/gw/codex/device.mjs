// 复用 Android 原设备 MCP；不开启设备权限、不复制配置，不依赖 Claude 运行时。
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import {CFG,HERE} from "../config.mjs";

export function deviceStatus(timeoutMs=2000){
 // New clients expose the same-UID service in their private files directory.
 // Never probe the old global abstract socket: another process can own it.
 const socketPath=process.env.CCAPP_PRIV_SOCK||path.join(CFG.runtime,".priv.sock");
 if(!path.isAbsolute(socketPath))return Promise.resolve({ok:false});
 return new Promise(resolve=>{
  let data="",done=false;
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve(value);};
  const socket=net.connect({path:socketPath},()=>socket.write(JSON.stringify({op:"dev_status"})+"\n"));
  const timer=setTimeout(()=>finish({ok:false}),timeoutMs);
  socket.on("data",d=>{data+=d;if(data.length>65536)finish({ok:false});});
  socket.on("end",()=>{try{finish(JSON.parse(data));}catch{finish({ok:false});}});
  socket.on("error",()=>finish({ok:false}));
 });
}
// 只有应用自己注入的设备服务跟随宿主全部放行；不覆盖用户的普通 MCP/Apps 审批。
export function deviceApprovalBypass(approval,{device,mode}={}){
 return mode==="bypassPermissions"&&device?.state==="enabled"&&typeof device.name==="string"&&/^cccodroid_device_[a-f0-9]{8}$/.test(device.name)&&approval?.serverName===device.name;
}
export async function deviceMcp({script=path.join(HERE,"bin","device-mcp.mjs"),isolated=false,status=deviceStatus}={}){
 if(isolated||!fs.existsSync(script))return {state:"unavailable",args:[]};
 const value=await status();
 if(!value?.ok||!value.on)return {state:value?.ok?"disabled":"unavailable",args:[]};
 const name="cccodroid_device_"+crypto.randomBytes(4).toString("hex");
 // Native consent may wait 60s; device-mcp allows 70s. Keep the outer RPC budget above both.
 const config={command:process.execPath,args:[script],default_tools_approval_mode:"writes",required:false,tool_timeout_sec:90};
 const toml="{"+Object.entries(config).map(([k,v])=>k+"="+JSON.stringify(v)).join(",")+"}";
 return {state:"enabled",name,args:["-c","mcp_servers."+name+"="+toml]};
}
