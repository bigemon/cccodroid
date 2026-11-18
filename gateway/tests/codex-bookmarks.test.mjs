import "../gw/config.mjs";
import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {Readable} from "node:stream";
import {CFG,PATHS} from "../gw/config.mjs";
import {upsertCodexSession,saveItems,readHistory,CODEX_DIR,trashCodexRecord,restoreCodexTrash} from "../gw/codex/store.mjs";
import {anchorEntries,locateAnchor,userBookmarkAnchor,assistantBookmarkAnchor} from "../gw/codex/message-anchors.mjs";
import {historyPage,mergeRecoveredHistory} from "../gw/codex/history-view.mjs";
import {routeBookmarks,forgetBookmarks} from "../gw/bookmarks.mjs";
import {purgeTrash} from "../gw/sessionops.mjs";
import {NAMES} from "../gw/sessions.mjs";
const file=path.join(CFG.home,"ccapp-bookmarks.json"),index=path.join(CODEX_DIR,"sessions.json");
fs.mkdirSync(PATHS.projects,{recursive:true});
const create=(items,opts={})=>{
 const id=randomUUID();upsertCodexSession({id,threadId:id,title:"Codex fixture",cwd:CFG.workspace});
 assert(saveItems(id,items,{complete:true,...opts}));return id;
};
const messages=()=>[{role:"user",text:"same",turnId:"t",bookmarkId:randomUUID()},
 {role:"assistant",text:"same\n\nsecond",turnId:"t",itemId:"a",phase:"commentary"},
 {role:"assistant",text:"same\n\nsecond",turnId:"t",itemId:"b",phase:"final_answer"}];
