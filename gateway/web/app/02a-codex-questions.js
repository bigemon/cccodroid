  // 原生异步问题随消息显示；用户提交后走普通消息/插话通道，不伪装为阻塞工具的回执。
  function renderCodexAsyncQuestions(parent, questions, {itemId}={}) {
    if (!questions.length) return null;
    const sid=view.sessionId;
    const key="cc.codex-question."+JSON.stringify([sid,itemId,questions]);
    const box=document.createElement("form");box.className="codex-questions";
    const note=document.createElement("p");note.className="tiny";
    note.textContent=t("选择或填写回答后发送；回答会作为消息交给 Codex。");box.appendChild(note);
    const answers=[];
    for(const question of questions){
      const field=document.createElement("fieldset"),legend=document.createElement("legend");
      legend.textContent=question.title;field.appendChild(legend);
      let choice="";
      for(const option of question.options||[]){
        const button=document.createElement("button");button.type="button";button.className="btn sm ghost";button.textContent=option;button.setAttribute("aria-pressed","false");
        button.onclick=()=>{
          choice=option;input.value="";
          field.querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed",String(b===button)));
          update();
        };
        field.appendChild(button);
      }
      const input=document.createElement("textarea");input.rows=2;input.maxLength=4000;input.placeholder=t("也可以填写自己的回答");input.setAttribute("aria-label",question.title);
      input.oninput=()=>{choice="";field.querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed","false"));update();};
      field.appendChild(input);box.appendChild(field);
      answers.push(()=>input.value.trim()||choice);
    }
    const submit=document.createElement("button");submit.type="submit";submit.className="btn sm";submit.textContent=t("发送回答");box.appendChild(submit);
    let busy=false,answered=false;try{answered=localStorage.getItem(key)==="sent";}catch{}
    function update(){
      submit.disabled=busy||answered||answers.some(a=>!a());
      box.querySelectorAll("fieldset").forEach(f=>f.disabled=busy||answered);
      if(answered)submit.textContent=t("回答已发送");
    }
    box.onsubmit=async event=>{
      event.preventDefault();
      if(busy||answered||answers.some(a=>!a()))return;
      if(!sid||view.sessionId!==sid||currentBackend()!=="codex"){toast(t("请回到提问的 Codex 会话后再回答。"),true);return;}
      const generation=view.gen;
      busy=true;update();
      try{
        const text="回答 Codex 的提问："+"\n\n"+questions.map((q,i)=>q.title+"\n"+answers[i]()).join("\n\n");
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,"0")).join("");
        // 计算标识期间可能切换或重建了视图，不能让 send() 使用此刻别的会话。
        if(view.gen!==generation||view.sessionId!==sid||currentBackend()!=="codex"||!box.isConnected)return;
        let pending;try{pending=JSON.parse(localStorage.getItem(key+".idem"));}catch{}
        const idem=pending?.hash===hash?pending.idem:newCid();
        try{localStorage.setItem(key+".idem",JSON.stringify({idem,hash}));}catch{}
        if(await send(text,undefined,idem)){
          answered=true;try{localStorage.setItem(key,"sent");localStorage.removeItem(key+".idem");}catch{}
        }
      }finally{busy=false;update();}
    };
    update();parent.appendChild(box);return box;
  }
