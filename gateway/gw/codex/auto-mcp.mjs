// 自动判断模式的本机 MCP 桥及只读子类共用传输；临时凭据仅交给同一核心，复用注册表与路径守卫。
import http from "node:http";
import crypto from "node:crypto";
import {toolEffect,SHARED_READ_TOOLS} from "./permissions.mjs";
export class AutoMcpBridge{
 constructor({registry,active,authorize,fileEdits=null,onEditResult=()=>{},interactions=null}){this.registry=registry;this.active=active;this.authorize=authorize;this.fileEdits=fileEdits;this.onEditResult=onEditResult;this.interactions=interactions;this.interactionCalls=new Map();this.editCalls=new Map();this.token=crypto.randomBytes(32).toString("hex");this.name="cccodroid_host_"+crypto.randomBytes(4).toString("hex");this.envKey="CCAPP_AUTO_MCP_"+crypto.randomBytes(4).toString("hex").toUpperCase();this.executing=new Set();this.seq=0;this.server=null;}
 owns(callId){return this.executing.has(callId);}
 ownsInteraction(callId){return this.interactionCalls.get(callId)||null;}
 ownsEdit(callId){return this.editCalls.get(callId)||null;}
 cancelScoped(threadId,turnId){return Promise.allSettled([...this.editCalls].filter(([,origin])=>origin.threadId===threadId&&origin.turnId===turnId).map(([id])=>this.registry.cancel?.(id)));}
 allowed(name){return this.registry.has(name)&&(toolEffect(name)!=="read"||SHARED_READ_TOOLS.has(name)||this.interactions?.handles(name));}
 async start(){
  this.server=http.createServer((req,res)=>this.handle(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();}));
  this.server.requestTimeout=15000;this.server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{this.server.once("error",reject);this.server.listen(0,"127.0.0.1",resolve);});
  return this;
 }
 config(){return {url:"http://127.0.0.1:"+this.server.address().port+"/mcp",bearer_token_env_var:this.envKey,default_tools_approval_mode:"writes",required:true,tool_timeout_sec:1000};}
 env(){return {[this.envKey]:this.token};}
 async handle(req,res){
  const reply=(status,body)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(body));};
  if(req.url!=="/mcp"||req.headers.authorization!=="Bearer "+this.token)return reply(401,{error:"unauthorized"});
  if(req.method==="GET"){res.writeHead(405);return res.end();}
  if(req.method==="DELETE"){res.writeHead(200);return res.end();}
  if(req.method!=="POST")return reply(405,{error:"method"});
  let size=0,chunks=[];for await(const data of req){size+=data.length;if(size>2*1024*1024)return reply(413,{error:"too_large"});chunks.push(data);}
  let msg;try{msg=JSON.parse(Buffer.concat(chunks));}catch{return reply(400,{error:"invalid_json"});}
  if(msg.id==null){res.writeHead(202);return res.end();}
  let result;
  if(msg.method==="initialize")result={protocolVersion:msg.params?.protocolVersion||"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"CCCDroid host tools",version:"1"}};
  else if(msg.method==="ping")result={};
  else if(msg.method==="tools/list")result={tools:this.registry.specs().filter(s=>this.allowed(s.name)).map(s=>({name:s.name,description:(this.interactions?.handles(s.name)?"Parent thread only; child agents cannot call this tool. ":"")+s.description,inputSchema:s.inputSchema,annotations:{readOnlyHint:toolEffect(s.name)==="read",destructiveHint:toolEffect(s.name)!=="read",openWorldHint:toolEffect(s.name)==="execute"}}))};
  else if(msg.method==="tools/call"){
   const params=msg.params||{},callId="auto-mcp-"+(++this.seq);
   if(!this.active()||!this.allowed(params.name))result={isError:true,content:[{type:"text",text:"No active matching CCCDroid turn."}]};
   else{
    const interactive=this.interactions?.handles(params.name)===true;
    const interaction=interactive?await this.interactions.takeWhenReady(params.name,params.arguments||{},params._meta):null;
    const scoped=this.fileEdits?.handles(params.name,params._meta)===true;
    const edit=scoped?this.fileEdits.take(params.name,params.arguments||{},params._meta):null;
    if(interactive&&!interaction)result={isError:true,content:[{type:"text",text:"This UI tool requires a matching active parent-thread call. Child agents cannot change the main plan or ask the user."}]};
    else if(scoped?!edit:toolEffect(params.name)!=="read"&&!this.authorize(params.name,params.arguments||{},params._meta))
      result={isError:true,content:[{type:"text",text:scoped?"宿主操作未获得匹配的线程、轮次和操作批准，宿主没有执行；请勿绕过或重试同一动作。":"自动审核尚未明确批准这项原始操作，宿主没有执行；请勿绕过或重试同一动作。"}]};
    else{
     this.executing.add(callId);if(edit)this.editCalls.set(callId,edit);if(interaction)this.interactionCalls.set(callId,interaction);
     try{const r=await this.registry.handleCall({tool:params.name,callId,arguments:params.arguments||{}});if(edit)this.onEditResult({name:params.name,origin:edit,result:r});result={isError:!r.success,content:(r.contentItems||[]).map(mcpContent)};}
     finally{this.executing.delete(callId);this.editCalls.delete(callId);this.interactionCalls.delete(callId);}
    }
   }
  }else return reply(200,{jsonrpc:"2.0",id:msg.id,error:{code:-32601,message:"Unsupported method"}});
  return reply(200,{jsonrpc:"2.0",id:msg.id,result});
 }
 async close(){const s=this.server;this.server=null;if(s){s.closeAllConnections();await new Promise(r=>s.close(r));}this.token="";}
}
export function actionFingerprint(name,args){
 const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
 return crypto.createHash("sha256").update(JSON.stringify([name,stable(args)])).digest("hex");
}

function mcpContent(c){
 if(c?.type==="inputImage"){
  const match=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(c.imageUrl||"");
  if(match)return {type:"image",mimeType:match[1],data:match[2]};
 }
 return {type:"text",text:typeof c?.text==="string"?c.text:"[non-text result]"};
}
