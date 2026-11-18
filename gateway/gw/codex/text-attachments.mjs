// 用户明确提交的上传附件共用逐文件许可；文本和图片分别保存，不能互相扩大读取范围。
import fs from "node:fs";
import path from "node:path";
import {checkTextSample} from "./text-reader.mjs";
import {imageInfo} from "./images.mjs";
import {isPdfFile,checkPdfFile} from "./pdf-reader.mjs";
import {makePathGuard,ToolError} from "./paths.mjs";

const IMAGE=/\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
const TEXT=/\.(txt|md|markdown|log|jsonl?|csv|tsv|ya?ml|toml|ini|cfg|conf|xml|html?|css|[cm]?js|jsx|tsx?|py|sh|bash|sql|diff|patch)$/i;
const inside=(file,root)=>!!root&&(file===root||file.startsWith(root+path.sep));
function validateText(file){
 if(!fs.statSync(file).isFile())throw new ToolError("attachment-not-file","附件不是普通文本文件："+path.basename(file));
 if(isPdfFile(file))checkPdfFile(file);else checkTextSample(file);
}
export function attachmentText(text,files){
 const missing=files.filter(p=>!text.includes(p));
 return text+(missing.length?"\n\n"+missing.map(p=>"@"+p).join("\n"):"");
}
class AttachmentAccess{
 constructor({cwd,uploadDir,paths=[]},image=false){
  this.image=image;
  this.cwd=fs.realpathSync(cwd);this.uploadDir=uploadDir;this.files=new Set();
  try{this.uploadRoot=fs.realpathSync(uploadDir);}catch{try{this.uploadRoot=path.join(fs.realpathSync(path.dirname(uploadDir)),path.basename(uploadDir));}catch{this.uploadRoot=null;}}
  for(const p of Array.isArray(paths)?paths:[])if(typeof p==="string"&&p.length<=4096&&path.isAbsolute(p)&&path.resolve(p)===p&&inside(p,this.uploadRoot)&&!inside(p,this.cwd))this.files.add(p);
 }
 paths(){return [...this.files];}
 prepare(text,attachments=[]){
  const entries=Array.isArray(attachments)?attachments:[];
  if(entries.length>16)throw new ToolError("too-many-attachments","一次最多附加 16 个文件");
  const explicit=entries.map(a=>a?.path).filter(p=>typeof p==="string"),candidates=[...explicit];
  for(const m of String(text).matchAll(/(?:^|\s)@([^\s]+)/g)){
   const p=m[1];if(explicit.some(file=>file.startsWith(p+" ")))continue;
   if(path.isAbsolute(p)||/^\.\.?\//.test(p)||TEXT.test(p)||fs.existsSync(path.resolve(this.cwd,p)))candidates.push(p);
  }
  const guard=makePathGuard([this.cwd,...(this.uploadDir&&fs.existsSync(this.uploadDir)?[this.uploadDir]:[])],this.cwd),out=new Set();
  for(const p of candidates){
   if(IMAGE.test(p)!==this.image)continue;
   const file=guard.resolve(p);
   if(inside(file,this.cwd))continue;
   if(this.image)imageInfo(file);else validateText(file);out.add(file);
  }
  return [...out];
 }
 grant(files){for(const file of files)this.files.add(file);}
 read(input){
  if(!this.files.size||typeof input!=="string"||input.length>4096||input.includes("\0"))return null;
  const abs=path.resolve(this.cwd,input);let real;
  try{real=fs.realpathSync(abs);}catch(err){if(this.files.has(abs))throw new ToolError("attachment-missing","附件已丢失或无法读取，请重新附加："+path.basename(abs));return null;}
  if(this.files.has(abs)&&real!==abs)throw new ToolError("attachment-changed","附件路径已指向其他文件，请重新附加："+path.basename(abs));
  if(!this.files.has(real))return null;
  return {file:real};
 }
}

export class TextAttachmentAccess extends AttachmentAccess{
 constructor(options){super(options);}
}
export class ImageAttachmentAccess extends AttachmentAccess{
 constructor(options){super(options,true);}
}
