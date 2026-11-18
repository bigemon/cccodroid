import assert from "node:assert/strict";
import {historyPage,nativeTurnItems,mergeRecoveredHistory} from "../gw/codex/history-view.mjs";
import {forkBoundary} from "../gw/codex/fork-boundary.mjs";
let n=0;function check(name,fn){fn();console.log("ok "+(++n)+" "+name);}
const items=Array.from({length:1300},(_,i)=>[{role:"user",text:"same",turnId:"t"+i},{role:"assistant",text:"A"+i,turnId:"t"+i}]).flat();
const h={items,complete:true,epoch:"e"};
const page=q=>historyPage(h,new URLSearchParams(q));
check("长历史默认只返回最新页",()=>{const p=page("");assert.equal(p.items.length,40);assert.equal(p.cursor,2560);assert.equal(p.items[0].historyIndex,2560);});
check("向前与向后分页覆盖全部历史且无重复",()=>{
 let before,all=[];do{const p=page(before==null?"":"before="+before);all=[...p.items,...all];before=p.cursor;}while(before);assert.equal(all.length,items.length);assert.equal(all[0].text,"same");assert.equal(all[1].text,"A0");
 let cursor=0,forward=[];do{const p=page("after="+cursor+"&limit=60");forward.push(...p.items);cursor=p.next;}while(cursor<items.length);assert.equal(forward.length,2600);
});
check("页边界不会拆开同轮工具结果",()=>{const p=historyPage({items:[{role:"user"},...Array(90).fill({role:"tool_use"}),{role:"user"}],epoch:"e"},new URLSearchParams("after=0&limit=10"));assert.equal(p.next,91);});
check("截取 SSE 正在重放的轮次",()=>assert.equal(historyPage(h,new URLSearchParams(),{liveStart:2500}).size,2500));
check("按运行起点排除已显示的后续轮次",()=>{const h2={...h,items:items.map((m,i)=>({...m,runStartedAt:i>=2500?100:0}))};assert.equal(historyPage(h2,new URLSearchParams("exclude=100")).size,2500);});
check("非法位置与旧版本位置拒绝",()=>{for(const q of["before=-1","after=99999","before=NaN","historyEpoch=old"])assert.throws(()=>page(q));});
check("长历史支持持久化位置分叉，忽略可见消息计数",()=>assert.equal(forkBoundary(items,{userText:"same",after:0,itemIndex:200,historyEpoch:"e"},h).lastTurnId,"t100"));
check("过期持久化位置不会猜测",()=>assert.throws(()=>forkBoundary(items,{userText:"same",itemIndex:200,historyEpoch:"old"},h)));
check("完整性缺失时仍拒绝分叉",()=>assert.throws(()=>forkBoundary(items,{userText:"same",after:0},{...h,complete:false})));
const turns=[{id:"t0",status:"completed",items:[{type:"userMessage",id:"u0",content:[{type:"text",text:"Q0"}]},{type:"agentMessage",id:"a0",text:"A0",phase:"final_answer"}]},
{id:"t1",status:"completed",items:[{type:"userMessage",id:"u1",content:[{type:"text",text:"Q1"}]},{type:"agentMessage",id:"a1",text:"A1"}]}];
check("只读取公开推理摘要",()=>{const r=nativeTurnItems({id:"r",items:[{type:"reasoning",id:"rr",summary:["public"],content:["HIDDEN"]}]});assert.equal(r.length,1);assert.equal(r[0].text,"public");assert(!JSON.stringify(r).includes("HIDDEN"));});
check("工具输出与附件映射",()=>{const r=nativeTurnItems({id:"r",items:[{type:"userMessage",id:"u",content:[{type:"localImage",path:"/a.png"}]},{type:"dynamicToolCall",id:"c",tool:"read",arguments:{},success:true,contentItems:[{type:"inputText",text:"result"}]}]});assert.equal(r[0].text,"@/a.png");assert.equal(r[2].text,"result");});
check("恢复补回前缀并保留完整宿主轮次",()=>{const local=[{role:"user",text:"Q1",turnId:"t1"},{role:"assistant",text:"PARTIAL",turnId:"t1",itemId:"a1",hostProperty:true},{role:"command",id:"extra",turnId:"t1"}];const r=mergeRecoveredHistory(turns,local);assert.equal(r[0].text,"Q0");assert.equal(r[3].text,"A1");assert(r[3].hostProperty);assert.equal(r[4].id,"extra");});
check("残缺首轮用完整核心记录恢复",()=>{const r=mergeRecoveredHistory(turns,[{role:"assistant",text:"PARTIAL",turnId:"t0"}]);assert.equal(r[0].text,"Q0");assert.equal(r[1].text,"A0");});
check("无法对齐的用户记录不会被覆盖",()=>{assert.throws(()=>mergeRecoveredHistory(turns,[{role:"user",text:"Q1"}]));assert.throws(()=>mergeRecoveredHistory(turns,[{role:"user",text:"wrong",turnId:"t1"}]));});
check("重复轮次、空核心与运行中记录拒绝",()=>{assert.throws(()=>mergeRecoveredHistory([...turns,turns[0]],[]));assert.throws(()=>mergeRecoveredHistory([],[{role:"user"}]));assert.throws(()=>nativeTurnItems({id:"a",status:"inProgress",items:[]}));});
check("带原文路径的原生图片不会重复追加而破坏合并",()=>{const t={id:"image",items:[{type:"userMessage",id:"u",content:[{type:"text",text:"看图 @/a.png"},{type:"localImage",path:"/a.png"}]}]};const r=mergeRecoveredHistory([t],[{role:"user",text:"看图 @/a.png",turnId:"image"}]);assert.equal(r[0].text,"看图 @/a.png");});
check("小数页大小也按整数安全读取",()=>assert.equal(page("after=0&limit=10.5").next,10));
check("宿主半段回复由核心终态补全并补回未保存条目",()=>{const local=[{role:"user",text:"Q1",turnId:"t1"},{role:"assistant",text:"PART",turnId:"t1",itemId:"a1"}];const extra={...turns[1],items:[...turns[1].items,{type:"agentMessage",id:"a2",text:"FINAL"}]};const r=mergeRecoveredHistory([turns[0],extra],local);assert.equal(r[3].text,"A1");assert.equal(r[4].text,"FINAL");assert(!JSON.stringify(r).includes("PART"));});
console.log(n+"/"+n+" history unit checks passed");
