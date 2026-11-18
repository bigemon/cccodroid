import {anchoredItems,locateAnchor} from "./message-anchors.mjs";
import {normalizeAsyncQuestions} from "./async-questions.mjs";
import {CodexSubagents} from "./subagents.mjs";
import {generatedImageRecords} from "./generated-images.mjs";
import {historicalSleepRecords} from "./sleep.mjs";
// 宿主历史分页。位置为持久化数组下标，与 DOM 中可见的消息数量无关。
const fail = message => {throw Object.assign(new Error(message),{status:409});};
export function historyPage(history, params, {liveStart} = {}) {
  const all=history.items;
  if(params.has("historyEpoch")&&params.get("historyEpoch")!==history.epoch)fail("历史记录已更新，请重新打开会话。");
  const anchor=params.get("anchor");
  const target=anchor&&anchor!=="start"?locateAnchor(history,anchor):null;
  if(anchor&&anchor!=="start"&&!target)throw Object.assign(new Error("找不到书签的位置。"),{status:404,code:"anchor not found"});
  const num = key => {
    const raw=params.get(key);
    if(raw==null||raw==="")return null;
    const n=Number(raw);if(!Number.isSafeInteger(n)||n<0)fail("历史位置无效，请重新打开会话。");
    return n;
  };
  const limit=Math.min(200,Math.max(10,Math.floor(Number(params.get("limit")))||40));
  let size=all.length;
  if(Number.isSafeInteger(liveStart))size=Math.min(size,liveStart);
  const exclude=Number(params.get("exclude"))||0;
  if(exclude>0){const cut=all.findIndex(m=>m.runStartedAt>=exclude);if(cut>=0)size=Math.min(size,cut);}
  let from,to,next;
  const after=num("after"),before=num("before");
  if(after!=null||params.has("anchor")){
    from=target?.index??after??0;
    if(target) { if(from>=size)throw Object.assign(new Error("书签所在内容尚未保存或正在重放。"),{status:404,code:"anchor not found"}); while(from>0&&all[from].role!=="user")from--; }
    if(from>size)fail("历史位置已变化，请重新打开会话。");
    to=Math.min(size,from+limit);
    while(to<size&&all[to].role!=="user")to++;
    next=to;
  }else{
    to=before??size;
    if(to>size)fail("历史位置已变化，请重新打开会话。");
    from=Math.max(0,to-limit);
    while(from>0&&all[from].role!=="user")from--;
  }
  return {items:anchoredItems(history,from,to).map((m,i)=>m.role==="user"?{...m,historyIndex:from+i,historyEpoch:history.epoch}:m),
    cursor:from,next,size,historyEpoch:history.epoch,historyComplete:history.complete,historySource:history.source||"host"};
}

const flatten = blocks => (blocks||[]).map(c=>typeof c?.text==="string"?c.text:c?.type==="localImage"?"@"+c.path:["image","inputImage"].includes(c?.type)?"[图片附件]":"").filter(Boolean).join("\n");
export function nativeTurnItems(turn,{imageStore}={}) {
  if(!turn?.id||!Array.isArray(turn.items)||["inProgress","in_progress"].includes(turn.status))fail("核心历史尚未完整落盘，请等任务结束后重试。");
  const out=[],push=m=>out.push({...m,turnId:turn.id});
  const parent=turn.items.find(i=>i.type==="collabAgentToolCall")?.senderThreadId||"core-history";
  const subagents=new CodexSubagents({threadId:()=>parent,turnId:()=>turn.id,push:r=>out.push(r),emit:()=>{}});
  for(const item of turn.items) {
    if(!item||typeof item.type!=="string")fail("核心返回了无法识别的历史记录。");
    if(subagents.handle("item/completed",{threadId:parent,turnId:turn.id,item}))continue;
    const base={itemId:item.id,turnId:turn.id};
    switch(item.type) {
      case "userMessage": {
        // Codex 输入已保留原文 @路径；不把原生图片再追加一遍，避免旧附件消息无法对齐。
        const text=(item.content||[]).filter(c=>c.type==="text").map(c=>c.text||"").join("\n");
        push({role:"user",text:text||flatten(item.content),...base});break;
      }
      case "agentMessage":case "plan":push({role:"assistant",text:item.text||"",phase:item.type==="plan"?"plan":item.phase||null,...(item.type==="agentMessage"?{questions:normalizeAsyncQuestions(item.questions)}:{}),...base});break;
      case "reasoning":for(const [index,text]of(item.summary||[]).entries())push({role:"thinking",text,summaryOnly:true,summaryIndex:index,...base});break;
      case "dynamicToolCall":
        push({role:"tool_use",id:item.id,name:item.tool,input:item.arguments??{}});
        if(item.contentItems!=null)push({role:"tool_result",id:item.id,ok:item.success===true,text:flatten(item.contentItems)});
        break;
      case "commandExecution":
        push({role:"tool_use",id:item.id,name:"command",input:{command:item.command,cwd:item.cwd}});
        push({role:"tool_result",id:item.id,ok:item.exitCode===0,text:item.aggregatedOutput||""});break;
      case "mcpToolCall":
        push({role:"tool_use",id:item.id,name:item.server+"/"+item.tool,input:item.arguments??{}});
        push({role:"tool_result",id:item.id,ok:!item.error,text:item.error?.message||flatten(item.result?.content)});break;
      case "sleep":for(const record of historicalSleepRecords(item,turn))push(record);break;
      case "imageGeneration":for(const record of generatedImageRecords(item,{turnId:turn.id,store:imageStore}))push(record);break;
      case "contextCompaction":push({role:"note",text:"上下文已压缩",compact:true});break;
      case "enteredReviewMode":push({role:"note",text:"开始审查"});break;
      case "exitedReviewMode":push({role:"review",id:turn.id+":review",status:"completed",text:item.review||""});break;
      case "hookPrompt":break; // 不展示注入的内部提示。
      default:push({role:"note",text:"核心历史记录："+item.type});break;
    }
  }
  subagents.finish();
  return out;
}

