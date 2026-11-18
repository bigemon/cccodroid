import {syncClaudeSkillReuse} from "./skill-reuse.mjs";
import fs from "node:fs";
import {resolveSkillScope} from "./skill-catalog.mjs";
import {syncProjectSkillReuse} from "./project-skill-reuse.mjs";
import { readProjectInstructions } from "../project-instructions.mjs";
import { codexConfig } from "./config.mjs";
import { codexDiagnosticSource } from "./run.mjs";
import { agentClient } from "./agent.mjs";
import {mcpManagementView} from "./mcp-config.mjs";
import { instructionConfig, skillInventory, mcpConfigured, readMcpInventory } from "./extensions-view.mjs";
const unavailable={state:"unavailable"};
const jobs=new Map();
function metadata(cwd,sharedFallback=true){
  try{const {name,target,exists,bytes,linked,shared,revision}=readProjectInstructions(cwd,"codex",{sharedFallback});
    return {state:"available",name,target,exists,bytes,linked,shared,revision,source:"disk-candidate",loaded:"unverified"};
  }catch{return {...unavailable};}
}
export async function codexExtensions({sid=null,projectId=null,scope=null,refresh=false}={}){
  if(scope==="thread"){
    if(!sid||projectId)return {status:400,message:"请指定一个 Codex 会话读取连接状态。"};
    const resolved=resolveSkillScope({sid});if(resolved.status)return resolved;
    const source=codexDiagnosticSource(sid),result={backend:"codex",scope:"thread",sessionId:sid,
      mcp:{state:"not_loaded",scope:"thread",servers:[]},canReloadMcp:!!source&&!source.snapshot.active&&!source.snapshot.taskIsolated&&!source.snapshot.runningCommands};
    if(source)try{result.mcp=await readMcpInventory(source.client,sid);}catch{result.mcp={state:"unavailable",scope:"thread",servers:[]};}
    return result;
  }
  const resolved=resolveSkillScope({sid,projectId,scope});
  if(resolved.status)return resolved;
  const {cwd,project}=resolved;
  const key=JSON.stringify([sid,cwd,scope,project?.id,refresh]);
  if(jobs.has(key))return jobs.get(key);
  const job=inspect({sid,cwd,scope,project,refresh});jobs.set(key,job);
  try{return await job;}finally{jobs.delete(key);}
}
async function inspect({sid,cwd,scope,project,refresh}){
  syncClaudeSkillReuse();
  let cwdAvailable=false;try{cwdAvailable=fs.statSync(cwd).isDirectory();}catch{}
  const source=sid?codexDiagnosticSource(sid):null;
  const projectReuse=project?{eligible:true,projectId:project.id,projectName:project.name,...syncProjectSkillReuse(project.path)}:{eligible:false};
  const result={backend:"codex",scope:scope==="global"?"global":"effective",sessionId:sid,cwd,cwdAvailable,projectSkillReuse:projectReuse,skills:{...unavailable},config:{...unavailable},mcpManagement:{...unavailable},
    mcp:{state:"not_loaded",scope:"thread",servers:[]},
    instructions:{local:metadata(cwd),global:metadata(codexConfig().home,false),loaded:"unverified",hostFallback:"CLAUDE.md",
      runtimeFallbacks:source?.snapshot.projectDocFallbacks||null},
    canReloadMcp:!!source&&!source.snapshot.active&&!source.snapshot.taskIsolated&&!source.snapshot.runningCommands,
    capturedAt:new Date().toISOString()};
  if(!cwdAvailable)return result;
  let client;
  try{client=source?.client||await agentClient();}catch{return result;}
  const reads=await Promise.allSettled([
    client.call("config/read",{cwd,includeLayers:true},10000),
    client.call("skills/list",{cwds:[cwd],forceReload:!!refresh},10000),
    source?readMcpInventory(client,sid):Promise.resolve(result.mcp),
  ]);
  if(reads[0].status==="fulfilled")try{
    result.config={state:"available",instructions:instructionConfig(reads[0].value),mcp:mcpConfigured(reads[0].value)};
    result.mcpManagement=mcpManagementView(reads[0].value,{cwd,codexHome:codexConfig().home});
  }catch{}
  if(reads[1].status==="fulfilled")try{result.skills=skillInventory(reads[1].value,cwd);}catch{}
  if(reads[2].status==="fulfilled")result.mcp=reads[2].value;
  else result.mcp={...unavailable,scope:"thread",servers:[]};
  if(scope==="global"){
    if(result.skills.state==="available")result.skills.skills=result.skills.skills.filter(s=>s.scope!=="repo");
    if(result.mcpManagement.state==="available")result.mcpManagement.servers=result.mcpManagement.servers.filter(s=>s.scope!=="project");
  }
  return result;
}
