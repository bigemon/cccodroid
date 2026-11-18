import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { localAdbTls } from "../gw/shizuku-adb-probe.mjs";
async function endpoint(fn) {
 const sockets=new Set();
 const server=net.createServer(s=>{sockets.add(s);s.on("close",()=>sockets.delete(s));s.once("data",b=>fn(s,b));});
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 return {port:server.address().port,close:async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
test("wireless probe sends CNXN and accepts a fragmented STLS response",async()=>{
 let packet;
 const server=await endpoint((s,b)=>{packet=b;s.write("ST");setTimeout(()=>s.end("LS"),5);});
 try{
  assert.equal(await localAdbTls(server.port),true);
  assert.equal(packet.subarray(0,4).toString(),"CNXN");
  assert.equal(packet.readUInt32LE(12),7);
  assert.equal(packet.subarray(24).toString(),"host::\0");
 }finally{await server.close();}
});
test("unrelated HTTP listeners are rejected without invoking adb",async()=>{
 const server=await endpoint(s=>s.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
 try{assert.equal(await localAdbTls(server.port),false);}finally{await server.close();}
});
test("silent local listeners have a bounded probe timeout",async()=>{
 const server=await endpoint(()=>{});
 try{assert.equal(await localAdbTls(server.port),false);}finally{await server.close();}
});
