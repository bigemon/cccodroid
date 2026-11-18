import zlib from "node:zlib";
export function numericPng(marker){
const digits=["11111100011000110001100011000111111","00100011000010000100001000010001110","11111000010000111111100001000011111","11111000010000101111000010000111111","10001100011000111111000010000100001","11111100001000011111000010000111111","11111100001000011111100011000111111","11111000010000100010001000010000100","11111100011000111111100011000111111","11111100011000111111000010000111111"];
const width=640,height=240,pixels=Buffer.alloc((width*3+1)*height,255);for(let y=0;y<height;y++)pixels[y*(width*3+1)]=0;
function pixel(x,y,color){const o=y*(width*3+1)+1+x*3;pixels[o]=pixels[o+1]=pixels[o+2]=color;}
const scale=12;for(let i=0;i<marker.length;i++)for(let row=0;row<7;row++)for(let col=0;col<5;col++)if(digits[Number(marker[i])][row*5+col]==="1")for(let yy=0;yy<scale;yy++)for(let xx=0;xx<scale;xx++)pixel(60+i*84+col*scale+xx,70+row*scale+yy,0);
const table=Array.from({length:256},(_,i)=>{for(let j=0;j<8;j++)i=i&1?0xedb88320^(i>>>1):i>>>1;return i>>>0;});
function chunk(type,data){const head=Buffer.from(type),sum=Buffer.concat([head,data]);let crc=0xffffffff;for(const v of sum)crc=table[(crc^v)&255]^(crc>>>8);const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);head.copy(out,4);data.copy(out,8);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
const image=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]);
return image;
}
