// 应用级默认值：null 是跟随标记，解析结果不写回为固定模型。
export function validDefaults(value){
 return !!value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).every(k=>["model","effort"].includes(k))&&["model","effort"].every(k=>Object.hasOwn(value,k)&&(value[k]===null||typeof value[k]==="string"&&value[k].length>0&&value[k].length<=(k==="model"?200:32)&&!/[\x00-\x1f\x7f]/.test(value[k])));
}
export function selectDefaultValues(defaults,project={},over={}){
 const value=(key)=>typeof over[key]==="string"?over[key]||null:project[key]||defaults[key];
 return {model:value("model"),effort:value("effort")};
}
export function resolveModelDefaults(values,models){
 const recommended=models.filter(m=>m.isDefault===true),defaultModel=recommended.length===1?recommended[0]:null;
 const selected=values.model?models.find(m=>m.id===values.model):null;
 const modelReset=!!values.model&&!selected,model=selected||defaultModel;
 const levels=model?.effort?.supported_levels||[],effortReset=!!values.effort&&!!model&&!levels.includes(values.effort);
 const normalized={model:modelReset?null:values.model,effort:effortReset?null:values.effort};
 const proposed=normalized.effort||model?.effort?.default_level||null;
 const effort=levels.includes(proposed)?proposed:null;
 return {normalized,model:model?.id||null,effort,defaultModel:defaultModel?.id||null,modelReset,effortReset,
  error:!model?"推荐默认模型暂不可确定，请刷新模型列表或选择可用模型。":levels.length&&!effort?"模型默认思考强度暂不可确定，请刷新模型列表或选择可用档位。":null};
}
