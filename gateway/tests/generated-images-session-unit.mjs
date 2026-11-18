import fs from "node:fs";import os from "node:os";import assert from "node:assert/strict";import {fakeCodexBin} from "./helpers/fake-codex-bin.mjs";
const root=fs.mkdtempSync(os.tmpdir()+"/generated-image-session-"),ws=root+"/workspace",cwd=ws+"/project",core=root+"/core";fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(core);Object.assign(process.env,{CCAPP_TEST:"1",CCAPP_HOME:root,CCAPP_WORKSPACE:ws,CCAPP_LOG:root+"/log"});const {CodexSession,DEFAULT_SERVER_ARGS}=await import("../gw/codex/session.mjs"),options={cwd,bin:fakeCodexBin(root+"/bin"),codexHome:core,dataDir:root,deviceMcpScript:root+"/missing"};
let s=new CodexSession(options),n=0;const check=(label,f)=>{f();console.log("ok "+(++n)+" "+label)};
try{
 await s.start();const events=[];let r=await s.runTurn({text:"GENERATED_IMAGE_FIXTURE OK",onEvent:e=>events.push(e)});assert.equal(r.status,"completed");const image=s.items.find(i=>i.generatedImage&&i.role==="tool_result"),original=s.client.notifications.find(m=>m.method==="item/completed"&&m.params.item?.type==="imageGeneration").params.item.savedPath;
 check("项目会话产物存到共享工作区，保持用户项目目录不变",()=>{assert(image.ok);assert(image.imagePath.startsWith(ws+"/.cccodroid-generated/"));assert(!image.imagePath.startsWith(cwd+"/"));assert.deepEqual(fs.readdirSync(cwd),[]);});
 r=await s.runTurn({text:"IMAGE_READER_FIXTURE "+JSON.stringify({path:original,viaMcp:true})});
 check("模型可通过原核心路径重读自己已发布的图片",()=>{assert.equal(r.status,"completed");assert(JSON.parse(fs.readFileSync(core+"/fake-image-result.json")).success)});
 r=await s.runTurn({text:"IMAGE_READER_FIXTURE "+JSON.stringify({path:image.imagePath})});
 check("后续轮次可通过公开产物路径重读",()=>{assert.equal(r.status,"completed");assert(JSON.parse(fs.readFileSync(core+"/fake-image-result.json")).success)});
 fs.writeFileSync(core+"/auth.json","PRIVATE");r=await s.runTurn({text:"IMAGE_READER_FIXTURE "+JSON.stringify({path:core+"/auth.json",viaMcp:true})});
 check("产物许可不扩大到私有配置或整个工作区",()=>{assert.equal(JSON.parse(fs.readFileSync(core+"/fake-image-result.json")).success,false);});
 check("传给模型的图片不写回宿主历史或诊断缓存",()=>{const text=JSON.stringify({history:s.items,events,notifications:s.client.notifications.filter(m=>m.params?.item?.type==="imageGeneration")});assert(!text.includes("iVBORw0KGgo"));});
 await s.dispose();s=new CodexSession({...options,serverArgs:[...DEFAULT_SERVER_ARGS]});s.taskIsolated=true;await s.start();
 check("无人值守核心显式禁用图片生成",()=>assert.deepEqual(s.client.serverArgs.slice(-2),["--disable","image_generation"]));
}finally{await s.dispose();}
console.log(n+"/"+n+" passed");process.exit(0);
