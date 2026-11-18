import assert from "node:assert/strict";
import {normalizeAsyncQuestions,HOST_INTERACTION_INSTRUCTIONS} from "../gw/codex/async-questions.mjs";
import {CodexProgress} from "../gw/codex/progress.mjs";
import {nativeTurnItems,mergeRecoveredHistory} from "../gw/codex/history-view.mjs";
let n=0;const check=(name,fn)=>{fn();console.log("ok "+(++n)+" "+name);};
const questions=[{title:"选择方案",options:["内部","外部"]},{title:"补充",options:null}];
const normalized=[{title:"选择方案",options:["内部","外部"]},{title:"补充",options:[]}];
check("异步问题按真实原生 title/options 结构解析并保留自由回答",()=>assert.deepEqual(normalizeAsyncQuestions(questions),normalized));
check("无效/过长字段拒绝，未知字段不透传",()=>{
 assert.deepEqual(normalizeAsyncQuestions([null,{title:""},{title:"x".repeat(4001)},{title:"A",options:["ok",null,""],secret:"hidden"}]),[{title:"A",options:["ok"]}]);
 assert.equal(normalizeAsyncQuestions(Array(20).fill({title:"A"})).length,10);
});
check("只有问题、没有文字的消息也发送事件并持久化",()=>{
 const items=[],events=[],p=new CodexProgress({turnId:()=>"t",push:i=>items.push(i),emit:e=>events.push(e)});
 const item={id:"a",type:"agentMessage",text:"",phase:"commentary",questions};
 p.handle("item/completed",{item});p.handle("item/completed",{item});
 assert.equal(items.length,1);assert.equal(events.length,1);
 assert.deepEqual(items[0].questions,normalized);assert.deepEqual(events[0].questions,normalized);
});
check("正文相同而问题新增/修改时不会被去重吞掉",()=>{
 const items=[],events=[],p=new CodexProgress({turnId:()=>"t",push:i=>items.push(i),emit:e=>events.push(e)});
 p.handle("item/started",{item:{id:"a",type:"agentMessage",phase:"commentary"}});
 p.handle("item/agentMessage/delta",{itemId:"a",delta:"请选择"});
 p.handle("item/completed",{item:{id:"a",type:"agentMessage",phase:"commentary",text:"请选择",questions}});
 assert.deepEqual(events.at(-1).questions,normalized);assert.equal(items.length,1);
 p.handle("item/completed",{item:{id:"a",type:"agentMessage",phase:"commentary",text:"请选择",questions:[]}});
 assert.deepEqual(events.at(-1).questions,[]);
});
check("核心历史恢复补回问题字段，覆盖旧宿主缺失字段",()=>{
 const turn={id:"t",status:"completed",items:[{id:"u",type:"userMessage",content:[{type:"text",text:"Q"}]},{id:"a",type:"agentMessage",text:"",questions}]};
 assert.deepEqual(nativeTurnItems(turn)[1].questions,normalized);
 assert.deepEqual(mergeRecoveredHistory([turn],[{role:"user",text:"Q",turnId:"t"},{role:"assistant",itemId:"a",turnId:"t",text:""}])[1].questions,normalized);
});
check("宿主默认指导提供普通模式可用的阻塞提问工具，accepted 不算用户回答",()=>{
 assert.match(HOST_INTERACTION_INSTRUCTIONS,/cccodroid_ask_user/);assert.match(HOST_INTERACTION_INSTRUCTIONS,/normal and plan/);assert.match(HOST_INTERACTION_INSTRUCTIONS,/Never treat an accepted/);
});
console.log(n+"/"+n+" passed");
