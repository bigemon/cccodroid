import {syncClaudeSkillReuse} from "./skill-reuse.mjs";
import path from "node:path";
const validName=v=>typeof v==="string"&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(v);
const validPath=v=>typeof v==="string"&&v.length<=4096&&path.isAbsolute(v)&&!v.includes("\0");
const short=(v,n=200)=>typeof v==="string"?v.slice(0,n):"";
export function skillNames(text){
 return [...new Set([...String(text||"").matchAll(/(?:^|\s)\$([A-Za-z0-9][A-Za-z0-9_-]{0,199})(?![A-Za-z0-9_/-])/g)].map(m=>m[1]))];
}
export function normalizeSkills(response,cwd){
 const entry=response?.data?.find?.(e=>e.cwd===cwd);
 if(!entry||!Array.isArray(entry.skills)||!Array.isArray(entry.errors))throw new Error("技能清单暂不可用，请稍后重试。");
 const skills=entry.skills.filter(s=>validName(s?.name)&&validPath(s?.path)).map(s=>({
  name:s.name,path:s.path,enabled:s.enabled===true,scope:["repo","user","system","admin"].includes(s.scope)?s.scope:"unknown",
  displayName:short(s.interface?.displayName),shortDescription:short(s.interface?.shortDescription||s.shortDescription)
 }));
 return {state:"available",source:"core-discovery",skills:skills.slice(0,200),truncated:skills.length>200,errorCount:entry.errors.length};
}
export async function listSkills(client,cwd,{refresh=false}={}){
 syncClaudeSkillReuse();
 try{return normalizeSkills(await client.call("skills/list",{cwds:[cwd],forceReload:refresh},10000),cwd);}
 catch{throw new Error("技能清单暂不可用，请稍后重试。");}
}
export function validateSkillRefs(refs){
 if(refs==null)return [];
 if(!Array.isArray(refs)||refs.length>16||refs.some(s=>!validName(s?.name)||!validPath(s?.path)))throw new Error("技能选择无效，请重新选择。");
 return refs.map(({name,path})=>({name,path}));
}
export async function skillInput(client,cwd,text,refs=[]){
 const chosen=validateSkillRefs(refs),names=skillNames(text);
 if(chosen.some(s=>!names.includes(s.name)))throw new Error("技能标记已改变，请重新选择技能。");
 if(!names.length)return [];
 const catalog=await listSkills(client,cwd,{refresh:true});
 if(catalog.truncated)throw new Error("技能清单过大，无法完整核验本次选择。");
 const result=[];
 for(const name of names){
  const matches=catalog.skills.filter(s=>s.name===name),pinned=chosen.filter(s=>s.name===name);
  if(new Set(pinned.map(s=>s.path)).size>1)throw new Error("同一技能名选择了多个路径，请重新选择。");
  const available=matches.filter(s=>s.enabled),selected=pinned.length?available.filter(s=>s.path===pinned[0].path):available;
  if(!matches.length&&!pinned.length)continue; // $HOME 等未知名称仍是普通文字，不冒充已选择的技能。
  if(!selected.length)throw new Error("技能 "+name+" 已停用、已移除或不属于当前目录，请重新选择。");
  const paths=[...new Set(selected.map(s=>s.path))];
  if(paths.length!==1)throw new Error("发现同名技能 "+name+"，请从技能菜单选择具体路径。");
  result.push({type:"skill",name,path:paths[0]});
 }
 if(result.length>16)throw new Error("一次最多选择 16 个技能。");
 return result;
}
export function submittedSkills(input){
 return (input||[]).filter(s=>s.type==="skill").map(({name,path})=>({name,path,evidence:"core-accepted-input"}));
}
