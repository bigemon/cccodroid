import fs from "node:fs";import os from "node:os";import path from "node:path";import assert from "node:assert/strict";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"auto-review-lifecycle-"));Object.assign(process.env,{CCAPP_TEST:"1",CCAPP_HOME:root,CCAPP_WORKSPACE:root});
const {CodexSession}=await import("../gw/codex/session.mjs"),{AutoReviewState}=await import("../gw/codex/auto-review.mjs");
const s=new CodexSession({cwd:root,bin:"unused",codexHome:root,dataDir:root,permissionMode:"auto"});
let release;const waiting=new Promise(r=>{release=r;});s.commands={close:()=>waiting};s.registry={cancelAll:async()=>{}};s.client={exited:null,dispose:async()=>{}};s.started=true;s.turn={id:"turn",autoReview:new AutoReviewState({server:"host"})};
assert(s.ready);const closing=s.dispose();
try{assert.equal(s.ready,false,"dispose must revoke bridge readiness before awaiting resource cleanup");assert.equal(s.turn.stopping,true);assert.equal(s.turn.autoReview.closed,true);console.log("ok 1 dispose 进入时立即关闭执行入口和本轮批准，无须等待资源清理");}finally{release();await closing;}
console.log("1/1 passed");

// Imports may start development-only keepalive timers; all tested cleanup above has settled.
process.exit(0);
