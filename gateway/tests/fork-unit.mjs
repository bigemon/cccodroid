import assert from "node:assert/strict";
process.env.CCAPP_TEST="1";
const {forkBoundary}=await import("../gw/codex/fork-boundary.mjs");
const items=[{role:"user",text:"same",turnId:"a"},{role:"assistant",turnId:"a",text:"A"},
 {role:"user",text:"same",turnId:"b"},{role:"assistant",turnId:"b",text:"B"}];
assert.equal(forkBoundary(items,{userText:"same",after:1}).lastTurnId,"a");
assert.equal(forkBoundary(items,{userText:"same",after:0,before:true}).lastTurnId,"a");
assert.throws(()=>forkBoundary(items,{userText:"changed",after:0}),/变化/);
assert.throws(()=>forkBoundary(items,{userText:"same",after:1,before:true}),/第一轮/);
const injected=[...items.slice(0,2),{role:"user",text:"extra",turnId:"a",injected:true},{role:"assistant",turnId:"a",text:"later"}];
assert.throws(()=>forkBoundary(injected,{userText:"same",after:1}),/中途/);
assert.throws(()=>forkBoundary(injected,{userText:"extra",after:0,before:true}),/插话/);
assert.throws(()=>forkBoundary([{role:"user",text:"legacy"}],{userText:"legacy",after:0}),/旧消息/);
assert.throws(()=>forkBoundary(Array(2000).fill({role:"user",text:"x",turnId:"x"}),{userText:"x",after:0}),/不完整/);
console.log("8/8 boundary checks passed");
