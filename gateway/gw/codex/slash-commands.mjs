export const CODEX_COMMANDS=[
 ["model","配置","查看或切换模型"],["models","配置","查看可用模型"],["effort","配置","调整思考强度"],
 ["context","上下文","查看核心报告的上下文占用"],["compact","上下文","压缩对话历史，释放上下文空间"],
 ["autocompact","上下文","查看自动压缩阈值"],["status","状态","当前环境与配置状态"],["usage","状态","订阅用量与限额"],
 ["review","项目","审查改动、分支、提交或自定义范围"],["login","账户","登录 ChatGPT 账户"],
 ["new","会话","开始新会话"],["clear","会话","开始新会话"],["rename","会话","重命名当前会话"],["help","帮助","查看可用命令"]
].map(([name,cat,desc])=>({name,cat,desc,local:!["compact","review"].includes(name),...(name==="review"?{usage:"/review · 未提交改动\n/review --base <分支> · 对比分支\n/review --commit <提交号> · 指定提交\n/review <审查说明> · 自定义审查；各目标不能混用。"}:{})}));
export function parseCodexCommand(text){
 const m=String(text||"").trim().match(/^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
 return m?{name:m[1].toLowerCase(),arg:(m[2]||"").trim()}:null;
}
