import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source=fs.readFileSync(new URL("../web/app/10-settings-device.js",import.meta.url),"utf8");
const begin=source.indexOf("  function renderPrivNoAsk("),end=source.indexOf("  async function loadPriv()",begin);
assert(begin>=0&&end>begin);
function page() {
  const elements={"priv-na":{checked:false},"priv-na-hours":{value:"24",dataset:{},classList:{toggle(){}}},"priv-na-result":{textContent:"",className:""}};
  elements["priv-na-self"]={checked:false};
  elements["priv-na-screen"]={checked:false};
  elements["priv-na-screen-row"]={hidden:true,classList:{toggle(name,hidden){elements["priv-na-screen-row"].hidden=hidden;}}};
  elements["priv-na-self-row"]={hidden:true,classList:{toggle(name,hidden){elements["priv-na-self-row"].hidden=hidden;}}};
  const context={Date,privNoAskBusy:false,document:{activeElement:null},$:id=>elements[id],t:s=>s};
  vm.runInNewContext(source.slice(begin,end)+"globalThis.render=renderPrivNoAsk;",context);
  const screenBegin=source.indexOf("  function renderScreenNoAsk("),screenEnd=source.indexOf("  function devRender(",screenBegin);
  assert(screenBegin>=0&&screenEnd>screenBegin);
  vm.runInNewContext(source.slice(screenBegin,screenEnd)+"globalThis.screen=renderScreenNoAsk;",context);
  return {elements,render:context.render,screen:context.screen,context};
}
test("cold page reflects persisted noask authorization without another enable request",()=>{
  const expiry=Date.now()+167*3600000, state={noask:true,noaskUntil:expiry};
  for(let n=0;n<2;n++){
    const p=page();p.render(state);
    assert.equal(p.elements["priv-na"].checked,true);
    assert.equal(p.elements["priv-na-hours"].value,"168");
    assert.match(p.elements["priv-na-result"].textContent,/有效至/);
  }
});
test("turning off or expiring noask clears old UI and preserves a focused duration choice",()=>{
  const p=page();p.render({noask:true,noaskUntil:Date.now()+3600000});
  p.elements["priv-na-hours"].value="72";p.context.document.activeElement=p.elements["priv-na-hours"];
  p.render({noask:true,noaskUntil:Date.now()+167*3600000});
  assert.equal(p.elements["priv-na-hours"].value,"72");
  p.render({noask:false});
  assert.equal(p.elements["priv-na"].checked,false);
  assert.equal(p.elements["priv-na-result"].textContent,"");
});

test("extra self switch is shown only with native noask and resets its visual value when hidden",()=>{
 const p=page();p.render({noask:false,noaskSelf:true});
 assert(p.elements["priv-na-self-row"].hidden);assert.equal(p.elements["priv-na-self"].checked,false);
 p.render({noask:true,noaskSelf:false});
 assert.equal(p.elements["priv-na-self-row"].hidden,false);assert.equal(p.elements["priv-na-self"].checked,false);
 p.render({noask:true,noaskSelf:true});assert(p.elements["priv-na-self"].checked);
});

test("screen bypass depends on device/accessibility, not privileged-command noask",()=>{
 const p=page();p.screen({on:true,a11y:{mode:"auto"}});assert.equal(p.elements["priv-na-screen"].checked,false);assert(!p.elements["priv-na-screen-row"].hidden);
 p.screen({on:true,a11y:{mode:"on"},noaskScreen:true});assert(p.elements["priv-na-screen"].checked);
 p.render({noask:false});assert(p.elements["priv-na-screen"].checked);assert(!p.elements["priv-na-screen-row"].hidden);
 p.render({noask:true});assert(p.elements["priv-na-screen"].checked);
});
test("screen bypass hides and clears its visual value when device tools or accessibility mode is off",()=>{
 const p=page();
 for(const st of [{on:false,a11y:{mode:"on"}},{on:true,a11y:{mode:"off"}},{on:true},{}]){
  p.screen({...st,noaskScreen:true});assert(!p.elements["priv-na-screen"].checked);assert(p.elements["priv-na-screen-row"].hidden);
 }
 p.screen({on:true,a11y:{mode:"auto",connected:false},noaskScreen:true});assert(p.elements["priv-na-screen"].checked);assert(!p.elements["priv-na-screen-row"].hidden,"auto idle is not a revoked permission");
});
test("command noask endpoints and expiry never revoke screen authorization",()=>{
 const native=fs.readFileSync(new URL("../../android/java/cc/codroid/Priv.java",import.meta.url),"utf8");
 const endpoint=native.slice(native.indexOf('case "noask":'),native.indexOf('case "noask_screen":'));
 const expiry=native.slice(native.indexOf('static long noAskUntil()'),native.indexOf('static boolean noAskSelf()'));
 assert(!endpoint.includes('NOASK_SCREEN'));assert(!expiry.includes('NOASK_SCREEN'));
 const screen=native.slice(native.indexOf('case "noask_screen":'),native.indexOf('case "noask_self":'));
 assert(!screen.includes('noAskUntil'));assert(screen.includes('screenNoAskAvailable()'));
});

test("native self grant does not revoke independent screen grant",()=>{
 const native=fs.readFileSync(new URL("../../android/java/cc/codroid/Priv.java",import.meta.url),"utf8");
 const body=native.slice(native.indexOf('case "noask_self":'),native.indexOf('case "to_front":'));
 assert(!body.includes('NOASK_SCREEN'),"self-only API must leave screen grant unchanged");
});
