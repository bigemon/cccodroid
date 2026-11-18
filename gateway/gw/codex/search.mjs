// 仅搜索宿主已保存的 Codex 用户/助手正文；不启动核心、不读取工具结果或核心私有 rollout。
import fs from "node:fs";
import path from "node:path";
import {CODEX_DIR,listCodexSessions} from "./store.mjs";

const cache=new Map();
const MAX_CHARS=4*1024*1024,MAX_ENTRIES=128;
let cachedChars=0;
const validId=id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,200}$/.test(id);
const stamp=st=>[st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs].join(":");
function drop(file){const old=cache.get(file);if(old)cachedChars-=old.text.length;cache.delete(file);}
function remember(file,entry){
 drop(file);
 if(entry.text.length>MAX_CHARS)return;
 cache.set(file,entry);cachedChars+=entry.text.length;
 while(cache.size>MAX_ENTRIES||cachedChars>MAX_CHARS)drop(cache.keys().next().value);
}
async function indexHistory(file){
 const handle=await fs.promises.open(file,"r");
 try{
  const before=await handle.stat();if(!before.isFile())throw new Error("Not a history file");
  const key=stamp(before),hit=cache.get(file);
  if(hit?.key===key){cache.delete(file);cache.set(file,hit);return hit;}
  drop(file);
  const data=JSON.parse(await handle.readFile("utf8"));
  if(!Array.isArray(data?.items))throw new Error("Invalid history");
  const parts=[];
  for(let i=0;i<data.items.length;i++){
   const item=data.items[i];
   if(item&&!item.isMeta&&["user","assistant"].includes(item.role)&&typeof item.text==="string")parts.push(item.text.replace(/\s+/g," ").trim());
   if(i%1000===999)await new Promise(r=>setImmediate(r));
  }
  const text=parts.filter(Boolean).join("\n"),entry={key,text,lower:text.toLowerCase(),complete:data.version===2?data.complete===true:data.items.length<2000};
  if(stamp(await handle.stat())===key)remember(file,entry);
  return entry;
 }finally{await handle.close();}
}
function match(title,entry,needle){
 const inTitle=title.toLowerCase().includes(needle);
 const i=entry.lower.indexOf(needle);
 if(!inTitle&&i<0)return null;
 let count=0,snippet="";
 if(i>=0){
  const a=Math.max(0,i-30),b=Math.min(entry.text.length,i+needle.length+60);
  snippet=(a?"…":"")+entry.text.slice(a,b).replace(/\n/g," ")+(b<entry.text.length?"…":"");
  for(let j=i;j>=0&&count<99;j=entry.lower.indexOf(needle,j+needle.length))count++;
 }
 return {inTitle,count,snippet};
}
export async function searchCodexSessions(needle,{names={},pins={}}={}){
 if(!needle)return {results:[],partial:false};
 const sessions=listCodexSessions().filter(s=>validId(s.id));
 const files=new Set(sessions.map(s=>path.join(CODEX_DIR,s.id+".json")));
 for(const file of cache.keys())if(!files.has(file))drop(file);
 const results=[];let partial=false;
 for(const session of sessions){
  const title=String(names[session.id]||session.title||"(无标题)");
  const file=path.join(CODEX_DIR,session.id+".json");
  let entry;
  try{entry=await indexHistory(file);if(!entry.complete)partial=true;}
  catch{drop(file);partial=true;entry={text:"",lower:""};}
  const hit=match(title,entry,needle);if(!hit)continue;
  results.push({...session,title,renamed:!!names[session.id],pinned:pins[session.id]||0,...hit});
 }
 return {results,partial};
}
