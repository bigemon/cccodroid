// 全局 Markdown 只建立受管文件链接，不改 Claude 源文或用户自有 Codex 指令。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {CFG,log} from "../config.mjs";
import {SETTINGS} from "../settings-store.mjs";
import {codexConfig} from "./config.mjs";
import {writeCodexSettings} from "./settings-write.mjs";
const source=()=>path.join(CFG.home,".claude","CLAUDE.md");
const raw=()=>({enabled:true,links:[],...(SETTINGS.codex?.instructionReuse||{})});
const home=()=>{const h=codexConfig().home;return h?path.resolve(h):null;};
const target=h=>path.join(h,"AGENTS.md");
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
function stat(file){try{return fs.lstatSync(file);}catch(e){if(e.code==="ENOENT")return null;throw e;}}
function available(){try{return fs.statSync(source()).isFile();}catch(e){if(["ENOENT","ENOTDIR"].includes(e.code))return false;throw e;}}
const matches=l=>{const s=stat(target(l.home));return !!s?.isSymbolicLink()&&path.resolve(l.home,fs.readlinkSync(target(l.home)))===l.source;};
const owned=()=>Array.isArray(raw().links)?raw().links.filter(l=>typeof l?.home==="string"&&path.isAbsolute(l.home)&&l.source===source()):[];
function tag(file){const s=stat(file);return !s?null:s.isSymbolicLink()?["link",fs.readlinkSync(file)]:["existing",s.dev,s.ino,s.size,s.mtimeMs];}
function revision(){const h=home();return crypto.createHash("sha256").update(JSON.stringify([raw(),h,h?tag(target(h)):null])).digest("hex");}
function overridden(h){try{return fs.statSync(path.join(h,"AGENTS.override.md")).isFile()&&fs.readFileSync(path.join(h,"AGENTS.override.md"),"utf8").trim().length>0;}catch{return false;}}
export function claudeInstructionReuse(){
 const h=home(),enabled=raw().enabled===true,dst=h?target(h):null;let state="disabled";
 if(enabled){const s=dst?stat(dst):null;state=!h?"waiting-home":s&&!owned().some(l=>l.home===h&&matches(l))?"preserved":!available()?"waiting-source":s?"active":"pending";if(h&&overridden(h))state="overridden";}
 return {backend:"codex",enabled,state,source:source(),target:dst,revision:revision(),scope:"codex-global-instructions",activation:"new-thread"};
}
function change(enabled){
 const before=raw(),h=home(),undo=[],links=[];let desired=null;
 try{
  if(enabled&&h&&available()){
   const s=stat(target(h));
   if(!s||owned().some(l=>l.home===h&&matches(l)))desired={home:h,source:source()};
  }
  for(const link of owned()){
   if(desired&&link.home===desired.home&&matches(link)){links.push(link);continue;}
   if(matches(link)){fs.unlinkSync(target(link.home));undo.push(()=>{if(!stat(target(link.home)))fs.symlinkSync(link.source,target(link.home));});}
  }
  if(desired&&!links.length){
   fs.mkdirSync(h,{recursive:true});fs.symlinkSync(desired.source,target(h));links.push(desired);
   undo.push(()=>{if(matches(desired))fs.unlinkSync(target(h));});
  }
  const next={enabled,links};
  if(JSON.stringify(before)!==JSON.stringify(next)||!SETTINGS.codex?.instructionReuse)writeCodexSettings({instructionReuse:next});
 }catch(e){
  let restored=true;for(const f of undo.reverse())try{f();}catch{restored=false;}
  if(!restored)fail("指令共享未完成，链接恢复失败，请检查后重试。",502);
  fail("全局指令共享未完成，请检查目录权限后重试。",502);
 }
 return claudeInstructionReuse();
}
export function setClaudeInstructionReuse(body){
 if(!body||typeof body.enabled!=="boolean"||typeof body.revision!=="string"||!/^[a-f0-9]{64}$/.test(body.revision))fail("共享设置参数无效，请重新读取。",400);
 if(body.revision!==revision())fail("共享设置或目录已变化，请刷新后重试。");
 return {ok:true,...change(body.enabled)};
}
export function syncClaudeInstructionReuse(){
 if(raw().enabled!==true)return;
 try{return change(true);}catch(e){log("[codex] "+e.message);return {enabled:true,state:"error",message:e.message};}
}
