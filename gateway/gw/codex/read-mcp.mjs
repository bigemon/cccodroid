// 子代理不继承 dynamicTools；仅镜像无副作用的工作区查询，复用同一 registry/路径守卫。
import {AutoMcpBridge} from "./auto-mcp.mjs";
import {SHARED_READ_TOOLS} from "./permissions.mjs";
export {SHARED_READ_TOOLS};
export class ReadMcpBridge extends AutoMcpBridge{
 config(){return {...super.config(),required:false};}
 constructor({registry,active}){
  super({registry:{specs:()=>registry.specs().filter(t=>SHARED_READ_TOOLS.has(t.name)),has:name=>SHARED_READ_TOOLS.has(name)&&registry.has(name),handleCall:params=>registry.handleCall(params)},active,authorize:()=>false});
  this.name="cccodroid_reads_"+this.name.split("_").at(-1);
 }
}
