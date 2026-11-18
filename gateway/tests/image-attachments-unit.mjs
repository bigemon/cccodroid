import fs from "node:fs";import os from "node:os";import path from "node:path";import assert from "node:assert/strict";
import {ImageAttachmentAccess,TextAttachmentAccess,attachmentText} from "../gw/codex/text-attachments.mjs";
import {buildToolRegistry} from "../gw/codex/tools/index.mjs";import {MAX_IMAGE_BYTES} from "../gw/codex/images.mjs";
import {AutoMcpBridge} from "../gw/codex/auto-mcp.mjs";import {ReadMcpBridge} from "../gw/codex/read-mcp.mjs";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"image-attachments-unit-")),cwd=path.join(root,"project"),uploads=path.join(root,"uploads");fs.mkdirSync(cwd);fs.mkdirSync(uploads);
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+r8AAAAASUVORK5CYII=","base64");
const file=path.join(uploads,"shot.png"),other=path.join(uploads,"other.png"),secret=path.join(root,"secret.png"),text=path.join(uploads,"notes.txt");for(const p of [file,other,secret,path.join(cwd,"local.png")])fs.writeFileSync(p,png);fs.writeFileSync(text,"TEXT_ONLY");
const access=new ImageAttachmentAccess({cwd,uploadDir:uploads}),texts=new TextAttachmentAccess({cwd,uploadDir:uploads});
const {registry}=buildToolRegistry({roots:[cwd],cwd,auditFile:path.join(root,"audit.jsonl"),readImageAttachment:p=>access.read(p),readAttachment:p=>texts.read(p)});
let seq=0,n=0;const call=(tool,args)=>registry.handleCall({tool,callId:"image-"+(++seq),arguments:args}),read=p=>call("cccodroid_read_image",{path:p}),bytes=r=>Buffer.from(r.contentItems.find(i=>i.type==="inputImage").imageUrl.split(",")[1],"base64");
async function check(label,fn){await fn();console.log("ok "+(++n)+" "+label);}
try{
await check("未附加的项目外图片不能读取",async()=>assert.equal((await read(file)).success,false));
await check("显式附件与 @引用去重，路径可供后续重新读取",()=>{const files=access.prepare("@"+file,[{path:file}]);assert.deepEqual(files,[file]);access.grant(files);assert.equal(attachmentText("Inspect",files),"Inspect\n\n@"+file);});
await check("原读图工具一次返回原生图片且字节一致",async()=>{const r=await read(file);assert(r.success);assert.deepEqual(r.contentItems.map(i=>i.type),["inputText","inputImage"]);assert(bytes(r).equals(png));});
await check("相对图片路径和项目内图片保持可读",async()=>{assert((await read("../uploads/shot.png")).success);assert((await read("local.png")).success);});
await check("相邻图片与另会话均不能借用许可",async()=>{assert.equal((await read(other)).success,false);const another=new ImageAttachmentAccess({cwd,uploadDir:uploads});assert.equal(another.read(file),null);});
await check("图片许可不能用于文本工具读取",async()=>assert.equal((await call("cccodroid_read_file",{path:file})).success,false));
await check("文本与图片许可共用校验但分别保存，文本不能借用图片入口",async()=>{texts.grant(texts.prepare("",[{path:text}]));assert((await call("cccodroid_read_file",{path:text})).success);assert.equal((await read(text)).success,false);assert.deepEqual(access.prepare("",[{path:text}]),[]);assert.deepEqual(texts.prepare("",[{path:file}]),[]);});
await check("图片许可不扩大目录、搜索、写入或编辑根目录",async()=>{for(const [tool,args]of [["cccodroid_list_files",{path:uploads}],["cccodroid_search",{path:uploads,pattern:"PNG"}],["cccodroid_write_file",{path:file,content:"BAD"}],["cccodroid_edit_file",{path:file,oldText:"PNG",newText:"BAD"}]])assert.equal((await call(tool,args)).success,false);assert(fs.readFileSync(file).equals(png));});
await check("持久化的路径列表在重启后恢复读图能力",async()=>{const cold=new ImageAttachmentAccess({cwd,uploadDir:uploads,paths:JSON.parse(JSON.stringify(access.paths()))});const {registry:r}=buildToolRegistry({roots:[cwd],cwd,readImageAttachment:p=>cold.read(p)});const out=await r.handleCall({tool:"cccodroid_read_image",arguments:{path:file}});assert(out.success);assert(bytes(out).equals(png));});
await check("异常持久化路径不能授权任意项目外文件",()=>{const cold=new ImageAttachmentAccess({cwd,uploadDir:uploads,paths:[secret,uploads,"relative.png",{},null,file]});assert.equal(cold.read(secret),null);assert(cold.read(file));});
await check("普通续聊不扫描历史或自动增加授权",()=>{const fresh=new ImageAttachmentAccess({cwd,uploadDir:uploads});assert.deepEqual(fresh.prepare("Please look again"),[]);assert.deepEqual(fresh.paths(),[]);});
await check("新增伪装图片在授予许可前被拒绝",()=>{const p=path.join(uploads,"fake.png");fs.writeFileSync(p,"NOT_IMAGE");assert.throws(()=>access.prepare("",[{path:p}]),/PNG|图片格式/);assert(!access.paths().includes(p));});
await check("超出20MiB的图片在授予许可前被拒绝",()=>{const p=path.join(uploads,"large.png"),fd=fs.openSync(p,"w");fs.ftruncateSync(fd,MAX_IMAGE_BYTES+1);fs.closeSync(fd);assert.throws(()=>access.prepare("",[{path:p}]),/20 MiB/);assert(!access.paths().includes(p));});
await check("任意外部图片和上传目录软链接逃逸均拒绝",()=>{const link=path.join(uploads,"escape.png");fs.symlinkSync(secret,link);for(const p of [secret,link])assert.throws(()=>access.prepare("",[{path:p}]),/outside allowed roots/);});
await check("授权文件被换成软链接后热读取与冷恢复都拒绝新目标",()=>{fs.renameSync(file,file+".kept");fs.symlinkSync(other,file);assert.throws(()=>access.read(file),/已指向其他/);const cold=new ImageAttachmentAccess({cwd,uploadDir:uploads,paths:access.paths()});assert.throws(()=>cold.read(file),/已指向其他/);fs.unlinkSync(file);fs.renameSync(file+".kept",file);});
await check("附件丢失时保留许可但明确要求重新附加",async()=>{fs.renameSync(file,file+".kept");const out=await read(file);assert(!out.success);assert(out.contentItems[0].text.includes("重新附加"));const cold=new ImageAttachmentAccess({cwd,uploadDir:uploads,paths:access.paths()});assert.throws(()=>cold.read(file),/重新附加/);fs.renameSync(file+".kept",file);});
await check("已授权图片更新后返回最新文件内容",async()=>{const updated=Buffer.concat([png,Buffer.from("UPDATED")]);fs.writeFileSync(file,updated);assert(bytes(await read(file)).equals(updated));fs.writeFileSync(file,png);});
await check("已授权路径变为非图片时不返回二进制内容",async()=>{fs.writeFileSync(file,"NO_PIXELS");const r=await read(file);assert(!r.success);assert(r.contentItems.every(i=>i.type==="inputText"));fs.writeFileSync(file,png);});
await check("附件数量和带空格的显式路径沿用现有约定",async()=>{assert.throws(()=>access.prepare("",Array.from({length:17},()=>({path:file}))),/16/);const p=path.join(uploads,"two words.png");fs.writeFileSync(p,png);access.grant(access.prepare("Read @"+p,[{path:p}]));assert((await read(p)).success);});
for(const [label,Bridge]of [["自动判断",AutoMcpBridge],["子代理只读",ReadMcpBridge]]){
 let approvals=0;const bridge=await new Bridge({registry,active:()=>true,authorize:()=>{approvals++;return false;}}).start();
 try{await check(label+" MCP 返回标准图片并继续拒绝相邻文件",async()=>{const invoke=async p=>{const r=await fetch(bridge.config().url,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+bridge.token},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"cccodroid_read_image",arguments:{path:p}}})});return (await r.json()).result;};const yes=await invoke(file),no=await invoke(other);assert(!yes.isError);assert.deepEqual(yes.content.map(i=>i.type),["text","image"]);assert.equal(yes.content[1].mimeType,"image/png");assert(Buffer.from(yes.content[1].data,"base64").equals(png));assert(no.isError);assert(no.content.every(i=>i.type==="text"));assert.equal(approvals,0);});}finally{await bridge.close();}
}
await check("审计仅保留参数和结果说明，不保存图片base64",()=>{const audit=fs.readFileSync(path.join(root,"audit.jsonl"),"utf8");assert(!audit.includes(png.toString("base64")));assert(!audit.includes("data:image/"));});
console.log(n+"/"+n+" passed");
}finally{fs.rmSync(root,{recursive:true,force:true});}