async function call(method,url,body){
 const req=Object.assign(Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]),{method});
 const u=new URL(url,"http://isolated.invalid"),res={code:0,writeHead(c){this.code=c;},end(b){this.body=JSON.parse(b);}};
 await routeBookmarks(req,res,u,u.pathname);return res;
}
const list=id=>call("GET","/api/bookmarks?session="+id+"&backend=codex");
const add=(id,a,more={})=>call("POST","/api/bookmarks",{session:id,backend:"codex",uuid:a.uuid,role:a.item.role,para:1,excerpt:"fixture",...more});
test("重复正文和同轮多条用户输入使用不同身份，普通追加不改旧锚点",()=>{
 const items=[{role:"user",text:"same",turnId:"t"},{role:"user",text:"same",turnId:"t"},...messages()];
 const id=create(items),before=anchorEntries(readHistory(id)).map(a=>a.uuid);
 assert.equal(new Set(before).size,before.length);assert(saveItems(id,[...items,{role:"user",text:"later"}]));
 assert.deepEqual(anchorEntries(readHistory(id)).slice(0,before.length).map(a=>a.uuid),before);
});
test("旧无 ID 历史的身份跨首次升级保存稳定，重建 epoch 后明确失效",()=>{
 const id=create([]),historyFile=path.join(CODEX_DIR,id+".json");
 const items=[{role:"user",text:"same"},{role:"assistant",text:"old"}];
 fs.writeFileSync(historyFile,JSON.stringify({items}));const anchor=anchorEntries(readHistory(id))[1].uuid;
 fs.writeFileSync(historyFile,JSON.stringify({items,epoch:"legacy"}));assert.equal(anchorEntries(readHistory(id))[1].uuid,anchor);
 assert(saveItems(id,[...items,{role:"user",text:"new"}]));assert(locateAnchor(readHistory(id),anchor));
 assert(saveItems(id,items,{newEpoch:true}));assert.equal(locateAnchor(readHistory(id),anchor),null);
});
test("原生回复 ID 和宿主用户 ID 在核心历史恢复后保持，重复原生 ID 拒绝歧义",()=>{
 const local=messages(),h={epoch:"one",items:local},old=anchorEntries(h).map(x=>x.uuid);
 const turns=[{id:"t",status:"completed",items:[{type:"userMessage",id:"u",content:[{type:"text",text:"same"}]},
 {type:"agentMessage",id:"a",text:local[1].text},{type:"agentMessage",id:"b",text:local[2].text}]}];
 const rebuilt={epoch:"two",items:mergeRecoveredHistory(turns,local)};
 assert.deepEqual(anchorEntries(rebuilt).map(x=>x.uuid),old);
 assert.equal(locateAnchor({epoch:"e",items:[local[1],local[1]]},old[1]),null);
});
test("跨页定位包含目标整轮；缺失目标返回 anchor not found；当前新轮不阻挡旧回复",()=>{
 const items=Array.from({length:160},(_,i)=>[{role:"user",text:"Q",turnId:"t"+i},{role:"assistant",text:"A",turnId:"t"+i,itemId:"a"+i}]).flat();
 const h={epoch:"e",items},a=anchorEntries(h)[81];
 const p=historyPage(h,new URLSearchParams({anchor:a.uuid}),{liveStart:300});
 assert.equal(p.cursor,80);assert(p.items.some(m=>m.uuid===a.uuid));
 assert.throws(()=>historyPage(h,new URLSearchParams({anchor:assistantBookmarkAnchor("missing","a")})),e=>e.status===404&&e.code==="anchor not found");
 assert.throws(()=>historyPage(h,new URLSearchParams({anchor:anchorEntries(h)[301].uuid}),{liveStart:300}),e=>e.code==="anchor not found");
});
test("用户/多阶段回复均可添加、去重、列出、删除，宿主原始历史不被改写",async()=>{
 const id=create(messages()),before=fs.readFileSync(path.join(CODEX_DIR,id+".json")),anchors=anchorEntries(readHistory(id));
 for(const a of anchors){const r=await add(id,a);assert.equal(r.code,200);assert.equal(r.body.item.backend,"codex");assert.equal(r.body.item.off,-1);}
 const dup=await add(id,anchors[1]);assert.equal((await list(id)).body.items.length,3);
 const global=await call("GET","/api/bookmarks");assert.equal(global.body.items.find(b=>b.id===dup.body.item.id).title,"Codex fixture");
 assert.deepEqual(fs.readFileSync(path.join(CODEX_DIR,id+".json")),before);
 assert.equal((await call("POST","/api/bookmarks/del",{id:dup.body.item.id})).body.removed,1);
 assert.equal((await list(id)).body.items.length,2);
});
test("实时/历史使用相同别名；旧事件只允许精确 turn/item 回退，文本猜测被拒绝",async()=>{
 const id=create(messages()),anchors=anchorEntries(readHistory(id));
 assert.equal(anchors[0].uuid,userBookmarkAnchor(readHistory(id).items[0].bookmarkId));
 assert.equal(anchors[1].uuid,assistantBookmarkAnchor("t","a"));
 const exact=await add(id,anchors[1],{uuid:"",turnId:"t",itemId:"a"});assert.equal(exact.code,200);assert.equal(exact.body.item.uuid,anchors[1].uuid);
 const guess=await add(id,anchors[1],{uuid:"",head:"same",nth:0});assert.equal(guess.code,409);assert.equal(guess.body.error,"message_not_saved");
 const pending=await add(id,anchors[1],{uuid:assistantBookmarkAnchor("t","not-saved")});assert.equal(pending.body.error,"message_not_saved");
});
test("重命名、回收站隐藏/恢复、彻底删除定向清理，不触碰 Claude 资料",async()=>{
 const id=create(messages()),a=anchorEntries(readHistory(id))[1];await add(id,a);NAMES[id]="Renamed";
 let r=await call("GET","/api/bookmarks");assert.equal(r.body.items.find(b=>b.sid===id).title,"Renamed");
 const sentinel=path.join(PATHS.projects,"-codex-purge-sentinel");fs.mkdirSync(sentinel,{recursive:true});
 const other=path.join(sentinel,id+".jsonl");fs.writeFileSync(other,"Claude sentinel");
 assert(trashCodexRecord(id).ok);r=await call("GET","/api/bookmarks");assert(!r.body.items.some(b=>b.sid===id));
 assert.equal((await list(id)).body.items.length,1);assert(restoreCodexTrash(id).ok);
 assert((await call("GET","/api/bookmarks")).body.items.some(b=>b.sid===id));
 assert(trashCodexRecord(id).ok);assert.equal(await purgeTrash([id]),1);assert.equal((await list(id)).body.items.length,0);
 assert.equal(fs.readFileSync(other,"utf8"),"Claude sentinel");fs.unlinkSync(other);
});
test("Codex 索引损坏/缺失不会清除书签；索引无法读取时拒绝新增",async()=>{
 const id=create(messages()),a=anchorEntries(readHistory(id))[1];await add(id,a);
 const original=fs.readFileSync(index),marks=fs.readFileSync(file);
 try{
  fs.writeFileSync(index,"broken");
  const r=await call("GET","/api/bookmarks");assert(r.body.unreadable);assert(r.body.items.some(b=>b.sid===id&&b.unavailable));
  assert.deepEqual(fs.readFileSync(file),marks);assert.equal((await add(id,a)).code,503);
  fs.unlinkSync(index);assert((await call("GET","/api/bookmarks")).body.items.some(b=>b.sid===id));
  assert.deepEqual(fs.readFileSync(file),marks);
 }finally{fs.writeFileSync(index,original);}
});
test("Claude 目录不可读时 Codex 仍可列出；历史损坏返回明确错误且不覆盖",async()=>{
 const id=create(messages()),a=anchorEntries(readHistory(id))[1];await add(id,a);
 fs.renameSync(PATHS.projects,PATHS.projects+".held");
 try{const r=await call("GET","/api/bookmarks");assert(r.body.unreadable);assert(r.body.items.some(b=>b.sid===id&&b.title==="Codex fixture"));}
 finally{fs.renameSync(PATHS.projects+".held",PATHS.projects);}
 fs.writeFileSync(path.join(CODEX_DIR,id+".json"),"broken");
 assert.equal((await add(id,a)).body.error,"history_unreadable");
});
test("存储失败新增/删除/定向清理均回滚内存",async()=>{
 const id=create(messages()),a=anchorEntries(readHistory(id))[1],first=await add(id,a);
 const original=fs.readFileSync(file);fs.unlinkSync(file);fs.mkdirSync(file);
 try{
  assert.equal((await add(id,a,{para:2})).code,500);assert.equal((await list(id)).body.items.length,1);
  assert.equal((await call("POST","/api/bookmarks/del",{id:first.body.item.id})).code,500);
  assert.equal(forgetBookmarks(id,"codex"),false);assert.equal((await list(id)).body.items.length,1);
 }finally{fs.rmdirSync(file);fs.writeFileSync(file,original);}
});
test("50 个单会话上限及旧 Claude 书签格式保持",async()=>{
 const id=create(messages()),a=anchorEntries(readHistory(id))[1];
 for(let i=0;i<50;i++)assert.equal((await add(id,a,{para:i})).code,200);
 assert.equal((await add(id,a,{para:51})).body.error,"full");
 const project=path.join(PATHS.projects,"-claude-control");fs.mkdirSync(project,{recursive:true});
 const sid=randomUUID(),uuid=randomUUID();fs.writeFileSync(path.join(project,sid+".jsonl"),JSON.stringify({type:"assistant",uuid,message:{role:"assistant",content:[{type:"text",text:"Claude control"}]}})+"\n");
 const r=await call("POST","/api/bookmarks",{session:sid,uuid,role:"assistant"});assert.equal(r.code,200);assert(!Object.hasOwn(r.body.item,"backend"));
 assert((await call("GET","/api/bookmarks")).body.items.some(b=>b.sid===sid));
});
test("模块重新加载仍保留 Codex schema，2000 总量上限只淘汰最旧一项",async()=>{
 const id=create(messages()),a=anchorEntries(readHistory(id))[1],original=fs.readFileSync(file);
 try{
  const seed=Array.from({length:2000},(_,i)=>({id:"seed-"+i,sid:"old-"+i,uuid:a.uuid,off:-1,para:0,role:"assistant",at:i,backend:"codex"}));
  fs.writeFileSync(file,JSON.stringify(seed));
  const reloaded=await import("../gw/bookmarks.mjs?restart-limit");
  const req=Object.assign(Readable.from([Buffer.from(JSON.stringify({session:id,uuid:a.uuid,backend:"codex",role:"assistant"}))]),{method:"POST"});
  const res={code:0,writeHead(c){this.code=c;},end(b){this.body=JSON.parse(b);}};
  await reloaded.routeBookmarks(req,res,new URL("http://isolated.invalid/api/bookmarks"),"/api/bookmarks");
  assert.equal(res.code,200);const persisted=JSON.parse(fs.readFileSync(file));assert.equal(persisted.length,2000);
  assert.equal(persisted[0].id,"seed-1");assert.equal(persisted.at(-1).backend,"codex");
  const restarted=await import("../gw/bookmarks.mjs?restart-schema");
  const response={writeHead(){},end(b){this.body=JSON.parse(b);}};
  await restarted.routeBookmarks({method:"GET"},response,new URL("http://isolated.invalid/api/bookmarks?session="+id),"/api/bookmarks");
  assert.equal(response.body.items[0].uuid,a.uuid);assert.equal(response.body.items[0].backend,"codex");
 }finally{fs.writeFileSync(file,original);}
});
test("同名跨核心会话拒绝猜测；历史变更状态拒绝新增",async()=>{
 const id=create(messages()),a=anchorEntries(readHistory(id))[1];
 const project=path.join(PATHS.projects,"-collision");fs.mkdirSync(project,{recursive:true});
 const filename=path.join(project,id+".jsonl");fs.writeFileSync(filename,"{}");
 assert.equal((await add(id,a)).body.error,"ambiguous_session");fs.unlinkSync(filename);
 const idx=JSON.parse(fs.readFileSync(index));idx.sessions[id].historyMutation={kind:"delete"};fs.writeFileSync(index,JSON.stringify(idx));
 assert.equal((await add(id,a)).body.error,"history_busy");
});
