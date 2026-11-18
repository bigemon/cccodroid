// 按需扫描行号，限制返回字节；文件与已提取的 UTF-8 Buffer 共用分页逻辑。
import fs from "node:fs";
import { ToolError } from "./paths.mjs";

const CHUNK = 32 * 1024;
export const MAX_TEXT_READ_BYTES = 256 * 1024;
const unsupported = () => new ToolError("not-text", "不是支持的 UTF-8 文本；PDF、Office 和压缩包请先转换。");

function decode(data, partial = false) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data, { stream: partial });
  } catch {
    throw unsupported();
  }
}

// 只验证开头样本；实际返回区间还会单独验证。样本末尾允许跨块 UTF-8 字符。
export function checkTextSample(file) {
  const fd = fs.openSync(file, "r");
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new ToolError("not-file", "不是普通文本文件");
    const buf = Buffer.alloc(Math.min(st.size, CHUNK));
    const n = fs.readSync(fd, buf, 0, buf.length, 0), data = buf.subarray(0, n);
    if (data.includes(0) || data.subarray(0, 5).toString() === "%PDF-" ||
        data.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) ||
        data.subarray(0, 8).equals(Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]))) throw unsupported();
    decode(data, n < st.size);
  } finally {
    fs.closeSync(fd);
  }
}

export async function readTextPage(file, { offset = 1, limit = 4000, byteOffset, maxBytes = MAX_TEXT_READ_BYTES, signal } = {}) {
  const start = Math.max(1, offset), take = Math.max(1, Math.min(4000, limit));
  if (byteOffset !== undefined && (!Number.isSafeInteger(byteOffset) || byteOffset < 0))
    throw new ToolError("invalid-offset", "byteOffset 必须是非负安全整数");
  if (!Number.isSafeInteger(start) || (byteOffset !== undefined && offset !== 1))
    throw new ToolError("invalid-offset", "offset 必须是安全整数；使用 byteOffset 时请省略 offset");

  const data=Buffer.isBuffer(file)?file:null;
  if(data){if(data.includes(0))throw unsupported();decode(data.subarray(0,CHUNK),data.length>CHUNK);}
  else checkTextSample(file);
  const fd = data ? {
    stat:async()=>({size:data.length}),
    read:async(buffer,offset,length,position)=>({bytesRead:data.copy(buffer,offset,position,Math.min(position+length,data.length))}),
    close:async()=>{},
  } : await fs.promises.open(file, "r");
  try {
    const st = await fd.stat(), budget = Math.max(4, Math.floor(maxBytes));
    let pos = byteOffset ?? 0, line = 1, skipping = byteOffset === undefined && start > 1;
    let lines = 0, bytes = 0, done = false, lineCut = false, eof = false;
    if (pos > st.size) throw new ToolError("invalid-offset", "byteOffset 超过文件末尾");
    const parts = [], buffer = Buffer.alloc(CHUNK);
    while (!done) {
      signal?.throwIfAborted();
      const { bytesRead: n } = await fd.read(buffer, 0, Math.min(CHUNK, budget - bytes), pos);
      if (!n) { eof = true; break; }
      let from = 0;
      if (skipping) {
        while (from < n && line < start) {
          const at = buffer.indexOf(10, from);
          if (at < 0 || at >= n) { from = n; break; }
          from = at + 1;
          line++;
        }
        skipping = line < start;
      }
      let end = from;
      if (!skipping) {
        while (end < n) {
          if (buffer[end++] === 10 && ++lines === take) { lineCut = true; done = true; break; }
        }
        if (end > from) { parts.push(Buffer.from(buffer.subarray(from, end))); bytes += end - from; }
      } else end = n;
      pos += end;
      if (bytes === budget) done = true;
    }
    // 字节截断时 decoder 保留未完成字符，续读从该字符起始字节继续。
    const raw = Buffer.concat(parts, bytes);
    if (raw.includes(0)) throw unsupported();
    const text = decode(raw, !eof && !lineCut && pos < st.size), used = Buffer.byteLength(text);
    pos -= raw.length - used;
    // 与原 offset/limit 一样，按行截断时不输出最后一个换行符；游标已跨过该分隔符。
    return {
      text: lineCut ? text.slice(0, -1) : text,
      nextByteOffset: pos < st.size ? pos : null,
      start: byteOffset === undefined ? start : null,
      bytes: used,
    };
  } finally {
    await fd.close();
  }
}
