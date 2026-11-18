import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'device-status-'));
Object.assign(process.env,{CCAPP_TEST:'1',CCAPP_HOME:root,CCAPP_RUNTIME:root,CCAPP_WORKSPACE:root,CCAPP_LOG:path.join(root,'log')});
const {deviceStatus,deviceMcp}=await import('../gw/codex/device.mjs');
let checks=0;
async function check(name,fn){await fn();console.log('ok '+(++checks)+' '+name);}
async function serve(reply,fn){
 const sock=path.join(root,'service.sock');process.env.CCAPP_PRIV_SOCK=sock;
 const clients=new Set();const seen=[];
 const server=net.createServer(c=>{clients.add(c);c.on('close',()=>clients.delete(c));c.on('data',b=>{seen.push(JSON.parse(b.toString()));if(reply!==null)c.end(reply);});});
 await new Promise(r=>server.listen(sock,r));
 try{await fn(seen);}finally{for(const c of clients)c.destroy();await new Promise(r=>server.close(r));}
}
try{
 await check('new private socket carries only the capability probe',()=>serve(JSON.stringify({ok:true,on:true,tools:[]}),async seen=>{
  const r=await deviceStatus();assert.equal(r.on,true);assert.deepEqual(seen,[{op:'dev_status'}]);
 }));
 const script=path.join(root,'device-mcp.mjs');fs.writeFileSync(script,'');
 await check('disabled device tools remain disabled without changing settings',()=>serve(JSON.stringify({ok:true,on:false}),async()=>{
  const r=await deviceMcp({script});assert.equal(r.state,'disabled');assert.deepEqual(r.args,[]);
 }));
 await check('enabled native service is attached under a per-session MCP name',()=>serve(JSON.stringify({ok:true,on:true}),async()=>{
  const r=await deviceMcp({script});assert.equal(r.state,'enabled');assert.match(r.name,/^cccodroid_device_[a-f0-9]{8}$/);assert(r.args.join(' ').includes(script));
 }));
 await check('malformed status fails closed',()=>serve('not-json',async()=>assert.equal((await deviceStatus()).ok,false)));
 await check('oversized reply fails closed',()=>serve('x'.repeat(70000),async()=>assert.equal((await deviceStatus()).ok,false)));
 await check('nonresponding service times out',()=>serve(null,async()=>assert.equal((await deviceStatus(30)).ok,false)));
 await check('missing service does not fall back to the global old socket',async()=>{process.env.CCAPP_PRIV_SOCK=path.join(root,'missing.sock');assert.equal((await deviceStatus()).ok,false);});
 await check('invalid relative or abstract socket is rejected',async()=>{process.env.CCAPP_PRIV_SOCK='relative';assert.equal((await deviceStatus()).ok,false);});
 await check('runtime private directory is used when the environment override is absent',async()=>{
  delete process.env.CCAPP_PRIV_SOCK;const server=net.createServer(c=>c.on('data',()=>c.end(JSON.stringify({ok:true,on:false}))));
  await new Promise(r=>server.listen(path.join(root,'.priv.sock'),r));try{assert.equal((await deviceStatus()).on,false);}finally{await new Promise(r=>server.close(r));}
 });
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log(checks+'/'+checks+' passed');
