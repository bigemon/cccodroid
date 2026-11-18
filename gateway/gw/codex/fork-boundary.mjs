const fail = message => { throw Object.assign(new Error(message), {status:409}); };
export function forkBoundary(items, {userText,after,before=false,itemIndex,historyEpoch}, history = null) {
  if(typeof userText!=="string"||(itemIndex==null&&(!Number.isInteger(after)||after<0)))fail("分叉位置无效，请刷新会话后重试。");
  if(history ? !history.complete : items.length>=2000)fail("界面历史可能不完整，请先恢复历史后再操作。");
  if(itemIndex!=null&&(!Number.isSafeInteger(itemIndex)||itemIndex<0||!history||historyEpoch!==history.epoch))fail("历史位置已失效，请刷新后重新选择。");
  const users=items.map((m,i)=>({m,i})).filter(x=>x.m.role==="user");
  const index=itemIndex!=null?users.findIndex(u=>u.i===itemIndex):users.length-1-after,target=users[index];
  if(!target||target.m.text!==userText)fail("会话记录已变化，请刷新后重新选择。");
  const turnOf = j => {
    if(j<0)return null;
    const u=users[j],next=users[j+1]?.i??items.length;
    const ids=new Set([u.m.turnId,...items.slice(u.i+1,next).map(m=>m.turnId)].filter(Boolean));
    if(ids.size!==1)fail("这条旧消息缺少可靠的核心轮次标识，暂不能在这里操作。");
    return [...ids][0];
  };
  if(before&&index===0)fail("回退到第一轮之前，请在同一项目新建会话。");
  const targetTurn=turnOf(index);
  if(before&&index>0&&turnOf(index-1)===targetTurn)fail("不能在同一核心轮次的插话中间回退。");
  if(!before&&index+1<users.length&&turnOf(index+1)===targetTurn)fail("不能从同一核心轮次中途分叉，请选择该轮最后一条回复。");
  const kept=before?index:index+1,cut=users[kept]?.i??items.length;
  return {items:items.slice(0,cut),lastTurnId:kept?turnOf(kept-1):null,kept,total:users.length};
}
