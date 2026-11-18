import test from "node:test";
import assert from "node:assert/strict";
import { createShizukuTcp } from "../gw/shizuku-tcp-core.mjs";

function fixture(opts = {}) {
  let running = opts.running ?? true, port = opts.port ?? false, saved = opts.fresh ? {} : { enabled: opts.enabled ?? false };
  let clock = 100000, starts = 0, switches = 0, active = 0, maximum = 0;
  let wireless = opts.wireless ?? true, opens = 0, restores = 0;
  const commands = [];
  const controller = createShizukuTcp({
    read: () => saved, write: v => saved = v, now: () => clock,
    status: async () => ({ state: running ? "ok" : "not_running", running, granted: running, autostart: opts.autostart ?? true,
      setup: { phase: opts.nativePhase || "done", log: ["adb connect 127.0.0.1:37089 → connected"] } }),
    reachable: async p => p === 5555 ? port : p === 37089 && wireless,
    tlsPort: async p => p === 37089 && wireless,
    shell: async cmd => cmd.includes("get global adb_enabled") ? "1" : "",
    sleep: async () => {},
    openWireless: opts.prepareWireless ? async () => {
      opens++; wireless = true;
      return async () => { restores++; wireless = false; };
    } : null,
    adb: async args => {
      commands.push(args);
      if (args[0] === "connect") return "connected";
      if (args.includes("get-state")) {
        if (opts.untrusted) throw Error("unauthorized");
        return "device";
      }
      if (args.includes("tcpip")) {
        switches++; running = false; port = true; return "restarting";
      }
      const cmd = args.at(-1);
      if (cmd === "settings get global adb_enabled") return "1";
      if (cmd.startsWith("pm path ")) return "package:/data/app/~~test/moe.shizuku.privileged.api-test/base.apk";
      if (cmd.endsWith("libshizuku.so")) {
        starts++; active++; maximum = Math.max(maximum, active);
        await Promise.resolve(); active--; running = true;
      }
      if (cmd === "usb") port = false;
      return "";
    },
  });
  return { controller, commands, kill() { running = false; }, next() { clock += 16000; },
    get wireless() { return wireless; }, get lifecycle() { return {opens, restores}; },
    get counts() { return { starts, switches, maximum }; }, get saved() { return saved; } };
}

test("first enable survives adbd switch by restarting Shizuku and persists opt-in", async () => {
  const f = fixture();
  await f.controller.enable();
  assert.deepEqual(f.counts, { starts: 1, switches: 1, maximum: 1 });
  assert.equal(f.saved.enabled, true);
  assert.equal(f.controller.snapshot().phase, "ready");
  assert(f.commands.some(a => a.at(-1) === "/data/app/~~test/moe.shizuku.privileged.api-test/lib/arm64/libshizuku.so"));
});
test("offline fixed transport recovers a dead server once under concurrent ticks", async () => {
  const f = fixture({ enabled: true, port: true, running: false });
  await Promise.all([f.controller.tick(), f.controller.tick(), f.controller.tick()]);
  assert.equal(f.counts.starts, 1);
  assert.equal(f.counts.switches, 0);
  assert.equal(f.controller.snapshot().recoveries, 1);
});
test("healthy server is not restarted; reboot with no listener waits for native Wi-Fi bootstrap", async () => {
  const f = fixture({ enabled: true, port: true });
  assert.equal(f.controller.snapshot().phase, "checking");
  assert.match(f.controller.snapshot().message, /已启用/);
  await f.controller.tick();
  assert.equal(f.counts.starts, 0);
  assert.equal(f.controller.snapshot().phase, "ready");
  assert.equal(f.controller.snapshot().recoveries, 0);
  const cold = fixture({ enabled: true, running: false });
  await cold.controller.tick();
  assert.equal(cold.counts.starts, 0);
  assert.equal(cold.counts.switches, 0);
  assert.equal(cold.controller.snapshot().phase, "waiting");
});
test("unauthorized fixed port never starts services, but preserves the enabled preference for retry", async () => {
  const f = fixture({ port: true, untrusted: true });
  await assert.rejects(f.controller.enable(), /无法认证/);
  assert.equal(f.controller.snapshot().enabled, true);
  assert.equal(f.saved.enabled, true);
  assert.equal(f.counts.starts, 0);
  assert.equal(f.counts.switches, 0);
});
test("pause preserves the running transport; close explicitly disables it", async () => {
  const f = fixture({ enabled: true, port: true });
  await f.controller.disable();
  assert(!f.commands.some(a => a.at(-1) === "usb"));
  await f.controller.close();
  assert(f.commands.some(a => a.at(-1) === "usb"));
  assert.equal(f.saved.enabled, false);
});
test("TCP monitor is independent of boot activation, disabled monitor never restarts", async () => {
  const off = fixture();
  await off.controller.tick();
  assert.equal(off.counts.starts, 0);
  const on = fixture({ enabled: true, autostart: false, running: false, port: true });
  await on.controller.tick();
  assert.equal(on.counts.starts, 1);
  assert.equal(on.controller.snapshot().phase, "ready");
});

