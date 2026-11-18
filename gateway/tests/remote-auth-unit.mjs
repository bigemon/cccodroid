import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { RemoteAuthStore } from "../gw/remote/auth-state.mjs";
const home=fs.mkdtempSync(path.join(os.tmpdir(),"remote-auth-unit-"));
const password={v:1,salt:"a".repeat(32),hash:"b".repeat(64)};
fs.writeFileSync(path.join(home,".ccremote-pass.json"),JSON.stringify(password));
fs.writeFileSync(path.join(home,".ccremote-session-key"),"1".repeat(64));
fs.writeFileSync(path.join(home,".ccremote-secret"),"2".repeat(64));
const store=new RemoteAuthStore(home),other=new RemoteAuthStore(home);
let checks=0;
const check=(name,fn)=>{fn();checks++;console.log("ok "+name);};
let before=store.read();
check("legacy credentials and sessions survive read without migration",()=>{
 assert.equal(before.mode,"password");assert.equal(before.key,"1".repeat(64));assert.equal(before.token,"2".repeat(64));
 assert.deepEqual(before.password,password);assert(!fs.existsSync(store.file));assert.equal(store.read().revision,before.revision);
});
check("stale save cannot overwrite authentication",()=>{
 assert.throws(()=>store.save({mode:"rt"},"bad"),e=>e.status===409);
 assert.equal(store.read().revision,before.revision);
});
check("invalid mode or token cannot change credentials",()=>{
 assert.throws(()=>store.save({mode:"none"},before.revision));
 assert.throws(()=>store.save({mode:"rt",token:"bad"},before.revision));
 assert.equal(store.read().revision,before.revision);
});
const saved=store.save({mode:"rt",token:"3".repeat(64)},before.revision);
check("one snapshot changes mode, key, token and clears active password",()=>{
 const s=other.read();assert.equal(s.mode,"rt");assert.equal(s.password,null);assert.equal(s.token,"3".repeat(64));
 assert.notEqual(s.key,before.key);assert.notEqual(s.revision,before.revision);assert.equal(fs.statSync(store.file).mode&0o777,0o600);
});
before=store.read();
check("no-op saves keep existing sessions and token",()=>{
 assert.equal(store.save({mode:"rt"},before.revision).changed,false);assert.deepEqual(store.read(),before);
});
check("password mode requires a password and keeps link mode on failure",()=>{
 assert.throws(()=>store.save({mode:"password"},before.revision));assert.deepEqual(store.read(),before);
});
check("write failure preserves the entire previous snapshot",()=>{
 const raw=fs.readFileSync(store.file,"utf8"),rename=fs.renameSync;
 fs.renameSync=(from,to)=>{if(to===store.file)throw Object.assign(new Error("simulated disk error"),{code:"EIO"});return rename(from,to);};
 try{assert.throws(()=>store.save({mode:"rt",token:"4".repeat(64)},before.revision));}finally{fs.renameSync=rename;}
 assert.equal(fs.readFileSync(store.file,"utf8"),raw);
 assert(!fs.readdirSync(home).some(n=>n.includes(".tmp.")));
});
check("legacy credential files track committed state for rollback",()=>{
 assert(!fs.existsSync(path.join(home,".ccremote-pass.json")));
 assert.equal(fs.readFileSync(path.join(home,".ccremote-secret"),"utf8").trim(),before.token);
 assert.equal(fs.readFileSync(path.join(home,".ccremote-session-key"),"utf8").trim(),before.key);
});
const rotated=store.save({mode:"rt",token:"5".repeat(64)},before.revision).state;
check("rotation visible to another process/store without restart",()=>{
 assert.equal(other.read().token,rotated.token);assert.notEqual(rotated.key,before.key);assert.equal(rotated.password,null);
});
const back=store.save({mode:"password",password},rotated.revision).state;
check("saving password stops link compatibility and invalidates previous key",()=>{
 assert.equal(back.mode,"password");assert.deepEqual(back.password,password);assert.equal(back.allowRt,false);
 assert.notEqual(back.token,rotated.token);assert.notEqual(back.key,rotated.key);
});
check("obsolete revision cannot rotate a newly saved credential",()=>{
 assert.throws(()=>store.save({mode:"rt"},rotated.revision),e=>e.status===409);assert.deepEqual(store.read(),back);
});
check("corrupt snapshot fails closed rather than reviving legacy credentials",()=>{
 fs.writeFileSync(store.file,"bad json");assert.throws(()=>other.read(),/认证状态损坏/);
});
console.log(checks+"/"+checks+" passed");
