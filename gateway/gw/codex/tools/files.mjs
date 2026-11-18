// 文件工具：读、写、改、列
//
// 安全边界：
//   - 所有路径先过 PathGuard（realpath + 根目录前缀）
//   - 写入前检查大小上限，拒绝二进制与超长内容
//   - 改文件要求 oldText 唯一命中，避免“以为改了一个地方，其实改了好几处”

import fs from "node:fs";
import path from "node:path";
import { ToolError, clampText } from "../paths.mjs";
import { imageInfo } from "../images.mjs";
import {readTextPage, MAX_TEXT_READ_BYTES} from "../text-reader.mjs";
import {checkPdfFile,isPdfFile,readPdfTextPage} from "../pdf-reader.mjs";
import {pdfPageReference,readPdfImagePage} from "../pdf-pages.mjs";

const SKIP_DIRS = new Set([".git", "node_modules", ".gradle", "build", "dist", "__pycache__", ".cache", ".idea"]);

export function registerFileTools(registry, { guard, limits = {}, readAttachment = null, readImageAttachment = null } = {}) {
  const maxReadBytes = limits.maxReadBytes ?? MAX_TEXT_READ_BYTES;
  const maxWriteBytes = limits.maxWriteBytes ?? 1024 * 1024;

  registry.register({
    name: "cccodroid_pwd",
    description: "Return the absolute path of the current working directory. Takes no arguments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => guard.cwd,
  });

  registry.register({
    name: "cccodroid_list_files",
    description:
      "List files and directories under a path (relative to the working directory). Skips .git, node_modules and build output. Returns one entry per line with a trailing / for directories.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to the working directory. Default '.'" },
        depth: { type: "integer", description: "Max recursion depth, 1-4. Default 1" },
        includeHidden: { type: "boolean", description: "Include dotfiles. Default false" },
      },
      additionalProperties: false,
    },
    handler: ({ path: rel = ".", depth = 1, includeHidden = false }) => {
      const dir = guard.resolve(rel);
      const d = Math.max(1, Math.min(4, Number(depth) || 1));
      const out = [];
      const walk = (abs, prefix, level) => {
        let entries;
        try {
          entries = fs.readdirSync(abs, { withFileTypes: true });
        } catch (err) {
          out.push(`${prefix}<error: ${err.code || err.message}>`);
          return;
        }
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const e of entries) {
          if (!includeHidden && e.name.startsWith(".")) continue;
          if (e.isDirectory() && SKIP_DIRS.has(e.name)) {
            out.push(`${prefix}${e.name}/ (skipped)`);
            continue;
          }
          if (out.length >= 2000) {
            out.push("… (truncated, 2000 entries)");
            return;
          }
          if (e.isDirectory()) {
            out.push(`${prefix}${e.name}/`);
            if (level < d) walk(path.join(abs, e.name), `${prefix}  `, level + 1);
          } else if (e.isSymbolicLink()) {
            out.push(`${prefix}${e.name} -> ${safeLink(abs, e.name)}`);
          } else {
            out.push(`${prefix}${e.name}`);
          }
        }
      };
      walk(dir, "", 1);
      return `${guard.display(dir)}/\n${out.join("\n")}`;
    },
  });

  registry.register({
    name: "cccodroid_read_file",
    description:
      "Read a UTF-8 text file, including large logs, with bounded output (256 KiB per call). Use offset/limit for lines. If the header provides next byteOffset, pass that byteOffset and omit offset to continue, including within a very long line. A cursor refers to the current file bytes; restart if the file changes. Explicitly attached upload text files are readable by their full path within this conversation. For PDFs this tool extracts the text layer using installed pdftotext; offset/limit and byteOffset refer to the extracted UTF-8 text, not PDF pages or original binary bytes. Images and scanned content are not included. For images use cccodroid_read_image.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory" },
        offset: { type: "integer", description: "1-based first line to return" },
        limit: { type: "integer", description: "Max lines to return (default 4000, capped at 4000)" },
        byteOffset: {type:"integer",description:"0-based byte cursor from the previous result. Omit offset when continuing."},
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async ({ path: rel, ...args }, {signal}) => {
      const attachment = readAttachment?.(rel);
      const file = attachment?.file || guard.resolve(rel);
      if (fs.statSync(file).isDirectory()) throw new ToolError("is-directory", `${rel} 是目录，用 cccodroid_list_files`);
      const page=await (isPdfFile(file)?readPdfTextPage:readTextPage)(file,{...args,maxBytes:maxReadBytes,signal});
      const range=page.start===null?"按字节续读":`从第 ${page.start} 行开始`;
      const next=page.nextByteOffset===null?"已到文件末尾":`继续读取请传 byteOffset: ${page.nextByteOffset}，省略 offset`;
      return `${guard.display(file)} (${page.pdf?"PDF 文字层，不含扫描图像；以下行号和字节游标均针对提取文本；":""}${range}，读取 ${page.bytes} 字节；${next})\n${page.text}`;
    },
  });

  registry.register({
    name: "cccodroid_read_image",
    description: "View a local image from the workspace or an explicitly attached upload image in this conversation in one call. Use its full path to reopen an attached image in later turns. Supports PNG, JPEG, WebP and GIF up to 20 MiB. For a PDF, render one page with path paper.pdf#page=2 (default page 1), up to 1600 pixels per side; explicitly attached PDF permissions also apply. This views the page including scans/charts; read_file is preferable for its text layer. Requires installed mutool. With functions.exec, the dynamic entry returns a string containing an image data URL: extract the data:image/...;base64,... URL and call image(url) to see the pixels. Do not use result.content or result.contentItems on that string. The MCP entry instead returns standard image blocks in result.content; forward with image(block). Do not print, stringify, or split base64 image data as text.",
    inputSchema: {type:"object",required:["path"],additionalProperties:false,properties:{path:{type:"string",maxLength:4096,description:"Image or PDF path, absolute or relative to the working directory. For a PDF page use paper.pdf#page=2; default page 1."}}},
    handler: async ({path:rel},{signal}) => {
      // 已存在的字面路径优先，避免把名为 *.pdf#page=N 的文件误解为片段。
      let literal=null;
      try{literal=readImageAttachment?.(rel)?.file||readAttachment?.(rel)?.file||guard.resolve(rel);}catch{}
      const ref=literal?{file:rel,page:1,explicit:false}:pdfPageReference(rel);
      const attachment=readImageAttachment?.(ref.file);
      const document=readAttachment?.(ref.file);
      const fromDocument=!attachment&&document&&isPdfFile(document.file);
      const file=attachment?.file||(fromDocument?document.file:guard.resolve(ref.file));
      // 文本附件只允许真正的 PDF 进入视觉入口，不能借 .pdf 文件名读取其他图片。
      if(fromDocument)checkPdfFile(file);
      let info;
      try{info=imageInfo(file);}catch(error){
        if(!fs.statSync(file).isFile()||!isPdfFile(file))throw error;
        const page=await readPdfImagePage(file,{page:ref.page,signal});
        return {text:guard.display(file)+" (PDF 第 "+page.page+"/"+page.pages+" 页，"+page.width+"×"+page.height+"，"+page.bytes+" bytes)",imageUrl:page.imageUrl};
      }
      if(ref.explicit)throw new ToolError("invalid-pdf","指定页读取仅支持 PDF。");
      const data=fs.readFileSync(file);
      if(data.length!==info.bytes)throw new ToolError("image-changed","图片读取期间发生变化，请重试。");
      return {text:guard.display(file)+" ("+info.mime+", "+info.bytes+" bytes)",imageUrl:"data:"+info.mime+";base64,"+data.toString("base64")};
    },
  });

  registry.register({
    name: "cccodroid_write_file",
    description:
      "Create or overwrite a UTF-8 text file. Parent directories are created automatically. Overwriting an existing file is allowed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory" },
        content: { type: "string", description: "Full file content" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: ({ path: rel, content }) => {
      const file = guard.resolve(rel, { allowMissing: true });
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > maxWriteBytes) throw new ToolError("content-too-large", `内容 ${bytes} 字节，超过写入上限 ${maxWriteBytes}`);
      const existed = fs.existsSync(file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { mode: 0o644 });
      return `${existed ? "已覆盖" : "已创建"} ${guard.display(file)} (${bytes} 字节)`;
    },
  });

  registry.register({
    name: "cccodroid_edit_file",
    description:
      "Replace an exact substring in a text file. Fails if oldText is not found or matches more than once (set replaceAll to allow multiple). Prefer small, unique snippets.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory" },
        oldText: { type: "string", description: "Exact text to replace" },
        newText: { type: "string", description: "Replacement text" },
        replaceAll: { type: "boolean", description: "Replace every occurrence (default false)" },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
    handler: ({ path: rel, oldText, newText, replaceAll = false }) => {
      const file = guard.resolve(rel);
      const st = fs.statSync(file);
      if (st.size > maxReadBytes) throw new ToolError("file-too-large", `文件 ${st.size} 字节，超过编辑上限`);
      const text = fs.readFileSync(file, "utf8");
      if (!oldText) throw new ToolError("empty-old-text");

      const count = text.split(oldText).length - 1;
      if (count === 0) throw new ToolError("text-not-found", `在 ${rel} 中找不到 oldText`);
      if (count > 1 && !replaceAll) {
        throw new ToolError("text-not-unique", `oldText 在 ${rel} 中命中 ${count} 次；请提供更长的唯一片段，或设 replaceAll=true`);
      }
      const next = replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText);
      fs.writeFileSync(file, next, "utf8");
      return `已修改 ${guard.display(file)}：替换 ${replaceAll ? count : 1} 处`;
    },
  });
}

function safeLink(dir, name) {
  try {
    return fs.readlinkSync(path.join(dir, name));
  } catch {
    return "?";
  }
}

export { clampText };
