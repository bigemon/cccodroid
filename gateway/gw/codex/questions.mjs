import {nativeApprovalResponse} from "./native-approvals.mjs";
import {nativeFormAnswers} from "./native-forms.mjs";
const nativeKind=p=>p.kind==="native"||p.kind==="form";
// 将提问、宿主批准、原生工具批准及标准表单接到现有卡片。
export function codexQuestions(run, { emit, publishState, timeoutMs = 15 * 60 * 1000 }) {
  const pending = new Map();
  const seen = new Set();
  let closed = false;
  run.perms = new Map();
  function settle(id, response, behavior) {
    const p = pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    pending.delete(id);
    run.perms.delete(id);
    emit({ type: "perm_resolved", id, behavior });
    publishState();
    p.resolve(p.kind === "tool" ? response === true : response);
    return true;
  }
  run.answerPerm = (id, answer) => {
    const p = pending.get(id);
    if (!p || run.ended || run.aborted) return false;
    if(p.kind==="form"){
      const ok=answer.behavior==="allow",content=ok?nativeFormAnswers(p.form,answer.answers):null;
      if(ok&&content===null)return false;
      const result=settle(id,{...nativeApprovalResponse(ok?"accept":"decline"),content},ok?"allow":"deny");
      if(answer.interrupt){run.aborted=true;run.abort?.();}
      return result;
    }
    if(p.kind==="native"){
      const ok=answer.behavior==="allow";
      const result=settle(id,nativeApprovalResponse(ok?"accept":"decline"),ok?"allow":"deny");
      if(answer.interrupt){run.aborted=true;run.abort?.();}
      return result;
    }
    if (p.kind === "tool") {
      const settled = settle(id, answer.behavior === "allow", answer.behavior === "allow" ? "allow" : "deny");
      if (answer.interrupt) { run.aborted = true; run.abort?.(); }
      return settled;
    }
    if (answer.behavior !== "allow") {
      settle(id, { answers: {} }, "deny");
      if (answer.interrupt) { run.aborted = true; run.abort?.(); }
      return true;
    }
    const answers = Object.create(null);
    for (const q of p.questions) {
      const value = answer.answers?.[q.id];
      if (typeof value !== "string" || !value.trim() || value.length > 10000) return false;
      if (q.options?.length && !q.isOther && !q.options.some(o => o.label === value)) return false;
      answers[q.id] = { answers: [value] };
    }
    return settle(id, { answers }, "allow");
  };
  run.validatePermAnswer = (id, answer) => {
    const p = pending.get(id);
    if(p?.kind==="form"&&answer.behavior==="allow")return nativeFormAnswers(p.form,answer.answers)!==null;
    if (!p || p.kind === "tool" || p.kind === "native" || answer.behavior !== "allow") return true;
    return p.questions.every(q => {
      const v = answer.answers?.[q.id];
      return typeof v === "string" && !!v.trim() && v.length <= 10000
        && (!q.options?.length || q.isOther || q.options.some(o => o.label === v));
    });
  };
  return {
    ask(msg) {
      const p = msg.params || {};
      if (closed || run.ended || run.aborted || run.unattended || p.threadId !== run.sessionId) return Promise.resolve({ answers: {} });
      const id = "codex-question-" + run.id + "-" + String(msg.id);
      if (pending.has(id)) return pending.get(id).promise;
      const qs = p.questions;
      if (seen.has(id) || !Array.isArray(qs) || !qs.length || qs.length > 10
        || qs.some(q => !q || typeof q.id !== "string" || !q.id || typeof q.question !== "string" || (q.options != null && (!Array.isArray(q.options) || q.options.some(o => !o || typeof o.label !== "string"))))
        || new Set(qs.map(q => q.id)).size !== qs.length) return Promise.resolve({ answers: {} });
      seen.add(id);
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      const delay = typeof p.autoResolutionMs === "number" && p.autoResolutionMs >= 0 ? Math.min(timeoutMs, p.autoResolutionMs) : timeoutMs;
      const timer = setTimeout(() => settle(id, { answers: {} }, "stopped"), delay);
      timer.unref?.();
      pending.set(id, { questions: qs, resolve, promise, timer, requestId: msg.id });
      const card = { id, backend: "codex", tool: "AskUserQuestion", toolUseId: p.itemId,
        runId: run.id, sessionId: run.sessionId, at: Date.now(),
        input: { questions: qs.map(q => ({ id: q.id, question: q.question, options: q.options || [],
          allowOther: !!q.isOther || !q.options?.length, isSecret: !!q.isSecret, multiSelect: false })) } };
      run.perms.set(id, card);
      emit({ type: "perm_request", ...card });
      publishState();
      return promise;
    },
    confirmTool({ name, args, callId, agentId, requestId }) {
      if (closed || run.ended || run.aborted || run.unattended) return Promise.resolve(false);
      const id = "codex-tool-" + run.id + "-" + (agentId ? agentId + "-" : "") + callId;
      if (pending.has(id)) return pending.get(id).promise;
      if (seen.has(id)) return Promise.resolve(false);
      seen.add(id);
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      const timer = setTimeout(() => settle(id, false, "stopped"), timeoutMs);
      timer.unref?.();
      pending.set(id, { kind: "tool", resolve, promise, timer, requestId });
      const tool = name === "cccodroid_write_file" ? "Write" : name === "cccodroid_edit_file" ? "Edit" : ["cccodroid_exec_command","cccodroid_run_command"].includes(name) ? "Bash" : name;
      const input = tool === "Write" ? { file_path: args.path, content: args.content }
        : tool === "Edit" ? { file_path: args.path, old_string: args.oldText, new_string: args.newText }
        : name === "cccodroid_run_command" ? {...args,description:"cwd: "+(args.cwd??".")} : args;
      const card = { id, backend: "codex", tool, input, toolUseId: callId, runId: run.id, sessionId: run.sessionId, at: Date.now(), ...(agentId?{agentId}:{}) };
      run.perms.set(id, card);
      emit({ type: "perm_request", ...card });
      publishState();
      return promise;
    },
    form(form) {
      if(closed||run.ended||run.aborted||run.unattended)return Promise.resolve(nativeApprovalResponse("decline"));
      const id="codex-form-"+run.id+"-"+String(form.requestId);
      if(pending.has(id))return pending.get(id).promise;
      if(seen.has(id))return Promise.resolve(nativeApprovalResponse("cancel"));
      seen.add(id);
      let resolve;const promise=new Promise(r=>{resolve=r;});
      const timer=setTimeout(()=>settle(id,nativeApprovalResponse("cancel"),"stopped"),timeoutMs);timer.unref?.();
      pending.set(id,{kind:"form",form,requestId:form.requestId,resolve,promise,timer});
      const card={id,backend:"codex",nativeForm:true,tool:"AskUserQuestion",runId:run.id,sessionId:run.sessionId,at:Date.now(),
        input:{server:form.serverName,message:form.message,questions:form.fields}};
      run.perms.set(id,card);emit({type:"perm_request",...card});publishState();
      return promise;
    },
    confirmNative(approval) {
      if(closed||run.ended||run.aborted||run.unattended)return Promise.resolve(nativeApprovalResponse("decline"));
      const id="codex-native-"+run.id+"-"+String(approval.requestId);
      if(pending.has(id))return pending.get(id).promise;
      if(seen.has(id))return Promise.resolve(nativeApprovalResponse("cancel"));
      seen.add(id);
      let resolve;const promise=new Promise(r=>{resolve=r;});
      const timer=setTimeout(()=>settle(id,nativeApprovalResponse("cancel"),"stopped"),timeoutMs);timer.unref?.();
      pending.set(id,{kind:"native",requestId:approval.requestId,resolve,promise,timer});
      const card={id,backend:"codex",native:true,tool:"MCP",runId:run.id,sessionId:run.sessionId,at:Date.now(),
        input:{server:approval.serverName,message:approval.message,arguments:approval.arguments,description:approval.description}};
      run.perms.set(id,card);emit({type:"perm_request",...card});publishState();
      return promise;
    },
    cancelTools() {
      for (const [id, p] of pending) if (p.kind === "tool" || nativeKind(p)) settle(id, nativeKind(p)?nativeApprovalResponse("cancel"):false, "cancel");
    },
    resolved(requestId) {
      for (const [id, p] of pending) if (String(p.requestId) === String(requestId)) settle(id, nativeKind(p)?nativeApprovalResponse("cancel"):{ answers: {} }, "cancel");
    },
    close() {
      closed = true;
      for (const [id,p] of [...pending]) settle(id, nativeKind(p)?nativeApprovalResponse("cancel"):{ answers: {} }, "stopped");
      run.answerPerm = null;
      run.validatePermAnswer = null;
    },
  };
}
