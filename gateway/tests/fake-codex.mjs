#!/usr/bin/env node
// 离线测试用的假 Codex App Server（P6-B1 §9 "离线 Mock 与录制事件回放"）
//
// 只实现 Gateway 用到的方法：initialize / initialized / account/read /
// thread/start | resume / turn/start | interrupt，并按真实时序发通知与 item/tool/call。
// 不联网、不读任何凭据。

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

if(process.argv.includes("--version")){console.log("codex-cli 0.169.0");process.exit(0);}

const rl = readline.createInterface({ input: process.stdin });
let nextServerReq = 900;
const pending = new Map();  // 服务端发起的请求 id → resolve

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const reply = (id, result) => send({ id, result });
const fullTurnItems=new Map();
const notify = (method, params) => {
  if(process.env.FAKE_FULL_TURNS==="1"&&method==="item/completed"&&params.item&&fullTurnItems.has(params.turnId))fullTurnItems.get(params.turnId).push(params.item);
  send({ method, params });
};
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerReq++;
    pending.set(id, resolve);
    send({ id, method, params });
  });

let threadSeq = 0;
const threads = new Map();
const autoFlag=process.argv.find(v=>/^mcp_servers\.cccodroid_host_[a-z0-9]+=/.test(v));
const readFlag=process.argv.find(v=>/^mcp_servers\.cccodroid_reads_[a-z0-9]+=/.test(v)),readConfig={};
const readServer=readFlag?.slice("mcp_servers.".length,readFlag.indexOf("="));
if(readFlag)for(const m of readFlag.matchAll(/([a-z_]+)=("(?:[^"\\]|\\.)*"|true|false|[0-9]+)/g))readConfig[m[1]]=JSON.parse(m[2]);
async function readCall(name,args,meta=null){
 const r=await fetch(readConfig.url,{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+process.env[readConfig.bearer_token_env_var]},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args,...(meta?{_meta:meta}:{})}})});return r.json();
}
const autoServer=autoFlag?.slice("mcp_servers.".length,autoFlag.indexOf("=")),autoConfig={};
if(autoFlag)for(const m of autoFlag.matchAll(/([a-z_]+)=("(?:[^"\\]|\\.)*"|true|false|[0-9]+)/g))autoConfig[m[1]]=JSON.parse(m[2]);
async function autoCall(method,params={},id=1){
 const r=await fetch(autoConfig.url,{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+process.env[autoConfig.bearer_token_env_var]},body:JSON.stringify({jsonrpc:"2.0",id,method,params})});return r.json();
}
const activeTurns = new Map();
const agentDbFile=()=>path.join(process.env.CODEX_HOME,"fake-agent-control.json");
const agentDb=()=>{try{return JSON.parse(fs.readFileSync(agentDbFile(),"utf8"));}catch{return {};}};
const saveAgentDb=db=>fs.writeFileSync(agentDbFile(),JSON.stringify(db));
const noteAgentRpc=(method,p)=>fs.appendFileSync(path.join(process.env.CODEX_HOME,"fake-agent-rpcs.jsonl"),JSON.stringify({method,params:p,pid:process.pid})+"\n");



