import fs from "node:fs";import os from "node:os";import path from "node:path";import assert from "node:assert/strict";
import {readTextPage,checkTextSample,MAX_TEXT_READ_BYTES as CAP} from "../gw/codex/text-reader.mjs";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"large-text-unit-")),file=path.join(root,"large.log");
Object.assign(process.env,{CCAPP_TEST:"1",CCAPP_HOME:path.join(root,"home"),CCAPP_WORKSPACE:root,CCAPP_SHARED:""});
const {buildToolRegistry}=await import("../gw/codex/tools/index.mjs");
let count=0;async function check(label,fn){await fn();console.log("ok "+(++count)+" "+label);}
try{
await check("大日志按行定位末尾，不返回前文",async()=>{fs.writeFileSync(file,"start\n"+"row\n".repeat(200000)+"尾部标记");const p=await readTextPage(file,{offset:200002,limit:1});assert.equal(p.text,"尾部标记");assert.equal(p.nextByteOffset,null);});
await check("行数分页给出精确字节续读位置",async()=>{fs.writeFileSync(file,"one\ntwo\nthree");const p=await readTextPage(file,{limit:2});assert.equal(p.text,"one\ntwo");assert.equal(p.nextByteOffset,8);assert.equal((await readTextPage(file,{byteOffset:p.nextByteOffset})).text,"three");});
await check("超长单行 UTF-8 跨块续读不丢字节",async()=>{const s="前缀"+"😀中".repeat(90000)+"END";fs.writeFileSync(file,s);let cursor=0,out="";do{const p=await readTextPage(file,{byteOffset:cursor});assert(p.bytes<=CAP);assert(p.text.length);assert(!p.text.includes("�"));out+=p.text;cursor=p.nextByteOffset;}while(cursor!==null);assert.equal(out,s);});
await check("CRLF、空行与尾部无换行保持原样",async()=>{fs.writeFileSync(file,"a\r\n\r\n尾");assert.equal((await readTextPage(file,{offset:2})).text,"\r\n尾");});
await check("UTF-8 样本边界不误报完整中文",async()=>{fs.writeFileSync(file,"A".repeat(32767)+"中"+ "Z".repeat(CAP));checkTextSample(file);const p=await readTextPage(file);assert(p.text.includes("中"));assert.equal(p.bytes,CAP);});
await check("文件末尾截断的 UTF-8 仍报错",async()=>{fs.writeFileSync(file,Buffer.concat([Buffer.alloc(CAP-1,65),Buffer.from([0xe4])]));await assert.rejects(readTextPage(file),/UTF-8/);});
await check("样本之后实际读取到的非 UTF-8 拒绝返回",async()=>{fs.writeFileSync(file,Buffer.concat([Buffer.alloc(40000,65),Buffer.from([255])]));checkTextSample(file);await assert.rejects(readTextPage(file),/UTF-8/);});
await check("样本之后的 NUL 拒绝返回",async()=>{fs.writeFileSync(file,Buffer.concat([Buffer.alloc(40000,65),Buffer.from([0])]));await assert.rejects(readTextPage(file),/UTF-8/);});
await check("PDF、ZIP、Office 签名不能作为文本",()=>{for(const data of [Buffer.from("%PDF-1.7"),Buffer.from([80,75,3,4,65]),Buffer.from([208,207,17,224,161,177,26,225])]){fs.writeFileSync(file,data);assert.throws(()=>checkTextSample(file),/请先转换/);}});
await check("空文件、超出行数和恰好 EOF 的游标正常结束",async()=>{fs.writeFileSync(file,"");assert.equal((await readTextPage(file)).text,"");fs.writeFileSync(file,"one");assert.equal((await readTextPage(file,{offset:9})).text,"");assert.equal((await readTextPage(file,{byteOffset:3})).nextByteOffset,null);});
await check("无效及 UTF-8 字符内部的游标明确失败",async()=>{fs.writeFileSync(file,"中文");for(const args of [{byteOffset:-1},{byteOffset:99},{byteOffset:1},{byteOffset:0,offset:2},{offset:Number.MAX_SAFE_INTEGER+1}])await assert.rejects(readTextPage(file,args));});
await check("扫描过程中取消会及时停止",async()=>{const c=new AbortController();c.abort();await assert.rejects(readTextPage(file,{signal:c.signal}),/abort/i);});
await check("超过 4000 行的默认读取按行截断",async()=>{fs.writeFileSync(file,"x\n".repeat(5000));const p=await readTextPage(file);assert.equal(p.nextByteOffset,8000);assert.equal(p.text.split("\n").length,4000);});
await check("大文件仅读取样本和所需区间，不加载整份文件",async()=>{
 const fd=fs.openSync(file,"w");fs.writeSync(fd,Buffer.alloc(CAP+1,65));fs.ftruncateSync(fd,1024*1024*1024);fs.closeSync(fd);
 const orig=fs.promises.open;let readBytes=0;fs.promises.open=async(...a)=>{const h=await orig(...a),read=h.read.bind(h);h.read=async(...v)=>{const r=await read(...v);readBytes+=r.bytesRead;return r;};return h;};
 try{const p=await readTextPage(file);assert.equal(p.bytes,CAP);assert(readBytes<=CAP);assert.equal(p.nextByteOffset,CAP);}finally{fs.promises.open=orig;}
});
await check("工作区大文本可读，但编辑上限保持不变",async()=>{fs.writeFileSync(file,"A".repeat(CAP+1));const {registry}=buildToolRegistry({roots:[root],cwd:root});const r=await registry.handleCall({tool:"cccodroid_read_file",arguments:{path:file}});assert(r.success);const e=await registry.handleCall({tool:"cccodroid_edit_file",arguments:{path:file,oldText:"A",newText:"B"}});assert(!e.success);assert.equal(fs.readFileSync(file)[0],65);});
console.log(count+"/"+count+" passed");
}finally{fs.rmSync(root,{recursive:true,force:true});}
