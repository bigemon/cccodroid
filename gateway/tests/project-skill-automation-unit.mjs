import fs from "node:fs";import os from "node:os";import assert from "node:assert/strict";
const root=fs.mkdtempSync(os.tmpdir()+"/project-skill-automation-"),a=root+"/a",b=root+"/b";for(const p of [a,b]){fs.mkdirSync(p+"/.claude/skills",{recursive:true});fs.writeFileSync(p+"/.claude/skills/keep","SOURCE");}
Object.assign(process.env,{CCAPP_TEST:"1",CCAPP_HOME:root,CCAPP_WORKSPACE:root,CCAPP_SHARED:"",CCAPP_LOG:root+"/log"});
const {SETTINGS}=await import("../gw/settings.mjs"),{PATHS}=await import("../gw/config.mjs"),{projectSkillReuse:get,setProjectSkillReuse:set,syncProjectSkillReuse:sync,projectSkillAutomation:auto,setProjectSkillAutomation:setAuto}=await import("../gw/codex/project-skill-reuse.mjs");
SETTINGS.model="CLAUDE";SETTINGS.codex={home:root+"/core",skillReuse:{enabled:true},defaults:{model:"KEEP"}};
const dst=p=>p+"/.agents/skills/cccodroid-claude",toggle=(p,mode)=>set(p,{mode,revision:get(p).revision}),global=enabled=>setAuto({enabled,revision:auto().revision});let n=0;function check(name,f){f();console.log("ok "+(++n)+" "+name);}
check("全局项目自动共享默认开启，GET 不写入项目",()=>{assert(auto().enabled);assert(get(a).enabled);assert.equal(get(a).mode,"inherit");assert(!fs.existsSync(a+"/.agents"));assert(!fs.existsSync(PATHS.settings));});
check("仅当前项目按需创建映射，其他项目完全不动",()=>{assert.equal(sync(a).state,"active");assert.equal(fs.readlinkSync(dst(a)),"../../.claude/skills");assert(!fs.existsSync(b+"/.agents"));});
check("自动映射仍跟随全局，不被固化为单独开启",()=>{assert.equal(get(a).mode,"inherit");assert.equal(SETTINGS.codex.projectSkillReuse.entries[0].mode,"inherit");});
check("全局关闭不扫描或立即改动其他项目",()=>{global(false);assert(fs.existsSync(dst(a)));assert(!fs.existsSync(b+"/.agents"));assert(!get(a).enabled);});
check("再次检查当前项目才移除其受管映射",()=>{sync(a);assert(!fs.existsSync(dst(a)));assert.equal(fs.readFileSync(a+"/.claude/skills/keep","utf8"),"SOURCE");});
check("全局关闭时可单独开启 A，B 仍关闭",()=>{assert(toggle(a,"on").enabled);assert.equal(get(a).mode,"on");assert(!get(b).enabled);});
check("保存全局开关保留手动开启和原 Codex／Claude 偏好",()=>{global(true);global(false);sync(a);assert(get(a).enabled);assert(fs.existsSync(dst(a)));assert.equal(SETTINGS.model,"CLAUDE");assert.equal(SETTINGS.codex.defaults.model,"KEEP");assert(SETTINGS.codex.skillReuse.enabled);});
check("恢复跟随全局时采用实际全局关闭值",()=>{assert(!toggle(a,"inherit").enabled);assert(!fs.existsSync(dst(a)));});
check("单独关闭优先于全局开启，后续同步不重建",()=>{toggle(a,"off");global(true);sync(a);assert(!get(a).enabled);assert(!fs.existsSync(dst(a)));});
check("恢复跟随全局开启时创建相同相对链接",()=>{assert.equal(toggle(a,"inherit").state,"active");assert.equal(fs.readlinkSync(dst(a)),"../../.claude/skills");});
check("既有 enabled=false 显式选择迁移为单独关闭",()=>{SETTINGS.codex.projectSkillReuse.entries.push({root:b,enabled:false,managed:false});assert.equal(get(b).mode,"off");assert(!sync(b).enabled);assert(!fs.existsSync(b+"/.agents"));});
check("既有 enabled=true 显式选择迁移后不跟随全局关闭",()=>{SETTINGS.codex.projectSkillReuse.entries=SETTINGS.codex.projectSkillReuse.entries.filter(e=>e.root!==b);SETTINGS.codex.projectSkillReuse.entries.push({root:b,enabled:true,managed:false});global(false);assert.equal(sync(b).mode,"on");assert(get(b).enabled);});
check("全局变化会让旧项目修订失效",()=>{const rev=get(a).revision;global(true);assert.throws(()=>set(a,{mode:"off",revision:rev}),e=>e.status===409);});
check("旧全局修订与畸形选择均不能覆盖新设置",()=>{const old=auto();global(false);assert.throws(()=>setAuto({enabled:true,revision:old.revision}),e=>e.status===409);for(const body of [null,{}, {enabled:"yes",revision:auto().revision}])assert.throws(()=>setAuto(body),e=>e.status===400);for(const mode of ["bad",true])assert.throws(()=>toggle(a,mode),e=>e.status===400);});
check("全局保存失败保持旧规则和项目链接",()=>{const tmp=PATHS.settings+".codex-defaults-"+process.pid;fs.mkdirSync(tmp);try{assert.throws(()=>global(true),e=>e.status===502);assert(!auto().enabled);assert(fs.existsSync(dst(b)));}finally{fs.rmdirSync(tmp);}});
check("项目模式保存失败还原既有链接和选择",()=>{toggle(a,"on");const tmp=PATHS.settings+".codex-defaults-"+process.pid;fs.mkdirSync(tmp);try{assert.throws(()=>toggle(a,"off"),e=>e.status===502);assert.equal(get(a).mode,"on");assert(fs.existsSync(dst(a)));}finally{fs.rmdirSync(tmp);}});
check("全局关闭后的默认项目检查不创建配置条目或目录",()=>{const c=root+"/c";fs.mkdirSync(c);const before=fs.readFileSync(PATHS.settings);sync(c);assert(fs.readFileSync(PATHS.settings).equals(before));assert(!fs.existsSync(c+"/.agents"));});
check("自动维护遇到手动内容时仍能单独关闭，不删除用户文件",()=>{fs.unlinkSync(dst(a));fs.writeFileSync(dst(a),"MANUAL");const d=sync(a);assert.equal(d.state,"preserved");assert(d.writable);assert.equal(d.mode,"on");toggle(a,"off");assert.equal(fs.readFileSync(dst(a),"utf8"),"MANUAL");});
check("全部操作保留两项目源技能文件",()=>{for(const p of [a,b])assert.equal(fs.readFileSync(p+"/.claude/skills/keep","utf8"),"SOURCE");});
console.log(n+"/"+n+" passed");process.exit(0);
