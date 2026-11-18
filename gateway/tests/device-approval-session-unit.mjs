import fs from "node:fs";import os from "node:os";import assert from "node:assert/strict";import {fakeCodexBin} from "./helpers/fake-codex-bin.mjs";
const root=fs.mkdtempSync(os.tmpdir()+"/device-approval-session-");Object.assign(process.env,{CCAPP_TEST:"1",CCAPP_HOME:root,CCAPP_WORKSPACE:root,CCAPP_LOG:root+"/log"});
const {CodexSession}=await import("../gw/codex/session.mjs");
const s=new CodexSession({cwd:root,bin:fakeCodexBin(root+"/bin"),codexHome:root,dataDir:root,permissionMode:"bypassPermissions",deviceMcpScript:root+"/missing-device"});
let n=0,cards=0;const check=async(label,fn)=>{await fn();console.log("ok "+(++n)+" "+label);};
try{
 await s.start();await s.ensureThread();s.device={state:"enabled",name:"cccodroid_device_0123abcd"};
 const request=(mode="bypassPermissions",change=()=>{})=>{s.toolPolicy.setMode(mode);s.turn={id:"turn",nativeApprovalIds:new Set()};const msg={id:n+1,method:"mcpServer/elicitation/request",params:{threadId:s.sessionId,turnId:"turn",serverName:s.device.name,mode:"form",message:"Approve device action",requestedSchema:{type:"object",properties:{}},_meta:{codex_approval_kind:"mcp_tool_call",tool_params:{node:1}}}};change(msg);return s.client.onServerRequest(msg);};
 s.onNativeApproval=async()=>{cards++;return {action:"decline"};};
 await check("受管设备全部放行不调用人工审批，并记录执行状态",async()=>{assert.equal((await request()).action,"accept");assert.equal(cards,0);assert(s.turn.nativeApprovedExecuting);});
 await check("受管设备在无人工回调时也能全部放行",async()=>{const callback=s.onNativeApproval;s.onNativeApproval=null;assert.equal((await request()).action,"accept");s.onNativeApproval=callback;});
 await check("其他 MCP 在全部放行下仍走其明确审批",async()=>{assert.equal((await request("bypassPermissions",m=>m.params.serverName="ordinary_mcp")).action,"decline");assert.equal(cards,1);});
 await check("逐项确认与接受编辑仍需人工审批",async()=>{for(const mode of ["default","acceptEdits"]){const before=cards;assert.equal((await request(mode)).action,"decline");assert.equal(cards,before+1);}});
 await check("计划模式、审查和停止状态不放行",async()=>{const before=cards;assert.equal((await request("plan")).action,"decline");for(const key of ["review","stopping","finished"])assert.equal((await request("bypassPermissions",()=>s.turn[key]=true)).action,"decline");assert.equal(cards,before);});
 await check("其他线程或轮次不能借用设备全部放行",async()=>{for(const key of ["threadId","turnId"])assert.equal((await request("bypassPermissions",m=>m.params[key]="foreign")).action,"decline");});
 await check("设备服务的交互表单不会被当作空批准自动提交",async()=>{assert.equal((await request("bypassPermissions",m=>m.params.requestedSchema.properties.value={type:"string"})).action,"decline");});
 await check("重复审批不重复放行，禁用设备不借用旧豁免",async()=>{let msg;await request("bypassPermissions",m=>msg=m);assert.equal((await s.client.onServerRequest(msg)).action,"cancel");s.device.state="disabled";const before=cards;assert.equal((await request()).action,"decline");assert.equal(cards,before+1);});
}finally{s.turn=null;await s.dispose();}
console.log(n+"/"+n+" passed");process.exit(0);
