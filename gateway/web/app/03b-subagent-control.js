  // 子代理控制按用户点击查询；会话/子线程/轮次均由服务端再次核对。
  let codexAgentQuerySeq=0;
  function codexAgentMenuLabel(status) {
    return status==="stopping"?t("正在停止"):codexAgentLabel(status);
  }
  function paintCodexAgentMenu(sid,agent,anchor) {
    closeMenu();
    popMenu(anchor,[
      {head:agent.label||t("子代理")},
      {head:t("本次查询：{status}",{status:codexAgentMenuLabel(agent.status)})},
      ...(agent.reason?[{head:t(agent.reason)}]:[]),
      {label:t("刷新状态"),fn:()=>openCodexAgent(sid,agent.agentThreadId,anchor)},
      {label:t("停止当前任务"),danger:true,fn:agent.canStop?()=>stopCodexAgent(sid,agent,anchor):null},
      "hr",{label:t("本会话子代理"),fn:()=>openCodexAgents(sid,anchor)},
    ],"up");
  }
  async function openCodexAgents(sid,anchor) {
    const seq=++codexAgentQuerySeq,generation=view.gen;
    try {
      const r=await api("/api/codex/subagents?sid="+encodeURIComponent(sid));
      if(seq!==codexAgentQuerySeq||generation!==view.gen)return;
      if(!anchor.isConnected)anchor=permEl;
      closeMenu();
      popMenu(anchor,[{head:t("本会话子代理")+" · "+r.agents.length},
        ...r.agents.map(a=>({label:a.label||t("子代理"),small:t("记录：{status}",{status:codexAgentMenuLabel(a.observedStatus)}),fn:()=>openCodexAgent(sid,a.agentThreadId,anchor)})),
        ...(!r.agents.length?[{head:t("当前没有已记录的子代理")}]:[]),
        "hr",{label:t("刷新列表"),fn:()=>openCodexAgents(sid,anchor)},
      ],"up");
    }catch(e){if(seq===codexAgentQuerySeq&&generation===view.gen)toast(e.message,true);}
  }
  async function openCodexAgent(sid,child,anchor) {
    const seq=++codexAgentQuerySeq,generation=view.gen;
    try {
      const r=await api("/api/codex/subagent/status?sid="+encodeURIComponent(sid)+"&agent="+encodeURIComponent(child));
      if(seq!==codexAgentQuerySeq||generation!==view.gen)return;
      if(!anchor.isConnected)anchor=permEl;
      paintCodexAgentMenu(sid,r.agent,anchor);
    }catch(e){if(seq===codexAgentQuerySeq&&generation===view.gen)toast(e.message,true);}
  }
  async function stopCodexAgent(sid,agent,anchor) {
    const seq=++codexAgentQuerySeq,generation=view.gen;
    try {
      const r=await post("/api/codex/subagent/stop",{sessionId:sid,agentThreadId:agent.agentThreadId,turnId:agent.childTurnId});
      if(seq!==codexAgentQuerySeq||generation!==view.gen)return;
      if(!anchor.isConnected)anchor=permEl;
      paintCodexAgentMenu(sid,r.agent,anchor);
    }catch(e){if(seq===codexAgentQuerySeq&&generation===view.gen)toast(e.message,true);}
  }

  // 仅按用户操作刷新，不新增后台轮询。
  let codexCommandQuerySeq=0;
  async function openCodexCommands(sid,anchor){
    const seq=++codexCommandQuerySeq,generation=view.gen;
    try{
      const r=await api("/api/codex/command/list?sessionId="+encodeURIComponent(sid));
      if(seq!==codexCommandQuerySeq||generation!==view.gen)return;
      if(!anchor?.isConnected)anchor=permEl;
      closeMenu();popMenu(anchor,[{head:t("后台命令")+" · "+r.commands.length},
        ...r.commands.map(c=>({label:c.command,small:c.running?t("运行中"):t("已结束"),fn:()=>openCodexCommandOutput(sid,c,anchor)})),
        ...(!r.commands.length?[{head:t("当前没有命令")}]:[]),
        "hr",{label:t("刷新列表"),fn:()=>openCodexCommands(sid,anchor)}
      ],"up");
    }catch(e){if(seq===codexCommandQuerySeq&&generation===view.gen)toast(e.message,true);}
  }
  function openCodexCommandOutput(sid,command,anchor){
    closeMenu();
    const ov=document.createElement("div");ov.className="rw-ov";const m=document.createElement("div");m.className="rw-dlg";m.setAttribute("role","dialog");m.setAttribute("aria-modal","true");m.innerHTML='<h3>'+esc(t("后台命令"))+'</h3><pre class="command-text"></pre><div class="tiny command-status"></div><pre class="command-output" style="max-height:45vh;overflow:auto"></pre><div class="row-actions"><button data-command-refresh>'+esc(t("刷新状态"))+'</button><button class="danger" data-command-stop>'+esc(t("停止命令"))+'</button><button data-close>'+esc(t("关闭"))+'</button></div>';ov.appendChild(m);OV.open(ov,{kind:"modal",keep:true,cover:true});m.querySelector("[data-close]").onclick=()=>OV.close(ov);
    const paint=c=>{command=c;m.querySelector(".command-text").textContent=c.command;m.querySelector(".command-status").textContent=(c.running?t("运行中"):t("已结束"))+(c.tty?" · PTY":"");m.querySelector(".command-output").textContent=c.output||"";m.querySelector("[data-command-stop]").disabled=!c.running;};
    const refresh=async()=>{const r=await api("/api/codex/command/list?sessionId="+encodeURIComponent(sid));if(!m.isConnected)return;const c=r.commands.find(c=>c.id===command.id);if(c)paint(c);else{m.querySelector(".command-status").textContent=t("命令已结束或连接已回收");m.querySelector("[data-command-stop]").disabled=true;}};
    paint(command);
    m.querySelector("[data-command-refresh]").onclick=()=>refresh().catch(e=>toast(e.message,true));
    m.querySelector("[data-command-stop]").onclick=async()=>{const b=m.querySelector("[data-command-stop]");b.disabled=true;try{await post("/api/codex/command/stop",{sessionId:sid,commandId:command.id});await refresh();}catch(e){if(m.isConnected)b.disabled=false;toast(e.message,true);}};
  }
