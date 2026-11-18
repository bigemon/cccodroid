import fs from "node:fs";import os from "node:os";import path from "node:path";import assert from "node:assert/strict";
import {TextAttachmentAccess,attachmentText} from "../gw/codex/text-attachments.mjs";
import {buildToolRegistry} from "../gw/codex/tools/index.mjs";
import {AutoMcpBridge} from "../gw/codex/auto-mcp.mjs";import {ReadMcpBridge} from "../gw/codex/read-mcp.mjs";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"text-attachments-unit-")),ws=path.join(root,"project"),uploads=path.join(root,"uploads");fs.mkdirSync(ws);fs.mkdirSync(uploads);
const file=path.join(uploads,"readme.md"),other=path.join(uploads,"other.txt"),secret=path.join(root,"secret.txt");fs.writeFileSync(file,"第一行\nATTACHED_MARKER\nlast line");fs.writeFileSync(other,"OTHER");fs.writeFileSync(secret,"SECRET");fs.writeFileSync(path.join(ws,"local.txt"),"LOCAL");
const access=new TextAttachmentAccess({cwd:ws,uploadDir:uploads});let seq=0;
const {registry}=buildToolRegistry({roots:[ws],cwd:ws,readAttachment:p=>access.read(p)}),call=(tool,args)=>registry.handleCall({tool,callId:"file-"+(++seq),arguments:args}),read=(p,extra={})=>call("cccodroid_read_file",{path:p,...extra});
let n=0;async function check(label,fn){await fn();console.log("ok "+(++n)+" "+label);}
try{
await check("未附加的上传文件仍不能读取",async()=>assert.equal((await read(file)).success,false));
await check("显式附件与 @引用去重，只产生逐文件许可",()=>{const files=access.prepare("@"+file,[{path:file}]);assert.deepEqual(files,[file]);access.grant(files);assert.deepEqual(access.paths(),[file]);});
await check("复用原读文件工具的 UTF-8、偏移和行数",async()=>{const r=await read(file,{offset:2,limit:1});assert(r.success);assert(r.contentItems[0].text.endsWith("\nATTACHED_MARKER"));assert(!r.contentItems[0].text.includes("last line"));});
await check("相对附件路径可用且工作区读取保持原行为",async()=>{assert((await read("../uploads/readme.md")).success);assert((await read("local.txt")).success);});
await check("同目录未附加文件仍拒绝",async()=>assert.equal((await read(other)).success,false));
await check("许可不扩大目录列举、搜索和写入根目录",async()=>{for(const [tool,args]of [["cccodroid_list_files",{path:uploads}],["cccodroid_search",{path:uploads,pattern:"OTHER"}],["cccodroid_write_file",{path:file,content:"BAD"}],["cccodroid_edit_file",{path:file,oldText:"ATTACHED_MARKER",newText:"BAD"}]])assert.equal((await call(tool,args)).success,false);assert(fs.readFileSync(file,"utf8").includes("ATTACHED_MARKER"));});
await check("另一个会话不继承许可",()=>{const otherAccess=new TextAttachmentAccess({cwd:ws,uploadDir:uploads});assert.equal(otherAccess.read(file),null);});
await check("只保存路径即可在重启后恢复读取",async()=>{const saved=JSON.parse(JSON.stringify(access.paths())),cold=new TextAttachmentAccess({cwd:ws,uploadDir:uploads,paths:saved});const {registry:r}=buildToolRegistry({roots:[ws],cwd:ws,readAttachment:p=>cold.read(p)});const out=await r.handleCall({tool:"cccodroid_read_file",arguments:{path:file}});assert(out.success);assert(out.contentItems[0].text.includes("ATTACHED_MARKER"));});
await check("持久化的异常路径不能授权任意外部文件",()=>{const cold=new TextAttachmentAccess({cwd:ws,uploadDir:uploads,paths:[secret,uploads,"relative.txt",null,{},file]});assert.equal(cold.read(secret),null);assert(cold.read(file));});
await check("缺失附件保留许可记录，实际读取明确报告丢失",async()=>{fs.renameSync(file,file+".gone");assert.throws(()=>access.read(file),/重新附加/);const cold=new TextAttachmentAccess({cwd:ws,uploadDir:uploads,paths:access.paths()});assert.throws(()=>cold.read(file),/重新附加/);fs.renameSync(file+".gone",file);});
await check("附加后增长的大文本仍可分段读取",async()=>{const old=fs.readFileSync(file);fs.writeFileSync(file,"A".repeat(300000));const r=await read(file);assert(r.success);assert(r.contentItems[0].text.includes("byteOffset: 262144"));assert(Buffer.byteLength(r.contentItems[0].text)<263000);fs.writeFileSync(file,old);});
await check("附件自身更新为普通文本时可以读到最新内容",async()=>{const old=fs.readFileSync(file);fs.writeFileSync(file,"UPDATED");assert((await read(file)).contentItems[0].text.endsWith("\nUPDATED"));fs.writeFileSync(file,old);});
await check("新附加的大文本可取得逐文件许可",()=>{const p=path.join(uploads,"large.txt");fs.writeFileSync(p,"A".repeat(300000));assert.deepEqual(access.prepare("",[{path:p}]),[p]);});
await check("目录不能作为文本附件",()=>assert.throws(()=>access.prepare("",[{path:uploads}]),/不是普通/));
await check("非 UTF-8、二进制和不完整 PDF 不能取得读取许可",()=>{for(const [name,data]of [["bad.txt",Buffer.from([255,254,65])],["binary",Buffer.from([65,0,66])],["paper.pdf",Buffer.from("%PDF-1.7")]]){const p=path.join(uploads,name);fs.writeFileSync(p,data);assert.throws(()=>access.prepare("",[{path:p}]),/UTF-8|PDF/);}});
await check("空文本附件可读取",async()=>{const p=path.join(uploads,"empty.txt");fs.writeFileSync(p,"");access.grant(access.prepare("",[{path:p}]));assert((await read(p)).contentItems[0].text.endsWith("\n"));});
await check("任意项目外路径和上传软链接逃逸不能取得许可",()=>{const link=path.join(uploads,"escape.txt");fs.symlinkSync(secret,link);for(const p of [secret,link])assert.throws(()=>access.prepare("",[{path:p}]),/outside allowed roots/);});
await check("原授权路径被换成软链接时拒绝访问新文件",()=>{const copy=file+".copy";fs.renameSync(file,copy);fs.symlinkSync(other,file);assert.throws(()=>access.read(file),/已指向其他/);fs.unlinkSync(file);fs.renameSync(copy,file);});
await check("图片仍交给原生图片输入，不增加文本许可",()=>{const p=path.join(uploads,"shot.png");assert.deepEqual(access.prepare("@"+p,[{path:p}]),[]);});
await check("普通 @提及和作用域包名不误判为附件",()=>assert.deepEqual(access.prepare("问 @alice，安装 @types/node 与 @scope/package"),[]));
await check("仅在需要时补充附件路径，正文不注入内容",()=>{assert.equal(attachmentText("Read", [file]),"Read\n\n@"+file);assert.equal(attachmentText("Read @"+file,[file]),"Read @"+file);assert(!attachmentText("Read",[file]).includes("ATTACHED_MARKER"));});
await check("单条消息附件数量保持既有上限",()=>assert.throws(()=>access.prepare("",Array.from({length:17},()=>({path:file}))),/16/));
await check("显式附件路径包含空格也能从元数据读取",async()=>{const p=path.join(uploads,"two words.txt");fs.writeFileSync(p,"SPACE");access.grant(access.prepare("Read @"+p,[{path:p}]));assert((await read(p)).contentItems[0].text.endsWith("\nSPACE"));});
for(const [label,Bridge]of [["自动判断",AutoMcpBridge],["子代理只读",ReadMcpBridge]]){
 const b=await new Bridge({registry,active:()=>true,authorize:()=>false}).start();try{
 await check(label+" MCP 同样读取已附加文本且不读相邻文件",async()=>{const invoke=async p=>{const r=await fetch(b.config().url,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+b.token},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"cccodroid_read_file",arguments:{path:p}}})});return (await r.json()).result;};const yes=await invoke(file),no=await invoke(other);assert(!yes.isError);assert(yes.content[0].text.includes("ATTACHED_MARKER"));assert(no.isError);});
 }finally{await b.close();}
}
console.log(n+"/"+n+" passed");
}finally{fs.rmSync(root,{recursive:true,force:true});}
