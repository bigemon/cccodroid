import fs from "node:fs";
import path from "node:path";
import { makePathGuard } from "./paths.mjs";
import { imageInfo } from "./images.mjs";

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

/** 只把用户显式附加/引用的图片作为原生输入，不扩大任何写入工具的根目录。 */
export function codexInput(text, attachments = [], { cwd, uploadDir }) {
  const entries = Array.isArray(attachments) ? attachments : [];
  if (entries.length > 16) throw new Error("一次最多附加 16 个文件");
  const candidates = [...entries.map(a => a?.path).filter(p => typeof p === "string")];
  // 兼容已有界面与历史消息的 @路径；上传文件名已经由宿主去掉空格。
  for (const m of text.matchAll(/(?:^|\s)@([^\s]+)/g)) candidates.push(m[1]);
  const roots = [cwd, uploadDir].filter(p => p && fs.existsSync(p));
  const guard = makePathGuard(roots, cwd);
  const input = [{ type: "text", text }];
  const seen = new Set();
  for (const candidate of candidates) {
    if (/\.(bmp|avif|heic|heif|tiff?)$/i.test(candidate)) throw new Error("Codex 图片附件目前支持 PNG、JPEG、WebP、GIF，请先转换：" + path.basename(candidate));
    if (!IMAGE_EXT.test(candidate)) continue;
    const file = guard.resolve(candidate);
    if (seen.has(file)) continue;
    seen.add(file);
    if (seen.size > 8) throw new Error("一次最多读取 8 张图片");
    imageInfo(file);
    input.push({ type: "localImage", path: file });
  }
  return input;
}
