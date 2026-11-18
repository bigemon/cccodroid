import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {execFile} from "node:child_process";
// Read the configured program's version without loading its account/session directory.
export async function configuredCodexVersion(bin,{env=process.env,signal}={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),"codex-version-"));
 try{
  const text=await new Promise((resolve,reject)=>execFile(bin,["--version"],{
   cwd:home,env:{...env,HOME:home,CODEX_HOME:home},signal,timeout:8000,maxBuffer:65536
  },(error,stdout)=>error?reject(Error("当前 Codex 程序版本读取失败")):resolve(stdout.trim())));
  const match=/^codex-cli ([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(text);
  if(!match)throw Error("当前程序没有返回可识别的 Codex 版本");
  return match[1];
 }finally{fs.rmSync(home,{recursive:true,force:true});}
}
