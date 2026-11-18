import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {configuredCodexVersion} from "../gw/codex/runtime-info.mjs";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"codex-info-test-"));
function cli(name,code){const bin=path.join(root,name);fs.writeFileSync(bin,"#!"+process.execPath+"\n"+code,{mode:0o700});return bin;}
try{
 const valid=cli("valid","if(process.env.HOME!==process.env.CODEX_HOME||process.env.HOME==="+JSON.stringify(root)+")throw Error('account exposed');console.log('codex-cli 0.166.0');");
 assert.equal(await configuredCodexVersion(valid,{env:{...process.env,HOME:root,CODEX_HOME:root}}),"0.166.0");
 console.log("ok 1 版本探测使用临时 HOME，不读取真实账号目录");
 const invalid=cli("invalid","console.log('private-output-sentinel');");
 await assert.rejects(configuredCodexVersion(invalid),e=>!e.message.includes("private-output-sentinel")&&/可识别/.test(e.message));
 console.log("ok 2 非标准输出不进入版本字段或错误提示");
 const controller=new AbortController();controller.abort();
 await assert.rejects(configuredCodexVersion(valid,{signal:controller.signal}),/失败/);
 console.log("ok 3 取消版本探测及时结束");
 console.log("3/3 passed");
}finally{fs.rmSync(root,{recursive:true,force:true});}
