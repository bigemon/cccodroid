// The native APK owns pairing. This optional gateway controller owns only the
// classic loopback transport and recovery; it never restarts a healthy server.
export function createShizukuTcp({ read, write, status, adb, shell, reachable, tlsPort = async () => true, openWireless = null, sleep, now = Date.now }) {
  const saved = read();
  let config = { enabled: saved?.enabled !== false, port: 5555, listenerType: saved?.listenerType === "unix" ? "unix" : "loopback", authBlocked:saved?.authBlocked===true };
  let busy = null, lastAttempt = 0;
  let state = { phase: config.enabled ? "checking" : "idle", message: config.enabled ? "已启用，正在检查本机 ADB 通道…" : "未启用", recoveries: 0, lastSuccess: 0 };
  const serial = () => `127.0.0.1:${config.port}`;
  const snapshot = () => ({ ...config, ...state, busy: !!busy });
  const set = (phase, message) => { state = { ...state, phase, message }; };
  const authMessage="本机 ADB 尚未获系统授权，已暂停自动重试，避免反复弹出 USB 调试确认；确认系统授权或重新配对后，点「重新检查 ADB 授权」";
  if(config.enabled&&config.authBlocked)state={...state,phase:"auth-required",message:authMessage};
  const save = () => write({ enabled: config.enabled, port: config.port, listenerType: config.listenerType,authBlocked:config.authBlocked });
  const isAuthError=e=>e?.code==="adb-auth-required"||/unauthorized|failed to authenticate/i.test(String(e?.message||e));
  const authError=()=>Object.assign(Error("固定 ADB 端口无法认证；无线端点无法认证，请检查系统调试授权"),{code:"adb-auth-required"});
  function retryAuth(){config.authBlocked=false;save();}
  async function connected(port) {
    if (!await reachable(port)) return false;
    const target = `127.0.0.1:${port}`;
    try{
      const out=await adb(["connect",target]);
      if(isAuthError(out))throw authError();
      const value=(await adb(["-s",target,"get-state"])).trim();
      if(isAuthError(value))throw authError();
      return value==="device";
    }catch(e){if(isAuthError(e))throw authError();throw e;}
  }
  async function waitConnection() {
    for (let i = 0; i < 12; i++) {
      try { if (await connected(config.port)) return true; } catch(e) {if(isAuthError(e))throw e;}
      await sleep(500);
    }
    throw new Error("固定 ADB 端口无法认证连接；请连接 Wi-Fi 后重试");
  }
  async function startServer() {
    // Obtain the installed package path through authenticated ADB, not from UI input.
    const apk = (await adb(["-s", serial(), "shell", "pm path moe.shizuku.privileged.api"]))
      .split("\n").map(s => s.trim()).find(s => /^package:\/data\/app\/[A-Za-z0-9_~+=./-]+\/base\.apk$/.test(s));
    if (!apk) throw new Error("找不到已安装的 Shizuku 启动器");
    const starter = apk.slice(8, -8) + "lib/arm64/libshizuku.so";
    await adb(["-s", serial(), "shell", starter]);
    for (let i = 0; i < 40; i++) {
      const s = await status();
      if (s.running || s.state === "ok" || s.state === "no_permission") {
        state.lastSuccess = now();
        return s;
      }
      await sleep(500);
    }
    throw new Error("ADB 可用，但 Shizuku Binder 未恢复");
  }
  async function recover() {
    await waitConnection();
    await adb(["-s", serial(), "shell", "settings put global adb_enabled 1"]);
    const usb = await adb(["-s", serial(), "shell", "settings get global adb_enabled"]);
    if (usb.trim() !== "1") throw new Error("USB 调试未保持开启，无法保证断 Wi-Fi 恢复");
    const s = await status();
    if (!s.running && s.state !== "ok" && s.state !== "no_permission") {
      set("recovering", "正在通过本机 ADB 恢复 Shizuku…");
      await startServer();
      state.recoveries++;
    }
    set("ready", "TCP 恢复已就绪；断开 Wi-Fi 后仍可恢复 Shizuku");
    state.lastSuccess = now();
  }
  async function prepare() {
    let s = await status();
    if (s.dev || s.state === "unsupported" || s.state === "unreachable")
      throw new Error("当前实例没有可用的原生 Shizuku 服务接口");
    if (await reachable(config.port)) {
      // Do not take over an unrelated/unauthorized listener.
      await recover();
      return;
    }
    if (!s.granted && s.state !== "ok")
      throw new Error("请先用现有一键激活完成 Shizuku 启动并授权");
    set("preparing", "正在建立本机 TCP 恢复通道…");
    // USB debugging keeps adbd alive after the wireless transport is disabled.
    await shell("settings put global adb_enabled 1");
    if ((await shell("settings get global adb_enabled")).trim() !== "1")
      throw new Error("系统未允许开启 USB 调试，请在开发者选项中开启后重试");
    // Prefer the last native pairing/activation port. ss supplies fresh candidates
    // when the APK's diagnostic ring contains a stale port. Never connect off-device.
    const logs = (s.setup?.log || []).join("\n");
    const ports = [...logs.matchAll(/127\.0\.0\.1:(\d+)/g)].map(m => +m[1]).reverse();
    let cleanup = null, source = null, sawTls = false, sawAuth=false;
    async function findSource() {
      const candidates = [...ports];
      const listeners = await shell("ss -ltn");
      for (const line of listeners.split("\n")) {
        const m = (line.trim().split(/\s+/)[3] || "").match(/:(\d+)$/);
        if (m) candidates.push(+m[1]);
      }
      for (const port of [...new Set(candidates)].filter(p => p > 0 && p <= 65535 && p !== config.port)) {
        try {
          if (!await tlsPort(port)) continue;
          sawTls = true;
          if (await connected(port)) return port;
        } catch(e) {if(isAuthError(e))sawAuth=true;}
      }
      return null;
    }
    try {
      source = await findSource();
      if (!source && !sawAuth && openWireless) {
        set("preparing", "正在临时开启无线调试，建立 TCP 保活通道…");
        cleanup = await openWireless();
        for (let i = 0; i < 12 && !source && !sawAuth; i++) {
          await sleep(500);
          source = await findSource();
        }
      }
      if(!source&&sawAuth)throw authError();
      if (!source) throw new Error(sawTls
        ? "本机无线 ADB 端点无法认证；请在无线调试中检查原配对密钥"
        : "无线 ADB 连接端口尚未就绪；请连接 Wi-Fi 并检查无线调试（adb 程序已找到）");
      // tcpip restarts adbd and may kill Shizuku: recover before restoring wireless.
      await adb(["-s", `127.0.0.1:${source}`, "tcpip", String(config.port)]);
      await recover();
    } finally {
      if (cleanup) await cleanup();
    }
  }
  function exclusive(fn) {
    if (busy) return busy;
    busy = (async () => {
      try { await fn(); }
      catch (e) {
        if(isAuthError(e)){config.authBlocked=true;save();set("auth-required",authMessage);}
        else set("error",String(e.message||e));
        throw e;
      }
      finally { busy = null; }
      return snapshot();
    })();
    return busy;
  }
  return {
    snapshot,
    setListener: type => exclusive(async () => {
      if (!["loopback", "unix"].includes(type)) throw new Error("不支持的 ADB 客户端接口");
      const previous = config.listenerType;
      retryAuth();config.listenerType = type;
      try {
        if (config.enabled) await recover();
        save();
      } catch (e) { config.listenerType = previous; throw e; }
    }),
    enable: () => exclusive(async () => {
      const previous = config.enabled;
      config.enabled = true;config.authBlocked=false;
      try { save(); } catch (e) { config.enabled = previous; throw e; }
      // Keep the user's intent even if Wi-Fi or authentication is temporarily unavailable.
      await prepare();
    }),
    // Disabling monitoring deliberately does not toggle USB debugging or restart
    // adbd underneath a running session. Closing the port is a separate operation.
    disable: () => exclusive(async () => {
      config.enabled = false; save(); set("idle", "自动恢复已关闭；现有 ADB 端口保持不变");
    }),
    close: () => exclusive(async () => {
      config.enabled = false; save();
      if(config.authBlocked){set("idle","自动恢复已关闭；ADB 未认证，未改动现有系统端口");return;}
      if (await connected(config.port)) await adb(["-s", serial(), "usb"]);
      set("idle", "TCP 端口已关闭；需要时可重新无线激活");
    }),
    recover: () => exclusive(async()=>{retryAuth();await recover();}),
    async tick() {
      if (!config.enabled || config.authBlocked || busy || now() - lastAttempt < 15000) return snapshot();
      lastAttempt = now();
      return exclusive(async () => {
        const s = await status();
        if (["downloading", "installing", "connecting", "pairing", "starting", "permission"].includes(s.setup?.phase)) return;
        if (s.running || s.state === "ok" || s.state === "no_permission") {
          // Following reboot the APK first bootstraps through Wi-Fi. Once it has
          // successfully authorized this client, reestablish the TCP transport.
          if (!await reachable(config.port)) {
            if (s.granted || s.state === "ok") await prepare();
            else set("waiting", "已启用，等待 Shizuku 授权后建立 TCP 通道");
          } else if (state.phase !== "ready") {
            if (!await connected(config.port)) throw new Error("已启用，但本机 ADB 通道尚未通过认证");
            set("ready", "已启用，ADB 通道可用，正在监测 Shizuku");
            state.lastSuccess = now();
          }
          return;
        }
        if (s.state !== "not_running") return;
        if (!await reachable(config.port)) {
          set("waiting", "等待 Wi-Fi 完成首次激活；固定 TCP 端口不跨手机重启");
          return;
        }
        await recover();
      });
    },
  };
}
