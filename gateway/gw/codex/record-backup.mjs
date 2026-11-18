// App 记录备份；不复制 CODEX_HOME、登录凭据、原生数据库或项目文件。
import fs from "node:fs";
import path from "node:path";
import {CODEX_DIR} from "./store.mjs";
import {validCodexMode} from "./permissions.mjs";

const fail=()=>{throw new Error("Codex 会话记录备份格式无效。");};
export const backupId=id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,200}$/.test(id)&&!["__proto__","constructor","prototype"].includes(id);
function historyOf(data,id){
 let history;try{history=JSON.parse(data.toString("utf8"));}catch{fail();}
 if(!history||![undefined,1,2].includes(history.version)||!Array.isArray(history.items)||(history.id!=null&&history.id!==id))fail();
 if(history.items.some(m=>!m||typeof m!=="object"||Array.isArray(m)||typeof m.role!=="string"||(m.text!=null&&typeof m.text!=="string")))fail();
 return history;
}
function recordOf(value,id){
 if(!backupId(id)||!value||typeof value!=="object"||Array.isArray(value)||value.id!==id||(value.threadId!=null&&value.threadId!==id)||typeof value.cwd!=="string"||!path.isAbsolute(value.cwd))fail();
 const record={id,threadId:id,backend:"codex",cwd:value.cwd};
 for(const key of ["title","model","effort","permissionMode","createdAt","updatedAt","parentId","forkTurnId"]){
  const v=value[key];if(v==null){if(key==="model"||key==="effort")record[key]=null;continue;}
  if(typeof v!=="string"||v.length>(key==="title"?500:300))fail();record[key]=v;
 }
 if(record.permissionMode&&!validCodexMode(record.permissionMode))fail();
 record.modelPicked=value.modelPicked===true;
 if(value.hostTools!=null){if(!Array.isArray(value.hostTools)||value.hostTools.some(v=>typeof v!=="string"||v.length>200))fail();record.hostTools=value.hostTools;}
 record.createdAt ||= new Date().toISOString();record.updatedAt ||= record.createdAt;
 return record;
}
export function exportCodexRecord(value,{title,renamed,pinned}){
 const record=recordOf(value,value.id),file=path.join(CODEX_DIR,value.id+".json"),data=fs.readFileSync(file),history=historyOf(data,value.id);
 const markdown="# "+String(title||record.title||"Codex")+"\n\n"+
  history.items.filter(m=>["user","assistant"].includes(m.role)&&!m.isMeta&&typeof m.text==="string").map(m=>"## "+(m.role==="user"?"User":"Assistant")+"\n\n"+m.text).join("\n\n")+"\n";
 return {entry:{id:record.id,backend:"codex",title:String(title||record.title||"Codex"),renamed:!!renamed,pinned:pinned||0,cwd:record.cwd,mtime:fs.statSync(file).mtimeMs,scope:"app-records",record},
  files:[{name:"codex/"+record.id+".json",data},{name:"codex/"+record.id+".md",data:markdown}]};
}
export function prepareCodexRecord(entry,data){
 if(entry.scope!=="app-records"||!data)fail();
 const record=recordOf(entry.record,entry.id);historyOf(data,record.id);
 if((entry.title!=null&&typeof entry.title!=="string")||(entry.pinned!=null&&(!Number.isFinite(entry.pinned)||entry.pinned<0)))fail();
 if(entry.mtime!=null&&(!Number.isFinite(entry.mtime)||entry.mtime<0||!Number.isFinite(new Date(entry.mtime).getTime())))fail();
 return {record:{...record,recordBackup:true,usage:null,plan:null,subagents:[]},data,
  title:typeof entry.title==="string"?entry.title.slice(0,120):"",renamed:entry.renamed===true,pinned:entry.pinned||0,
  mtime:Number.isFinite(entry.mtime)&&entry.mtime>0?entry.mtime:null};
}
