import fs from "node:fs";import path from "node:path";import os from "node:os";import assert from "node:assert/strict";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"skill-settings-unit-"));Object.assign(process.env,{CCAPP_TEST:"1",CCAPP_HOME:root,CCAPP_WORKSPACE:root,CCAPP_SHARED:"",CCAPP_LOG:root+"/log"});
const {writeSkillEnabled}=await import("../gw/codex/skill-settings.mjs");
const cwd="/repo",selected={name:"build",path:"/repo/.agents/skills/build/SKILL.md",enabled:true},body={name:selected.name,path:selected.path,enabled:false,expectedEnabled:true};
let n=0;async function check(name,fn){await fn();console.log("ok "+(++n)+" "+name);}
function fixture({rows=[selected],effective,writeError=false,afterError=false,badResponse=false,delay=0}={}){
 let listCount=0;const calls=[],c={codexHome:"/isolated",calls,call:async(method,p)=>{
  calls.push({method,params:p});
  if(method==="skills/list"){assert.deepEqual(p,{cwds:[cwd],forceReload:true});if(afterError&&listCount++)throw Error("SECRET_AFTER");return {data:[{cwd,skills:rows,errors:[]}]};}
  assert.equal(method,"skills/config/write");if(delay)await new Promise(r=>setTimeout(r,delay));if(writeError)throw Error("SECRET_WRITE");const state=typeof effective==="boolean"?effective:p.enabled;rows=rows.map(s=>s.path===p.path?{...s,enabled:state}:s);return badResponse?{}:{effectiveEnabled:state};
 }};return c;
}
await check("保存只传路径和开关，强制重读确认实际状态",async()=>{const c=fixture(),r=await writeSkillEnabled(c,cwd,body);assert(r.changed&&!r.enabled);assert.deepEqual(c.calls.map(c=>c.method),["skills/list","skills/config/write","skills/list"]);assert.deepEqual(c.calls[1].params,{path:selected.path,enabled:false});});
await check("无变化时不写入配置",async()=>{const c=fixture();const r=await writeSkillEnabled(c,cwd,{...body,enabled:true});assert(!r.changed);assert.equal(c.calls.length,1);});
await check("核心策略阻止开关时返回实际状态，不假报已停用",async()=>{const c=fixture({effective:true}),r=await writeSkillEnabled(c,cwd,body);assert(r.enabled&&!r.changed);assert.equal(r.requestedEnabled,false);});
await check("伪造、跨目录、已移除、过期状态和超大目录不触发写入",async()=>{for(const [c,b]of [[fixture(),{...body,path:"/other/SKILL.md"}],[fixture(),{...body,name:"other"}],[fixture({rows:[]}),body],[fixture(),{...body,expectedEnabled:false}],[fixture({rows:Array.from({length:201},(_,i)=>({...selected,name:"s"+i}))}),body]]){await assert.rejects(writeSkillEnabled(c,cwd,b),e=>e.status===409);assert(!c.calls.some(c=>c.method==="skills/config/write"));}});
await check("格式错误在核心调用前拒绝",async()=>{for(const b of [{...body,path:"relative"},{...body,path:"/bad\0"},{...body,name:"../x"},{...body,enabled:"false"},{...body,expectedEnabled:undefined}]){const c=fixture();await assert.rejects(writeSkillEnabled(c,cwd,b),e=>e.status===400);assert.equal(c.calls.length,0);}});
await check("同名技能以路径区分，不误停另一个",async()=>{const c=fixture({rows:[selected,{...selected,path:"/another/SKILL.md"}]}),r=await writeSkillEnabled(c,cwd,{...body,path:"/another/SKILL.md"});assert(!r.enabled);assert.equal(c.calls[1].params.path,"/another/SKILL.md");});
for(const options of [{writeError:true},{afterError:true},{badResponse:true}])await check("写入或重读异常返回待核实结果且不泄漏内部错误",async()=>{const c=fixture(options);await assert.rejects(writeSkillEnabled(c,cwd,body),e=>e.status===502&&!e.message.includes("SECRET")&&/检查/.test(e.message));});
await check("同一路径的重复修改被锁住，完成后锁释放",async()=>{const c=fixture({delay:30}),first=writeSkillEnabled(c,cwd,body);await assert.rejects(writeSkillEnabled(c,cwd,body),e=>e.status===409);await first;assert((await writeSkillEnabled(c,cwd,{...body,enabled:true,expectedEnabled:false})).enabled);});
console.log(n+"/"+n+" passed");process.exit(0);
