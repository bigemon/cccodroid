import { AsyncLocalStorage } from "node:async_hooks";
// 工具内的现有 runProcess 调用自动继承取消信号，无需逐个文件传递。
export const toolContext = new AsyncLocalStorage();
