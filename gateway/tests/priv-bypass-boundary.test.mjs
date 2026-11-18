import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Evaluate the native privilege decision expression verbatim. Core mode must not bypass it.
const java = fs.readFileSync(new URL("../../android/java/cc/codroid/Priv.java", import.meta.url), "utf8");
const expression = /String pass = ([^\n]+);/.exec(java)?.[1];
assert(expression);
test("core bypass preserves native noask switch, session grants and self protection", () => {
  for (const permMode of ["default", "bypassPermissions"]) {
    for (const [risky, self, noask, session, expected] of [
      [true,false,false,false,true],
      [true,false,true,false,false],
      [true,false,false,true,false],
      [true,true,true,true,true],
      [false,false,false,false,false],
    ]) {
      const pass = vm.runInNewContext(expression, {risky,self,selfAllowed:false,noAsk:()=>noask,sess:session?"session":null,
        SESS_OK:{contains:()=>session},permMode});
      assert.equal(risky && pass === null, expected, JSON.stringify({permMode,risky,self,noask,session}));
    }
  }
});

test("self bypass requires both the native master and its extra opt-in, regardless of core mode",()=>{
 for(const permMode of ["default","bypassPermissions"])for(const noask of [false,true])for(const extra of [false,true]){
  const pass=vm.runInNewContext(expression,{risky:true,self:true,selfAllowed:noask&&extra,noAsk:()=>noask,sess:"session",SESS_OK:{contains:()=>true},permMode});
  assert.equal(pass!==null,noask&&extra,JSON.stringify({permMode,noask,extra}));
 }
});
