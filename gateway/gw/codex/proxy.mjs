// 最小 HTTP CONNECT 代理（仅用于 P3-A 网络修复实验）
//
// 约束：
//   - 只监听 127.0.0.1，端口由系统分配（--port 0）
//   - 只允许 CONNECT 到白名单域名:443
//   - 使用 Node（bionic）解析 DNS，连接前校验所有解析结果都是公网地址
//   - 只透传字节，不做 TLS MITM、不读请求正文、不记录 Cookie/Authorization
//   - 日志只记录目标、解析结果、耗时、结果类别
//
// 用法: node proxy.mjs --log <path> [--port 0] [--allow a.com,b.com]

import http from "node:http";
import net from "node:net";
import dns from "node:dns";
import fs from "node:fs";

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};

const LOG = arg("--log", "/tmp/connect-proxy.log");
const PORT = Number(arg("--port", "0"));
const ALLOW_ALL = argv.includes("--allow-all");
const ALLOW = new Set(
  (arg("--allow", "chatgpt.com,auth.openai.com,api.openai.com") || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const CONNECT_TIMEOUT_MS = 12000;

function logEvent(ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...ev });
  try {
    fs.appendFileSync(LOG, line + "\n");
  } catch {}
}

function isPublicIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (p[2] === 0 || p[2] === 2)) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && p[2] === 100) return false;
  if (a === 203 && b === 0 && p[2] === 113) return false;
  if (a >= 224) return false; // multicast / reserved / broadcast
  return true;
}

function isPublicIPv6(ip) {
  const s = ip.toLowerCase();
  if (s.includes("%")) return false; // scope id
  if (s.startsWith("::ffff:")) return isPublicIPv4(s.slice(7));
  if (s === "::" || s === "::1") return false;
  if (s.startsWith("fc") || s.startsWith("fd")) return false; // ULA
  if (/^fe[89ab]/.test(s)) return false; // link-local
  if (s.startsWith("ff")) return false; // multicast
  if (s.startsWith("2001:db8")) return false; // documentation
  if (s.startsWith("64:ff9b")) return false; // NAT64
  if (s.startsWith("::")) return false; // IPv4-compatible / unspecified
  return true;
}

const isPublicIP = (ip) => (net.isIP(ip) === 4 ? isPublicIPv4(ip) : net.isIP(ip) === 6 ? isPublicIPv6(ip) : false);

function tryConnect(ip, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: ip, port, family: net.isIP(ip) });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      sock.destroy();
      reject(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }));
    }, CONNECT_TIMEOUT_MS);
    sock.once("connect", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

const server = http.createServer((req, res) => {
  // 普通 HTTP 请求一律拒绝：本代理只做 CONNECT 隧道
  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("CONNECT only\n");
});

server.on("connect", async (req, clientSocket, head) => {
  const started = Date.now();
  const target = String(req.url || "");
  const entry = { target, client: req.socket.remoteAddress };

  const fail = (status, errClass, extra = {}) => {
    logEvent({ ...entry, ...extra, ok: false, ms: Date.now() - started, error: errClass });
    try {
      clientSocket.write(`HTTP/1.1 ${status} ${errClass}\r\nConnection: close\r\n\r\n`);
    } catch {}
    try {
      clientSocket.destroy();
    } catch {}
  };

  // 只接受 host:port，host 必须在白名单，端口必须是 443
  const m = /^([a-z0-9.-]+):(\d+)$/i.exec(target.trim());
  if (!m) return fail(400, "bad-target");
  const host = m[1].toLowerCase();
  const port = Number(m[2]);
  entry.host = host;
  entry.port = port;

  if (port !== 443) return fail(403, "port-not-allowed");
  if (!ALLOW_ALL && !ALLOW.has(host)) return fail(403, "host-not-allowed");

  let records;
  try {
    records = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    return fail(502, `dns-${err.code || "error"}`);
  }
  const ips = records.map((r) => r.address);
  entry.ips = ips;
  if (!ips.length) return fail(502, "dns-empty");
  if (!ips.every(isPublicIP)) return fail(403, "non-public-ip");

  let upstream = null;
  let lastErr = null;
  for (const ip of ips) {
    try {
      upstream = await tryConnect(ip, port);
      entry.connectedIp = ip;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!upstream) return fail(502, `connect-${lastErr?.code || "error"}`);

  upstream.setNoDelay(true);
  clientSocket.setNoDelay(true);

  logEvent({ ...entry, ok: true, ms: Date.now() - started });
  try {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  } catch (err) {
    upstream.destroy();
    return;
  }
  if (head && head.length) upstream.write(head);

  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstream.destroy());
  upstream.pipe(clientSocket);
  clientSocket.pipe(upstream);
});

server.on("error", (err) => {
  logEvent({ event: "server-error", error: String(err) });
  process.stderr.write(`proxy error: ${err}\n`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const { port, address } = server.address();
  logEvent({ event: "listening", address, port, allowAll: ALLOW_ALL, allow: [...ALLOW] });
  process.stdout.write(JSON.stringify({ listening: port, address }) + "\n");
  process.stderr.write(`proxy listening on ${address}:${port}\n`);
});

const shutdown = () => {
  logEvent({ event: "shutdown" });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
