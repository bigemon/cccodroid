import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import {test} from "node:test";
const hash=b=>crypto.createHash("sha256").update(b).digest("hex");
function load(){
 const source=fs.readFileSync(new URL("../../devkit/devkit.mjs",import.meta.url),"utf8");
 const start=source.indexOf("async function loadRepo(repo) {"),end=source.indexOf("\nfunction closure(",start);
 assert(start>=0&&end>start);
 const code=source.slice(start,end).replace('const { TERMUX_KEYS, verifyDetached } = await import("./pgp.mjs");',"");
 return new Function("get","verifyDetached","TERMUX_KEYS","sha256","zlib",code+";return loadRepo;");
}
const good=zlib.gzipSync(Buffer.from("Package: approved-fixture\nVersion: 1\nFilename: pool/approved.deb\nSHA256: "+"a".repeat(64)+"\nSize: 1\n\n"));
const wrong=zlib.gzipSync(Buffer.from("Package: wrong-index-fixture\nVersion: 1\nFilename: pool/wrong.deb\nSHA256: "+"b".repeat(64)+"\nSize: 1\n\n"));
const release=Buffer.from("Date: fixture\nSHA256:\n "+hash(good)+" "+good.length+" main/binary-aarch64/Packages.gz\n");
const cfg={name:"offline-fixture",base:"https://primary.invalid/",mirrors:["https://backup.invalid/"],dist:"stable",component:"main",arch:"aarch64"};
async function probe(mode){
 const seen=[];
 const get=async url=>{
  seen.push(url);if(url.endsWith("/Release"))return release;
  if(url.endsWith("/Release.gpg"))return Buffer.from(mode==="all-signatures-rejected"||(mode==="partial-then-bad-signature"&&url.startsWith("https://backup.invalid/"))||(mode==="signature-fallback"&&url.startsWith("https://primary.invalid/"))?"invalid":"valid");
  if(url.endsWith("/Packages.gz"))return ["valid","signature-fallback"].includes(mode)?good:wrong;
  throw Error("unexpected fixture URL");
 };
 const verify=(_buf,sig)=>{if(sig!=="valid")throw Error("fixture signature rejected");};
 const run=load()(get,verify,[],hash,zlib);
 try{const r=await run(cfg);return {mode,accepted:true,packages:[...r.pkgs.keys()],fetches:seen.length};}
 catch(e){return {mode,accepted:false,error:e.message,fetches:seen.length};}
}
// Offline control-flow test: real gzip/SHA-256, injected network and PGP outcomes.
for(const mode of ["valid","hash-mismatch","partial-then-bad-signature","signature-fallback","all-signatures-rejected"])
 test("devkit verified mirror: "+mode,async()=>{
  const result=await probe(mode);
  assert.equal(result.accepted,["valid","signature-fallback"].includes(mode),JSON.stringify(result));
  if(result.accepted) assert.deepEqual(result.packages,["approved-fixture"]);
 });
