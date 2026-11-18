// 普通权限宿主 MCP：共享读取及获批操作；命令会话和预览仅允许匹配的活动主线程调用。
import {AutoMcpBridge} from "./auto-mcp.mjs";
import {SHARED_READ_TOOLS} from "./permissions.mjs";
import {SCOPED_HOST_TOOLS} from "./file-edit-approvals.mjs";
export class FileMcpBridge extends AutoMcpBridge{
 config(){return {...super.config(),required:false};}
 constructor({registry,active,fileEdits,onEditResult,interactions}){
  const allowed=name=>SHARED_READ_TOOLS.has(name)||SCOPED_HOST_TOOLS.has(name)||interactions?.handles(name);
  super({registry:{specs:()=>registry.specs().filter(t=>allowed(t.name)),has:name=>allowed(name)&&registry.has(name),handleCall:p=>registry.handleCall(p),cancel:id=>registry.cancel(id)},active,authorize:()=>false,fileEdits,onEditResult,interactions});
  this.name="cccodroid_reads_"+this.name.split("_").at(-1);
 }
}
