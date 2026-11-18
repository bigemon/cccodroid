import assert from "node:assert/strict";
import {skillNames,normalizeSkills,validateSkillRefs,skillInput,submittedSkills} from "../gw/codex/skills.mjs";
let n=0;async function check(name,fn){await fn();console.log("ok "+(++n)+" "+name);}
const cwd="/project",row=(name="build",p="/skills/build/SKILL.md",enabled=true)=>({name,path:p,enabled,scope:"repo",description:"SECRET_DESCRIPTION",dependencies:{token:"SECRET"}}),response=skills=>({data:[{cwd,skills,errors:[]}]}),client=skills=>({call:async(method,p)=>{assert.equal(method,"skills/list");assert.deepEqual(p,{cwds:[cwd],forceReload:true});return response(skills);}});
await check("仅识别显式标记，去重且不把路径、转义和更长变量截成技能",()=>{assert.deepEqual(skillNames("$build task $build; $HOME/bin \\$skip $buildMore $skill-name."),["build","buildMore","skill-name"]);});
await check("无标记时不做发现调用",async()=>assert.deepEqual(await skillInput({call:()=>{throw new Error("unexpected");}},cwd,"normal text"),[]));
await check("只传原生路径和名字，敏感描述与依赖不进入清单",()=>{const x=normalizeSkills(response([row()]),cwd);assert.equal(x.skills[0].name,"build");assert(!JSON.stringify(x).includes("SECRET"));});
await check("手动唯一标记转换成原生输入",async()=>assert.deepEqual(await skillInput(client([row()]),cwd,"$build task"),[{type:"skill",name:"build",path:"/skills/build/SKILL.md"}]));
await check("未知美元变量仍是普通文字",async()=>assert.deepEqual(await skillInput(client([row()]),cwd,"echo $HOME"),[]));
await check("同名技能必须选具体路径",async()=>{const rows=[row(),row("build","/other/build/SKILL.md")];await assert.rejects(()=>skillInput(client(rows),cwd,"$build"),/同名/);const x=await skillInput(client(rows),cwd,"$build",[{name:"build",path:"/other/build/SKILL.md"}]);assert.equal(x[0].path,"/other/build/SKILL.md");});
await check("不能伪造路径、跨目录或使用停用技能",async()=>{await assert.rejects(()=>skillInput(client([row()]),cwd,"$build",[{name:"build",path:"/auth/SKILL.md"}]));await assert.rejects(()=>skillInput(client([row("build",undefined,false)]),cwd,"$build"));});
await check("选择标记被移除后拒绝旧引用",async()=>assert.rejects(()=>skillInput(client([row()]),cwd,"plain",[{name:"build",path:"/skills/build/SKILL.md"}])));
await check("清单过大与解析失败不伪造成功",async()=>{await assert.rejects(()=>skillInput(client(Array.from({length:201},(_,i)=>row("s"+i))),cwd,"$s0"),/过大/);await assert.rejects(()=>skillInput({call:async()=>{throw new Error("SECRET");}},cwd,"$build"),e=>!e.message.includes("SECRET"));});
await check("格式、数量、空字符与相对路径明确拒绝",()=>{for(const refs of [{},[{name:"x",path:"relative"}],[{name:"x",path:"/x\0"}],Array(17).fill({name:"x",path:"/x"})])assert.throws(()=>validateSkillRefs(refs));});
await check("历史证据只说明核心接受输入，不宣称技能已执行",()=>{const p=submittedSkills([{type:"text",text:"x"},{type:"skill",name:"build",path:"/s"}]);assert.equal(p[0].evidence,"core-accepted-input");assert.equal(p.length,1);});
console.log(n+"/"+n+" passed");
// 技能发现会加载应用设置及其后台计时器；所有断言结束后显式退出测试进程。
process.exit(0);