// 核心负责轮次顺序；可完整匹配的宿主轮次保留原卡片与附件显示。
export function mergeRecoveredHistory(turns, local, options={}) {
  const seen=new Set();
  const core=turns.map(t=>{
    if(seen.has(t.id))fail("核心历史出现重复轮次，原记录已保留。");
    seen.add(t.id);return {id:t.id,items:nativeTurnItems(t,options)};
  });
  if(!core.length&&local.length)fail("核心未返回已有历史，原记录已保留。");
  const groups=new Map();let current=null,leading=[];
  for(const m of local){
    if(m.role==="user"){
      current={items:[],ids:new Set()};
      groups.set(groups.size,current);
    }
    if(!current){leading.push(m);continue;}
    current.items.push(m);if(m.turnId)current.ids.add(m.turnId);
  }
  const overlays=new Map(),unmatched=[];
  for(const group of groups.values()){
    if(group.ids.size!==1){unmatched.push(group);continue;}
    const id=[...group.ids][0];
    if(!seen.has(id))fail("界面记录包含核心中找不到的轮次，原记录已保留。");
    if(!overlays.has(id))overlays.set(id,[]);
    overlays.get(id).push(...group.items);
  }
  // 不猜测无标识的旧用户消息；明确拒绝，避免覆盖有效记录。
  if(unmatched.length)fail("旧记录缺少可靠轮次标识，无法安全合并历史，原记录已保留。");
  const result=[];
  for(const block of core){
    const host=overlays.get(block.id);
    if(host){
      const users=x=>x.filter(m=>m.role==="user").map(m=>m.text);
      const nativeUsers=users(block.items),hostUsers=users(host);
      if(nativeUsers.length&&JSON.stringify(nativeUsers)!==JSON.stringify(hostUsers))fail("核心与界面的用户消息不一致，原记录已保留。");
      // 核心完整 item 是正文终态；旧宿主快照可能只保存了用户插话或半段回复。
      // 同标识记录合并，保留附件原文及宿主独有卡片，不让部分旧回复覆盖完整核心正文。
      const key=m=>m.role==="thinking" ? "thinking:"+m.itemId+":"+(m.summaryIndex||0)
        : m.itemId||m.id ? m.role+":"+(m.itemId||m.id) : null;
      const keyed=new Map(host.map(m=>[key(m),m]).filter(([k])=>k));
      const used=new Set(),hostMessages=host.filter(m=>m.role==="user");
      let userIndex=0;
      if(!nativeUsers.length)for(const m of hostMessages){result.push(m);used.add(m);}
      for(const item of block.items){
        let prior;
        if(item.role==="user")prior=hostMessages[userIndex++];
        else if(key(item))prior=keyed.get(key(item));
        else if(item.compact)prior=host.find(m=>m.compact);
        if(prior)used.add(prior);
        result.push(prior ? {...prior,...item,...(item.role==="user"?{text:prior.text}:{})} : item);
      }
      // 早期未带 itemId 的同文正文可以去重，无法识别的宿主扩展仍保留。
      for(const m of host)if(!used.has(m)&&!block.items.some(c=>!key(m)&&c.role===m.role&&c.text===m.text))result.push(m);
    }else result.push(...block.items);
  }
  // 旧截尾可能从一轮中间开始：正文以核心完整轮次重建，宿主独有的卡片补回原轮。
  if(leading.length){
    const ids=new Set(leading.map(m=>m.turnId).filter(Boolean));
    if(ids.size!==1||!seen.has([...ids][0]))fail("历史开头的残缺片段无法定位，原记录已保留。");
    const id=[...ids][0],extras=leading.filter(m=>["command","diff"].includes(m.role));
    const first=result.findIndex(m=>m.turnId===id);
    if(first>=0){let end=first;while(end<result.length&&result[end].turnId===id)end++;result.splice(end,0,...extras);}
  }
  return result;
}
