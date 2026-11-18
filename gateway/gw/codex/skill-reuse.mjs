import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {CFG,log} from "../config.mjs";
import {SETTINGS} from "../settings-store.mjs";
import {codexConfig} from "./config.mjs";
import {writeCodexSettings} from "./settings-write.mjs";
const LINK_NAME="cccodroid-claude";
const source=()=>path.join(CFG.home,".claude","skills");
// 未设置的新安装和旧配置默认启用；明确保存的关闭选择始终优先。
const raw=()=>({enabled:true,links:[],...(SETTINGS.codex?.skillReuse||{})});
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
function stat(file){try{return fs.lstatSync(file);}catch(e){if(e.code==="ENOENT")return null;throw e;}}
const target=home=>path.join(home,"skills",LINK_NAME);
const matches=link=>{const file=target(link.home);return !!stat(file)?.isSymbolicLink()&&path.resolve(path.dirname(file),fs.readlinkSync(file))===link.source;};
function sourceReady(){try{return fs.statSync(source()).isDirectory();}catch(e){if(e.code==="ENOENT")return false;throw e;}}
const owned=()=>Array.isArray(raw().links)?raw().links.filter(l=>typeof l?.home==="string"&&path.isAbsolute(l.home)&&l.source===source()):[];
function location(){const home=codexConfig().home;return home?path.resolve(home):null;}
function diskTag(file){const s=stat(file);return !s?null:s.isSymbolicLink()?["link",fs.readlinkSync(file)]:["existing",s.dev,s.ino];}
function revision(){const home=location();return crypto.createHash("sha256").update(JSON.stringify([raw(),home,home?diskTag(target(home)):null])).digest("hex");}
export function claudeSkillReuse(){
 const home=location(),file=home?target(home):null,enabled=raw().enabled===true;
 let state="disabled";
 if(enabled){
  const s=file?stat(file):null;
  state=!home?"waiting-home":!sourceReady()?"waiting-source":s?owned().some(l=>l.home===home&&matches(l))?"active":"conflict":"pending";
 }
 return {backend:"codex",enabled,state,source:source(),target:file,revision:revision(),scope:"codex-user-skills",activation:"next-skill-discovery"};
}
function change(enabled){
 const before=raw(),home=location(),undo=[],links=[];
 try{
  let desired=null;
  if(enabled&&home){
   if(sourceReady()){
    const parent=path.join(home,"skills");
    fs.mkdirSync(parent,{recursive:true});
    const src=fs.realpathSync(source()),dst=path.join(fs.realpathSync(parent),LINK_NAME);
    if(src===path.dirname(dst)||dst.startsWith(src+path.sep)||src===dst||src.startsWith(dst+path.sep))fail("技能目录相互包含，无法创建共享链接。");
    desired={home,source:source()};
    const existing=stat(target(home)),tracked=owned().some(l=>l.home===home&&matches(l));
    if(existing&&!tracked)fail("共享位置已有目录或手动链接，已保留原内容；请先检查该位置。");
   }
  }
  for(const link of owned()){
   if(desired&&link.home===desired.home&&matches(link)){links.push(link);continue;}
   if(matches(link)){
    fs.unlinkSync(target(link.home));
    undo.push(()=>{if(!stat(target(link.home)))fs.symlinkSync(link.source,target(link.home),"dir");});
   }
  }
  if(desired&&!links.length){
   fs.symlinkSync(desired.source,target(home),"dir");links.push(desired);
   undo.push(()=>{if(matches(desired))fs.unlinkSync(target(home));});
  }
  const next={enabled,links};
  if(JSON.stringify(before)!==JSON.stringify(next)||!SETTINGS.codex?.skillReuse)writeCodexSettings({skillReuse:next});
 }catch(e){
  let restored=true;for(const restore of undo.reverse())try{restore();}catch{restored=false;}
  if(!restored)fail("共享设置未完成，链接恢复失败，请检查共享位置后重试。",502);
  if(e.status)throw e;fail("技能共享未完成，请检查目录权限后重试。",502);
 }
 return claudeSkillReuse();
}
export function setClaudeSkillReuse(body){
 if(!body||typeof body.enabled!=="boolean"||typeof body.revision!=="string"||!/^[a-f0-9]{64}$/.test(body.revision))fail("共享设置参数无效，请重新读取。",400);
 if(body.revision!==revision())fail("共享设置或目录已变化，请刷新后重试。");
 return {ok:true,...change(body.enabled)};
}
// 已启用后按需维护；不开轮询。失败只影响技能共享，不中断既有模型任务。
export function syncClaudeSkillReuse(){
 if(raw().enabled!==true)return;
 try{return change(true);}catch(e){log("[codex] "+e.message);return {enabled:true,state:"error",message:e.message};}
}
