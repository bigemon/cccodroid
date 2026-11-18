import assert from "node:assert/strict";
import { CodexProgress, normalizePlan, visiblePlan, planTasks } from "../gw/codex/progress.mjs";
import { buildToolRegistry } from "../gw/codex/tools/index.mjs";
import { codexToolPolicy } from "../gw/codex/permissions.mjs";
import { safeConfig } from "../gw/codex/diagnostic-view.mjs";
let n=0;
function test(name,fn){fn();console.log("ok "+name);n++;}
test("计划不将未知状态或轮次结束冒充完成",()=>{
 const p=normalizePlan({turnId:"t",plan:[{step:"A",status:"completed"},{step:"B",status:"invalid"},{step:"C",status:"inProgress"}]});
 assert.equal(planTasks(p)[1].status,"pending");assert.equal(planTasks(p)[2].status,"in_progress");assert.equal(visiblePlan(p,false).status,"interrupted");
 assert.equal(visiblePlan(p,true).status,"running");assert.equal(normalizePlan({plan:[]}),null);
});
test("多个消息与摘要索引分别累积，最终全文覆盖草稿且不重复",()=>{
 const items=[],events=[],p=new CodexProgress({turnId:()=>"t",push:i=>items.push(i),emit:e=>events.push(e)});
 p.handle("item/started",{item:{type:"agentMessage",id:"a",phase:"commentary"}});
 p.handle("item/agentMessage/delta",{itemId:"a",delta:"A"});
 p.handle("item/agentMessage/delta",{itemId:"b",delta:"B"});
 p.handle("item/agentMessage/delta",{itemId:"a",delta:"2"});
 p.handle("item/completed",{item:{type:"agentMessage",id:"a",text:"A2",phase:"commentary"}});
 p.handle("item/completed",{item:{type:"agentMessage",id:"b",text:"B-final",phase:"final_answer"}});
 p.handle("item/reasoning/summaryTextDelta",{itemId:"r",summaryIndex:0,delta:"S0"});
 p.handle("item/reasoning/summaryTextDelta",{itemId:"r",summaryIndex:1,delta:"S1"});
 p.handle("item/completed",{item:{type:"reasoning",id:"r",summary:["S0","S1"],content:["PRIVATE"]}});
 assert.deepEqual(items.map(i=>i.text),["A2","B-final","S0","S1"]);
 assert.equal(items[1].phase,"final_answer");assert.equal(items[2].summaryOnly,true);
 assert(!JSON.stringify({items,events}).includes("PRIVATE"));
 assert.equal(events.filter(e=>e.itemId==="a"&&e.type==="assistant_text").length,0);
});
test("计划最终正文不依赖增量拼接一致性",()=>{
 const items=[],p=new CodexProgress({turnId:()=>"t",push:i=>items.push(i),emit:()=>{}});
 p.handle("item/plan/delta",{itemId:"p",delta:"draft"});
 p.handle("item/completed",{item:{type:"plan",id:"p",text:"authoritative"}});
 assert.equal(items.length,1);assert.equal(items[0].text,"authoritative");assert.equal(items[0].phase,"plan");
});
test("仅白名单配置及来源类别可离开诊断映射",()=>{
 const got=safeConfig({config:{model:"safe",instructions:"SECRET",model_providers:{token:"SECRET"},api_key:"SECRET"},origins:{model:{name:{type:"user",file:"SECRET"},version:"SECRET"}}});
 assert.deepEqual(got,{model:{value:"safe",source:"user"}});assert(!JSON.stringify(got).includes("SECRET"));
});
const calls=[];
const policy=codexToolPolicy({mode:"plan"});
const {registry}=buildToolRegistry({roots:[process.cwd()],beforeCall:p=>policy.authorize(p),updatePlan:p=>calls.push(p)});
let reply=await registry.handleCall({callId:"plan1",tool:"cccodroid_update_plan",arguments:{plan:[{step:"Inspect",status:"in_progress"}]}});
test("计划模式可以更新任务清单，不需要文件或脚本权限",()=>{assert.equal(reply.success,true);assert.equal(calls.length,1);});
reply=await registry.handleCall({callId:"plan2",tool:"cccodroid_update_plan",arguments:{plan:[{step:"A",status:"in_progress"},{step:"B",status:"in_progress"}]}});
test("无效计划不会改变已发布状态",()=>{assert.equal(reply.success,false);assert.equal(calls.length,1);});
console.log(n+"/"+n+" passed");
