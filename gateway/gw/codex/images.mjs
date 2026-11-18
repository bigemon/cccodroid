import fs from "node:fs";
import path from "node:path";
import {ToolError} from "./paths.mjs";

export const MAX_IMAGE_BYTES=20*1024*1024;
export function imageMime(head){
 if(head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return "image/png";
 if(head[0]===255&&head[1]===216&&head[2]===255)return "image/jpeg";
 if(/^GIF8[79]a$/.test(head.subarray(0,6).toString()))return "image/gif";
 if(head.subarray(0,4).toString()==="RIFF"&&head.subarray(8,12).toString()==="WEBP")return "image/webp";
 return null;
}
export function imageInfo(file){
 const st=fs.statSync(file);
 if(!st.isFile()||st.size===0||st.size>MAX_IMAGE_BYTES)throw new ToolError("invalid-image-size","图片为空、不是普通文件或超过 20 MiB："+path.basename(file));
 const fd=fs.openSync(file,"r"),head=Buffer.alloc(16);
 try{fs.readSync(fd,head,0,16,0);}finally{fs.closeSync(fd);}
 const mime=imageMime(head);
 if(!mime)throw new ToolError("unsupported-image","无法识别图片格式，请使用 PNG、JPEG、WebP、GIF："+path.basename(file));
 return {mime,bytes:st.size};
}
