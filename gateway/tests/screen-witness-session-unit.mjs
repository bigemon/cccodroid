import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import assert from 'node:assert/strict';
import {fakeCodexBin} from './helpers/fake-codex-bin.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'screen-session-')),sock=path.join(root,'native.sock'),script=path.join(root,'device.mjs');fs.writeFileSync(script,'');
Object.assign(process.env,{CCAPP_TEST:'1',CCAPP_HOME:root,CCAPP_WORKSPACE:root,CCAPP_LOG:root+'/log',CCAPP_PRIV_SOCK:sock});
const server=net.createServer(c=>c.once('data',()=>c.end(JSON.stringify({ok:true,on:true}))));await new Promise(r=>server.listen(sock,r));
const {CodexSession}=await import('../gw/codex/session.mjs');const {privWitness}=await import('../gw/run.mjs');
const opts={cwd:root,bin:fakeCodexBin(root+'/bin'),codexHome:root,dataDir:root,deviceMcpScript:script};let a,b,c;
try{
 a=new CodexSession(opts);await a.start();const sid=await a.ensureThread(),pid=a.client.child.pid,token=privWitness(process.pid,pid);assert.match(token,/^[a-f0-9]{32}$/);
 b=new CodexSession(opts);await b.start();await b.ensureThread();assert.notEqual(privWitness(process.pid,b.client.child.pid),token);
 await a.dispose();assert.equal(privWitness(process.pid,pid),'');
 c=new CodexSession({...opts,sessionId:sid});await c.start();assert.equal(privWitness(process.pid,c.client.child.pid),token);
 assert.equal(privWitness(process.pid,2147483646),'');
 console.log('PASS actual mocked-core sessions: trusted process witness, separate threads, dispose revocation and same-thread reconnect');
}finally{await a?.dispose();await b?.dispose();await c?.dispose();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