const managementFile=()=>path.join(process.env.CODEX_HOME,"fake-mcp-management.json");
function managementState(){try{return JSON.parse(fs.readFileSync(managementFile(),"utf8"));}catch{return null;}}
const managementVersion=value=>"sha256:"+crypto.createHash("sha256").update(JSON.stringify(value||{})).digest("hex");
function managementConfig(cwd){
 const state=managementState(),user=state.user||{},project=state.projects?.[cwd]||{},runtime={};
 for(const name of [readServer,autoServer].filter(Boolean))runtime[name]={enabled:true,command:"HOST_CONNECTION",default_tools_approval_mode:"writes"};
 const merged=Object.fromEntries([...new Set([...Object.keys(user),...Object.keys(project),...Object.keys(runtime)])].map(name=>[name,{...(user[name]||{}),...(project[name]||{}),...(runtime[name]||{})}]));
 return {config:{model:"gpt-fake",model_reasoning_effort:"low",project_doc_fallback_filenames:["CLAUDE.md"],project_doc_max_bytes:32768,apps:{},mcp_servers:merged},origins:{},layers:[
 {name:{type:"sessionFlags"},version:"runtime",disabledReason:null,config:{mcp_servers:runtime}},
 ...(Object.keys(project).length?[{name:{type:"project",dotCodexFolder:cwd+"/.codex"},version:managementVersion(project),disabledReason:null,config:{mcp_servers:project}}]:[]),
 {name:{type:"user",file:path.join(process.env.CODEX_HOME,"config.toml"),profile:null},version:managementVersion(user),disabledReason:null,config:{mcp_servers:user}}
 ]};
}
const managementEnabled=cwd=>Object.fromEntries(Object.entries(managementConfig(cwd).config.mcp_servers).map(([name,s])=>[name,s.enabled!==false]));
async function managementRpc(msg,p){
 let state=managementState();if(!state)return false;const method=msg.method;
 if(["thread/unsubscribe","thread/loaded/list","config/mcpServer/reload","config/value/write"].includes(method))fs.appendFileSync(path.join(process.env.CODEX_HOME,"fake-mcp-management-rpcs.jsonl"),JSON.stringify({method,threadId:p.threadId||null,...(method==="config/value/write"?{keyPath:p.keyPath,value:p.value,filePath:p.filePath,expectedVersion:p.expectedVersion}:{})})+"\n");
 const error=(message,data)=>send({id:msg.id,error:{code:-32600,message,data}});
 if(method==="config/value/write"){
  if(state.control?.writeDelay)await sleep(state.control.writeDelay);
  state=managementState();
  if(state.control?.writeReject){error("SECRET_WRITE_ERROR");return true;}
  if(state.control?.writeConflict||p.expectedVersion!==managementVersion(state.user)){error("config changed",{config_write_error_code:"configVersionConflict"});return true;}
  const m=p.keyPath?.match(/^mcp_servers\.(.+)\.enabled$/);let name;try{name=JSON.parse(m?.[1]);}catch{}
  if(!state.user?.[name]||p.filePath!==path.join(process.env.CODEX_HOME,"config.toml")||typeof p.value!=="boolean"){error("SECRET_BAD_CONFIG");return true;}
  state.user[name].enabled=p.value;fs.writeFileSync(managementFile(),JSON.stringify(state));
  reply(msg.id,state.control?.badWriteResponse?{}:{status:"ok",filePath:p.filePath,version:managementVersion(state.user),overriddenMetadata:null});return true;
 }
 if(method==="thread/loaded/list"){reply(msg.id,{data:[...threads.keys(),...(state.control?.otherLoaded||[])],nextCursor:null});return true;}
 if(method==="thread/unsubscribe"){threads.delete(p.threadId);reply(msg.id,{status:"unsubscribed"});return true;}
 if(method==="config/mcpServer/reload"){
  if(state.control?.reloadDelay)await sleep(state.control.reloadDelay);
  if(state.control?.reloadReject){error("SECRET_RELOAD_ERROR");return true;}
  for(const t of threads.values())t.mcpEnabled=managementEnabled(t.cwd);
  reply(msg.id,{});return true;
 }
 return false;
}

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // 客户端对我们发起的请求的响应
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const r = pending.get(msg.id);
    if (r) {
      pending.delete(msg.id);
      r(msg);
    }
    return;
  }
  if (!msg.method) return;

  const p = msg.params || {};
  if(process.env.FAKE_HISTORY_LIFECYCLE_LOG==="1")fs.appendFileSync(path.join(process.env.CODEX_HOME,"fake-history-lifecycle.jsonl"),JSON.stringify({pid:process.pid,method:msg.method,threadId:p.threadId||null,clientName:p.clientInfo?.name||null,itemsView:p.itemsView||null})+"\n");
  if(await managementRpc(msg,p))return;
  switch (msg.method) {
    case "initialize":
      if(process.env.FAKE_INIT_DELAY)await sleep(Number(process.env.FAKE_INIT_DELAY));
      return reply(msg.id, {
        userAgent: "fake-codex/0.0.0",
        codexHome: process.env.CODEX_HOME || "/tmp",
        platformFamily: "unix",
        platformOs: "linux",
      });

    case "initialized":
      return;

    case "collaborationMode/list":
      return reply(msg.id, { data: [{ mode: "plan" }, { mode: "default" }] });

    case "skills/list": {
      if(process.env.FAKE_SKILLS_UNSUPPORTED==="1")return send({id:msg.id,error:{code:-32601,message:"SECRET_SKILL_ERROR"}});
      let extra=[];try{extra=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,"fake-skills.json")));}catch{}
      let states={};try{states=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,"fake-skill-config.json")));}catch{}
      let control={};try{control=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,"fake-skill-write-control.json")));}catch{}
      if(control.listFailure&&Object.keys(states).length)return send({id:msg.id,error:{code:-32600,message:"SECRET_LIST_FAILURE"}});
      return reply(msg.id,{data:(p.cwds||[]).map(cwd=>({cwd,skills:[{name:"fixture-skill",path:cwd+"/.agents/skills/fixture/SKILL.md",scope:"repo",enabled:true,description:"SECRET_SKILL_DESCRIPTION",dependencies:{token:"SECRET_DEPENDENCY"}},...extra.map(v=>({...v,path:v.path?.replace("{cwd}",cwd)}))].map(v=>({...v,enabled:states[v.path]??v.enabled})),errors:[{message:"SECRET_SKILL_PARSE_ERROR"}]}))});

    }
    case "skills/config/write": {
      const file=path.join(process.env.CODEX_HOME,"fake-skill-config.json");let control={};try{control=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,"fake-skill-write-control.json")));}catch{}
      fs.appendFileSync(path.join(process.env.CODEX_HOME,"fake-skill-writes.jsonl"),JSON.stringify(p)+"\n");
      if(control.delay)await sleep(control.delay);
      if(control.reject)return send({id:msg.id,error:{code:-32601,message:"SECRET_WRITE_FAILURE"}});
      let states={};try{states=JSON.parse(fs.readFileSync(file));}catch{}
      const enabled=typeof control.effectiveEnabled==="boolean"?control.effectiveEnabled:p.enabled;states[p.path]=enabled;fs.writeFileSync(file,JSON.stringify(states));
      return reply(msg.id,control.badResponse?{}:{effectiveEnabled:enabled});
    }
    case "mcpServerStatus/list": {
      if(process.env.FAKE_MCP_UNSUPPORTED==="1")return send({id:msg.id,error:{code:-32601,message:"SECRET_MCP_ERROR"}});
      const off=process.argv.some((v,i)=>v==="--disable"&&process.argv[i+1]==="apps");
      let data=[];if(readServer)data.push({name:readServer,runtimeStatus:"connected",authStatus:"bearerToken",tools:{}});if(autoServer)data.push({name:autoServer,runtimeStatus:"connected",authStatus:"bearerToken",tools:{}});try{data=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,"fake-mcp.json")));}catch{}
      if(process.env.FAKE_NATIVE_APPS==="1"&&!off)data.push({name:"codex_apps",runtimeStatus:"connected",authStatus:"oAuth",tools:{remote_write:{inputSchema:{secret:"SECRET_TOOL_SCHEMA"}}},httpOrigin:"SECRET_ENDPOINT",toolsError:null});
      if(process.env.FAKE_MCP_ROGUE==="1")data.push({name:"native_rogue",runtimeStatus:"connected",tools:{write:{}},toolsError:"SECRET_TOOL_ERROR"});
      if(managementState()){const state=managementState();if(state.control?.catalogReject)return send({id:msg.id,error:{code:-32600,message:"SECRET_CATALOG"}});const configured=threads.get(p.threadId)?.mcpEnabled||managementEnabled(p.cwd||process.cwd());data.push(...Object.entries(configured).filter(([name])=>![readServer,autoServer].includes(name)).map(([name,on])=>({name,runtimeStatus:on?"connected":"disabled",tools:on?{read:{}}:{}})));}
      const start=Number(p.cursor||0),limit=p.limit||50;return reply(msg.id,{data:data.slice(start,start+limit),nextCursor:start+limit<data.length?String(start+limit):null});
    }
    case "config/read":
      if(managementState())return reply(msg.id,managementConfig(p.cwd||process.cwd()));
      if (process.env.FAKE_CONFIG_UNSUPPORTED === "1") return send({ id: msg.id, error: { code: -32601, message: "SECRET_CONFIG_ERROR" } });
      return reply(msg.id, {
        config: { project_doc_fallback_filenames:["TEAM.md"],project_doc_max_bytes:32768, ...(process.env.FAKE_CONFIG_NATIVE_MCP==="1"?{mcp_servers:{native:{enabled:true,command:"SECRET_COMMAND",env:{key:"SECRET_ENV"}}}}:{}), model: "gpt-config-default", model_reasoning_effort: "high", model_auto_compact_token_limit: 90000,
          model_provider: "openai", approval_policy: "on-request", sandbox_mode: "read-only",
          api_key: "SECRET_API_KEY", instructions: "SECRET_INSTRUCTIONS", developer_instructions: "SECRET_DEVELOPER",
          model_providers: { private: { bearer_token: "SECRET_NESTED" } } },
        origins: { model: { name: { type: "user", file: "/secret/auth.json" }, version: "SECRET_VERSION" } },
        layers: [{ config: { token: "SECRET_LAYER" } }],
      });
    case "account/read": {
      // FAKE_CODEX_LOGGED_OUT=1：模拟未登录；fake-account.json 可切换账号身份（同套餐换账号用例）
      let acct = process.env.FAKE_CODEX_LOGGED_OUT === "1" ? null : { type: "chatgpt", planType: "prolite", email: null, workspaceName: null };
      try {
        const f = path.join(process.env.CODEX_HOME || "/tmp", "fake-account.json");
        if (acct && fs.existsSync(f)) {
          const j = JSON.parse(fs.readFileSync(f, "utf8"));
          acct = { ...acct, ...j };
        }
      } catch {}
      try{if(JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,"fake-models.json"))).loggedOut)acct=null;}catch{}
      reply(msg.id, { account: acct, requiresOpenaiAuth: true });
      // 真实 app-server 也会主动报一次账号状态；它**不代表**有登录在进行（P6-E3 回归点）
      notify("account/updated", { authMode: "chatgpt", planType: acct ? acct.planType : null });
      return;
    }

    case "model/list": {
      bumpModelList();
      // 与真实 model/list 同形状：没有 context_window 字段
      const all = [
        { id: "gpt-fake", model: "gpt-fake", displayName: "GPT Fake", description: "离线测试用默认模型",
          defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "快" }, { reasoningEffort: "high", description: "深" }],
          hidden: false, isDefault: true, inputModalities: ["text", "image"], serviceTiers: [], upgrade: null },
        { id: "gpt-fake-alt", model: "gpt-fake-alt", displayName: "GPT Fake Alt", description: "离线测试用备选模型",
          defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "快" }, { reasoningEffort: "high", description: "深" }],
          hidden: false, isDefault: false, inputModalities: ["text"], serviceTiers: [], upgrade: null },
        { id: "gpt-fake-hidden", model: "gpt-fake-hidden", displayName: "Hidden", description: "默认不显示",
          defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "快" }],
          hidden: true, isDefault: false, inputModalities: ["text"], serviceTiers: [], upgrade: null },
      ];
      let fixture=null;try{fixture=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,"fake-models.json")));}catch{}
      if(fixture?.reject)return send({id:msg.id,error:{code:-32600,message:"SECRET_MODEL_FAILURE"}});
      if(fixture?.delay)await sleep(fixture.delay);
      const selected=fixture?.models||all;
      const data = p.includeHidden ? selected : selected.filter((m) => !m.hidden);
      if(fixture?.cursorLoop)return reply(msg.id,{data,nextCursor:"loop"});
      return reply(msg.id, { data, nextCursor: null });
    }

    case "account/login/start":
      if (p.type !== "chatgptDeviceCode") return send({ id: msg.id, error: { code: -32600, message: "fake: only device code" } });
      return reply(msg.id, { type: "chatgptDeviceCode", loginId: "login-fake-1", userCode: "FAKE-CODE", verificationUrl: "https://example.invalid/device" });

    case "account/login/cancel":
      return reply(msg.id, { status: "canceled" });

    case "account/logout":
      return reply(msg.id, {});

    case "account/rateLimits/read":
      if (process.env.FAKE_CODEX_LOGGED_OUT === "1") return send({ id: msg.id, error: { code: -32600, message: "codex account authentication required to read rate limits" } });
      return reply(msg.id, {
        rateLimits: {
          limitId: "codex", limitName: null, planType: "prolite",
          primary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1793775028 },
          secondary: null,
          credits: { hasCredits: true, unlimited: false, balance: "999.0000" },
        },
        rateLimitsByLimitId: null,
      });

    case "account/usage/read":
      if (process.env.FAKE_CODEX_LOGGED_OUT === "1") return send({ id: msg.id, error: { code: -32600, message: "codex account authentication required to read token usage" } });
      return reply(msg.id, {
        summary: { lifetimeTokens: 1234567, peakDailyTokens: 23456, currentStreakDays: 3, longestStreakDays: 9, longestRunningTurnSec: 120 },
        dailyUsageBuckets: [{ startDate: "2026-11-01", tokens: 1000 }],
        threadUsage: p.threadId ? { threadId: p.threadId, estimatedUsageCreditsMicros: 42, groups: [{ model: "gpt-fake", inputTokens: 10, totalTokens: 12, estimatedUsageCreditsMicros: 42 }] } : null,
      });

    case "thread/start": {
      fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-thread-start.json"),JSON.stringify({developerInstructions:p.developerInstructions,config:p.config,approvalPolicy:p.approvalPolicy,dynamicTools:p.dynamicTools,approvalsReviewer:p.approvalsReviewer,appsDisabled:process.argv.some((v,i)=>v==="--disable"&&process.argv[i+1]==="apps")}));
      threadSeq += 1;
      const id = `01fake-${Date.now().toString(36)}-${String(threadSeq).padStart(2, "0")}-${Math.random().toString(36).slice(2, 6)}`;
      threads.set(id, { cwd: p.cwd || "/",...(managementState()?{mcpEnabled:managementEnabled(p.cwd||"/")}:{}) });
      notify("thread/started", { thread: { id } });
      return reply(msg.id, {
        thread: { id, sessionId: id },
        model: p.model || "gpt-fake",
        reasoningEffort: p.effort || "low",
        cwd: p.cwd || "/",
        sandbox: { type: "readOnly", networkAccess: false },
        approvalPolicy: "on-request",approvalsReviewer:process.env.FAKE_AUTO_REVIEW_UNSUPPORTED==="1"?"user":p.approvalsReviewer||"user",
      });
    }

    case "thread/fork": {
      if(process.env.FAKE_FORK_UNSUPPORTED==="1")return send({id:msg.id,error:{code:-32601,message:"unsupported fork"}});
      if(process.env.FAKE_FORK_DELAY)await sleep(Number(process.env.FAKE_FORK_DELAY));
      const db=loadTurns(),turns=db[p.threadId]||[],index=turns.findIndex(t=>t.id===p.lastTurnId);
      if(index<0)return send({id:msg.id,error:{code:-32600,message:"missing boundary"}});
      const id="fork-"+Date.now()+"-"+Math.random().toString(36).slice(2,7);
      db[id]=process.env.FAKE_FORK_IGNORE_BOUNDARY==="1"?turns:turns.slice(0,index+1);saveTurns(db);
      return reply(msg.id,{thread:{id},model:"gpt-fake",cwd:p.cwd});
    }
    case "thread/revert": {
      const control=(()=>{try{return JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,"fake-revert-control.json")));}catch{return {};}})();
      fs.appendFileSync(path.join(process.env.CODEX_HOME,"fake-revert-rpcs.jsonl"),JSON.stringify(p)+"\n");
      if(control.delay)await sleep(control.delay);
      if(control.legacy)return send({id:msg.id,error:{code:-32600,message:"thread/revert only supports paginated threads"}});
      const db=loadTurns(),turns=db[p.threadId]||[],index=turns.findIndex(t=>t.id===p.beforeTurnId);
      if(index<0)return send({id:msg.id,error:{code:-32600,message:"turn not found"}});
      if(!control.ignore)db[p.threadId]=turns.slice(0,index);saveTurns(db);
      if(control.blockIndexClear)fs.mkdirSync(path.join(process.env.CCAPP_HOME,".ccapp-codex","sessions.json.tmp-"+control.gatewayPid));
      notify("thread/reverted",{threadId:p.threadId});
      return reply(msg.id,{thread:{id:p.threadId,turns:[]},turnsBackwardsCursor:null,itemsBackwardsCursor:null});
    }
    case "thread/read": {
      if(managementState()&&threads.has(p.threadId))return reply(msg.id,{thread:{id:p.threadId,status:{type:managementState().control?.coreBusy||activeTurns.has(p.threadId)?"active":"idle"}}});
      const a=agentDb()[p.threadId];if(!a)return send({id:msg.id,error:{code:-32600,message:"missing thread"}});
      noteAgentRpc("thread/read",p);
      return reply(msg.id,{thread:{id:p.threadId,parentThreadId:a.parentThreadId,sessionId:a.parentThreadId,status:{type:a.ownerPid===process.pid?a.runtime:"notLoaded"},turns:[]}});
    }
    case "thread/items/list": {
      const control=(()=>{try{return JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,"fake-history-read-control.json")));}catch{return {};}})();
      if(control.itemsUnsupported)return send({id:msg.id,error:{code:-32601,message:"items unsupported"}});
      const turn=(loadTurns()[p.threadId]||[]).find(t=>t.id===p.turnId),start=Number(p.cursor||0),all=turn?.items||[],data=all.slice(start,start+(p.limit||100)).map(item=>({turnId:p.turnId,item}));
      fs.appendFileSync(path.join(process.env.CODEX_HOME,"fake-history-reads.jsonl"),JSON.stringify({threadId:p.threadId,turnId:p.turnId,method:msg.method,limit:p.limit,cursor:p.cursor||null})+"\n");
      return reply(msg.id,{data,nextCursor:start+data.length<all.length?String(start+data.length):null});
    }
    case "thread/turns/list": {
      const readControl=(()=>{try{return JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,"fake-history-read-control.json")));}catch{return {};}})();
      if(readControl.delay)await sleep(readControl.delay);
      if(readControl.reject)return send({id:msg.id,error:{code:-32600,message:"fixture read rejected"}});
      const a=agentDb()[p.threadId];if(a){noteAgentRpc("thread/turns/list",p);return reply(msg.id,{data:[a.turn],nextCursor:null});}

      if(p.itemsView==="full"&&process.env.FAKE_HISTORY_UNSUPPORTED==="1")return send({id:msg.id,error:{code:-32601,message:"history unsupported"}});
      if(p.itemsView==="full"&&process.env.FAKE_HISTORY_DELAY)await sleep(Number(process.env.FAKE_HISTORY_DELAY));
      const turns=loadTurns()[p.threadId]||[],sorted=p.sortDirection==="desc"?[...turns].reverse():turns;
      const start=Number(p.cursor||0),data=sorted.slice(start,start+(p.limit||100));
      if(p.itemsView)for(const t of data){
        t.itemsView=p.itemsView==="full"&&process.env.FAKE_HISTORY_SUMMARY==="1"?"summary":p.itemsView;
        if(p.itemsView==="notLoaded")t.items=[];
        if(p.itemsView==="summary"){t.items=(t.items||[]).filter(i=>i.type==="userMessage"||i.type==="agentMessage");if(readControl.summaryFirstUser){let found=false;t.items=t.items.filter(i=>i.type!=="userMessage"||(!found&&(found=true)));}}
      }
      if(process.env.FAKE_HISTORY_FORBID_FULL==="1"&&p.itemsView==="full")return send({id:msg.id,error:{code:-32600,message:"Full history body must not be read in this fixture"}});
      fs.appendFileSync(path.join(process.env.CODEX_HOME,"fake-history-reads.jsonl"),JSON.stringify({threadId:p.threadId,itemsView:p.itemsView,limit:p.limit,cursor:p.cursor||null})+"\n");
      const next=start+data.length<sorted.length?String(start+data.length):null;
      return reply(msg.id,{data,nextCursor:process.env.FAKE_HISTORY_LOOP==="1"?"repeat":next});
    }
    case "thread/resume": {
      if (!threads.has(p.threadId)) { /* 允许恢复未知线程：离线用例覆盖 */ threads.set(p.threadId, { cwd: p.cwd || "/" }); }
      if(managementState()){threads.get(p.threadId).mcpEnabled=managementEnabled(p.cwd||threads.get(p.threadId).cwd);fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-mcp-resume.json"),JSON.stringify(p));}
      return reply(msg.id, { thread: { id: p.threadId }, model: p.model || threads.get(p.threadId)?.model || "gpt-fake", reasoningEffort: "low", cwd: p.cwd || "/",approvalsReviewer:process.env.FAKE_AUTO_REVIEW_UNSUPPORTED==="1"?"user":p.approvalsReviewer||"user" });
    }

    case "review/start": {
      if(process.env.FAKE_REVIEW_UNSUPPORTED==="1")return send({id:msg.id,error:{code:-32601,message:"review unsupported"}});
      fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-review.json"),JSON.stringify(p));
      const turnId="review-"+Date.now(),threadId=p.threadId;activeTurns.set(threadId,turnId);
      fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-review.json"),JSON.stringify({...p,_turnId:turnId}));
      notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress"}});
      notify("item/completed",{threadId,turnId,item:{type:"enteredReviewMode",id:"enter",review:"Uncommitted changes"}});
      const blocked=await request("item/tool/call",{threadId,turnId,callId:"review-write",tool:"cccodroid_write_file",arguments:{path:"REVIEW_MUST_NOT_WRITE",content:"oops"}});
      const execute=await request("item/tool/call",{threadId,turnId,callId:"review-exec",tool:"cccodroid_exec_command",arguments:{command:"touch REVIEW_MUST_NOT_EXEC"}});
      fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-review-blocked.json"),JSON.stringify({write:blocked.result.success,exec:execute.result.success}));
      notify("turn/diff/updated",{threadId:"other-thread",turnId,diff:"FOREIGN_DIFF"});
      notify("turn/diff/updated",{threadId,turnId:"old-turn",diff:"OLD_DIFF"});
      notify("turn/diff/updated",{threadId,turnId,diff:"diff --git a/demo b/demo\n-old\n+new"});
      notify("turn/diff/updated",{threadId,turnId,diff:"diff --git a/demo b/demo\n-old\n+final"});
      if(process.env.FAKE_REVIEW_HOLD==="1"){
        for(let i=0;i<100&&!interrupted.has(turnId);i++)await sleep(30);
      }
      if(interrupted.has(turnId)){finish(threadId,turnId,"interrupted");return reply(msg.id,{turn:{id:turnId},reviewThreadId:threadId});}
      if(process.env.FAKE_REVIEW_NATIVE_APPROVAL==="1"){
        const response=await request("mcpServer/elicitation/request",{threadId,turnId,serverName:"approval_fixture",mode:"form",message:"Review native action",
          _meta:{codex_approval_kind:"mcp_tool_call",tool_params:{label:"REVIEW"}},requestedSchema:{type:"object",properties:{}}});
        fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-review-native.json"),JSON.stringify(response.result));
      }
      if(process.env.FAKE_REVIEW_NO_RESULT!=="1")notify("item/completed",{threadId,turnId,item:{type:"exitedReviewMode",id:"exit",review:"REVIEW_FINDING"}});
      finish(threadId,turnId,process.env.FAKE_REVIEW_FAILED==="1"?"failed":"completed");
      return reply(msg.id,{turn:{id:turnId},reviewThreadId:threadId});
    }

    case "turn/start": {
      const turnId = `01fake-${Date.now().toString(36)}-turn`;
      lastTurnModel = p.model ?? null;
      turnSeq += 1;
      // 记录这一轮收到的 model / effort：测试用来验证「切换后下一轮生效」
      try {
        fs.writeFileSync(path.join(process.env.CODEX_HOME || "/tmp", "fake-last-turn.json"),
          JSON.stringify({ model: p.model ?? null, effort: p.effort ?? null, threadId: p.threadId ?? null, input: p.input, collaborationMode: p.collaborationMode }));
      } catch {}
      const text = (p.input || []).map((x) => x.text || "").join(" ");
      if(process.env.FAKE_FULL_TURNS==="1")fullTurnItems.set(turnId,[{type:"userMessage",id:"user-"+turnId,content:p.input}]);
      activeTurns.set(p.threadId, turnId);
      reply(msg.id, { turn: { id: turnId, status: "inProgress" } });
      runFakeTurn(threadIdOf(p.threadId), turnId, text).catch(() => {});
      return;
    }

    case "turn/steer": {
      if (process.env.FAKE_STEER_REJECT === "1" || activeTurns.get(p.threadId) !== p.expectedTurnId) return send({ id: msg.id, error: { code: -32600, message: "no matching active turn" } });
      fs.writeFileSync(path.join(process.env.CODEX_HOME, "fake-steer.json"), JSON.stringify(p));
      if (process.env.FAKE_STEER_DROP === "1") return; // 模拟核心已接收但 RPC 回包丢失。
      return reply(msg.id, { turnId: p.expectedTurnId });
    }

    case "thread/compact/start": {
      if (process.env.FAKE_COMPACT_ERROR === "1") return send({ id: msg.id, error: { code: -32601, message: "compact not supported" } });
      const turnId = "compact-" + Date.now();
      const threadId = p.threadId;
      // 故意在 RPC 回包之前完整发完事件，验证订阅竞态与新旧事件去重。
      notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
      notify("item/started", { threadId, turnId, item: { type: "contextCompaction", id: "compact-item" } });
      if (process.env.FAKE_COMPACT_NO_USAGE !== "1") notify("thread/tokenUsage/updated", { threadId, tokenUsage: { last: { totalTokens: 18000 }, total: { totalTokens: 200000 }, modelContextWindow: 100000 } });
      notify("item/completed", { threadId, turnId, item: { type: "contextCompaction", id: "compact-item" } });
      notify("thread/compacted", { threadId, turnId });
      notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
      return reply(msg.id, {});
    }

    case "turn/interrupt": {
      const db=agentDb(),a=db[p.threadId];
      if(a){
        noteAgentRpc("turn/interrupt",p);
        if(a.ownerPid!==process.pid||a.turn.id!==p.turnId||a.turn.status!=="inProgress")return send({id:msg.id,error:{code:-32600,message:"no matching active child turn"}});
        if(a.behavior!=="pending"){a.turn.status="interrupted";a.runtime="idle";saveAgentDb(db);notify("turn/completed",{threadId:p.threadId,turn:{...a.turn}});}
        return reply(msg.id,{});
      }
      interrupted.add(p.turnId || "");
    }
      return reply(msg.id, {});

    default:
      return send({ id: msg.id, error: { code: -32600, message: `fake: unknown method ${msg.method}` } });
  }
});

