import test from "node:test";
import assert from "node:assert/strict";
import { adbCommand } from "../gw/shizuku-adb-command.mjs";
const binary="/data/user/0/cc.codroid/files/usr/bin/adb";
test("direct adb can re-exec its real executable to cold-start the server",()=>{
 const env={CCAPP_EXEC:"direct",TERMUX_EXEC__PROC_SELF_EXE:"/parent/node"};
 const c=adbCommand(binary,["start-server"],env);
 assert.equal(c.binary,binary);assert.deepEqual(c.args,["start-server"]);
 assert(!("TERMUX_EXEC__PROC_SELF_EXE" in c.env));
 assert.equal(env.TERMUX_EXEC__PROC_SELF_EXE,"/parent/node");
});
test("loader adb carries its own executable identity and bionic preload",()=>{
 const env={CCAPP_EXEC:"loader",CCAPP_BIONIC_PRELOAD:"/app/lib/exec-shim-bionic.so:/usr/lib/termux.so",TERMUX_EXEC__PROC_SELF_EXE:"/parent/node"};
 const c=adbCommand(binary,["-P","15037","start-server"],env);
 assert.equal(c.binary,"/system/bin/linker64");
 assert.deepEqual(c.args,[binary,"-P","15037","start-server"]);
 assert.equal(c.env.TERMUX_EXEC__PROC_SELF_EXE,binary);
 assert.equal(c.env.LD_PRELOAD,env.CCAPP_BIONIC_PRELOAD);
});
