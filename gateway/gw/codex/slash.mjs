import fs from "node:fs";
import {CFG} from "../config.mjs";
import {projectById} from "../projects.mjs";
import {CODEX_OPERATIONS} from "./operation-lock.mjs";
import {codexModelsResponse,setCodexSessionModel} from "./catalog.mjs";
import {getCodexSession} from "./store.mjs";
import {agentClient,readRateLimits} from "./agent.mjs";
import {mapRateLimits} from "./model-view.mjs";
import {CODEX_COMMANDS,parseCodexCommand} from "./slash-commands.mjs";
export {CODEX_COMMANDS,parseCodexCommand};
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const fmt=v=>v!=null&&Number.isFinite(Number(v))?Number(v).toLocaleString("en-US"):"未知";
const mono=v=>"`"+String(v??"未设置").replaceAll("`","")+"`";
export async function codexSlash({text,sessionId=null,projectId=null,pin=null,attachments=[]}={}){
 if(typeof text!=="string"||(sessionId!=null&&typeof sessionId!=="string")||(projectId!=null&&typeof projectId!=="string"))fail("命令或会话参数无效。");
 const command=parseCodexCommand(text);
 if(!command)fail("请输入完整的斜杠命令。");
 const {name,arg}=command;
 if(attachments?.length)fail("此命令不接受附件，请先移除附件。");
 if(!CODEX_COMMANDS.some(c=>c.name===name))fail("Codex 尚未接入 /"+name+"；请使用 /help 查看可用命令。");
 const rec=sessionId?getCodexSession(sessionId):null;
 if(sessionId&&!rec)fail("未找到对应的 Codex 会话。",404);
 if(sessionId&&CODEX_OPERATIONS.has(sessionId))fail("会话正在操作中，请稍后重试。",409);
 const project=!sessionId&&projectId?projectById(projectId):null;
 if(!sessionId&&projectId&&!project)fail("项目不存在，未改用其他项目。",404);
 const cwd=rec?.cwd||project?.path||CFG.workspace;
 const out=value=>({backend:"codex",command:name,sessionId,...value});
 const noArgs=()=>{if(arg)fail("/"+name+" 暂不接受参数。");};
 if(name==="help"){noArgs();return out({text:CODEX_COMMANDS.map(c=>"/"+c.name+" — "+c.desc+(c.usage?"\n"+c.usage:"")).join("\n\n")});}
 if(["compact","review"].includes(name))fail("请在对话中发送 /"+name+"，由运行队列执行。");

 if(name==="login"){if(arg&&arg!=="device")fail("Codex 只支持设备码登录，请使用 /login 或 /login device。");return out({action:"login",text:"请在 Codex 账号设置中完成设备码登录。"});}
 if(["new","clear","rename"].includes(name))return out({text:"请在 App 界面执行 /"+name+"，会话与工作目录按界面操作处理。"});
 if(name==="autocompact"){
  if(arg)fail("尚未接入通过命令修改 Codex 自动压缩阈值；不会因这条命令关闭自动压缩，未修改任何配置。");
  const r=await (await agentClient()).call("config/read",{cwd,includeLayers:false},10000);
  const limit=r.config?.model_auto_compact_token_limit;
  return out({text:"自动压缩阈值："+(Number.isFinite(limit)?fmt(limit)+" tokens":"由 Codex 核心决定")+"。\n\n这是核心配置值；会话实际用量请用 /context 查看。"});
 }
 if(name==="context"){
  noArgs();const u=rec?.usage;
  return out({text:u?.context_tokens!=null?"最近一次核心报告的上下文：**"+fmt(u.context_tokens)+" / "+fmt(u.context_window)+" tokens**"+(u.pct_used!=null?"（"+u.pct_used+"%）":"")+"。\n\n压缩后尚未报告新用量时显示待更新，不将旧值当成当前值。":"尚未收到核心上下文用量，或正在等待压缩后的新数据。"});
 }
 if(name==="usage"){
  noArgs();const r=mapRateLimits(await readRateLimits());
  const windows=r.windows.map(w=>(w.label||w.id)+"：已用 "+w.usedPercent+"%"+(w.resetsAt?"，重置时间 "+new Date(w.resetsAt*1000).toISOString():""));
  return out({text:"Codex 订阅用量\n\n"+(windows.join("\n\n")||"核心尚未报告额度窗口。")+"\n\n额度窗口与当前对话上下文是不同统计。"});
 }
 if(name==="status"){
  noArgs();const model=await codexModelsResponse(sessionId,{projectId,model:pin?.model,effort:pin?.effort});
  return out({text:"核心：**Codex**\n\n所选模型："+mono(model.current||rec?.model)+"\n\n思考强度："+mono(model.effort||rec?.effort||"默认")+"\n\n工作目录："+mono(cwd)+(fs.existsSync(cwd)?"":"（目录不可用）")+"\n\n原生工具按只读声明判断；未声明只读的操作需要确认，计划模式拒绝这类批准请求。"});
 }
 const catalog=await codexModelsResponse(sessionId,{projectId,model:pin?.model,effort:pin?.effort});
 if(!catalog.available)fail("Codex 模型目录暂不可用，请稍后重试。",502);
 const models=catalog.models||[],current=models.find(m=>m.id===catalog.current);
 const commit=(patch,reset=false)=>{
  if(sessionId){
    setCodexSessionModel(sessionId,reset?{reset:true}:patch);
    const saved=getCodexSession(sessionId);
    if(!saved||reset&&(saved.model!==null||saved.effort!==null||saved.modelPicked!==false)
      ||!reset&&Object.entries(patch).some(([k,v])=>(saved[k]??null)!==(v===""?null:v)))
      fail("Codex 设置保存失败，请重新读取后再试。",500);
  }
  return {changed:true,patch,reset,scope:sessionId?"session":"new-conversation"};
 };
 if(name==="model"||name==="models"){
  if(!arg)return out({text:"当前模型："+mono(catalog.current)+"\n\n"+models.map(m=>mono(m.id)+(m.name?" — "+m.name:"")).join("\n\n")+(catalog.stale?"\n\n目录正在后台刷新。":"")+"\n\n使用 /model <完整模型名>；/model default 恢复默认。"});
  if(["default","reset"].includes(arg.toLowerCase()))return out({...commit({},true),text:"已恢复默认模型与思考强度；下一轮生效。"});
  const target=models.find(m=>m.id===arg);
  if(!target)fail("没有可用模型 "+arg+"；请用 /models 查看完整名称。");
  const levels=target.effort?.supported_levels||[],patch={model:target.id};
  if(catalog.effort&&levels.length&&!levels.includes(catalog.effort))patch.effort=target.effort.default_level||"";
  return out({...commit(patch),text:"已选择 "+mono(target.id)+"，下一轮生效。"+(!sessionId?"\n\n仅用于当前准备创建的对话。":"")});
 }
 if(name==="effort"){
  const levels=current?.effort?.supported_levels||[];
  if(!arg)return out({text:"思考强度："+mono(catalog.effort||"默认")+"\n\n可选档位："+(levels.map(mono).join(" / ")||"目录未报告")+"\n\n使用 /effort <档位>；/effort default 恢复默认。"});
  const reset=["default","reset"].includes(arg.toLowerCase());
  if(!reset&&!levels.includes(arg))fail("当前模型不支持该强度；可选："+levels.join(" / "));
  return out({...commit({effort:reset?"":arg}),text:"思考强度已设为 "+mono(reset?"默认":arg)+"，下一轮生效。"+(!sessionId?"\n\n仅用于当前准备创建的对话。":"")});
 }
 fail("Codex 尚未接入此命令。");
}
