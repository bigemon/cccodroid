import fs from "node:fs";import os from "node:os";import path from "node:path";import assert from "node:assert/strict";
import {buildToolRegistry} from "../gw/codex/tools/index.mjs";
import {imageMime,MAX_IMAGE_BYTES} from "../gw/codex/images.mjs";
import {codexInput} from "../gw/codex/attachments.mjs";
import {codexToolPolicy,SHARED_READ_TOOLS,toolEffect} from "../gw/codex/permissions.mjs";
import {codexTaskPolicy,taskToolAllowed} from "../gw/codex/task-policy.mjs";
import {AutoMcpBridge} from "../gw/codex/auto-mcp.mjs";import {ReadMcpBridge} from "../gw/codex/read-mcp.mjs";
import {nativeTurnItems} from "../gw/codex/history-view.mjs";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"image-reader-unit-")),ws=path.join(root,"ws");fs.mkdirSync(ws);
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==","base64");
fs.writeFileSync(path.join(ws,"image.png"),png);fs.writeFileSync(path.join(root,"outside.png"),png);fs.mkdirSync(path.join(root,"ws-neighbor"));fs.writeFileSync(path.join(root,"ws-neighbor/image.png"),png);
fs.symlinkSync(path.join(root,"outside.png"),path.join(ws,"outside-link.png"));fs.symlinkSync(path.join(ws,"image.png"),path.join(ws,"inside-link.png"));
let n=0;async function check(label,fn){await fn();console.log("ok "+(++n)+" "+label);}
const {registry}=buildToolRegistry({roots:[ws],cwd:ws,auditFile:path.join(root,"audit.jsonl")});
let seq=0;const read=(p,extra={})=>registry.handleCall({tool:"cccodroid_read_image",callId:"image-"+(++seq),arguments:{path:p,...extra}});
const fail=async(p,code)=>{const r=await read(p);assert.equal(r.success,false);assert(r.contentItems[0].text.includes(code));};
try{
await check("图片工具声明单一路径参数并提示直接读图",()=>{const s=registry.specs().find(s=>s.name==="cccodroid_read_image");assert(s.description.includes("one call"));assert.deepEqual(s.inputSchema.required,["path"]);assert.equal(s.inputSchema.additionalProperties,false);});
await check("动态工具一次返回说明和原生图片，二进制逐字节一致",async()=>{const r=await read("image.png");assert(r.success);assert.deepEqual(r.contentItems.map(c=>c.type),["inputText","inputImage"]);assert(!r.contentItems[0].text.includes("base64"));assert(Buffer.from(r.contentItems[1].imageUrl.split(",")[1],"base64").equals(png));});
await check("工作区绝对路径和内部软链接可读",async()=>{assert((await read(path.join(ws,"image.png"))).success);assert((await read("inside-link.png")).success);});
await check("无后缀图片也按实际字节识别",async()=>{fs.writeFileSync(path.join(ws,"no-extension"),png);assert((await read("no-extension")).contentItems[1].imageUrl.startsWith("data:image/png;"));});
for(const [name,bytes,mime]of [["jpeg",Buffer.from([255,216,255,224]),"image/jpeg"],["gif",Buffer.from("GIF89a"),"image/gif"],["webp",Buffer.from("RIFF0000WEBP"),"image/webp"]]){
 await check(name+" 按签名映射正确 MIME",async()=>{fs.writeFileSync(path.join(ws,"format-"+name),bytes);const r=await read("format-"+name);assert(r.success);assert(r.contentItems[1].imageUrl.startsWith("data:"+mime+";base64,"));});
}
await check("绝对外部路径被拒绝",()=>fail(path.join(root,"outside.png"),"path-outside-root"));
await check("相对路径不能逃出工作区",()=>fail("../outside.png","path-outside-root"));
await check("指向外部的软链接被拒绝",()=>fail("outside-link.png","path-outside-root"));
await check("相似前缀目录不能越界",()=>fail(path.join(root,"ws-neighbor/image.png"),"path-outside-root"));
await check("缺失文件返回明确错误",()=>fail("missing.png","path-not-found"));
await check("目录不能作为图片",()=>fail(".","invalid-image-size"));
await check("空文件不能作为图片",async()=>{fs.writeFileSync(path.join(ws,"empty.png"),"");await fail("empty.png","invalid-image-size");});
await check("大于 20 MiB 在读取内容前拒绝",async()=>{const f=path.join(ws,"large.png"),fd=fs.openSync(f,"w");fs.ftruncateSync(fd,MAX_IMAGE_BYTES+1);fs.closeSync(fd);await fail("large.png","invalid-image-size");});
await check("伪装图片与不支持的格式返回转换提示",async()=>{fs.writeFileSync(path.join(ws,"fake.png"),"NOT_A_PICTURE");await fail("fake.png","unsupported-image");fs.writeFileSync(path.join(ws,"bmp"),"BM0000");await fail("bmp","unsupported-image");});
await check("非法参数不会读图",async()=>{assert.equal((await read("image.png",{offset:1})).success,false);await fail("image.png\0","path-nul");});
await check("所有手动权限模式下读图均无需审批",async()=>{assert.equal(toolEffect("cccodroid_read_image"),"read");assert(SHARED_READ_TOOLS.has("cccodroid_read_image"));let asks=0;for(const mode of ["default","acceptEdits","plan","auto","bypassPermissions"])await codexToolPolicy({mode,confirm:()=>{asks++;return false;}}).authorize({name:"cccodroid_read_image"});assert.equal(asks,0);});
await check("定时任务只读与自定义权限可选择图片工具",()=>{assert(taskToolAllowed(codexTaskPolicy("ro"),"cccodroid_read_image"));assert(taskToolAllowed(codexTaskPolicy("custom","cccodroid_read_image"),"cccodroid_read_image"));assert(!taskToolAllowed(codexTaskPolicy("custom","cccodroid_read_file"),"cccodroid_read_image"));});
for(const [label,Bridge]of [["自动判断",AutoMcpBridge],["子代理只读",ReadMcpBridge]]){
 let active=true,approvals=0;const b=await new Bridge({registry,active:()=>active,authorize:()=>{approvals++;return false;}}).start();
 const call=async(method,params={},auth=true)=>{const r=await fetch(b.config().url,{method:"POST",headers:{"content-type":"application/json",...(auth?{authorization:"Bearer "+b.token}:{})},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})});return {status:r.status,data:await r.json()};};
 try{
 await check(label+" MCP 声明图片工具只读且无需写入授权",async()=>{const t=(await call("tools/list")).data.result.tools.find(t=>t.name==="cccodroid_read_image");assert(t.annotations.readOnlyHint);assert(!t.annotations.destructiveHint);});
 await check(label+" MCP 原样传输图片内容及 MIME",async()=>{const r=(await call("tools/call",{name:"cccodroid_read_image",arguments:{path:"image.png"}})).data.result;assert(!r.isError);assert.deepEqual(r.content.map(c=>c.type),["text","image"]);assert.equal(r.content[1].mimeType,"image/png");assert(Buffer.from(r.content[1].data,"base64").equals(png));assert.equal(approvals,0);});
 await check(label+" MCP 错误不包含图片且拒绝越界",async()=>{const r=(await call("tools/call",{name:"cccodroid_read_image",arguments:{path:"outside-link.png"}})).data.result;assert(r.isError);assert(r.content.every(c=>c.type==="text"));});
 await check(label+" MCP 仍要求认证和有效活动状态",async()=>{assert.equal((await call("tools/list",{},false)).status,401);active=false;assert((await call("tools/call",{name:"cccodroid_read_image",arguments:{path:"image.png"}})).data.result.isError);});
 }finally{await b.close();}
}
await check("审计记录不保存图片二进制或 base64",()=>{const log=fs.readFileSync(path.join(root,"audit.jsonl"),"utf8");assert(!log.includes(png.toString("base64")));assert(!log.includes("data:image/"));});
await check("原生历史投影只保留图片提示而非二进制",()=>{for(const type of ["dynamicToolCall","mcpToolCall"]){const out=nativeTurnItems({id:"turn",status:"completed",items:[{type,id:"image",tool:"cccodroid_read_image",arguments:{path:"image.png"},success:true,contentItems:[{type:"inputText",text:"image.png"},{type:"inputImage",imageUrl:"data:image/png;base64,"+png.toString("base64")}],result:{content:[{type:"text",text:"image.png"},{type:"image",data:png.toString("base64"),mimeType:"image/png"}]}}]});assert(out.find(m=>m.role==="tool_result").text.includes("[图片附件]"));assert(!JSON.stringify(out).includes(png.toString("base64")));}});
await check("显式图片附件沿用原生 localImage 和原路径边界",()=>{assert.equal(codexInput("@image.png",[],{cwd:ws})[1].type,"localImage");assert.throws(()=>codexInput("@../outside.png",[],{cwd:ws}),/outside allowed roots/);assert.equal(imageMime(png),"image/png");assert.equal(imageMime(Buffer.from("text")),null);});
console.log(n+"/"+n+" passed");
}finally{fs.rmSync(root,{recursive:true,force:true});}
