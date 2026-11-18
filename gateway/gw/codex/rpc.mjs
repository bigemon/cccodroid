// Codex App Server JSON-RPC 客户端（stdio / JSONL）
//
// 与 poc/rpc-client/client.mjs 的差别：
//   - 服务端请求处理器可以是 async（动态工具要读写文件、跑命令）
//   - 通知可以实时回调，而不是事后翻数组
//   - 服务端请求并发处理，按 id 回包，不阻塞通知流
//   - 重复 id 只在本地记账，不改变协议行为（服务端本来就不去重）
//
// 不变的部分：stdin/stdout/stderr 严格分离；半包不提前解析；退出拒绝所有待处理请求。

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

export class AppServerClient extends EventEmitter {
  constructor({
    bin,
    codexHome,
    cwd,
    extraEnv = null,
    serverArgs = [],
    wrap = null,
    label = "codex",
    onServerRequest = null,
    requestTimeoutMs = 60000,
  }) {
    super();
    this.bin = bin;
    this.codexHome = codexHome;
    this.cwd = cwd;
    this.extraEnv = extraEnv;
    this.serverArgs = serverArgs;
    this.wrap = wrap;
    this.label = label;
    this.onServerRequest = onServerRequest;
    this.requestTimeoutMs = requestTimeoutMs;

    this.nextId = 1;
    this.pending = new Map();
    this.inflightServerRequests = new Set();
    this.notifications = [];
    this.serverRequests = [];
    this.parseErrors = [];
    this.stderrLines = [];
    this.exited = null;
    this.exitWaiters = [];
    this.child = null;
    this.rl = null;
    this.duplicateIds = [];
  }

  start() {
    const cmd = this.wrap ? this.wrap.bin : this.bin;
    const base = ["app-server", "--listen", "stdio://", ...(this.serverArgs || [])];
    const args = this.wrap ? [...this.wrap.args, this.bin, ...base] : base;

    this.child = spawn(cmd, args, {
      cwd: this.cwd,
      env: { ...process.env, CODEX_HOME: this.codexHome, ...(this.extraEnv || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.on("error", (err) => {
      this.exited = { code: null, signal: null, error: String(err) };
      this.#failAll(new Error(`spawn failed: ${err.message}`));
      this.#notifyExit();
    });

    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => this.#onLine(line));

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (line.length) {
          this.stderrLines.push(line);
          if (this.stderrLines.length > 5000) this.stderrLines.shift();
        }
      }
    });

    this.child.on("exit", (code, signal) => {
      this.exited = { code, signal };
      this.#failAll(new Error(`app-server exited (code=${code}, signal=${signal})`));
      this.#notifyExit();
    });

    return this;
  }

  #failAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emit("exit", this.exited);
  }

  #notifyExit() {
    for (const fn of this.exitWaiters.splice(0)) fn(this.exited);
  }

  #onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.parseErrors.push({ line: line.slice(0, 500), error: String(err) });
      return;
    }

    const hasId = msg.id !== undefined && msg.id !== null;
    const isResponse = hasId && (msg.result !== undefined || msg.error !== undefined);

    if (isResponse) {
      const p = this.pending.get(msg.id);
      if (!p) {
        this.duplicateIds.push(msg.id);
        return;
      }
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(msg);
      return;
    }

    if (hasId && msg.method) {
      this.serverRequests.push(msg);
      this.emit("serverRequest", msg);
      this.#handleServerRequest(msg);
      return;
    }

    if (msg.method) {
      // 调用方实时消费完整生成结果；诊断环形记录不长期保留原生图片 base64。
      this.notifications.push(msg.params?.item?.type==="imageGeneration" ? {...msg,params:{...msg.params,item:{...msg.params.item,result:undefined}}} : msg);
      // 通知只保留最近 2000 条，避免长会话吃内存
      if (this.notifications.length > 2000) this.notifications.shift();
      this.emit("notification", msg);
    }
  }

  async #handleServerRequest(msg) {
    const id = msg.id;
    this.inflightServerRequests.add(id);
    try {
      let result = null;
      if (this.onServerRequest) {
        try {
          result = await this.onServerRequest(msg);
        } catch (err) {
          this.emit("serverRequestError", { msg, error: String(err) });
          result = null;
        }
      }
      // 等待 UI 期间核心可能已退出；旧请求的终态无需写回已关闭的传输。
      if(this.exited)return;
      if (result === null || result === undefined) {
        // 明确回绝，避免服务端挂起
        this.sendRaw({
          id,
          error: { code: -32601, message: "cccodroid: client does not handle this server request" },
        });
      } else {
        this.sendRaw({ id, result });
      }
    } catch (err) {
      this.emit("serverRequestError", {msg,error:String(err)});
    } finally {
      this.inflightServerRequests.delete(id);
    }
  }

  sendRaw(obj) {
    if (!this.child || this.exited) throw new Error("app-server is not running");
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms: ${method} (id=${id})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.sendRaw({ method, id, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** 发请求并要求 result 存在；error 时抛出带 code 的异常 */
  async call(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const msg = await this.request(method, params, timeoutMs);
    if (msg.error) {
      const err = new Error(`${method}: ${msg.error.message}`);
      err.code = msg.error.code;
      err.rpc = msg.error;
      throw err;
    }
    return msg.result;
  }

  notify(method, params = {}) {
    this.sendRaw({ method, params });
  }

  waitForNotification(method, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const found = this.notifications.find((n) => n.method === method);
        if (found) return resolve(found);
        if (this.exited) return reject(new Error(`app-server exited while waiting for ${method}`));
        if (Date.now() - started > timeoutMs) return reject(new Error(`notification timeout: ${method}`));
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  waitForExit(timeoutMs = 8000) {
    if (this.exited) return Promise.resolve(this.exited);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("exit timeout")), timeoutMs);
      this.exitWaiters.push((info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  async dispose() {
    if (!this.child || this.exited) return this.exited;
    try {
      this.child.stdin.end();
    } catch {}
    try {
      return await this.waitForExit(2500);
    } catch {
      try {
        this.child.kill("SIGTERM");
      } catch {}
      try {
        return await this.waitForExit(3000);
      } catch {
        try {
          this.child.kill("SIGKILL");
        } catch {}
        return this.waitForExit(2000).catch(() => this.exited);
      }
    }
  }

  snapshot() {
    return {
      label: this.label,
      pid: this.child?.pid ?? null,
      exited: this.exited,
      notificationCount: this.notifications.length,
      serverRequestCount: this.serverRequests.length,
      inflightServerRequests: [...this.inflightServerRequests],
      parseErrors: this.parseErrors.length,
      stderrLines: this.stderrLines.slice(-20),
      pending: [...this.pending.keys()],
    };
  }
}
