import fs from "node:fs";
import { CodexSession } from "./session.mjs";
import { codexConfig } from "./config.mjs";
import { getCodexSession, readHistory, saveItems, upsertCodexSession, CODEX_DIR } from "./store.mjs";
import { commandHistory } from "./commands.mjs";
import { CODEX_OPERATIONS } from "./operation-lock.mjs";
import { forkBoundary } from "./fork-boundary.mjs";
const fail = message => { throw Object.assign(new Error(message), {status:409}); };
export async function forkCodexSession(id, options) {
  if(CODEX_OPERATIONS.has(id))fail("这个会话正在操作中，请稍后再试。");
  CODEX_OPERATIONS.add(id);
  let session;
  try {
    const rec=getCodexSession(id);if(!rec)fail("找不到 Codex 会话。");
    if(!rec.cwd||!fs.existsSync(rec.cwd)||!fs.statSync(rec.cwd).isDirectory())fail("原工作目录不可用，无法继续分叉。");
    const history=readHistory(id);const boundary=forkBoundary(history.items,options,history);
    const cfg=codexConfig();
    session=new CodexSession({cwd:rec.cwd,bin:cfg.bin,codexHome:cfg.home,sslCertFile:cfg.sslCertFile,dataDir:CODEX_DIR,model:rec.model,effort:rec.effort});
    await session.start();
    const result=await session.client.call("thread/fork",{threadId:id,lastTurnId:boundary.lastTurnId,cwd:rec.cwd,excludeTurns:true},60000);
    const nid=result.thread?.id;
    if(!nid||nid===id||getCodexSession(nid)||!/^[a-zA-Z0-9_-]{1,200}$/.test(nid))fail("核心未返回有效的新会话。");
    const page=await session.client.call("thread/turns/list",{threadId:nid,sortDirection:"desc",limit:1},20000);
    if(page.data?.[0]?.id!==boundary.lastTurnId){
      await session.client.call("thread/archive",{threadId:nid},10000).catch(()=>{});
      fail("核心未按所选轮次截取上下文，已拒绝显示为成功。");
    }
    if(nid===id||!nid||getCodexSession(nid))fail("新会话标识冲突，未修改原会话。");
    // 操作进程先卸载核心线程，再发布宿主索引，避免其他窗口提前开始续聊。
    await session.dispose();session=null;
    const items=commandHistory(boundary.items,false);
    if(!saveItems(nid,items,{complete:true}))throw new Error("分叉历史保存失败");
    const title=(rec.title||"Codex")+" · "+(options.before?"回退":"分叉");
    upsertCodexSession({id:nid,threadId:nid,cwd:rec.cwd,title,model:rec.model,effort:rec.effort,
      modelPicked:rec.modelPicked,permissionMode:rec.permissionMode,parentId:id,
      forkTurnId:boundary.lastTurnId,hostTools:null,plan:null,usage:null});
    if(!getCodexSession(nid))throw new Error("分叉索引保存失败");
    return {ok:true,id:nid,title,kept:boundary.kept,total:boundary.total,backend:"codex",filesReverted:false};
  }finally{
    try { await session?.dispose(); } finally { CODEX_OPERATIONS.delete(id); }
  }
}
