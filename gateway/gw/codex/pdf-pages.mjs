// 指定 PDF 单页转图。授权由调用方完成；临时快照/输出不进入会话或持久缓存。
import fs from "node:fs";
import path from "node:path";
import {CFG} from "../config.mjs";
import {ToolError} from "./paths.mjs";
import {checkPdfFile,MAX_PDF_BYTES,pdfBinary,pdfEnvironment} from "./pdf-reader.mjs";
import {startProcess} from "./tools/exec.mjs";
export const MAX_PDF_PAGE_PIXELS=1600,MAX_PDF_PAGE_BYTES=20*1024*1024;
// 仅识别 PDF 后缀后的页码片段，保持原 path-only 工具协议。
export function pdfPageReference(input){
 const match=/^(.*\.pdf)#page=(.*)$/i.exec(input);
 if(!match)return {file:input,page:1,explicit:false};
 if(!/^[1-9]\d{0,8}$/.test(match[2]))throw new ToolError("pdf-page","PDF 页码必须是从 1 开始的整数，例如 paper.pdf#page=2。");
 return {file:match[1],page:Number(match[2]),explicit:true};
}
export async function readPdfImagePage(file,{page=1,signal}={},options={}){
 signal?.throwIfAborted();
 if(!Number.isSafeInteger(page)||page<1||page>999999999)throw new ToolError("pdf-page","PDF 页码必须是从 1 开始的整数。");
 const st=checkPdfFile(file),binary=options.binary===undefined?pdfBinary("mutool"):options.binary;
 if(!binary)throw new ToolError("pdf-tool-missing","PDF 页面渲染工具 mutool 未安装；仍可尝试 read_file 提取文字层。");
 const data=fs.readFileSync(file);
 if(data.length!==st.size||data.length>MAX_PDF_BYTES||data.subarray(0,5).toString()!=="%PDF-")throw new ToolError("pdf-changed","PDF 读取期间发生变化，请重试。");
 fs.mkdirSync(CFG.home,{recursive:true});
 const dir=fs.mkdtempSync(path.join(CFG.home,".pdf-page-"));
 try{
  const source=path.join(dir,"source.pdf"),output=path.join(dir,"page.png");
  fs.writeFileSync(source,data,{mode:0o600});
  async function run(args){
   signal?.throwIfAborted();
   const r=await startProcess({cmd:binary,args,cwd:dir,inheritEnv:false,env:pdfEnvironment(),signal,timeoutMs:options.timeoutMs??8000,maxBytes:16384}).done;
   if(r.timedOut)throw new ToolError("pdf-timeout","PDF 页面处理超时，请缩小文件后重试。");
   if(r.aborted)throw new ToolError("cancelled","PDF 页面读取已取消。");
   if(r.error)throw new ToolError("pdf-tool-unavailable","PDF 渲染工具无法启动，请检查 mutool 安装。");
   if(r.truncated)throw new ToolError("pdf-output-limit","PDF 诊断输出过多，未返回可能不完整的页面。");
   if(/password|encrypted|authenticate/i.test(r.stderr))throw new ToolError("pdf-encrypted","PDF 已加密或需要密码，请先提供可读取的副本。");
   if(r.code!==0)throw new ToolError("pdf-render","PDF 页面解析或渲染失败，请检查文件。");
   return r;
  }
  // mutool draw 会将越界页码静默钳制为末页，必须先核对页数。
  const meta=await run(["show",source,"trailer/Root/Pages/Count"]);
  const count=Number(meta.stdout.trim());
  if(meta.stderr.trim()||!/^\d+$/.test(meta.stdout.trim())||!Number.isSafeInteger(count)||count<1)throw new ToolError("pdf-render","无法可靠确定 PDF 页数，未返回页面。");
  if(page>count)throw new ToolError("pdf-page","PDF 共 "+count+" 页，请选择 1–"+count+" 页。");
  const r=await run(["draw","-F","png","-o",output,"-r","120","-w",String(MAX_PDF_PAGE_PIXELS),"-h",String(MAX_PDF_PAGE_PIXELS),"-L","-m","100663296","-B","128","-T","1",source,String(page)]);
  // 除固定内存统计外只接受一行页码进度；拒绝字体/修复诊断，避免返回残缺页面。
  const expected="page "+source+" "+page;
  const diagnostics=r.stderr.trim().split(/\r?\n/).filter(line=>!/^Memory use total=\d+ peak=\d+ current=\d+$/.test(line)&&!/^Allocations total=\d+$/.test(line));
  if(r.stdout.trim()||diagnostics.length!==1||diagnostics[0]!==expected)throw new ToolError("pdf-render","PDF 渲染出现警告或页码无法核对，页面可能不完整；请重新导出 PDF。");
  const out=fs.statSync(output);
  if(!out.isFile()||out.size<33||out.size>MAX_PDF_PAGE_BYTES)throw new ToolError("pdf-output-limit","PDF 页面输出无效或超过 20 MiB。");
  const png=fs.readFileSync(output),width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  if(png.length!==out.size||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||!width||!height||width>MAX_PDF_PAGE_PIXELS||height>MAX_PDF_PAGE_PIXELS)throw new ToolError("pdf-render","PDF 页面输出格式或尺寸无效。");
  return {imageUrl:"data:image/png;base64,"+png.toString("base64"),page,pages:count,width,height,bytes:png.length};
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
