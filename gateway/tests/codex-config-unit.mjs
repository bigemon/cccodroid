import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"codex-config-unit-"));
Object.assign(process.env,{CCAPP_TEST:"1",CCAPP_HOME:root,CCAPP_WORKSPACE:root});
const {SETTINGS}=await import("../gw/settings.mjs");
const {codexConfig}=await import("../gw/codex/config.mjs");
const keys=["PREFIX","CCAPP_CODEX_CERT","CCAPP_CODEX_BIN","CCAPP_CODEX_HOME"];
const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
const previous=SETTINGS.codex;
let n=0;
const check=(name,fn)=>{fn();console.log("ok "+(++n)+" "+name);};
try{
  process.env.PREFIX=path.join(root,"prefix");
  delete process.env.CCAPP_CODEX_CERT;
  const snapshot={bin:"/fixture/codex",home:"/fixture/home",sslCertFile:null};
  SETTINGS.codex={...snapshot};
  check("设置中的空 CA 沿用前缀证书，独立测试与正式运行一致",()=>{
    assert.equal(codexConfig(snapshot).sslCertFile,path.join(process.env.PREFIX,"etc/tls/cert.pem"));
    assert.deepEqual(codexConfig(snapshot),codexConfig());
  });
  check("环境证书覆盖前缀默认值",()=>{
    process.env.CCAPP_CODEX_CERT=path.join(root,"environment-ca.pem");
    assert.equal(codexConfig(snapshot).sslCertFile,process.env.CCAPP_CODEX_CERT);
  });
  check("显式证书优先且不改写原设置",()=>{
    const custom={...snapshot,sslCertFile:path.join(root,"custom-ca.pem")};
    assert.equal(codexConfig(custom).sslCertFile,custom.sslCertFile);
    assert.equal(SETTINGS.codex.sslCertFile,null);
    assert.equal(snapshot.sslCertFile,null);
  });
  check("无前缀平台保留系统信任库及环境程序路径",()=>{
    delete process.env.PREFIX;delete process.env.CCAPP_CODEX_CERT;
    process.env.CCAPP_CODEX_BIN="/env/codex";process.env.CCAPP_CODEX_HOME="/env/home";
    const config=codexConfig({});
    assert.equal(config.sslCertFile,"");
    assert.equal(config.bin,process.env.CCAPP_CODEX_BIN);
    assert.equal(config.home,process.env.CCAPP_CODEX_HOME);
  });
  check("空配置使用内部受管路径，显式设置仍优先",()=>{
    delete process.env.CCAPP_CODEX_BIN;delete process.env.CCAPP_CODEX_HOME;
    const d=codexConfig({});assert(d.bin.startsWith(root+"/.local/share/cccodroid/codex/"));assert.equal(d.home,path.join(root,".codex"));
    assert.equal(codexConfig(snapshot).bin,snapshot.bin);
  });
  check("已确认的托管选择覆盖旧环境变量，账号目录仍使用原路径",()=>{
    process.env.CCAPP_CODEX_BIN="/old/poc/codex";process.env.CCAPP_CODEX_HOME="/old/poc/home";
    const adopted=codexConfig({useManagedRuntime:true,home:"/existing/account"});
    assert(adopted.bin.startsWith(root+"/.local/share/cccodroid/codex/"));
    assert.equal(adopted.home,"/existing/account");
    assert.equal(codexConfig({useManagedRuntime:false,bin:"/manual/codex"}).bin,"/manual/codex");
  });
}finally{
  SETTINGS.codex=previous;
  for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
}
console.log(n+"/"+n+" passed");
// settings 的完整网关依赖含轮询计时器，断言完成后结束本隔离进程。
process.exit(0);
