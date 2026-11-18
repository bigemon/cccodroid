import fs from "node:fs";
import {CFG} from "../config.mjs";
import {projectById,projectOfDir} from "../projects.mjs";
import {syncProjectSkillReuse} from "./project-skill-reuse.mjs";
import {getCodexSession} from "./store.mjs";
import {codexDiagnosticSource} from "./run.mjs";
import {agentClient} from "./agent.mjs";
import {listSkills} from "./skills.mjs";
export function resolveSkillScope({sid=null,projectId=null,scope=null}={}){
 if(scope!=null&&scope!=="global")return {status:400,message:"能力范围无效。"};
 if(scope==="global"&&(sid||projectId))return {status:400,message:"全局能力不能混用会话或项目范围。"};
 if(sid&&projectId)return {status:400,error:"ambiguous_scope",message:"请只指定会话或项目。"};
 const rec=sid?getCodexSession(sid):null,project=projectId?projectById(projectId):null;
 if(sid&&!rec)return {status:404,error:"unknown_session",message:"未找到对应的 Codex 会话。"};
 if(projectId&&!project)return {status:404,error:"unknown_project",message:"项目不存在。"};
 const cwd=scope==="global"?CFG.home:rec?.cwd||project?.path||CFG.workspace;
 try{if(!fs.statSync(cwd).isDirectory())throw new Error();}catch{return {status:409,error:"cwd_unavailable",message:"工作目录不可用，未切换到其他目录。"};}
 return {cwd,project:scope==="global"?null:project||(rec?projectOfDir(cwd):null)};
}
export async function codexSkills({sid=null,projectId=null,refresh=false}={}){
 const scope=resolveSkillScope({sid,projectId});if(scope.status)return scope;const {cwd}=scope;
 const {project}=scope;if(project)syncProjectSkillReuse(project.path);
 try{const client=codexDiagnosticSource(sid)?.client||await agentClient();return {backend:"codex",sessionId:sid,cwd,...await listSkills(client,cwd,{refresh})};}
 catch{return {status:502,error:"skills_unavailable",message:"技能清单暂不可用，请稍后重试。"};}
}
