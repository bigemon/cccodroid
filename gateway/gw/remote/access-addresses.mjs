import net from "node:net";

export function urlHost(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "");
  return net.isIP(h) === 6 ? "[" + h + "]" : h;
}

// Common Android Wi-Fi, hotspot and Wi-Fi Direct interface names.
export function isWifiInterface(name) {
  return /^(?:wlan|wifi|swlan|ap|p2p)\d/i.test(String(name || ""));
}

// Listing an address does not change which interfaces the proxy listens on.
export function accessAddresses({ host, port, publicHost = "", rt = "" }, interfaces = {}) {
  const rows = new Map();
  const unbracket = s => String(s || "").replace(/^\[|\]$/g, "");
  const remoteIP = ip => {
    const family = net.isIP(ip);
    if (family === 4) return ip !== "0.0.0.0" && !ip.startsWith("127.");
    // Browsers cannot use scoped link-local IPv6 URL literals consistently.
    return family === 6 && ip !== "::" && ip !== "::1" &&
      !ip.includes("%") && !/^fe[89ab]/i.test(ip) && !/^ff/i.test(ip);
  };
  const add = (hostname, label, wifi = false) => {
    const h = unbracket(hostname);
    if (!h) return;
    const literal = urlHost(h);
    let url;
    try {
      const base = new URL("http://" + literal + ":" + port + "/");
      if (!/^https?:$/.test(base.protocol) || base.username || base.password) return;
      url = base.href + (rt ? "?rt=" + encodeURIComponent(rt) : "");
    } catch { return; }
    if (!rows.has(url) || (!rows.get(url).wifi && wifi)) rows.set(url, { url, label, wifi });
  };
  const canonical = ip => {
    try { return net.isIP(ip) === 6 ? new URL("http://[" + ip + "]/").hostname : ip; }
    catch { return ip; }
  };
  const bind = unbracket(host);
  for (const name of Object.keys(interfaces).sort()) {
    for (const entry of interfaces[name] || []) {
      const ip = entry.address, family = net.isIP(ip);
      if (entry.internal || !remoteIP(ip)) continue;
      if (!(bind === "::" || (bind === "0.0.0.0" && family === 4) || (net.isIP(bind) && canonical(bind) === canonical(ip)))) continue;
      add(ip, name + " · IPv" + family, isWifiInterface(name));
    }
  }
  // Hostname listeners cannot be mapped to interface aliases without resolving
  // the actual bind. Retain the configured hostname rather than guessing.
  if (bind && !net.isIP(bind) && bind !== "localhost") add(bind, "监听地址");
  if (publicHost) add(publicHost, "对外地址");
  return [...rows.values()].sort((a, b) => Number(b.wifi) - Number(a.wifi));
}
