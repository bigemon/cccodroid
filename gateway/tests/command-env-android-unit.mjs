import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-command-env-'));
Object.assign(process.env,{CCAPP_TEST:'1',CCAPP_HOME:root,CCAPP_WORKSPACE:root,CCAPP_LOG:path.join(root,'log'),CCAPP_EXEC:'direct'});
const {commandEnvironment}=await import('../gw/codex/command-env.mjs');
const {buildToolRegistry}=await import('../gw/codex/tools/index.mjs');
const before=process.env.LD_PRELOAD,previous=process.env.CCAPP_BIONIC_PRELOAD;delete process.env.CCAPP_BIONIC_PRELOAD;
let n=0;const check=async(name,fn)=>{await fn();console.log('ok '+(++n)+' '+name);};
try{
 const config=commandEnvironment();
 if(!config.env.LD_PRELOAD?.endsWith('libtermux-exec-direct-ld-preload.so')){console.log('SKIP Android direct-mode preload is not installed');process.exit(0);}
 await check('direct-mode tool children get the adapter without changing the live host environment',()=>{assert.equal(config.env.CCAPP_BIONIC_PRELOAD,config.env.LD_PRELOAD);assert.equal(process.env.LD_PRELOAD,before);});
 for(const [tag,interpreter,body,expected] of [
  ['sh','/bin/sh','echo SHEBANG_SH','SHEBANG_SH'],['bash','/bin/bash','printf SHEBANG_BASH','SHEBANG_BASH'],
  ['env-sh','/usr/bin/env sh','echo SHEBANG_ENV_SH','SHEBANG_ENV_SH'],
  ['python','/usr/bin/env python3','print("SHEBANG_PYTHON")','SHEBANG_PYTHON'],
  ['node','/usr/bin/env node','console.log("SHEBANG_NODE")','SHEBANG_NODE']]){
  await check('legacy interpreter works: '+tag,()=>{const p=path.join(root,tag);fs.writeFileSync(p,'#!'+interpreter+'\n'+body+'\n',{mode:0o700});const r=spawnSync(config.shell,['--noprofile','--norc','-c','"$FIXTURE_SCRIPT"'],{cwd:root,env:{...config.env,FIXTURE_SCRIPT:p},encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),expected);});
 }
 await check('explicit native loader adapter takes precedence',()=>{process.env.CCAPP_BIONIC_PRELOAD='/fixture/loader-adapter.so';assert.equal(commandEnvironment().env.LD_PRELOAD,process.env.CCAPP_BIONIC_PRELOAD);delete process.env.CCAPP_BIONIC_PRELOAD;});
 await check('fixed npm test runner receives the same clean environment and executes .bin shebangs offline',async()=>{
  fs.mkdirSync(path.join(root,'node_modules/.bin'),{recursive:true});
  fs.writeFileSync(path.join(root,'node_modules/.bin/probe'),'#!/usr/bin/env node\nif(process.env.ANTHROPIC_API_KEY||process.env.OPENAI_API_KEY||process.env.BASH_ENV)process.exit(9);console.log("OFFLINE_NPM_OK");\n',{mode:0o700});
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'offline-probe',version:'1.0.0',scripts:{test:'./node_modules/.bin/probe'}}));
  process.env.ANTHROPIC_API_KEY='SYNTHETIC_SECRET';process.env.OPENAI_API_KEY='SYNTHETIC_SECRET';process.env.BASH_ENV=path.join(root,'must-not-load');
  const cfg=commandEnvironment();const registry=buildToolRegistry({roots:[root],shortCommandEnv:cfg}).registry;
  const result=await registry.handleCall({tool:'cccodroid_run_tests',callId:'offline-npm',arguments:{runner:'npm',timeoutMs:15000}});
  assert(result.success,JSON.stringify(result));const text=result.contentItems[0].text;assert(text.includes('exit=0'),text);assert(text.includes('OFFLINE_NPM_OK'),text);
 });
}finally{
 if(previous===undefined)delete process.env.CCAPP_BIONIC_PRELOAD;else process.env.CCAPP_BIONIC_PRELOAD=previous;
 fs.rmSync(root,{recursive:true,force:true});
}
console.log(n+'/'+n+' passed');
