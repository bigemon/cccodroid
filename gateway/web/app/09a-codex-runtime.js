  let codexRuntimeSeq=0,codexRuntimeReady=false,codexUpdateSubmitting=false,codexRuntimeKnown=false;
  function paintCodexChannel(s){
    const channel=["alpha","pinned"].includes(s.channel)?s.channel:"stable",select=$("upd-codex-channel");
    select.value=channel;select.disabled=!!s.busy||s.phase==="waiting";
    select.querySelector('[value="pinned"]').textContent=channel==="pinned"&&s.pinVersion?t("CLI：固定 {v}",{v:s.pinVersion}):t("CLI：固定版本…");
    return channel;
  }
  function paintCodexInstalled(s){
    const el=$("codex-installed-state"),button=$("codex-update-link");
    const channel=s.channel==="pinned"?t("固定版本 {v}",{v:s.pinVersion||t("未知")}):t("更新通道 {channel}",{channel:s.channel||"stable"});
    const version=s.currentVersion||t("版本未知");
    if(s.available){
      el.textContent=t("已安装 Codex {version} · {channel}",{version,channel})+(s.custom?" · "+t("自定义环境"):"");
      el.className="prov-state ok";button.textContent=t("选择版本");
    }else if(!s.custom&&s.installed){
      el.textContent=t("Codex {version} 当前不可用 · {channel}",{version,channel});el.className="prov-state err";button.textContent=t("选择版本");
    }else{el.textContent=t("尚未安装");el.className="prov-state err";button.textContent=t("安装");}
    button.disabled=false;codexRuntimeKnown=true;
  }
  async function openCodexEnvironment(){
    await openSettings("update");await openCodexVersions();
  }
  async function refreshCodexSetup(){
    const seq=++codexRuntimeSeq;
    $("codex-update-link").disabled=true;
    try{
      const s=await api("/api/codex/runtime");
      if(seq!==codexRuntimeSeq)return;
      const becameReady=!codexRuntimeReady&&s.available;codexRuntimeReady=!!s.available;
      paintCodexInstalled(s);paintCodexChannel(s);$("set-codex-bin").placeholder=s.bin;$("set-codex-home").placeholder=s.home;
      await paintCodexStatus();
      if(seq!==codexRuntimeSeq)return;
      if(s.available){
        await paintCodexAccount();
        if(seq!==codexRuntimeSeq)return;
        if(!document.querySelector('.set-cat[data-cat="provider"]').classList.contains("hidden")&&!$("core-panel-codex").classList.contains("hidden")&&!codexPreferenceLoading)loadCodexPreferences(true);
        if(becameReady){paintBackend();recheckSetup();}
      }else{
        codexAccountSeq++;$("codex-account-state").textContent=t("请先在“更新”页安装 Codex，再登录 ChatGPT。");
        $("codex-account-acts").textContent="";paintCodexLoginFlow(null);$("codex-quota").classList.add("hidden");
        $("codex-preferences-state").textContent=t("安装并登录后可选择模型。");
      }
    }catch(e){if(seq===codexRuntimeSeq){codexRuntimeKnown=false;$("codex-installed-state").textContent=t("安装状态读取失败，请重试");$("codex-installed-state").className="prov-state err";$("codex-update-link").textContent=t("重试");$("codex-update-link").disabled=false;toast(e.message,true);}}
  }
  async function applyCodexRuntimeUpdate(selection=null){
    if(codexUpdateSubmitting)return null;
    codexUpdateSubmitting=true;let token=null;
    try{
      const s=await api("/api/codex/runtime");
      const choice=selection||{channel:s.channel||"stable",...(s.channel==="pinned"?{version:s.pinVersion}:{}),install:true};
      if(choice.channel==="alpha"&&s.channel!=="alpha"&&!confirm(t("跟随 Codex alpha 预览通道？\n\n预览版可能有兼容问题。确认后准备切换；自动更新不会擅自降级。")))return null;
      const prepared=await post("/api/codex/runtime",{action:"prepare",...choice});
      if(prepared.ok===false)throw Error(prepared.message);
      token=prepared.selectionToken;
      if(prepared.install&&prepared.downgrade&&!confirm(t("把 Codex 从 {from} 降级到 {to}？\n\n旧版可能缺少功能或无法读取新版数据。仅切换程序，登录和会话文件保留；这不保证原生数据可向下兼容。取消保持原通道和版本。",{from:prepared.currentVersion,to:prepared.version})))return null;
      if(prepared.install&&prepared.custom&&!confirm(t("改用官方 Codex {version}？\n\n原来的程序保留，登录、会话和配置继续使用原数据目录：\n{home}",{version:prepared.version,home:prepared.configuredHome})))return null;
      const result=await post("/api/codex/runtime",{action:"commit",selectionToken:token,acceptDowngrade:prepared.downgrade===true,adopt:prepared.custom===true});
      if(result.ok===false)throw Error(result.message);
      token=null;followUpd();setTimeout(loadUpd,200);return result;
    }finally{
      if(token)await post("/api/codex/runtime",{action:"discard",selectionToken:token}).catch(()=>{});
      codexUpdateSubmitting=false;
    }
  }
  async function uninstallCodex(){
    const s=await api("/api/codex/runtime");
    if(!confirm(t("卸载 Codex？\n\n删除应用托管的 Codex 程序及下载缓存，保留登录、会话、工作区和设置。之后不会自动装回，需要在“安装…”中重新选通道或版本。")))return null;
    const r=await post("/api/codex/runtime",{action:"uninstall",expectedConfig:s.configurationToken});
    if(r.ok===false)throw Error(r.message);followUpd();await loadUpd();await refreshCodexSetup();return r;
  }
  $("codex-update-link").addEventListener("click",()=>codexRuntimeKnown?openCodexEnvironment():refreshCodexSetup());
  $("upd-codex-channel").addEventListener("change",async e=>{
    const next=e.target.value;
    if(next==="pinned"){e.target.value=lastUpd.codexChannel||"stable";openCodexVersions();return;}
    e.target.disabled=true;
    try{
      const s=await api("/api/codex/runtime");
      const r=await applyCodexRuntimeUpdate({channel:next,install:!!s.available});
      if(r)toast(t("已改为跟随 {channel}",{channel:next}));
    }catch(error){toast(error.message,true);}
    finally{await refreshCodexSetup();loadUpd();}
  });
