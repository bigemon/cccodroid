import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
export const INSTRUCTION_MAX_BYTES=128*1024;
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const hash=text=>crypto.createHash("sha256").update(text).digest("hex");
function rootOf(cwd){
  let st;try{st=fs.lstatSync(cwd);}catch{fail(409,"项目目录不可用。");}
  if(st.isSymbolicLink()||!st.isDirectory())fail(409,"项目目录已变化，请重新检查项目路径。");
  return fs.realpathSync(cwd);
}
function readAt(root,name){
  const file=path.join(root,name);let stat;
  try{stat=fs.lstatSync(file);}catch(err){if(err.code==="ENOENT")return {name,target:name,text:"",exists:false,revision:"missing:"+name,bytes:0,linked:false};throw err;}
  let resolved;try{resolved=fs.realpathSync(file);}catch{fail(409,"指令链接不可用，请在文件浏览器检查。");}
  if(!resolved.startsWith(root+path.sep))fail(409,"指令链接指向项目外，请使用文件浏览器管理。");
  if(!fs.statSync(resolved).isFile())fail(409,"指令文件不是普通文件。");
  if(fs.statSync(resolved).size>INSTRUCTION_MAX_BYTES)fail(413,"指令文件超过 128 KiB，请使用文件浏览器编辑。");
  const text=fs.readFileSync(resolved,"utf8"),target=path.relative(root,resolved);
  return {name,target,text,exists:true,revision:hash(resolved+"\0"+text),bytes:Buffer.byteLength(text),linked:stat.isSymbolicLink()};
}
export function readProjectInstructions(cwd,backend="claude",{sharedFallback=true}={}){
  if(!["claude","codex"].includes(backend))fail(400,"未知的指令核心。");
  const root=rootOf(cwd);
  let entry;
  if(backend==="codex"){
    const override=readAt(root,"AGENTS.override.md"),base=override.text.trim()?null:readAt(root,"AGENTS.md");
    entry=override.text.trim()?override:base.text.trim()?base:sharedFallback?readAt(root,"CLAUDE.md"):base;
  }else entry=readAt(root,"CLAUDE.md");
  return {...entry,backend,path:path.join(root,entry.name),scope:"project-directory",shared:entry.target==="CLAUDE.md",
    activation:backend==="codex"?"new-thread":"core-managed"};
}
export function writeProjectInstructions(cwd,{backend="claude",text="",name,revision}={}){
  const current=readProjectInstructions(cwd,backend),root=rootOf(cwd);
  if(typeof text!=="string")fail(400,"指令内容无效。");
  if(Buffer.byteLength(text)>INSTRUCTION_MAX_BYTES)fail(413,"指令文件超过 128 KiB，请使用文件浏览器编辑。");
  if(backend==="codex"&&(!name||typeof revision!=="string"))fail(400,"请先读取 Codex 指令文件再保存。");
  if(name&&name!==current.name)fail(409,"指令优先级已变化，请重新打开项目后再编辑。");
  if(revision!=null&&revision!==current.revision)fail(409,"指令已被其他操作修改，请重新读取后再保存。");
  const target=path.join(root,current.target),tmp=path.join(path.dirname(target),"."+path.basename(target)+".tmp-"+crypto.randomUUID());
  try{
    // 清空只清内容，保留链接目标，避免共享指令链接变成断链。
    fs.writeFileSync(tmp,text&& !text.endsWith("\n")?text+"\n":text,{mode:0o600,flag:"wx"});
    const latest=readProjectInstructions(cwd,backend);
    if(latest.name!==current.name||latest.revision!==current.revision)fail(409,"指令已变化，请重新读取后再保存。");
    fs.renameSync(tmp,target);
  }finally{try{fs.unlinkSync(tmp);}catch{}}
  return {ok:true,...readProjectInstructions(cwd,backend)};
}
export function sharedDocFallbacks(response){
  const fallbacks=response?.config?.project_doc_fallback_filenames??[];
  if(!Array.isArray(fallbacks)||fallbacks.some(v=>typeof v!=="string"))throw new Error("invalid-project-doc-config");
  return [...new Set([...fallbacks,"CLAUDE.md"])];
}
