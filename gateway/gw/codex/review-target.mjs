import {runProcess} from "./tools/exec.mjs";
const fail=message=>{throw new Error(message);};
const usage="用法：/review、/review --base <分支>、/review --commit <提交号>，或 /review <审查说明>；各目标不能混用。";
export function parseReviewTarget(arg=""){
 if(typeof arg!=="string"||arg.length>8000||/[\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(arg))fail("审查说明无效或过长，最多 8000 字符。");
 const text=arg.trim();if(!text)return {type:"uncommittedChanges"};
 const option=text.match(/^--(base|commit|custom)(?:\s+([\s\S]+))?$/);
 if(!option){if(text.startsWith("--"))fail(usage);return {type:"custom",instructions:text};}
 const [,kind,raw]=option,value=raw?.trim();if(!value)fail(usage);
 if(kind==="custom")return {type:"custom",instructions:value};
 if(/\s/.test(value)||value.startsWith("-"))fail(usage);
 if(kind==="commit"){
  if(!/^[a-fA-F0-9]{4,64}$/.test(value))fail("请提供至少 4 位十六进制提交号；分支请使用 --base。");
  return {type:"commit",sha:value,title:null};
 }
 if(value.length>1024)fail("分支名过长。");
 return {type:"baseBranch",branch:value};
}
export function validateReviewTarget(target){
 if(target?.type==="uncommittedChanges")return {type:"uncommittedChanges"};
 if(target?.type==="baseBranch"&&typeof target.branch==="string"&&target.branch.length<=1024&&!/[\s\0-\x1f\x7f]/.test(target.branch)&&!target.branch.startsWith("-")&&target.branch)return {type:"baseBranch",branch:target.branch};
 if(target?.type==="commit"&&typeof target.sha==="string"&&/^[a-fA-F0-9]{4,64}$/.test(target.sha))return {type:"commit",sha:target.sha,title:null};
 if(target?.type==="custom"&&typeof target.instructions==="string"&&target.instructions.trim()&&target.instructions.length<=8000&&!/[\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(target.instructions))return {type:"custom",instructions:target.instructions};
 fail(usage);
}
export async function resolveReviewTarget(cwd,target){
 target=validateReviewTarget(target);
 const call=args=>runProcess({cmd:"git",args:["--no-optional-locks","-c","core.fsmonitor=false",...args],cwd,env:{GIT_TERMINAL_PROMPT:"0",GIT_PAGER:"cat"},timeoutMs:10000,maxBytes:8192});
 const usable=r=>r.code===0&&!r.timedOut&&!r.aborted&&!r.truncated;
 const probe=await call(["rev-parse","--is-inside-work-tree"]);
 if(!usable(probe)||probe.stdout.trim()!=="true")fail("当前目录不是可读取的 Git 工作区，无法启动原生审查。");
 if(target.type==="baseBranch"){
  const refs=target.branch.startsWith("refs/")?[target.branch]:["refs/heads/"+target.branch,"refs/remotes/"+target.branch];
  for(const ref of refs){
   if(!/^refs\/(heads|remotes)\//.test(ref)||!usable(await call(["check-ref-format",ref])))continue;
   const r=await call(["rev-parse","--verify","--end-of-options",ref+"^{commit}"]);
   if(usable(r)&&/^[a-f0-9]{40,64}$/.test(r.stdout.trim()))return {type:"baseBranch",branch:ref};
  }
  fail("未找到可读取的本地或远程跟踪分支；请确认分支名。不会自动拉取远程。");
 }
 if(target.type==="commit"){
  const r=await call(["rev-parse","--verify","--end-of-options",target.sha+"^{commit}"]);
  if(!usable(r)||!/^[a-f0-9]{40,64}$/.test(r.stdout.trim()))fail("提交号不存在、存在歧义或不可读取，请提供准确提交号。");
  return {type:"commit",sha:r.stdout.trim(),title:null};
 }
 return target;
}