test("native pairing in progress is never interrupted", async () => {
 const f=fixture({enabled:true,running:false,port:true,nativePhase:"pairing"});
 await f.controller.tick();
 assert.equal(f.counts.starts,0);
});

test("fresh installations enable keepalive by default, explicit off survives restart", async()=>{
 const fresh=fixture({fresh:true,port:true}); assert.equal(fresh.controller.snapshot().enabled,true);
 const off=fixture({enabled:false}); assert.equal(off.controller.snapshot().enabled,false);
});
test("listener selection persists, rejects invalid values and leaves healthy server intact", async()=>{
 const f=fixture({enabled:true,port:true});
 await f.controller.setListener("unix");assert.equal(f.saved.listenerType,"unix");
 assert.equal(f.counts.starts,0);assert.equal(f.counts.switches,0);
 await assert.rejects(f.controller.setListener("public"),/不支持/);
 assert.equal(f.controller.snapshot().listenerType,"unix");
 await f.controller.setListener("loopback");assert.equal(f.saved.listenerType,"loopback");
});


test("native activation cleaned wireless endpoint: recreate it, authenticate, recover, then restore", async () => {
  const f = fixture({ wireless: false, prepareWireless: true });
  await f.controller.enable();
  assert.equal(f.controller.snapshot().phase, "ready");
  assert.equal(f.saved.enabled, true);
  assert.deepEqual(f.lifecycle, { opens: 1, restores: 1 });
  assert.equal(f.wireless, false);
  assert.equal(f.counts.starts, 1);
});
test("missing source is a connection failure, does not erase the user preference", async () => {
  const f = fixture({ wireless: false });
  await assert.rejects(f.controller.enable(), /连接端口尚未就绪/);
  assert.equal(f.saved.enabled, true);
  assert.equal(f.controller.snapshot().phase, "error");
});
test("failed TLS authentication restores the temporary wireless endpoint", async () => {
  const f = fixture({ wireless: false, prepareWireless: true, untrusted: true });
  await assert.rejects(f.controller.enable(), /端点无法认证/);
  assert.deepEqual(f.lifecycle, { opens: 1, restores: 1 });
  assert.equal(f.wireless, false);
  assert.equal(f.counts.switches, 0);
});

test("authorization rejection latches across ticks and restart until explicit retry",async()=>{
 const f=fixture({enabled:true,port:true,untrusted:true});
 await assert.rejects(f.controller.tick(),/无法认证/);
 assert.equal(f.controller.snapshot().phase,"auth-required");assert.equal(f.saved.authBlocked,true);
 const count=f.commands.length;
 for(let i=0;i<5;i++){f.next();await f.controller.tick();}
 assert.equal(f.commands.length,count);
 const blocked=createShizukuTcp({read:()=>f.saved,write:()=>{},status:async()=>{throw Error("must not probe")},adb:async()=>{throw Error("must not connect")},shell:async()=>{},reachable:async()=>true,sleep:async()=>{}});
 await blocked.tick();assert.equal(blocked.snapshot().phase,"auth-required");
 await assert.rejects(f.controller.enable(),/无法认证/);assert(f.commands.length>count);
});
test("turning off an unauthorized connection does not trigger another system prompt",async()=>{
 const f=fixture({enabled:true,port:true,untrusted:true});await assert.rejects(f.controller.tick());
 const count=f.commands.length;await f.controller.close();assert.equal(f.commands.length,count);assert.equal(f.saved.enabled,false);
});
