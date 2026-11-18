import {agentClient} from "./agent.mjs";
import {codexConfig} from "./config.mjs";
import {resolveSkillScope} from "./skill-catalog.mjs";
import {listSkills,validateSkillRefs} from "./skills.mjs";
const writes=new Set();
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};

// 只写核心当前目录实际发现的技能路径，不接收通用配置键或任意文件内容。
export async function writeSkillEnabled(client,cwd,{name,path,enabled,expectedEnabled}){
 try{validateSkillRefs([{name,path}]);}catch{fail("技能选择无效，请重新检查。",400);}
 if(typeof enabled!=="boolean"||typeof expectedEnabled!=="boolean")fail("技能设置无效，请重新检查。",400);
 const key=JSON.stringify([client.codexHome,path]);
 if(writes.has(key))fail("技能设置正在保存，请稍后重试。");
 writes.add(key);
 try{
  const before=await listSkills(client,cwd,{refresh:true});
  if(before.truncated)fail("技能清单已截断，请缩小范围后再修改。");
  const selected=before.skills.find(s=>s.name===name&&s.path===path);
  if(!selected)fail("技能已移除或不属于当前目录，请重新检查。");
  if(selected.enabled!==expectedEnabled)fail("技能状态已变化，请重新检查后再修改。");
  if(selected.enabled===enabled)return {ok:true,enabled,requestedEnabled:enabled,changed:false};
  let result;
  try{result=await client.call("skills/config/write",{path,enabled},10000);}
  catch{fail("技能设置结果尚未核实，请重新检查后再操作。",502);}
  try{
   if(typeof result?.effectiveEnabled!=="boolean")throw new Error();
   const after=await listSkills(client,cwd,{refresh:true}),actual=after.skills.find(s=>s.name===name&&s.path===path);
   if(after.truncated||!actual||actual.enabled!==result.effectiveEnabled)throw new Error();
   return {ok:true,enabled:actual.enabled,requestedEnabled:enabled,changed:actual.enabled!==selected.enabled};
  }catch{fail("技能设置可能已保存，但重新检查未完成，请重新检查后再操作。",502);}
 }finally{writes.delete(key);}
}
export async function setCodexSkillEnabled(body){
 if([body.sessionId,body.projectId].some(v=>v!=null&&(typeof v!=="string"||!v)))fail("技能设置范围无效，请重新检查。",400);
 const scope=resolveSkillScope({sid:body.sessionId,projectId:body.projectId,scope:body.scope});
 if(scope.status)fail(scope.message,scope.status);
 const client=await agentClient(),cfg=codexConfig();
 if(client.bin!==cfg.bin||client.codexHome!==cfg.home)fail("Codex 配置已变化，请重启网关后再修改技能。");
 return {backend:"codex",...await writeSkillEnabled(client,scope.cwd,body)};
}