const interrupted = new Set();
let lastTurnModel = null;
let turnSeq = 0;

/** 记一下 model/list 被调了几次：测试用来验证目录缓存有没有被无谓清掉 */
function bumpModelList() {
  const dir = process.env.CODEX_HOME;
  if (!dir) return;
  const f = path.join(dir, "fake-model-list-count.json");
  let n = 0;
  try { n = JSON.parse(fs.readFileSync(f, "utf8")).count || 0; } catch {}
  try { fs.writeFileSync(f, JSON.stringify({ count: n + 1 })); } catch {}
}
const threadIdOf = (id) => id;

async function runFakeTurn(threadId, turnId, text) {
  const itemId = `msg_${turnId}`;
  if(text.startsWith("NOTIFY_FINAL_FIXTURE ")){
    const answer=text.slice("NOTIFY_FINAL_FIXTURE ".length);
    notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress"}});
    notify("item/completed",{threadId,turnId,item:{type:"agentMessage",id:itemId+"-progress",text:"PROGRESS_ONLY_"+answer,phase:"commentary"}});
    notify("item/completed",{threadId,turnId,item:{type:"agentMessage",id:itemId,text:answer,phase:"final_answer"}});
    finish(threadId,turnId,"completed");return;
  }
  if(text.startsWith("TEXT_ATTACHMENT_FIXTURE ")){
    const f=JSON.parse(text.split("\n")[0].slice("TEXT_ATTACHMENT_FIXTURE ".length)),tool=f.tool||"cccodroid_read_file",args=f.args||{path:f.path||text.match(/\n\n@([^\n]+)/)?.[1]},id="text-"+turnId;
    notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress"}});
    let output,success,content;
    if(f.viaMcp){
      const server=autoServer||readServer,item={type:"mcpToolCall",id,server,tool,arguments:args,status:"inProgress"};
      notify("item/started",{threadId,turnId,item});
      output=(autoServer?await autoCall("tools/call",{name:tool,arguments:args}):await readCall(tool,args)).result;success=!output.isError;content=output.content||[];
      notify("item/completed",{threadId,turnId,item:{...item,status:success?"completed":"failed",result:{content},error:success?null:{message:content.map(c=>c.text||"").join("\n")}}});
    }else{
      notify("item/started",{threadId,turnId,item:{type:"dynamicToolCall",id,tool,arguments:args,status:"inProgress"}});
      output=(await request("item/tool/call",{threadId,turnId,callId:id,tool,arguments:args})).result;success=output.success;content=output.contentItems||[];
      notify("item/completed",{threadId,turnId,item:{type:"dynamicToolCall",id,tool,arguments:args,status:"completed",...output}});
    }
    fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-text-result.json"),JSON.stringify({success,text:content.map(c=>c.text||"").join("\n")}));
    notify("item/completed",{threadId,turnId,item:{type:"agentMessage",id:itemId,text:success?"TEXT_TOOL_OK":"TEXT_TOOL_DENIED",phase:"final_answer"}});
    finish(threadId,turnId,"completed");return;
  }

  if(text.startsWith("NATIVE_SLEEP_FIXTURE ")){
    const f=JSON.parse(text.slice("NATIVE_SLEEP_FIXTURE ".length)),id="sleep-"+turnId,item={type:"sleep",id,durationMs:f.durationMs??800,startedAtMs:Date.now(),completedAtMs:null};
    notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress"}});
    if(f.foreign)notify("item/started",{threadId:"other-thread",turnId:"other-turn",item:{...item,id:"foreign",durationMs:86400000}});
    else notify("item/started",{threadId,turnId,item});
    const began=Date.now(),actualMs=f.actualMs??item.durationMs;
    while(Date.now()-began<actualMs&&!interrupted.has(turnId)){
      if(f.duplicate)notify("item/started",{threadId,turnId,item});
      await sleep(25);
    }
    if(interrupted.has(turnId))return finish(threadId,turnId,"interrupted");
    if(!f.stall&&!f.foreign){const completed={...item,completedAtMs:Date.now()};notify("item/completed",{threadId,turnId,item:completed});if(f.duplicate)notify("item/completed",{threadId,turnId,item:completed});}
    if(f.stall||f.afterStall){while(!interrupted.has(turnId))await sleep(25);return finish(threadId,turnId,"interrupted");}
    notify("item/completed",{threadId,turnId,item:{type:"agentMessage",id:itemId,text:"SLEEP_DONE",phase:"final_answer"}});
    return finish(threadId,turnId,"completed");
  }
  if(text.startsWith("GENERATED_IMAGE_FIXTURE ")){
    const mode=text.slice("GENERATED_IMAGE_FIXTURE ".length).trim(),id="generated-"+turnId,png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+r8AAAAASUVORK5CYII=","base64"),item={type:"imageGeneration",id,status:"in_progress",result:""};
    notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress"}});notify("item/started",{threadId,turnId,item});
    if(mode==="HOLD"){await sleep(1200);if(interrupted.has(turnId))return finish(threadId,turnId,"interrupted");}
    const directory=path.join(process.env.CODEX_HOME,"generated_images",threadId);fs.mkdirSync(directory,{recursive:true});const savedPath=path.join(directory,id+".png");fs.writeFileSync(savedPath,png);
    const completed={...item,status:mode==="FAIL"?"failed":"completed",result:mode==="FILE_ID"?"":png.toString("base64"),savedPath:mode==="INLINE"||mode==="FILE_ID"?null:savedPath,failure:mode==="FAIL"?"quota unavailable":null};
    notify("item/completed",{threadId,turnId,item:completed});notify("item/completed",{threadId,turnId,item:{type:"agentMessage",id:itemId,text:"IMAGE_DONE",phase:"final_answer"}});
    return finish(threadId,turnId,"completed");
  }
  if(text.startsWith("IMAGE_READER_FIXTURE ")){
    const f=JSON.parse(text.split("\n")[0].slice("IMAGE_READER_FIXTURE ".length)),args={path:f.path||text.match(/\n\n@([^\n]+)/)?.[1]?.trim()},id="image-"+turnId,tool="cccodroid_read_image";
    notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress"}});
    let output,success,content;
    if(f.viaMcp){
      const server=autoServer||readServer,item={type:"mcpToolCall",id,server,tool,arguments:args,status:"inProgress"};
      notify("item/started",{threadId,turnId,item});
      output=(autoServer?await autoCall("tools/call",{name:tool,arguments:args}):await readCall(tool,args)).result;
      success=!output.isError;content=output.content||[];
      notify("item/completed",{threadId,turnId,item:{...item,status:success?"completed":"failed",result:{content},error:success?null:{message:content.map(c=>c.text||"").join("\n")}}});
    }else{
      const item={type:"dynamicToolCall",id,tool,namespace:null,arguments:args,status:"inProgress"};
      notify("item/started",{threadId,turnId,item});
      output=(await request("item/tool/call",{threadId,turnId,callId:id,tool,arguments:args})).result;
      success=output.success;content=output.contentItems||[];
      notify("item/completed",{threadId,turnId,item:{...item,status:"completed",...output}});
    }
    const image=content.find(c=>["image","inputImage"].includes(c.type));
    fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-image-result.json"),JSON.stringify({success,viaMcp:!!f.viaMcp,types:content.map(c=>c.type),mime:image?.mimeType||image?.imageUrl?.slice(5).split(";")[0],bytes:image?Buffer.from(image.data||image.imageUrl.split(",")[1],"base64").length:0}));
    const answer=success?"IMAGE_TOOL_OK":"IMAGE_TOOL_DENIED";
    notify("item/completed",{threadId,turnId,item:{type:"agentMessage",id:itemId,text:answer,phase:"final_answer"}});
    finish(threadId,turnId,"completed");return;
  }
  if(text.includes("SUBAGENT_CONTROL_FIXTURE")||text.includes("SUBAGENT_CONTROL_FOLLOWUP")){
    notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress"}});
    const release=path.join(process.env.CODEX_HOME,"release-parent-"+threadId);try{fs.unlinkSync(release);}catch{}
    if(text.includes("SUBAGENT_CONTROL_FIXTURE")){
      const db=agentDb();
      for(const name of ["alpha","beta"]){
        const child="control-"+name+"-"+threadId;
        db[child]={parentThreadId:threadId,ownerPid:process.pid,runtime:"active",turn:{id:"child-turn-"+name+"-"+turnId,status:"inProgress"}};
        notify("item/started",{threadId,turnId,item:{type:"subAgentActivity",id:"activity-"+name+"-"+turnId,agentThreadId:child,kind:"started",agentPath:"/root/"+name,model:"gpt-fake",reasoningEffort:"low"}});
      }saveAgentDb(db);
    }
    const began=Date.now();while(!text.includes("FAST")&&!fs.existsSync(release)&&Date.now()-began<18000&&!interrupted.has(turnId))await sleep(25);
    notify("item/completed",{threadId,turnId,item:{type:"agentMessage",id:itemId,text:"CONTROL_PARENT_DONE",phase:"final_answer"}});
    return finish(threadId,turnId,interrupted.has(turnId)?"interrupted":"completed");
  }
  if(text.includes("SUBAGENT_FIXTURE")){
    notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress"}});
    const child="child-"+turnId,spawn={type:"subAgentActivity",id:"spawn-"+turnId,kind:"started",agentThreadId:child,agentPath:"/root/fixture_reader",model:"gpt-fake",reasoningEffort:"low"};
    notify("item/started",{threadId:"foreign-thread",turnId,item:{...spawn,agentThreadId:"FOREIGN_AGENT"}});
    notify("item/started",{threadId,turnId:"foreign-turn",item:{...spawn,agentThreadId:"FOREIGN_TURN_AGENT"}});
    notify("item/started",{threadId,turnId,item:spawn});notify("item/completed",{threadId,turnId,item:spawn});
    notify("item/completed",{threadId,turnId,item:{type:"collabAgentToolCall",id:"wait-"+turnId,tool:"wait",status:"completed",senderThreadId:threadId,receiverThreadIds:[],agentsStates:{}}});
    const record={child};
    if(text.includes("READ"))record.read=(await readCall("cccodroid_read_file",{path:"child-marker.txt"})).result;
    if(text.includes("WRITE")){record.write=(await readCall("cccodroid_write_file",{path:"CHILD_MUST_NOT_WRITE",content:"denied"})).result;record.control=(await readCall("cccodroid_stop_command",{command_id:"parent-command"})).result;}
    if(text.includes("HOLD"))for(let i=0;i<Math.min(300,Number(process.env.FAKE_CHILD_HOLD_MS||3000)/50)&&!interrupted.has(turnId);i++)await sleep(50);
    if(interrupted.has(turnId)){
      record.late=(await readCall("cccodroid_read_file",{path:"child-marker.txt"})).result;
      fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-subagent.json"),JSON.stringify(record));
      return finish(threadId,turnId,"interrupted");
    }
    const done={...spawn,id:"done-"+turnId,kind:"completed"};notify("item/started",{threadId,turnId,item:done});notify("item/completed",{threadId,turnId,item:done});
    notify("item/completed",{threadId,turnId,item:{...spawn,id:"close-"+turnId,kind:"interrupted"}});
    fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-subagent.json"),JSON.stringify(record));
    notify("item/completed",{threadId,turnId,item:{type:"agentMessage",id:itemId,text:"SUBAGENT_FINISHED",phase:"final_answer"}});
    return finish(threadId,turnId,"completed");
  }

  if(text.startsWith("PARENT_INTERACTION_FIXTURE ")){
    const f=JSON.parse(text.split("\n")[0].slice("PARENT_INTERACTION_FIXTURE ".length)),caller=f.child?"fake-ui-child-"+threadId:threadId,ct=f.child?"child-"+turnId:turnId,server=autoServer||readServer,results=[],ids=[];
    notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress"}});
    const question={questions:[{id:"color",question:"Choose a color",options:[{label:"Blue"},{label:"Red"}],isOther:false}]};
    const operations=f.tool?[{tool:f.tool,args:f.args||question}]:[{tool:"cccodroid_update_plan",args:{plan:[{step:"Choose color",status:"in_progress"},{step:"Report",status:"pending"}]}},{tool:"cccodroid_ask_user",args:question},{tool:"cccodroid_update_plan",args:{plan:[{step:"Choose color",status:"completed"},{step:"Report",status:"completed"}]}}];
    for(let i=0;i<operations.length;i++){
      const op=operations[i],id="parent-ui-"+i+"-"+turnId,it={type:"mcpToolCall",id,server,tool:op.tool,arguments:op.args,status:"inProgress"};ids.push(id);
      if(!f.skipStarted)notify("item/started",{threadId:caller,turnId:ct,item:it});
      const meta={threadId:f.badMeta?"wrong-thread":caller,sessionId:f.badSession?"wrong-root":threadId,callId:id,"x-codex-turn-metadata":JSON.stringify({thread_id:caller,turn_id:f.badTurn?"wrong-turn":ct})},args=f.badArgs?{plan:[{step:"ALTERED",status:"completed"}]}:op.args;
      const r=(autoServer?await autoCall("tools/call",{name:op.tool,arguments:args,_meta:meta}):await readCall(op.tool,args,meta)).result;results.push({tool:op.tool,result:r});
      notify("item/completed",{threadId:caller,turnId:ct,item:{...it,status:r.isError?"failed":"completed",result:r,error:r.isError?{message:"blocked"}:null}});
    }
    fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-parent-ui.json"),JSON.stringify({turnId,caller,ids,results}));
    return finish(threadId,turnId,"completed");
  }
  if(text.startsWith("CHILD_EDIT_FIXTURE ")){
    const f=JSON.parse(text.split("\n")[0].slice("CHILD_EDIT_FIXTURE ".length)),child=f.root?threadId:"fake-child-"+threadId,ct=f.root?turnId:"child-"+turnId,server=autoServer||readServer,tool=f.tool||"cccodroid_write_file",args=f.args||{path:"child.txt",content:"CHILD_WRITTEN"};
    notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress"}});
    const spawn={type:"subAgentActivity",id:"child-spawn-"+turnId,kind:"started",agentThreadId:child,agentPath:"/root/editor"};
    if(!f.root){notify("item/started",{threadId,turnId,item:spawn});notify("item/completed",{threadId,turnId,item:spawn});notify("turn/started",{threadId:child,turn:{id:ct,status:"inProgress"}});}
    const it={type:"mcpToolCall",id:"child-edit-"+turnId,server,tool,arguments:args,status:"inProgress"};notify("item/started",{threadId:child,turnId:ct,item:it});
    let approval=null,r={isError:true,content:[{type:"text",text:"declined"}]};
    if(autoServer){
      const status=f.denyReview?"denied":"approved",p={threadId:child,turnId:ct,reviewId:"child-review-"+turnId,targetItemId:it.id,review:{status}};
      notify("item/autoApprovalReview/started",{...p,review:{status:"inProgress"}});notify("item/autoApprovalReview/completed",p);await sleep(20);approval={action:status==="approved"?"accept":"decline"};
    }else{approval=(await request("mcpServer/elicitation/request",{threadId:child,turnId:ct,serverName:server,mode:"form",message:"Allow isolated child file edit",requestedSchema:{type:"object",properties:{}},_meta:{codex_approval_kind:"mcp_tool_call",tool_params:args}})).result;}
    if(approval?.action==="accept"){
      const meta={threadId:f.badMeta?"unknown-child":child,sessionId:threadId,callId:it.id,"x-codex-turn-metadata":JSON.stringify({thread_id:child,turn_id:ct})};
      r=(autoServer?await autoCall("tools/call",{name:tool,arguments:args,_meta:meta}):await readCall(tool,args,meta)).result;
    }
    fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-child-edit.json"),JSON.stringify({approval,result:r,child,turnId:ct}));
    notify("item/completed",{threadId:child,turnId:ct,item:{...it,status:r.isError?"failed":"completed",result:r,error:r.isError?{message:"not executed"}:null}});
    if(!f.root){notify("turn/completed",{threadId:child,turn:{id:ct,status:"completed"}});notify("item/completed",{threadId,turnId,item:{...spawn,id:"child-done-"+turnId,kind:"completed"}});}
    return finish(threadId,turnId,"completed");
  }
  if(text.includes("AUTO_PERMISSION_FIXTURE")){
    notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress"}});
    const args={path:text.includes("LATE_AFTER_STOP")?"auto-after-stop.txt":text.includes("DENY")?"auto-denied.txt":"auto-approved.txt",content:"AUTO_APPROVED"};
    if(text.includes("DYNAMIC")){
      const r=await request("item/tool/call",{threadId,turnId,tool:"cccodroid_write_file",callId:"old-dynamic",arguments:args});
      fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-auto-result.json"),JSON.stringify(r.result));
      return finish(threadId,turnId,"completed");
    }
    if(!autoServer){finish(threadId,turnId,"failed");return;}
    const it={type:"mcpToolCall",id:"auto-tool-"+turnId,server:autoServer,tool:"cccodroid_write_file",arguments:args,status:"inProgress"},reviewId="review-"+turnId;
    notify("item/started",{threadId,turnId,item:it});
    notify("item/autoApprovalReview/started",{threadId,turnId,reviewId,targetItemId:it.id,review:{status:"inProgress"},action:{type:"mcpToolCall",server:autoServer,toolName:it.tool}});
    if(text.includes("HOLD")||text.includes("LATE_AFTER_STOP")){for(let i=0;i<100&&!interrupted.has(turnId);i++)await sleep(30);}
    const status=text.includes("LATE_AFTER_STOP")?"approved":interrupted.has(turnId)?"aborted":text.includes("DENY")?"denied":"approved";
    notify("item/autoApprovalReview/completed",{threadId,turnId,reviewId,targetItemId:it.id,review:{status,rationale:"FAKE_REVIEW_"+status},action:{type:"mcpToolCall",server:autoServer,toolName:it.tool}});
    await sleep(20);
    let r={isError:true,content:[{type:"text",text:status}]};
    if(status==="approved")r=(await autoCall("tools/call",{name:it.tool,arguments:args,_meta:{threadId,sessionId:threadId,callId:it.id,"x-codex-turn-metadata":JSON.stringify({thread_id:threadId,turn_id:turnId})}})).result;
    fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-auto-result.json"),JSON.stringify(r));
    notify("item/completed",{threadId,turnId,item:{...it,status:r.isError?"failed":"completed",result:r,error:r.isError?{message:status}:null}});
    notify("item/completed",{threadId,turnId,item:{type:"agentMessage",id:itemId,text:"AUTO_"+status,phase:"final_answer"}});
    return finish(threadId,turnId,interrupted.has(turnId)?"interrupted":"completed");
  }
  if(text.includes("NATIVE_FORM_FIXTURE")){
    notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress"}});
    const schema={type:"object",properties:{
      name:{type:"string",title:"项目名称",minLength:2,maxLength:30},
      enabled:{type:"boolean",title:"启用",default:false},
      count:{type:"integer",title:"数量",minimum:0,maximum:5},
      project:{type:"string",title:"环境",enum:["prod","dev"],enumNames:["生产","开发"]},
      tags:{type:"array",title:"标签",items:{anyOf:[{const:"a,b",title:"选项甲"},{const:"c",title:"选项乙"}]},minItems:1},
      note:{type:"string",title:"备注"}},required:["name","enabled","count","project","tags"]};
    if(text.includes("OPTIONAL")){schema.required=[];schema.properties={note:{type:"string",title:"备注"}};}
    if(text.includes("UNICODE")){schema.required=["name"];schema.properties={name:{type:"string",title:"单字符",maxLength:1}};}
    if(text.includes("UNSUPPORTED"))schema.properties.name.pattern=".*";
    const params={threadId:text.includes("FOREIGN_THREAD")?"foreign-thread":threadId,
      turnId:text.includes("FOREIGN_TURN")?"foreign-turn":text.includes("UNBOUND")?null:turnId,
      serverName:"form_fixture",mode:text.includes("URL")?"url":"form",message:"请填写测试表单 <script>globalThis.FORM_XSS=1</script>",_meta:{secret:"FORM_META_MUST_NOT_LEAK"},requestedSchema:schema};
    if(text.includes("FOREIGN_RESOLVED"))setTimeout(()=>notify("serverRequest/resolved",{threadId:"foreign-thread",requestId:nextServerReq-1}),100);
    const requestId=nextServerReq;
    if(text.includes("RESOLVED")&&!text.includes("FOREIGN_RESOLVED"))setTimeout(()=>notify("serverRequest/resolved",{threadId,requestId}),120);
    if(text.includes("DISCONNECT"))setTimeout(()=>process.exit(4),150);
    const response=await request("mcpServer/elicitation/request",params);
    fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-form-result.json"),JSON.stringify(response.result));
    if(text.includes("HOLD_AFTER"))await sleep(300);
    notify("item/completed",{threadId,turnId,item:{type:"agentMessage",id:itemId,text:"FORM_"+String(response.result?.action).toUpperCase(),phase:"final_answer"}});
    return finish(threadId,turnId,interrupted.has(turnId)?"interrupted":"completed");
  }
  if(text.includes("NATIVE_APPROVAL_FIXTURE")){
    notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress"}});
    const native={type:"mcpToolCall",id:"native-"+turnId,server:"approval_fixture",tool:"ack",arguments:{label:"ORIGINAL"},status:"inProgress"};
    notify("item/started",{threadId,turnId,item:native});
    const params={threadId:text.includes("FOREIGN_THREAD")?"foreign-thread":threadId,
      turnId:text.includes("FOREIGN_TURN")?"foreign-turn":text.includes("UNBOUND")?null:turnId,
      serverName:"approval_fixture",mode:"form",message:'Allow the approval_fixture MCP server to run tool "ack"?',
      _meta:{codex_approval_kind:"mcp_tool_call",tool_description:"Local fixture",tool_params:{label:"ORIGINAL"},secret_ignored:"DO_NOT_PUBLISH_METADATA"},
      requestedSchema:{type:"object",properties:{}}};
    if(text.includes("FORM"))params.requestedSchema.properties.value={type:"string"};
    if(text.includes("URL"))Object.assign(params,{mode:"url",url:"https://example.invalid/login",elicitationId:"fixture"});
    const requestId=nextServerReq;
    if(text.includes("RESOLVED"))setTimeout(()=>notify("serverRequest/resolved",{threadId,requestId}),120);
    if(text.includes("DISCONNECT"))setTimeout(()=>process.exit(4),120);
    const response=await request("mcpServer/elicitation/request",params),action=response.result?.action;
    fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-native-approval.json"),JSON.stringify(response.result));
    if(action==="accept"){
      if(text.includes("HOLD"))await sleep(1000);
      fs.appendFileSync(path.join(threads.get(threadId)?.cwd||process.env.CCAPP_WORKSPACE,"native-executed.jsonl"),JSON.stringify(native.arguments)+"\n");
    }
    const result=action==="accept"?{content:[{type:"text",text:"NATIVE_ACCEPTED"},{type:"image",data:"BINARY_MUST_NOT_APPEAR"}]}:null;
    notify("item/completed",{threadId,turnId,item:{...native,status:action==="accept"?"completed":"failed",result,error:result?null:{message:"native "+action}}});
    notify("item/completed",{threadId,turnId,item:{type:"agentMessage",id:itemId,text:"NATIVE_"+String(action).toUpperCase(),phase:"final_answer"}});
    return finish(threadId,turnId,interrupted.has(turnId)?"interrupted":"completed");
  }
  if(text.includes("SCHED_POLICY_FIXTURE")){
    notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress"}});
    if(text.includes("HOLD"))await sleep(900);
    const write=await request("item/tool/call",{threadId,turnId,callId:"task-write-"+turnId,tool:"cccodroid_write_file",arguments:{path:"SCHED_EDIT",content:"ALLOWED_EDIT"}});
    const outside=await request("item/tool/call",{threadId,turnId,callId:"task-outside-"+turnId,tool:"cccodroid_write_file",arguments:{path:"../SCHED_OUTSIDE",content:"MUST_NOT_WRITE"}});
    const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
    const exec=await request("item/tool/call",{threadId,turnId,callId:"task-exec-"+turnId,tool:"cccodroid_exec_command",arguments:{command:quote(process.execPath)+" -e "+quote("require('node:fs').writeFileSync('SCHED_EXEC','EXPLICITLY_ALLOWED')"),yield_time_ms:1000,timeout_ms:3000}});
    const ask=await request("item/tool/call",{threadId,turnId,callId:"task-ask-"+turnId,tool:"cccodroid_ask_user",arguments:{questions:[{id:"q",question:"Choose",options:[{label:"A"},{label:"B"}]}]}});
    const result={write:write.result?.success===true,outside:outside.result?.success===true,exec:exec.result?.success===true,ask:ask.result?.contentItems?.[0]?.text||""};
    fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-task-result.json"),JSON.stringify(result));
    notify("item/completed",{threadId,turnId,item:{type:"agentMessage",id:itemId,text:"SCHEDULE_RESULT "+JSON.stringify(result),phase:"final_answer"}});
    return finish(threadId,turnId,"completed");
  }
  if(text.includes("BROWSER_FIXTURE")){
    notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress"}});
    await request("item/tool/call",{threadId,turnId,callId:"browser-"+turnId,tool:"cccodroid_open_browser",arguments:{url:"http://127.0.0.1:31234/preview-test"}});
    notify("item/completed",{threadId,turnId,item:{type:"agentMessage",id:"browser-answer-"+turnId,text:"PREVIEW_REQUESTED",phase:"final_answer"}});
    return finish(threadId,turnId,"completed");
  }
  if (text.includes("COMMAND_FIXTURE")) {
    notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    const q=s=>"'"+s.replaceAll("'","'\\''")+"'";
    let code = "console.log('COMMAND_FIRST');setTimeout(()=>console.log('COMMAND_LAST'),250)";
    if (text.includes("HOLD") || text.includes("RETURN_EARLY") || text.includes("TIMEOUT")) code = "const{spawn}=require('node:child_process');const fs=require('node:fs');const ch=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync('command-child.pid',String(ch.pid));console.log('COMMAND_READY');setInterval(()=>console.log('COMMAND_TICK'),100)";
    if (text.includes("INPUT")) code = "process.stdin.on('data',d=>process.stdout.write('ECHO:'+d));process.stdin.on('end',()=>process.exit(0));";
    if (text.includes("FAIL")) code = "console.error('COMMAND_ERROR');process.exit(9)";
    const command = q(process.execPath) + " -e " + q(code);
    notify("item/started",{threadId,turnId,item:{id:"exec-"+turnId,type:"dynamicToolCall",tool:"cccodroid_exec_command",arguments:{command}}});
    const response = await request("item/tool/call", { threadId, turnId, callId: "exec-"+turnId, tool: "cccodroid_exec_command",
      arguments: { command, yield_time_ms: 30, timeout_ms: text.includes("TIMEOUT") ? 250 : 10000, ...(text.includes("PERSIST")?{background:true,timeout_ms:45000}:{}) } });
    let result;
    try { result = JSON.parse(response.result.contentItems[0].text); } catch {}
    fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-command.json"),JSON.stringify({threadId,turnId,result,success:response.result?.success}));
    if (result?.id && text.includes("INPUT")) {
      const input = await request("item/tool/call", { threadId, turnId, callId:"input-"+turnId,tool:"cccodroid_write_command",arguments:{command_id:result.id,chars:"hello\n",eof:true,wait_ms:500}});
      try { result=JSON.parse(input.result.contentItems[0].text); } catch {}
    }
    if (!text.includes("RETURN_EARLY")) {
      let count=0;
      while (result?.running && count++<150 && !interrupted.has(turnId)) {
        const read=await request("item/tool/call", {threadId,turnId,callId:"read-"+turnId+"-"+count,tool:"cccodroid_read_command",arguments:{command_id:result.id,wait_ms:100}});
        try { result=JSON.parse(read.result.contentItems[0].text); } catch { break; }
      }
    }
    fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-command-result.json"),JSON.stringify(result || {denied:true}));
    notify("item/completed",{threadId,turnId,item:{type:"agentMessage",id:"command-answer-"+turnId,phase:"final_answer",text:result?.id?"COMMAND_FINISHED":"COMMAND_DENIED"}});
    return finish(threadId,turnId,interrupted.has(turnId)?"interrupted":"completed");
  }
  if (text.includes("PLAN_PROGRESS_FIXTURE")) {
    notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    await request("item/tool/call", { threadId: "foreign-thread", turnId, callId: "foreign-call", tool: "cccodroid_update_plan",
      arguments: { plan: [{ step: "FOREIGN_TOOL", status: "completed" }] } });
    await request("item/tool/call", { threadId, turnId: "foreign-turn", callId: "foreign-turn-call", tool: "cccodroid_update_plan",
      arguments: { plan: [{ step: "FOREIGN_TOOL_TURN", status: "completed" }] } });
    const steps = [{ step: "Inspect fixture", status: "completed" }, { step: "Verify fixture", status: "inProgress" }];
    notify("turn/plan/updated", { threadId: "foreign-thread", turnId, plan: [{ step: "FOREIGN_THREAD", status: "completed" }] });
    notify("turn/plan/updated", { threadId, turnId: "foreign-turn", plan: [{ step: "FOREIGN_TURN", status: "completed" }] });
    notify("item/agentMessage/delta", { threadId, turnId: "foreign-turn", itemId: "foreign", delta: "FOREIGN_TEXT" });
    notify("turn/plan/updated", { threadId, turnId, explanation: "Check the two fixture steps", plan: steps });
    notify("item/started", { threadId, turnId, item: { type: "reasoning", id: "reason-" + turnId } });
    notify("item/reasoning/summaryTextDelta", { threadId, turnId, itemId: "reason-" + turnId, summaryIndex: 0, delta: "PUBLIC_SUMMARY" });
    notify("item/reasoning/summaryTextDelta", { threadId, turnId, itemId: "reason-" + turnId, summaryIndex: 1, delta: "SECOND_PUBLIC_SUMMARY" });
    notify("item/reasoning/textDelta", { threadId, turnId, itemId: "reason-" + turnId, contentIndex: 0, delta: "PRIVATE_REASONING_MUST_NOT_APPEAR" });
    notify("item/completed", { threadId, turnId, item: { type: "reasoning", id: "reason-" + turnId, summary: ["PUBLIC_SUMMARY", "SECOND_PUBLIC_SUMMARY"], content: ["PRIVATE_REASONING_MUST_NOT_APPEAR"] } });
    notify("item/started", { threadId, turnId, item: { type: "agentMessage", id: "comment-" + turnId, phase: "commentary" } });
    notify("item/agentMessage/delta", { threadId, turnId, itemId: "comment-" + turnId, delta: "COMMENTARY_ONE" });
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "comment-" + turnId, phase: "commentary", text: "COMMENTARY_ONE" } });
    notify("item/plan/delta", { threadId, turnId, itemId: "plan-" + turnId, delta: "DRAFT_PLAN_TEXT" });
    notify("item/completed", { threadId, turnId, item: { type: "plan", id: "plan-" + turnId, text: "FINAL_PLAN_TEXT" } });
    if (text.includes("HOLD")) {
      for (let i=0;i<100;i++) {
        if (interrupted.has(turnId)) return finish(threadId, turnId, "interrupted");
        await sleep(50);
      }
    }
    if (text.includes("COMPLETE_STEPS")) {
      steps[1].status = "completed";
      notify("turn/plan/updated", { threadId, turnId, explanation: null, plan: steps });
    }
    notify("item/started", { threadId, turnId, item: { type: "agentMessage", id: "final-" + turnId, phase: "final_answer" } });
    notify("item/agentMessage/delta", { threadId, turnId, itemId: "final-" + turnId, delta: "FINAL_PART" });
    notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "final-" + turnId, phase: "final_answer", text: "FINAL_ANSWER" } });
    return finish(threadId, turnId, "completed");
  }
  if (text.includes("TIMEOUT_PROGRESS_FIXTURE") || text.includes("TIMEOUT_STALL_FIXTURE")) {
    notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
    if (text.includes("TIMEOUT_PROGRESS_FIXTURE")) {
      for (let i=0;i<12;i++) {
        await sleep(20);
        if (interrupted.has(turnId)) return finish(threadId, turnId, "interrupted");
        notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: "." });
      }
    } else await sleep(160);
    return finish(threadId, turnId, interrupted.has(turnId) ? "interrupted" : "completed");
  }
  if(text.includes("ASYNC_QUESTIONS_FIXTURE")){
    notify("item/completed",{threadId,turnId,item:{type:"agentMessage",id:"async-"+turnId,text:"",phase:"commentary",
      questions:[{title:"选择接下来的方案",options:["保留内部存储","外部迁移"]},{title:"补充要求",options:null}]}});
    return finish(threadId,turnId,"completed");
  }
  if(text.startsWith("回答 Codex 的提问："))fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-async-answer.txt"),text);
  if (text.includes("ASK_USER_FIXTURE")) {
    const response = await request("item/tool/requestUserInput", {
      threadId, turnId, itemId, isBlocking: true, autoResolutionMs: null,
      questions: [{ id: "color", header: "Color", question: "Choose a color", isOther: true, isSecret: false,
        options: [{ label: "Blue", description: "Use blue" }, { label: "Red", description: "Use red" }] }],
    });
    fs.writeFileSync(path.join(process.env.CODEX_HOME, "fake-answer.json"), JSON.stringify(response.result));
  }
  if (text.includes("WRITE_PERMISSION_FIXTURE") || text.includes("EXEC_PERMISSION_FIXTURE")) {
    const execute = text.includes("EXEC_PERMISSION_FIXTURE");
    const result = await request("item/tool/call", { threadId, turnId, callId: "permission-" + turnId,
      tool: execute ? "cccodroid_run_tests" : "cccodroid_write_file",
      arguments: execute ? { runner: "node", path: "slow.mjs" } : { path: "permission-output.txt", content: "approved contents" } });
    fs.writeFileSync(path.join(process.env.CODEX_HOME, "fake-permission-result.json"), JSON.stringify(result.result));
  }
  if (text.includes("STEER_HOLD_FIXTURE")) await sleep(900);

  if (DELAY > 0) await sleep(DELAY);
  notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
  const rerouteTurns = Number(process.env.FAKE_CODEX_REROUTE_TURNS || 0);
  if (process.env.FAKE_CODEX_REROUTE === "1" || (rerouteTurns > 0 && turnSeq <= rerouteTurns)) {
    notify("model/rerouted", {
      threadId, turnId,
      fromModel: lastTurnModel || "gpt-fake",
      toModel: process.env.FAKE_CODEX_REROUTE_TO || "gpt-reserve",
      reason: "highRiskCyberActivity",
    });
    // 测试用：给界面留出「本轮改道」的观察窗口（真实环境里这段是模型的思考时间）
    const pause = Number(process.env.FAKE_CODEX_PAUSE_AFTER_REROUTE_MS || 0);
    if (pause > 0) await sleep(pause);
  }
  notify("item/started", { threadId, turnId, item: { type: "userMessage", id: `u_${turnId}`, content: [{ type: "text", text }] } });

  // 1) 先说一句
  for (const d of ["我先看一下", "当前目录。"]) {
    if (interrupted.has(turnId)) return finish(threadId, turnId, "interrupted");
    notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: d });
    await sleep(120);
  }

  // 2) 动态工具调用
  notify("item/started", {
    threadId,
    turnId,
    item: { type: "dynamicToolCall", id: `call_${turnId}`, tool: "cccodroid_pwd", namespace: null, arguments: {}, status: "inProgress" },
  });
  const res = await request("item/tool/call", {
    threadId,
    turnId,
    callId: `call_${turnId}`,
    namespace: null,
    tool: "cccodroid_pwd",
    arguments: {},
  });
  const out = (res.result?.contentItems || []).map((c) => c.text || "").join("");
  notify("item/completed", {
    threadId,
    turnId,
    item: {
      type: "dynamicToolCall",
      id: `call_${turnId}`,
      tool: "cccodroid_pwd",
      namespace: null,
      arguments: {},
      status: "completed",
      success: Boolean(res.result?.success),
      contentItems: res.result?.contentItems || [],
    },
  });

  if (interrupted.has(turnId)) return finish(threadId, turnId, "interrupted");

  // 3) 收尾
  notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: `目录是 ${out}。` });
  // 与真实事件同形状：last 是最近一次请求占用的上下文，total 是本 thread 累计值。
  // 故意让 total 比 last 大，测试里用它验证「不能用累计值算上下文」。
  notify("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: {
      last: { inputTokens: 23000, cachedInputTokens: 14208, cacheWriteInputTokens: 0, outputTokens: 456, reasoningOutputTokens: 46, totalTokens: 23456 },
      total: { inputTokens: 77368, cachedInputTokens: 14208, cacheWriteInputTokens: 0, outputTokens: 790, reasoningOutputTokens: 92, totalTokens: 78158 },
      modelContextWindow: 400000,
    },
  });
  notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: itemId, text: `我先看一下当前目录。目录是 ${out}。`, phase: "final_answer" } });
  finish(threadId, turnId, "completed");
}

function finish(threadId, turnId, status) {
  const db=loadTurns();db[threadId]||=[];if(!db[threadId].some(t=>t.id===turnId)){db[threadId].push({id:turnId,status,...(process.env.FAKE_FULL_TURNS==="1"?{items:fullTurnItems.get(turnId)||[]}: {})});saveTurns(db);}
  activeTurns.delete(threadId);
  notify("turn/completed", { threadId, turn: { id: turnId, status, error: status === "interrupted" ? { message: "interrupted" } : null } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DELAY = Number(process.env.FAKE_CODEX_DELAY_MS || 0);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

function loadTurns(){try{return JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,"fake-turns.json")));}catch{return {};}}
function saveTurns(db){fs.writeFileSync(path.join(process.env.CODEX_HOME,"fake-turns.json"),JSON.stringify(db));}
