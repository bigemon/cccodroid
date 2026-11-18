// 只按需维护当前项目；全局默认开启，显式项目选择优先，单项技能仍由核心用户配置管理。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {log} from "../config.mjs";
import {SETTINGS} from "../settings-store.mjs";
import {writeCodexSettings} from "./settings-write.mjs";
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
const entries=()=>Array.isArray(SETTINGS.codex?.projectSkillReuse?.entries)?SETTINGS.codex.projectSkillReuse.entries:[];
const modes=["inherit","on","off"];
const entry=root=>entries().find(e=>e?.root===root)||{root,mode:"inherit",managed:false};
const modeOf=s=>modes.includes(s.mode)?s.mode:typeof s.enabled==="boolean"?(s.enabled?"on":"off"):"inherit";
const automatic=()=>SETTINGS.codex?.projectSkillReuse?.autoEnabled!==false;
const isEnabled=mode=>mode==="inherit"?automatic():mode==="on";
const digest=v=>crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function projectSkillAutomation(){const enabled=automatic();return {backend:"codex",enabled,revision:digest(["project-skill-automation",enabled]),activation:"next-project-check"};}
export function setProjectSkillAutomation(body){
 if(!body||typeof body.enabled!=="boolean"||typeof body.revision!=="string")fail("项目自动共享设置无效，请重新检查。",400);
 if(body.revision!==projectSkillAutomation().revision)fail("项目自动共享设置已变化，请重新检查。");
 writeCodexSettings({projectSkillReuse:{...(SETTINGS.codex?.projectSkillReuse||{}),autoEnabled:body.enabled}});
 return {ok:true,...projectSkillAutomation()};
}
function stat(file){try{return fs.lstatSync(file);}catch(e){if(e.code==="ENOENT")return null;throw e;}}
function rootOf(value){
 try{const root=fs.realpathSync(value);if(!fs.statSync(root).isDirectory())throw Error();return root;}
 catch{fail("项目目录不可用，请重新检查。");}
}
const source=root=>path.join(root,".claude","skills");
const target=root=>path.join(root,".agents","skills","cccodroid-claude");
function parents(root,create=false){
 for(const part of [".agents",".agents/skills"]){
  const dir=path.join(root,part),s=stat(dir);
  if(s&&(s.isSymbolicLink()||!s.isDirectory()))return false;
  if(!s&&create)fs.mkdirSync(dir);
 }
 return true;
}
function matches(root){
 if(!parents(root))return false;
 const s=stat(target(root));return !!s?.isSymbolicLink()&&path.resolve(path.dirname(target(root)),fs.readlinkSync(target(root)))===source(root);
}
function ready(root){try{return fs.statSync(source(root)).isDirectory();}catch(e){if(["ENOENT","ENOTDIR"].includes(e.code))return false;throw e;}}
function tag(file){const s=stat(file);return !s?null:s.isSymbolicLink()?["link",fs.readlinkSync(file)]:[s.dev,s.ino,s.isDirectory()?"directory":"file"];}
function revision(root){
 const s=fs.statSync(root),safe=parents(root);
 return crypto.createHash("sha256").update(JSON.stringify([root,s.dev,s.ino,automatic(),entry(root),tag(path.join(root,".agents")),safe?tag(path.join(root,".agents","skills")):"blocked",safe?tag(target(root)):"blocked"])).digest("hex");
}
export function projectSkillReuse(value){
 const root=rootOf(value),saved=entry(root),mode=modeOf(saved),enabled=isEnabled(mode),safe=parents(root),dst=safe?stat(target(root)):null,managed=saved.managed===true&&safe&&matches(root);
 const state=!safe?"blocked":dst&&!managed?"preserved":!enabled?"disabled":!ready(root)?"waiting-source":managed?"active":"pending";
 return {backend:"codex",scope:"project-skills",root,source:source(root),target:target(root),mode,autoEnabled:automatic(),enabled,managed,state,revision:revision(root),writable:true,activation:"next-skill-discovery"};
}
function change(root,mode,{explicit=false}={}){
 const enabled=isEnabled(mode),old=entry(root),undo=[];let managed=old.managed===true&&matches(root);
 try{
  if(enabled){
   if(!parents(root))fail("项目技能目录是文件或链接，未修改；请在文件浏览器检查。");
   const existing=stat(target(root));if(existing&&!managed)fail("项目共享位置已有目录或手动链接，已保留，请先检查。");
   if(ready(root)){
    const src=fs.realpathSync(source(root)),dst=target(root);
    if(src===path.dirname(dst)||src===dst||dst.startsWith(src+path.sep)||src.startsWith(dst+path.sep))fail("技能目录相互包含，无法创建共享链接。");
    parents(root,true);
    if(!managed){
     fs.symlinkSync(path.relative(path.dirname(dst),source(root)),dst,"dir");managed=true;
     undo.push(()=>{if(matches(root))fs.unlinkSync(dst);});
    }
   }else if(managed){
    const oldTarget=fs.readlinkSync(target(root));fs.unlinkSync(target(root));managed=false;
    undo.push(()=>{if(parents(root)&&!stat(target(root)))fs.symlinkSync(oldTarget,target(root),"dir");});
   }
  }else if(managed){
   const oldTarget=fs.readlinkSync(target(root));fs.unlinkSync(target(root));managed=false;
   undo.push(()=>{if(parents(root)&&!stat(target(root)))fs.symlinkSync(oldTarget,target(root),"dir");});
  }
  const next={root,mode,managed},exists=entries().some(e=>e?.root===root);
  if((explicit||exists||managed)&&(JSON.stringify(old)!==JSON.stringify(next)||!exists))
   writeCodexSettings({projectSkillReuse:{...(SETTINGS.codex?.projectSkillReuse||{}),entries:[...entries().filter(e=>e?.root!==root),next]}});
 }catch(e){
  let restored=true;for(const f of undo.reverse())try{f();}catch{restored=false;}
  if(!restored)fail("项目共享未完成，链接恢复失败，请检查后重试。",502);
  if(e.status)throw e;fail("项目技能共享未完成，请检查目录权限后重试。",502);
 }
 return projectSkillReuse(root);
}
export function setProjectSkillReuse(value,body){
 const mode=body?.mode??(typeof body?.enabled==="boolean"?(body.enabled?"on":"off"):null);
 if(!modes.includes(mode)||body.mode!=null&&body.enabled!=null||typeof body.revision!=="string"||!/^[a-f0-9]{64}$/.test(body.revision))fail("项目共享设置无效，请重新检查。",400);
 const root=rootOf(value);
 if(body.revision!==revision(root))fail("项目或共享目录已变化，请重新检查后再保存。");
 return {ok:true,...change(root,mode,{explicit:true})};
}
export function syncProjectSkillReuse(value){
 try{const d=projectSkillReuse(value);return change(d.root,d.mode);}
 catch(e){
  log("[codex] 项目技能共享："+e.message);
  // 自动维护冲突时仍保留项目选择入口，用户可以单独关闭而不必删除手工文件。
  try{const d=projectSkillReuse(value);return {...d,state:["preserved","blocked"].includes(d.state)?d.state:"unavailable"};}
  catch{return {backend:"codex",scope:"project-skills",state:"unavailable",writable:false};}
 }
}
