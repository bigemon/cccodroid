// 原生图片只投影小型元数据；产物复用宿主工作区文件预览，不开放 CODEX_HOME。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {CFG} from "../config.mjs";
import {imageMime,MAX_IMAGE_BYTES} from "./images.mjs";
const hash=s=>crypto.createHash("sha256").update(s).digest("hex");
const extensions={"image/png":"png","image/jpeg":"jpg","image/webp":"webp","image/gif":"gif"};
const validId=id=>typeof id==="string"&&id.length>0&&id.length<=200;
const bytesAt=(file,headerOnly=false)=>{
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size===0||st.size>MAX_IMAGE_BYTES)throw Error("image-size");const b=headerOnly?Buffer.alloc(16):fs.readFileSync(fd);if(headerOnly)fs.readSync(fd,b,0,16,0);if(b.length>MAX_IMAGE_BYTES||!imageMime(b))throw Error("image-format");return b;}finally{fs.closeSync(fd);}
};
export class GeneratedImageStore {
 constructor({codexHome=null,workspace=CFG.workspace}={}){this.codexHome=codexHome;this.workspace=workspace;}
 directory(create=false){
  const ws=fs.realpathSync(this.workspace),dir=path.join(ws,".cccodroid-generated");
  if(create)try{fs.mkdirSync(dir,{mode:0o700});}catch(e){if(e.code!=="EEXIST")throw e;}
  if(fs.realpathSync(dir)!==dir||!fs.lstatSync(dir).isDirectory())throw Error("image-directory");
  return dir;
 }
 existing(id){
  try{const dir=this.directory();for(const ext of Object.values(extensions)){const file=path.join(dir,hash(id)+"."+ext);if(!fs.existsSync(file))continue;const b=bytesAt(file,true);if(extensions[imageMime(b)]===ext)return file;}}catch{}
  return null;
 }
 read(requested,items){
  if(typeof requested!=="string"||!path.isAbsolute(requested))return null;
  const target=path.normalize(requested);
  for(const item of items){
   if(item.role!=="tool_result"||!item.generatedImage||!item.imagePath||!validId(item.itemId))continue;
   const published=this.existing(item.itemId);if(!published||published!==item.imagePath)continue;
   if(target===published)return {file:published};
   // 核心回复可能仍引用自己的文件名；仅映射本会话已发布的同一产物，不读取请求路径。
   const root=this.codexHome&&path.resolve(this.codexHome,"generated_images"),name=path.basename(target,path.extname(target));
   if(root&&target.startsWith(root+path.sep)&&name===item.itemId)return {file:published};
  }
  return null;
 }
 save(item){
  if(!validId(item?.id))return null;
  const cached=this.existing(item.id);if(cached)return cached;
  let bytes=null;
  // 只接受原生生成目录中的明确产物；不会读取 config/auth 或任意核心返回的路径。
  if(this.codexHome&&typeof item.savedPath==="string")try{
   const home=fs.realpathSync(this.codexHome),root=path.join(home,"generated_images"),realRoot=fs.realpathSync(root),file=fs.realpathSync(item.savedPath);
   if(realRoot===root&&file.startsWith(root+path.sep))bytes=bytesAt(file);
  }catch{}
  // 某些版本只返回内联图片；严格限量，落成文件后不再向历史/SSE 传递该字段。
  if(!bytes&&typeof item.result==="string"&&item.result.length>0&&item.result.length<=Math.ceil(MAX_IMAGE_BYTES/3)*4&&/^[A-Za-z0-9+/]+={0,2}$/.test(item.result)&&item.result.length%4===0){
   const b=Buffer.from(item.result,"base64");if(b.length<=MAX_IMAGE_BYTES&&imageMime(b))bytes=b;
  }
  if(!bytes)return null;
  let dir;try{dir=this.directory();}catch{try{dir=this.directory(true);}catch{return null;}}
  const file=path.join(dir,hash(item.id)+"."+extensions[imageMime(bytes)]);
  try{fs.writeFileSync(file,bytes,{flag:"wx",mode:0o600});return file;}catch{return this.existing(item.id);}
 }
}
export function generatedImageRecords(item,{turnId=null,store=new GeneratedImageStore()}={}){
 if(!validId(item?.id))return [];
 const id="codex-image:"+item.id,base={turnId,itemId:item.id,generatedImage:true};
 const use={role:"tool_use",id,name:"ImageGeneration",input:{},...base};
 const completed=item.status==="completed"&&!item.failure;
 const file=completed?store.save(item):null;
 const detail=typeof item.failure==="string"?item.failure:typeof item.failure?.message==="string"?item.failure.message:null;
 const text=file?file:completed?"图片已生成，但当前核心未提供可读取的图片文件。":
  ["interrupted","cancelled","canceled"].includes(item.status)?"图片生成已停止。":"图片生成失败。"+(detail?" "+detail.slice(0,800):"");
 const result={role:"tool_result",id,name:"ImageGeneration",ok:!!file,text,...base,...(file?{imagePath:file}:{})};
 return [use,result];
}
export class GeneratedImages {
 constructor({emit,push,turnId,store}){Object.assign(this,{emit,push,turnId,store});this.started=new Set();this.done=new Set();}
 handle(method,p){
  const item=p.item;if(item?.type!=="imageGeneration"||!validId(item.id))return false;
  if(!["item/started","item/completed"].includes(method))return true;
  if(this.done.has(item.id))return true;
  if(!this.started.has(item.id)){const use=generatedImageRecords({...item,status:"in_progress"},{turnId:this.turnId(),store:this.store})[0];this.started.add(item.id);this.push(use);this.emit({type:"tool_use",...use});}
  if(method==="item/completed"){
   const result=generatedImageRecords(item,{turnId:this.turnId(),store:this.store})[1];this.done.add(item.id);this.push(result);this.emit({type:"tool_result",...result});
  }
  return true;
 }
 finish(status="interrupted"){
  for(const id of this.started)if(!this.done.has(id))this.handle("item/completed",{item:{type:"imageGeneration",id,status:status==="completed"?"failed":"interrupted"}});
 }
}
