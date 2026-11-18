// 每个 CodexSession 独占的命令管理；后台命令跨轮次保留，连接回收/退出时清理。
import crypto from "node:crypto";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
import { startProcess } from "./tools/exec.mjs";

const GLOBAL = new Set();
export const hasRunningCommands=sid=>!!sid&&[...GLOBAL].some(r=>r.running&&r.owner?.()===sid);
const clamp = (n, d, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || d));
export class CommandSessions {
  constructor({ guard, shell, env, owner=()=>null, toolUseId=id=>id, emit = () => {}, onPid = () => {}, onReap = () => {} }) {
    Object.assign(this, { guard, shell, env, owner, toolUseId, emit, onPid, onReap });
    this.records = new Map(); this.closed = true;
  }
  begin(turnId) {
    if ([...this.records.values()].some(r=>r.running&&!r.background)) throw new Error("Previous commands are still running");
    for(const [id,r]of this.records)if(!r.background)this.records.delete(id);
    this.closed = false; this.turnRef = turnId;
  }
  get running() { return [...this.records.values()].filter(r => r.running).length; }
  get backgroundRunning(){return [...this.records.values()].filter(r=>r.running&&r.background).length;}
  list(){return [...this.records.values()].map(r=>this.view(r));}
  require(id) {
    const r = this.records.get(id);
    if (!r) throw new Error("Unknown or expired command in this turn");
    return r;
  }
  view(r) {
    let begin = Math.max(r.start, r.end - 16000);
    if (/[\uDC00-\uDFFF]/.test(r.output[begin - r.start])) begin++;
    return { id: r.id, toolUseId:r.toolUseId||null, turnId: r.turnRef?.id || null, background:r.background, tty:r.tty, rows:r.rows, cols:r.cols, command: r.command, cwd: r.cwd, pid: r.process?.pid || null,
      running: r.running, status: r.status, exitCode: r.result?.code ?? null, signal: r.result?.signal || null,
      terminationReason: r.result?.terminationReason || null, output: r.output.slice(begin - r.start),
      outputStart: begin, nextCursor: r.end, truncated: begin > 0, durationMs: r.result?.ms ?? Date.now() - r.started };
  }
  publish(r, force = false) {
    if (!force) {
      if (!r.timer) r.timer = setTimeout(() => { r.timer = null; this.publish(r, true); }, 100);
      return;
    }
    clearTimeout(r.timer); r.timer = null;
    this.emit({ type: "command", command: this.view(r) });
  }
  async start({ command, cwd = ".", timeout_ms, yield_time_ms = 1000, background=false, tty=false, rows=24, cols=80 }, signal, callId=null) {
    if (this.closed || signal?.aborted) throw new Error("This turn has ended");
    if (this.running >= 4 || GLOBAL.size >= 16) throw new Error("Command capacity reached; stop or finish existing commands");
    if (this.records.size >= 64) for (const [id, old] of this.records) {
      if (!old.running && old.readCursor >= old.end) this.records.delete(id);
      if (this.records.size < 64) break;
    }
    if (this.records.size >= 64) throw new Error("Command output buffer is full; read remaining output or start a new turn");
    const dir = this.guard.resolve(cwd);
    if (!fs.statSync(dir).isDirectory()) throw new Error("cwd must be a directory");
    if (!command.trim() || command.includes("\0")) throw new Error("command must be nonempty and contain no NUL");
    const r = { id: crypto.randomUUID(), toolUseId:this.toolUseId(callId), command, cwd: dir, owner:this.owner, background:!!background, tty:!!tty, rows:clamp(rows,24,5,300), cols:clamp(cols,80,20,500), turnRef:this.turnRef, started: Date.now(), running: true, status: "running",
      output: "", start: 0, end: 0, readCursor: 0, result: null, timer: null, process: null };
    this.records.set(r.id, r); GLOBAL.add(r);
    try {
      const helper=process.env.CCAPP_PTYHOST||fileURLToPath(new URL("../../lib/ptyhost",import.meta.url));
      if(tty)try{fs.accessSync(helper,fs.constants.X_OK);}catch{throw new Error("PTY helper is unavailable on this installation");}
      const env=tty?{...this.env,TERM:"xterm-256color",COLORTERM:"truecolor"}:this.env;
      if(tty){delete env.CI;delete env.NO_COLOR;}
      r.process = startProcess({ cmd: tty?helper:this.shell, args: [...(tty?[String(r.rows),String(r.cols),this.shell]:[]),"--noprofile", "--norc", "-c", command], control:tty, cwd: dir,
        env, inheritEnv: false, stdin: true, signal,
        timeoutMs: timeout_ms==null&&background?null:clamp(timeout_ms, 120000, 100, background?86400000:1800000), maxBytes: 64 * 1024,
        onPid: this.onPid, onReap: this.onReap,
        onOutput: (kind, text) => {
          const chunk = (kind === "stderr" ? "[stderr] " : "") + text;
          r.end += chunk.length; r.output += chunk;
          if (r.output.length > 65536) {
            let cut = r.output.length - 65536;
            if (/[\uDC00-\uDFFF]/.test(r.output[cut])) cut++;
            r.output = r.output.slice(cut); r.start += cut;
          }
          this.publish(r);
        },
      });
      r.done = r.process.done.then(result => {
        r.result = result; r.running = false;
        r.status = result.timedOut ? "timeout" : result.aborted ? "cancelled" : result.error || result.code !== 0 ? "failed" : "completed";
        if (result.error) {
          const text = "\n" + result.error;
          r.output += text; r.end += text.length;
        }
        GLOBAL.delete(r); this.publish(r, true);
      });
      this.publish(r, true);
    } catch (err) {
      r.running = false; r.status = "failed"; GLOBAL.delete(r); this.records.delete(r.id); throw err;
    }
    await this.wait(r, clamp(yield_time_ms, 1000, 1, 10000));
    return this.read(r.id);
  }
  async wait(r, ms) {
    if (!r.running) return;
    let timer;
    await Promise.race([r.done, new Promise(resolve => { timer = setTimeout(resolve, ms); })]);
    clearTimeout(timer);
  }
  read(id, cursor = null, maxChars = 16000) {
    const r = this.require(id);
    const wanted = cursor == null ? r.readCursor : Number(cursor);
    if (!Number.isInteger(wanted) || wanted < 0 || wanted > r.end) throw new Error("Invalid output cursor");
    let start = Math.max(wanted, r.start);
    if (/[\uDC00-\uDFFF]/.test(r.output[start - r.start])) start++;
    const limit = clamp(maxChars, 16000, 2, 32000);
    let output = r.output.slice(start - r.start, start - r.start + limit);
    if (/[\uD800-\uDBFF]/.test(output.at(-1))) output = output.slice(0, -1);
    const next = start + output.length;
    r.readCursor = next;
    return { ...this.view(r), output, outputStart: start, nextCursor: next, truncated: wanted < r.start };
  }
  async poll({ command_id, cursor = null, wait_ms = 1000, max_output_chars = 16000 }) {
    const r = this.require(command_id);
    await this.wait(r, clamp(wait_ms, 1000, 1, 10000));
    return this.read(r.id, cursor, max_output_chars);
  }
  async input({ command_id, chars = "", eof = false, wait_ms = 1000 }) {
    if (this.closed) throw new Error("This turn has ended");
    const r = this.require(command_id);
    if (!r.running) throw new Error("Command is not running");
    r.process.write(chars, eof);
    await this.wait(r, clamp(wait_ms, 1000, 1, 10000));
    return this.read(r.id);
  }
  async stop({ command_id }, reason = "stopped") {
    const r = this.require(command_id);
    if (r.running) await r.process.stop(reason);
    await r.done;
    return this.read(r.id);
  }
  async resize({command_id,rows=24,cols=80,wait_ms=100}){
    if(this.closed)throw new Error("This turn has ended");
    const r=this.require(command_id);if(!r.tty||!r.running)throw new Error("PTY is not running");
    r.rows=clamp(rows,24,5,300);r.cols=clamp(cols,80,20,500);r.process.resize(r.rows,r.cols);
    await this.wait(r,clamp(wait_ms,100,1,10000));this.publish(r,true);return this.read(r.id);
  }
  endTurn(reason="turn-ended"){return this.close(reason,false);}
  async close(reason = "turn-ended", includeBackground=true) {
    this.closed = true;
    await Promise.all([...this.records.values()].filter(r => r.running&&(includeBackground||!r.background)).map(r => this.stop({ command_id: r.id }, reason)));
  }
}

export function commandHistory(items, live, commands=[]) {
  const actual=new Map(commands.map(c=>[c.id,c]));
  return items.map(i => i.role==="command"&&actual.has(i.id)?{...i,...actual.get(i.id)}:i.role === "command" && i.running && !live
    ? { ...i, running: false, status: "interrupted", terminationReason: "gateway-restarted" } : i);
}
