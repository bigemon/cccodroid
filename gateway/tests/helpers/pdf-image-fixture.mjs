// 真正仅含栅格图像的两页 PDF；没有可泄露答案的文字层。
import {numericPng} from "./image-fixture.mjs";
export function imagePdf(markers=["2468","1357"]){
 const objects=[null,Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),null],kids=[];
 function add(value){objects.push(Buffer.isBuffer(value)?value:Buffer.from(value));return objects.length-1;}
 function stream(dict,bytes){return Buffer.concat([Buffer.from("<< "+dict+" /Length "+bytes.length+" >>\nstream\n"),bytes,Buffer.from("\nendstream")]);}
 for(const marker of markers){
  const png=numericPng(marker),chunks=[];
  for(let at=8;at<png.length;){const len=png.readUInt32BE(at),kind=png.subarray(at+4,at+8).toString();if(kind==="IDAT")chunks.push(png.subarray(at+8,at+8+len));at+=12+len;}
  const image=add(stream("/Type /XObject /Subtype /Image /Width 640 /Height 240 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns 640 >>",Buffer.concat(chunks)));
  const content=add(stream("",Buffer.from("q 640 0 0 240 0 0 cm /Im0 Do Q")));
  kids.push(add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 240] /Resources << /XObject << /Im0 "+image+" 0 R >> >> /Contents "+content+" 0 R >>"));
 }
 objects[2]=Buffer.from("<< /Type /Pages /Count "+kids.length+" /Kids ["+kids.map(n=>n+" 0 R").join(" ")+"] >>");
 const parts=[Buffer.from("%PDF-1.7\n")],offsets=[0];let length=parts[0].length;
 for(let i=1;i<objects.length;i++){offsets.push(length);const part=Buffer.concat([Buffer.from(i+" 0 obj\n"),objects[i],Buffer.from("\nendobj\n")]);parts.push(part);length+=part.length;}
 parts.push(Buffer.from("xref\n0 "+objects.length+"\n0000000000 65535 f \n"+offsets.slice(1).map(n=>String(n).padStart(10,"0")+" 00000 n \n").join("")+"trailer\n<< /Size "+objects.length+" /Root 1 0 R >>\nstartxref\n"+length+"\n%%EOF\n"));
 return Buffer.concat(parts);
}
