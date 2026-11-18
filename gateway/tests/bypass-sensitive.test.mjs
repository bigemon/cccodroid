import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Execute the actual can_use_tool handler up to queueing a manual card.
const source = fs.readFileSync(new URL("../gw/run.mjs", import.meta.url), "utf8");
const start = source.indexOf("  const onControl = (ev) => {");
const end = source.indexOf("      run.perms.set(id, p);", start);
assert(start >= 0 && end > start);
function harness(mode, unattended = false) {
  const run = {permMode: mode, unattended, id:"test", sessionId:"session"};
  const allowed = [], pending = [];
  const context = {run, pending, Date, HUMAN_TOOLS:new Set(["AskUserQuestion","ExitPlanMode"]),
    log(){}, argLen(){return "";}, guardKey:p=>p.guard.cat, writeCtl:ev=>allowed.push(ev.response.response)};
  vm.runInNewContext(source.slice(start, end) + "pending.push(p); } }; globalThis.control = onControl;", context);
  const call = (tool, interactive = false) => context.control({request_id:"r",request:{subtype:"can_use_tool",tool_name:tool,input:{path:".env"},
    decision_reason_type:"hook",decision_reason:"cccodroid-guard|secret:env|.env",requires_user_interaction:interactive}});
  return {run, allowed, pending, call};
}
test("Claude bypass approves sensitive-file and device guard requests without a card", () => {
  const h = harness("bypassPermissions");
  h.call("Read"); h.call("mcp__device__clipboard_read");
  assert.equal(h.allowed.length,2);
  assert(h.allowed.every(x=>x.behavior === "allow"));
  assert.equal(h.pending.length,0);
  h.run.permMode="default"; h.call("Read");
  assert.equal(h.pending.length,1);
});
test("default mode and interactive requests retain manual confirmation", () => {
  for (const mode of ["default","acceptEdits","auto"]) {
    const h=harness(mode);h.call("Read");
    assert.equal(h.allowed.length,0);assert.equal(h.pending.length,1);
  }
  for (const [tool, interactive] of [["AskUserQuestion",false],["ExitPlanMode",false],["Read",true]]) {
    const h=harness("bypassPermissions");h.call(tool,interactive);
    assert.equal(h.allowed.length,0);assert.equal(h.pending.length,1);
  }
});
test("unattended guard requests still follow the scheduled-run restriction", () => {
  const h=harness("bypassPermissions",true);h.call("Read");
  assert.equal(h.allowed[0].behavior,"deny");assert.equal(h.pending.length,0);
});
