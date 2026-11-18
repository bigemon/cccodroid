// MCP 标准 form 的有界子集；扩展表单/URL/用户验证另行适配。
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (v, k) => Object.hasOwn(v, k);
const text = (v, max) => typeof v === "string" && v.length <= max;
const keys = (v, allowed) => Object.keys(v).every(k => allowed.includes(k));
const finite = v => typeof v === "number" && Number.isFinite(v);
const FORMATS = ["email", "uri", "date", "date-time"];

function validFormat(value, format) {
  if (!format) return true;
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === "uri") { try { return !!new URL(value).protocol; } catch { return false; } }
  const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  if (format === "date") return validDate(value);
  return validDate(value.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}[Tt]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && Number.isFinite(Date.parse(value));
}

function options(schema) {
  let out;
  if (Array.isArray(schema.enum) && !own(schema, "oneOf")) {
    if (schema.enumNames !== undefined && (!Array.isArray(schema.enumNames) || schema.enumNames.length !== schema.enum.length)) return null;
    out = schema.enum.map((value, i) => ({ value, label: schema.enumNames?.[i] ?? value }));
  } else if (Array.isArray(schema.oneOf) && !own(schema, "enum") && !own(schema, "enumNames")) {
    if (schema.oneOf.some(o => !object(o) || !keys(o, ["const", "title"]))) return null;
    out = schema.oneOf.map(o => ({ value: o.const, label: o.title ?? o.const }));
  }
  if (!out?.length || out.length > 50 || out.some(o => !text(o.value, 200) || !o.value || !text(o.label, 200)) ||
      new Set(out.map(o => o.value)).size !== out.length) return null;
  return out;
}

function field(id, schema, required) {
  if (!object(schema) || !text(id, 160) || !id || ["__proto__", "constructor", "prototype"].includes(id)) return null;
  const s = schema, common = ["type", "title", "description", "default"];
  if ((s.title !== undefined && !text(s.title, 200)) || (s.description !== undefined && !text(s.description, 2000))) return null;
  const f = { id, type: s.type, title: s.title ?? id, description: s.description ?? "", required };
  if (s.type === "string") {
    if (own(s, "enum") || own(s, "oneOf")) {
      if (!keys(s, [...common, "enum", "enumNames", "oneOf"])) return null;
      f.options = options(s);
      if (!f.options) return null;
    } else {
      if (!keys(s, [...common, "minLength", "maxLength", "format"])) return null;
      for (const k of ["minLength", "maxLength"]) {
        if (s[k] !== undefined && (!Number.isSafeInteger(s[k]) || s[k] < 0 || s[k] > 10000)) return null;
      }
      f.minLength = s.minLength ?? 0; f.maxLength = s.maxLength ?? 10000;
      if (f.minLength > f.maxLength || (s.format !== undefined && !FORMATS.includes(s.format))) return null;
      if (s.format) f.format = s.format;
    }
  } else if (s.type === "boolean") {
    if (!keys(s, common)) return null;
  } else if (s.type === "number" || s.type === "integer") {
    if (!keys(s, [...common, "minimum", "maximum"])) return null;
    for (const k of ["minimum", "maximum"]) {
      if (s[k] !== undefined) { if (!finite(s[k])) return null; f[k] = s[k]; }
    }
    if (f.minimum !== undefined && f.maximum !== undefined && f.minimum > f.maximum) return null;
  } else if (s.type === "array") {
    if (!keys(s, [...common, "items", "minItems", "maxItems"]) || !object(s.items)) return null;
    if (keys(s.items, ["anyOf"]) && Array.isArray(s.items.anyOf)) f.options = options({oneOf:s.items.anyOf});
    else if (s.items.type === "string" && keys(s.items, ["type", "enum"])) f.options = options(s.items);
    if (!f.options) return null;
    for (const k of ["minItems", "maxItems"]) if (s[k] !== undefined && (!Number.isSafeInteger(s[k]) || s[k] < 0 || s[k] > 50)) return null;
    f.minItems = s.minItems ?? 0; f.maxItems = s.maxItems ?? f.options.length;
    if (f.minItems > f.maxItems || f.minItems > f.options.length) return null;
  } else return null;
  if (own(s, "default")) {
    if (!validValue(f, s.default)) return null;
    f.default = Array.isArray(s.default) ? [...s.default] : s.default;
  }
  return f;
}

function validValue(f, v) {
  if (f.type === "boolean") return typeof v === "boolean";
  if (f.type === "number" || f.type === "integer")
    return finite(v) && (f.type !== "integer" || Number.isSafeInteger(v)) && (f.minimum === undefined || v >= f.minimum) && (f.maximum === undefined || v <= f.maximum);
  if (f.type === "array")
    return Array.isArray(v) && v.length >= f.minItems && v.length <= f.maxItems && new Set(v).size === v.length && v.every(x => f.options.some(o => o.value === x));
  return text(v, 10000) && (f.options ? f.options.some(o => o.value === v) :
    [...v].length >= f.minLength && [...v].length <= f.maxLength && validFormat(v, f.format));
}

export function nativeFormRequest(msg, { threadId, turnId }) {
  const p = msg?.params, s = p?.requestedSchema;
  if (msg?.method !== "mcpServer/elicitation/request" || msg.id == null || !p || !turnId || p.threadId !== threadId || p.turnId !== turnId ||
      p.mode !== "form" || (p._meta != null && (!object(p._meta) || own(p._meta, "codex_approval_kind"))) ||
      !text(p.serverName, 160) || !p.serverName || !text(p.message, 4000) || !p.message ||
      !object(s) || s.type !== "object" || !object(s.properties) ||
      !keys(s, ["type", "properties", "required", "$schema", "additionalProperties"]) ||
      (s.additionalProperties !== undefined && s.additionalProperties !== false) ||
      (s.$schema !== undefined && !text(s.$schema, 300))) return null;
  let size; try { size = JSON.stringify(s).length; } catch { return null; }
  if (size > 32768) return null;
  const entries = Object.entries(s.properties), required = s.required ?? [];
  if (!entries.length || entries.length > 10 || !Array.isArray(required) || required.some(k => typeof k !== "string" || !own(s.properties, k)) ||
      new Set(required).size !== required.length) return null;
  const fields = entries.map(([id, s]) => field(id, s, required.includes(id)));
  return fields.some(f => !f) ? null : { requestId: msg.id, serverName: p.serverName, message: p.message, fields };
}

// HTTP/UI 值转换为原生 JSON 标量/列表；省略的可选字段不隐式填默认值。
export function nativeFormAnswers(form, answers) {
  if (!object(answers) || !keys(answers, form.fields.map(f => f.id))) return null;
  const content = Object.create(null);
  for (const f of form.fields) {
    if (!own(answers, f.id)) { if (f.required) return null; continue; }
    let v = answers[f.id];
    if (f.type === "boolean" && typeof v === "string") v = v === "true" ? true : v === "false" ? false : v;
    if ((f.type === "number" || f.type === "integer") && typeof v === "string") {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v)) return null;
      v = Number(v);
    }
    if (!validValue(f, v)) return null;
    content[f.id] = Array.isArray(v) ? [...v] : v;
  }
  return content;
}
