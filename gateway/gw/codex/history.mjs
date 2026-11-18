import {hasRunningCommands} from "./commands.mjs";
import {GeneratedImageStore} from "./generated-images.mjs";
import { CodexSession } from "./session.mjs";
import { codexConfig } from "./config.mjs";
import { getCodexSession, readHistory, saveItems, backupHistory, setHistoryMutation, CODEX_DIR } from "./store.mjs";
import { CODEX_OPERATIONS } from "./operation-lock.mjs";
import { mergeRecoveredHistory } from "./history-view.mjs";
export { historyPage } from "./history-view.mjs";
const fail=message=>{throw Object.assign(new Error(message),{status:409});};

// 显式恢复只读取持久化核心历史，不 resume、不启动模型轮次。
export async function recoverCodexHistory(id) {
  if(hasRunningCommands(id))fail("后台命令仍在运行，请先停止后再恢复历史。");
  if(CODEX_OPERATIONS.has(id))fail("这个会话正在操作中，请稍后再试。");
  CODEX_OPERATIONS.add(id);
  let session;
  try {
    const rec=getCodexSession(id);if(!rec)fail("找不到 Codex 会话。");
    const original=readHistory(id),cfg=codexConfig();
    session=new CodexSession({cwd:rec.cwd,bin:cfg.bin,codexHome:cfg.home,sslCertFile:cfg.sslCertFile,dataDir:CODEX_DIR});
    await session.start();
    const turns=[],cursors=new Set();let cursor=null,bytes=0,count=0;
    const deadline=Date.now()+90000;
    if(rec.historyMutation?.version===2)turns.push(...await (await import("./history-delete.mjs")).deletionTurns(session.client,id));
    else do {
      if(Date.now()>deadline)fail("历史较大，恢复已停止，原记录已保留。");
      const page=await session.client.call("thread/turns/list",{threadId:id,sortDirection:"asc",itemsView:"full",limit:50,...(cursor?{cursor}:{})},20000);
      if(!Array.isArray(page.data)||!("nextCursor"in page))fail("核心没有返回完整分页信息，原记录已保留。");
      if(page.data.some(t=>t.itemsView!=="full"))fail("核心只返回了历史摘要，未覆盖原记录。");
      bytes+=Buffer.byteLength(JSON.stringify(page.data));
      count+=page.data.reduce((n,t)=>n+(t.items?.length||0),0);
      if(turns.length+page.data.length>5000||count>20000||bytes>64*1024*1024)fail("历史较大，恢复已停止，原记录已保留。");
      turns.push(...page.data);
      cursor=page.nextCursor;
      if(cursor!=null&&(typeof cursor!=="string"||!cursor||cursors.has(cursor)))fail("核心分页位置重复或无效，原记录已保留。");
      if(cursor)cursors.add(cursor);
    }while(cursor);
    const reconciled=rec.historyMutation ? (await import("./history-delete.mjs")).reconcileDeletion(turns,original.items,rec.historyMutation) : null;
    const items=reconciled ? reconciled.items : mergeRecoveredHistory(turns,original.items,{imageStore:new GeneratedImageStore({codexHome:cfg.home})});
    await session.dispose();session=null;
    // 清掉之前缓存的界面副本，下一轮从同步后的历史加载。
    const { discardCodexSession }=await import("./run.mjs");
    await discardCodexSession(id);
    const backup=backupHistory(id);
    if(!saveItems(id,items,{complete:reconciled?.complete??true,newEpoch:true,source:rec.historyMutation?.version===2?"host-prefix-recovered":"core-recovered"}))throw new Error("恢复历史保存失败");
    if(rec.historyMutation)setHistoryMutation(id,null,{clearDerived:reconciled.deleted});
    return {ok:true,items:items.length,turns:turns.length,backup:!!backup,filesChanged:false};
  }finally{
    try{await session?.dispose();}finally{CODEX_OPERATIONS.delete(id);}
  }
}
