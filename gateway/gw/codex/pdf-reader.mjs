// 按需提取 PDF 文字层，复用宿主进程限额/取消和文本分页，不保存转换文件。
import fs from "node:fs";
import path from "node:path";
import {CFG,PREFIX} from "../config.mjs";
import {ToolError} from "./paths.mjs";
import {readTextPage} from "./text-reader.mjs";
import {startProcess} from "./tools/exec.mjs";
export const MAX_PDF_BYTES=20*1024*1024,MAX_PDF_TEXT_BYTES=4*1024*1024;
export function isPdfFile(file){
 if(/\.pdf$/i.test(file))return true;
 const fd=fs.openSync(file,"r");try{const b=Buffer.alloc(5);return fs.readSync(fd,b,0,5,0)===5&&b.toString()==="%PDF-";}finally{fs.closeSync(fd);}
}
export function checkPdfFile(file){
 const fd=fs.openSync(file,"r");try{
  const st=fs.fstatSync(fd);if(!st.isFile())throw new ToolError("not-file","PDF 不是普通文件。");
  if(st.size>MAX_PDF_BYTES)throw new ToolError("pdf-too-large","PDF 超过 20 MiB 读取上限，请先拆分。");
  const b=Buffer.alloc(5);if(st.size<16||fs.readSync(fd,b,0,5,0)!==5||b.toString()!=="%PDF-")throw new ToolError("invalid-pdf","PDF 文件头无效或文件不完整。");
  return st;
 }finally{fs.closeSync(fd);}
}
export function pdfBinary(name="pdftotext"){
 const candidates=PREFIX?[path.join(PREFIX,"bin",name)]:[path.join("/usr/bin",name),path.join("/bin",name)];
 for(const file of candidates)try{fs.accessSync(file,fs.constants.X_OK);if(fs.statSync(file).isFile())return file;}catch{}
 return null;
}
export function pdfEnvironment(){
 const env={HOME:CFG.home,LANG:"C.UTF-8"};
 for(const k of ["PATH","LD_LIBRARY_PATH","LD_PRELOAD","TMPDIR","PREFIX","FONTCONFIG_FILE","FONTCONFIG_PATH","POPPLER_DATADIR"])if(process.env[k])env[k]=process.env[k];
 if(process.env.CCAPP_BIONIC_PRELOAD)env.LD_PRELOAD=process.env.CCAPP_BIONIC_PRELOAD;
 return env;
}
export async function readPdfTextPage(file,{signal,...page}={},options={}){
 signal?.throwIfAborted();
 const st=checkPdfFile(file),binary=options.binary===undefined?pdfBinary():options.binary;
 if(!binary)throw new ToolError("pdf-tool-missing","PDF 文字提取工具 pdftotext 未安装，当前无法读取 PDF；请先将文件转换为文本。");
 // 一次读取已核验文件；转换程序只从 stdin 收字节，不把用户路径放进 shell。
 const data=fs.readFileSync(file);
 if(data.length!==st.size||data.length>MAX_PDF_BYTES||data.subarray(0,5).toString()!=="%PDF-")throw new ToolError("pdf-changed","PDF 读取期间发生变化，请重试。");
 let stdoutBytes=0,stderrBytes=0,task;
 task=startProcess({cmd:binary,args:["-enc","UTF-8","-layout","-nopgbrk","-","-"],cwd:CFG.home,stdin:data,inheritEnv:false,env:pdfEnvironment(),signal,
  timeoutMs:options.timeoutMs??10000,maxBytes:MAX_PDF_TEXT_BYTES,
  onOutput:(kind,text)=>{if(kind==="stdout")stdoutBytes+=Buffer.byteLength(text);else stderrBytes+=Buffer.byteLength(text);if(stdoutBytes>MAX_PDF_TEXT_BYTES||stderrBytes>16384)task.stop("pdf-output-limit");}});
 const r=await task.done;
 if(r.timedOut)throw new ToolError("pdf-timeout","PDF 文字提取超时，请缩小文件后重试。");
 if(r.terminationReason==="pdf-output-limit"||r.truncated)throw new ToolError("pdf-output-limit","PDF 提取结果过大，未返回残缺文字；请先拆分文件。");
 if(r.aborted)throw new ToolError("cancelled","PDF 读取已取消。");
 if(r.error)throw new ToolError("pdf-tool-unavailable","PDF 文字提取工具无法启动，请检查 pdftotext 安装。");
 const diagnostic=r.stderr.trim();
 if(/password|encrypted/i.test(diagnostic))throw new ToolError("pdf-encrypted","PDF 已加密或需要密码，请先提供可读取的副本。");
 if(/Missing language pack|[Cc][Mm]ap|[Tt]o[Uu]nicode|[Mm]apping/.test(diagnostic))throw new ToolError("pdf-mapping","PDF 字体或文字映射不可用，提取可能漏字；未将残缺内容作为完整结果返回。请重新导出带文字映射的 PDF，或提供文本。");
 if(r.code!==0||diagnostic)throw new ToolError("pdf-parse","PDF 解析失败或出现警告，文字可能不完整；请检查文件或先转换为文本。");
 if(!r.stdout.trim())throw new ToolError("pdf-no-text","PDF 没有可提取的文字层；可用 cccodroid_read_image 读取原路径加 #page=1 的指定页图像。");
 const result=await readTextPage(Buffer.from(r.stdout,"utf8"),{...page,signal});
 return {...result,pdf:true};
}
