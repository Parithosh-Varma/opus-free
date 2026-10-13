#!/usr/bin/env node
/**
 * puter-proxy.mjs — Puter → OpenAI-compatible proxy for OpenCode.
 *
 * Lets OpenCode use `claude-opus-5-5` (and any other Puter model) via:
 *   POST http://127.0.0.1:3001/v1/chat/completions   (OpenAI shape, tools supported)
 *   POST http://127.0.0.1:3001/v1/messages           (Anthropic shape, tools supported)
 *   GET  http://127.0.0.1:3001/v1/models
 *
 * Upstream: https://api.puter.com/drivers/call (puter-chat-completion / ai-chat / complete)
 * Auth: round-robin across Puter auth_tokens pooled from:
 *   1. $PUTER_TOKENS (comma-separated) / $PUTER_TOKEN
 *   2. ~/puter-pool/data/pool.db → puter_accounts.token  (shared with puter-pool)
 *
 * Strategy: always call Puter non-streaming upstream, then re-emit
 * OpenAI SSE / Anthropic SSE downstream if the client asked for stream:true.
 * This is reliable and fully tool-call compatible (opencode needs tools).
 *
 * No deps. Node 20+.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const PORT = parseInt(process.env.PUTER_PROXY_PORT || "3001", 10);
const PUTER_API = process.env.PUTER_API_BASE_URL || "https://api.puter.com";
const TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "120000", 10);

// ---------- token pool ----------
function loadTokens() {
  const tokens = [];
  if (process.env.PUTER_TOKEN) tokens.push(process.env.PUTER_TOKEN.trim());
  if (process.env.PUTER_TOKENS) {
    for (const t of process.env.PUTER_TOKENS.split(",")) {
      const s = t.trim();
      if (s) tokens.push(s);
    }
  }
  // ~/.opus/tokens.json (saved by `opus login`)
  try {
    const opusTokens = path.join(os.homedir(), ".opus", "tokens.json");
    if (fs.existsSync(opusTokens)) {
      const j = JSON.parse(fs.readFileSync(opusTokens, "utf8"));
      const arr = Array.isArray(j) ? j : j.tokens || [];
      for (const e of arr) {
        const t = typeof e === "string" ? e : e?.token;
        if (t && t.trim().length > 20 && !tokens.includes(t.trim())) tokens.push(t.trim());
      }
    }
  } catch (e) {
    console.warn("[proxy] could not load ~/.opus/tokens.json:", String(e).slice(0, 150));
  }
  // shared DB with puter-pool
  try {
    const dbPath =
      process.env.SQLITE_PATH ||
      path.join(os.homedir(), "puter-pool", "data", "pool.db");
    if (fs.existsSync(dbPath)) {
      const out = execSync(
        `sqlite3 "${dbPath.replace(/"/g, "")}" "select token from puter_accounts;"`,
        { encoding: "utf8", timeout: 5000 }
      );
      for (const line of out.split("\n")) {
        const s = line.trim();
        if (s && s.length > 20 && !tokens.includes(s)) tokens.push(s);
      }
    }
  } catch (e) {
    console.warn("[proxy] could not load tokens from pool.db:", String(e).slice(0, 200));
  }
  return [...new Set(tokens)].filter(Boolean);
}

let TOKENS = loadTokens();
let rr = 0;
function nextToken(exclude = new Set()) {
  if (TOKENS.length === 0) return null;
  for (let i = 0; i < TOKENS.length; i++) {
    rr = (rr + 1) % TOKENS.length;
    const t = TOKENS[rr];
    if (!exclude.has(t)) return { token: t, index: rr };
  }
  return null;
}

// ---------- helpers ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 15 * 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function openaiContentToString(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p?.type === "text") return p.text || "";
        if (p?.type === "input_text") return p.text || "";
        if (p?.text) return p.text;
        return "";
      })
      .join("");
  }
  if (content == null) return "";
  return String(content);
}

// Normalize messages for Puter: keep OpenAI shape verbatim, but ensure
// content is string (Puter handles string best; tool blocks stay structured).
// Also stamps an Anthropic cache breakpoint (cache_control ephemeral) on the
// system message (fallback: first message). OpenCode re-sends full history
// every turn; without this, every input token bills full price. With it,
// the static system+tools prefix bills ~5% on cache reads (Opus/Sonnet 5.5).
function normalizeMessagesForPuter(messages) {
  const arr = messages || [];
  const sysIdx = arr.findIndex((m) => m.role === "system");
  const breakIdx = sysIdx >= 0 ? sysIdx : 0;
  return arr.map((m, i) => {
    const out = { role: m.role };
    if (typeof m.content === "string" || m.content == null) {
      out.content = m.content ?? "";
    } else if (Array.isArray(m.content)) {
      // If all parts are text, join; else keep array (Puter normalizes internally)
      const hasNonText = m.content.some(
        (p) => typeof p === "object" && p?.type && !["text", "input_text"].includes(p.type)
      );
      out.content = hasNonText ? m.content : openaiContentToString(m.content);
    } else {
      out.content = String(m.content);
    }
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
    if (i === breakIdx) out.cache_control = { type: "ephemeral" };
    return out;
  });
}

// Serialize upstream calls: Puter single-account pools reject parallel
// requests with 429 "Usage is reserved". A tiny mutex + 429 backoff
// makes opencode (which fires title + main + tool calls concurrently) reliable.
let _queue = Promise.resolve();
function withQueue(fn) {
  const run = _queue.then(fn, fn);
  _queue = run.catch(() => {});
  return run;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function puterCompleteInner({ messages, model, tools, tool_choice, maxTokens, temperature }) {
  const tried = new Set();
  let lastError = "no tokens";
  const maxAttempts = Math.max(1, Math.min(TOKENS.length || 1, 5));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const pick = nextToken(tried);
    if (!pick) break;
    tried.add(pick.token);
    const args = {
      messages,
      model,
      stream: false,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(tools?.length ? { tools } : {}),
      ...(tool_choice !== undefined ? { tool_choice, toolChoice: tool_choice } : {}),
    };
    const body = JSON.stringify({
      interface: "puter-chat-completion",
      driver: "ai-chat",
      method: "complete",
      args,
      auth_token: pick.token,
      test_mode: false,
    });
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const resp = await fetch(`${PUTER_API}/drivers/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "puter-proxy/1.0" },
        body,
        signal: ctrl.signal,
      }).finally(() => clearTimeout(to));
      const raw = await resp.text();
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      if (resp.ok && parsed && parsed.success !== false) {
        const r = parsed.result ?? parsed;
        const msg = r?.message ?? {};
        return {
          content: msg.content ?? r?.text ?? r?.content ?? (typeof r === "string" ? r : ""),
          tool_calls: msg.tool_calls ?? r?.tool_calls ?? null,
          finish_reason: r?.finish_reason ?? r?.stopReason ?? (msg.tool_calls?.length ? "tool_calls" : "stop"),
          usage: r?.usage ?? null,
          providerUsed: parsed?.metadata?.providerUsed ?? null,
        };
      }
      lastError = `HTTP ${resp.status}: ${String(raw).slice(0, 400)}`;
      // exhausted / invalid token → try next account
      if ([401, 402, 429].includes(resp.status) || /insufficient_funds|usage_limited/i.test(raw)) {
        console.warn(`[proxy] token#${pick.index} failed (${resp.status}), failing over…`);
        continue;
      }
      // other 4xx = request error, don't retry with another token
      if (resp.status >= 400 && resp.status < 500 && ![401, 402, 429].includes(resp.status)) {
        throw new Error(lastError);
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.warn(`[proxy] token#${pick.index} error:`, String(lastError).slice(0, 300));
    }
  }
  throw new Error(lastError || "all puter accounts failed");
}


async function puterComplete(args) {
  return withQueue(async () => {
    let delay = 2000;
    for (let r = 0; r < 4; r++) {
      try {
        const res = await puterCompleteInner(args);
        recordUsage(args.model, res.usage, true);
        return res;
      } catch (e) {
        const msg = String(e).slice(0, 500);
        if (/429|too_many_requests|credits_reserved|reserved by requests/i.test(msg) && r < 3) {
          console.warn(`[proxy] 429 contention, retry ${r + 1}/3 after ${delay}ms`);
          await sleep(delay);
          delay *= 2;
          continue;
        }
        recordUsage(args.model, null, false);
        throw e;
      }
    }
  });
}

// ---------- Anthropic <-> OpenAI converters ----------
function anthropicContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text || "" : "")).join("");
  }
  return String(content ?? "");
}

function anthropicToOpenAI(body) {
  const { model, messages, system, max_tokens, maxTokens, temperature, tools, tool_choice } = body;
  const oaMessages = [];
  if (system) {
    const sysText = anthropicContentToText(system);
    if (sysText) oaMessages.push({ role: "system", content: sysText });
  }
  for (const m of messages || []) {
    if (m.role === "user") {
      // content can include tool_result blocks → map to tool messages + user text
      if (typeof m.content === "string") {
        oaMessages.push({ role: "user", content: m.content });
      } else if (Array.isArray(m.content)) {
        let textParts = [];
        for (const b of m.content) {
          if (b?.type === "text") textParts.push(b.text || "");
          else if (b?.type === "tool_result") {
            if (textParts.length) { oaMessages.push({ role: "user", content: textParts.join("") }); textParts = []; }
            const contentText =
              typeof b.content === "string" ? b.content
              : Array.isArray(b.content) ? b.content.map((x) => (typeof x === "string" ? x : x?.text || "")).join("")
              : JSON.stringify(b.content ?? "");
            oaMessages.push({ role: "tool", tool_call_id: b.tool_use_id, content: contentText });
          }
        }
        if (textParts.length) oaMessages.push({ role: "user", content: textParts.join("") });
        if (oaMessages.length === 0 || (m.content.length > 0 && oaMessages[oaMessages.length - 1]?.role === "tool" && textParts.length === 0)) {
          // edge: message was only tool_results — already pushed
        }
      }
    } else if (m.role === "assistant") {
      if (typeof m.content === "string") {
        oaMessages.push({ role: "assistant", content: m.content });
      } else if (Array.isArray(m.content)) {
        let text = "";
        const tool_calls = [];
        for (const b of m.content) {
          if (b?.type === "text") text += b.text || "";
          else if (b?.type === "tool_use") {
            tool_calls.push({
              id: b.id,
              type: "function",
              function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
            });
          }
        }
        const msg = { role: "assistant", content: text };
        if (tool_calls.length) msg.tool_calls = tool_calls;
        oaMessages.push(msg);
      }
    }
  }
  let oaTools;
  if (Array.isArray(tools) && tools.length) {
    oaTools = tools.map((t) => {
      if (t?.type === "function") return t; // already OpenAI shape
      return {
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.input_schema || t.parameters || { type: "object", properties: {} },
        },
      };
    });
  }
  let oaToolChoice;
  if (tool_choice) {
    if (typeof tool_choice === "string") oaToolChoice = tool_choice;
    else if (tool_choice.type === "auto") oaToolChoice = "auto";
    else if (tool_choice.type === "any") oaToolChoice = "required";
    else if (tool_choice.type === "none") oaToolChoice = "none";
    else if (tool_choice.type === "tool") {
      oaToolChoice = { type: "function", function: { name: tool_choice.name } };
    } else oaToolChoice = tool_choice;
  }
  return {
    model: model || "claude-opus-5-5",
    oaMessages,
    maxTokens: max_tokens ?? maxTokens,
    temperature,
    oaTools,
    oaToolChoice,
  };
}

function openaiResultToAnthropic(result, modelId) {
  const text = result.content || "";
  const content = [];
  if (text) content.push({ type: "text", text });
  const toolUses = [];
  for (const tc of result.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { input = {}; }
    toolUses.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
  }
  content.push(...toolUses);
  if (content.length === 0) content.push({ type: "text", text: "" });
  const stop_reason =
    result.finish_reason === "tool_calls" ? "tool_use"
    : result.finish_reason === "length" ? "max_tokens"
    : "end_turn";
  return {
    id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
    type: "message",
    role: "assistant",
    content,
    model: modelId,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: result.usage?.input_tokens ?? 0,
      output_tokens: result.usage?.output_tokens ?? Math.ceil(text.length / 4),
    },
  };
}

function savePuterToken(token, username) {
  const dir = path.join(os.homedir(), ".opus");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "tokens.json");
  let arr = [];
  try {
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      arr = Array.isArray(j) ? j : j.tokens || [];
    }
  } catch {}
  const have = arr.map((e) => (typeof e === "string" ? e : e?.token));
  if (!have.includes(token)) {
    arr.push({ token, username: username || null, added_at: new Date().toISOString() });
    fs.writeFileSync(f, JSON.stringify(arr, null, 2));
  }
  try {
    const db = path.join(os.homedir(), "puter-pool", "data", "pool.db");
    if (fs.existsSync(db)) {
      const esc = token.replace(/'/g, "''");
      const has = execSync("sqlite3 \"" + db + "\" \"select count(*) from puter_accounts where token='" + esc + "';\"", { encoding: "utf8" }).trim();
      if (has === "0") {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        execSync("sqlite3 \"" + db + "\" \"insert into puter_accounts (id,name,token,status,daily_credit_limit) values ('" + id + "','puter-web','" + esc + "','active',100);\"");
      }
    }
  } catch (e) {
    console.warn("[proxy] pool.db save skipped:", String(e).slice(0, 150));
  }
  TOKENS = loadTokens();
}

const UI_HTML = "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">"
+ "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
+ "<title>opus — Puter proxy</title>"
+ "<script src=\"https://js.puter.com/v2/\"></script>"
+ "<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0c0f12;color:#f2f2f2;display:flex;justify-content:center;padding:48px 16px;margin:0}"
+ ".card{max-width:520px;width:100%;background:#151a20;border:1px solid #2a3139;border-radius:14px;padding:32px}"
+ "h1{margin:0 0 4px;font-size:22px}.sub{color:#9aa4b0;font-size:13px;margin-bottom:20px}"
+ "button{background:#ff3b1f;color:#fff;border:0;border-radius:9px;padding:12px 20px;font-size:15px;font-weight:600;cursor:pointer;width:100%}"
+ "button:disabled{opacity:.55;cursor:wait}button.ghost{background:#222b34;margin-top:10px}"
+ "#status{margin:16px 0;font-size:13px;color:#9aa4b0}#msg{margin-top:14px;font-size:13px;min-height:20px}"
+ ".ok{color:#4ade80}.err{color:#f87171}input{width:100%;box-sizing:border-box;background:#0c0f12;border:1px solid #2a3139;color:#f2f2f2;border-radius:9px;padding:10px;margin-top:10px;font-size:12px}"
+ "code{background:#222b34;padding:2px 6px;border-radius:5px;font-size:12px}.hint{font-size:12px;color:#9aa4b0;margin-top:18px;line-height:1.7}</style></head>"
+ "<body><div class=\"card\"><h1>opus</h1><div class=\"sub\">Puter proxy for Claude Opus 5.5 + OpenCode</div>"
+ "<div id=\"status\">checking proxy…</div><div id=\"cost\" style=\"font-size:13px;color:#9aa4b0;margin-bottom:16px\"></div>"
+ "<button id=\"signin\">Sign in to Puter</button>"
+ "<button id=\"switch\" class=\"ghost\">Switch account</button>"
+ "<div id=\"msg\"></div>"
+ "<input id=\"paste\" placeholder=\"or paste puter auth_token here (puter.com → DevTools → localStorage → auth_token)\">"
+ "<button id=\"savepaste\" class=\"ghost\">Save pasted token</button>"
+ "<div class=\"hint\">Proxy: <code>POST :3001/v1/chat/completions</code> with model <code>claude-opus-5-5</code><br>"
+ "OpenCode: <code>opencode run --model puter/claude-opus-5-5 \"…\"</code> (needs this repo's opencode.json)</div>"
+ "</div><script>"
+ "var msg=function(t,c){var m=document.getElementById('msg');m.className=c||'';m.textContent=t;};"
+ "fetch('/healthz').then(function(r){return r.json();}).then(function(j){"
+ "document.getElementById('status').textContent='proxy ok · '+j.tokens+' token(s) saved';fetch('/api/usage').then(function(r){return r.json();}).then(function(u){document.getElementById('cost').textContent='session: '+u.requests+' req · '+u.input_tokens+'+'+u.output_tokens+' tok · ¢'+Number(u.usd_cents).toFixed(2);});}).catch(function(){"
+ "document.getElementById('status').textContent='proxy unreachable';});"
+ "function pageToken(){try{var ks=[];for(var i=0;i<localStorage.length;i++){ks.push(localStorage.key(i));}"
+ "var best=null;for(var k=0;k<ks.length;k++){var v=localStorage.getItem(ks[k]);"
+ "if(typeof v==='string'&&v.indexOf('eyJ')===0&&v.length>50&&(!best||v.length>best.length))best=v;}return best;}catch(e){return null;}}"
+ "function saveToken(t,btn){msg('verifying + saving…','');"
+ "fetch('/api/save-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})})"
+ ".then(function(r){return r.json().then(function(j){return {s:r.status,j:j};});})"
+ ".then(function(x){if(x.s===200&&x.j.ok){msg('signed in as @'+(x.j.username||'?')+' · '+x.j.tokens+' token(s) saved. You can close this tab.','ok');"
+ "document.getElementById('status').textContent='proxy ok · '+x.j.tokens+' token(s) saved';}"
+ "else{msg('save failed: '+(x.j.error||x.s),'err');}if(btn)btn.disabled=false;})"
+ ".catch(function(e){msg('save failed: '+e,'err');if(btn)btn.disabled=false;});}"
+ "document.getElementById('signin').addEventListener('click',function(){var b=this;b.disabled=true;msg('opening Puter sign-in…','');"
+ "puter.auth.signIn().then(function(){return puter.auth.getUser();}).then(function(u){"
+ "var t=null;if(puter.auth.getToken){try{t=puter.auth.getToken();}catch(e){}}"
+ "if(t&&t.then)t.then(function(x){saveToken(x||pageToken(),b);},function(){saveToken(pageToken(),b);});"
+ "else saveToken(t||pageToken(),b);}).catch(function(e){msg('sign-in failed: '+((e&&e.message)||e),'err');b.disabled=false;});});"
+ "document.getElementById('switch').addEventListener('click',function(){var b=this;b.disabled=true;"
+ "puter.auth.signIn({request_auth:true}).then(function(){location.reload();}).catch(function(e){msg('switch failed: '+((e&&e.message)||e),'err');b.disabled=false;});});"
+ "document.getElementById('savepaste').addEventListener('click',function(){var v=document.getElementById('paste').value.trim();"
+ "if(!v){msg('paste a token first','err');return;}var b=this;b.disabled=true;saveToken(v,b);});"
+ "</script></body></html>";

const STATS_FILE = path.join(os.homedir(), ".opus", "usage.json");
const STATS = { requests: 0, ok: 0, errors: 0, input_tokens: 0, output_tokens: 0, usd_cents: 0, by_model: {} };
try {
  if (fs.existsSync(STATS_FILE)) Object.assign(STATS, JSON.parse(fs.readFileSync(STATS_FILE, "utf8")));
} catch {}
function recordUsage(model, usage, ok) {
  STATS.requests++;
  if (ok) STATS.ok++; else STATS.errors++;
  const i = usage?.input_tokens ?? usage?.inputTokens ?? 0;
  const o = usage?.output_tokens ?? usage?.outputTokens ?? 0;
  const c = usage?.usd_cents ?? 0;
  STATS.input_tokens += i; STATS.output_tokens += o; STATS.usd_cents += c;
  const m = (STATS.by_model[model] = STATS.by_model[model] || { requests: 0, input_tokens: 0, output_tokens: 0, usd_cents: 0 });
  m.requests++; m.input_tokens += i; m.output_tokens += o; m.usd_cents += c;
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(STATS)); } catch {}
}
function costStr(usage) {
  const i = usage?.input_tokens ?? usage?.inputTokens ?? 0;
  const o = usage?.output_tokens ?? usage?.outputTokens ?? 0;
  const c = usage?.usd_cents ?? 0;
  return "tok=" + i + "+" + o + " cost=¢" + Number(c).toFixed(4);
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version",
    });
    res.end();
    return;
  }
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
    return sendJson(res, 200, { status: "ok", tokens: TOKENS.length, time: new Date().toISOString() });
  }
  if (req.method === "GET" && url.pathname === "/readyz") {
    return sendJson(res, TOKENS.length ? 200 : 503, {
      status: TOKENS.length ? "ready" : "no tokens — add $PUTER_TOKEN or rows in ~/puter-pool/data/pool.db",
      tokens: TOKENS.length,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/reload-tokens") {
    TOKENS = loadTokens();
    return sendJson(res, 200, { tokens: TOKENS.length });
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    try {
      const r = await fetch(`${PUTER_API}/puterai/chat/models/details`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const data = await r.json();
        const models = (data?.models || []).map((m) => ({
          id: m.id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: m.provider || "puter",
        }));
        return sendJson(res, 200, { object: "list", data: models });
      }
    } catch {}
    // fallback minimal list
    return sendJson(res, 200, {
      object: "list",
      data: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5", "gpt-5.6-sol"].map((id) => ({
        id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "puter",
      })),
    });
  }

  // ----- OpenAI: POST /v1/chat/completions -----
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return sendJson(res, 400, { error: { message: "invalid JSON", type: "invalid_request_error" } }); }
    const { model, messages, stream, max_tokens, max_completion_tokens, temperature, tools, tool_choice } = body;
    if (!messages?.length) {
      return sendJson(res, 400, { error: { message: "messages is required", type: "invalid_request_error" } });
    }
    if (!TOKENS.length) {
      return sendJson(res, 503, { error: { message: "no puter tokens configured. Add one: POST /api/accounts equivalent or set PUTER_TOKEN, then POST /api/reload-tokens", type: "server_error" } });
    }
    const modelId = model || "claude-opus-5-5";
    const t0 = Date.now();
    try {
      const result = await puterComplete({
        messages: normalizeMessagesForPuter(messages),
        model: modelId,
        tools,
        tool_choice,
        maxTokens: max_tokens ?? max_completion_tokens,
        temperature,
      });
      console.log(`[proxy] ${modelId} ok in ${Date.now() - t0}ms tools=${result.tool_calls?.length || 0} chars=${(result.content || "").length} ` + costStr(result.usage));
      const completionId = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const created = Math.floor(Date.now() / 1000);
      const finish = result.finish_reason === "tool_calls" ? "tool_calls" : result.finish_reason === "length" ? "length" : "stop";
      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
          "X-Accel-Buffering": "no",
        });
        // text deltas
        const text = result.content || "";
        if (text) {
          // chunk by ~40 chars to look alive
          for (let i = 0; i < text.length; i += 40) {
            const chunk = {
              id: completionId, object: "chat.completion.chunk", created, model: modelId,
              choices: [{ index: 0, delta: { role: i === 0 ? "assistant" : undefined, content: text.slice(i, i + 40) }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        }
        // tool_calls deltas (one chunk per tool call, then finish)
        (result.tool_calls || []).forEach((tc, ti) => {
          const chunk = {
            id: completionId, object: "chat.completion.chunk", created, model: modelId,
            choices: [{ index: 0, delta: { tool_calls: [{ index: ti, id: tc.id, type: "function", function: { name: tc.function?.name, arguments: tc.function?.arguments } }] }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        });
        const done = {
          id: completionId, object: "chat.completion.chunk", created, model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: finish }],
        };
        res.write(`data: ${JSON.stringify(done)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      return sendJson(res, 200, {
        id: completionId,
        object: "chat.completion",
        created,
        model: modelId,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: result.content ?? "",
            ...(result.tool_calls?.length ? { tool_calls: result.tool_calls } : {}),
          },
          finish_reason: finish,
        }],
        usage: {
          prompt_tokens: result.usage?.input_tokens ?? 0,
          completion_tokens: result.usage?.output_tokens ?? 0,
          total_tokens: (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0),
        },
      });
    } catch (e) {
      const emsg = String((e && e.message) || e).slice(0, 500);
      console.error("[proxy] chat/completions failed:", emsg);
      if (!res.headersSent) {
        // Upstream is always buffered fully before any SSE byte is written,
        // so an error here means nothing was sent yet: return a real error
        // (esp. 402 no-credits) instead of an empty stream, which clients
        // report as the cryptic "stream ended without finish_reason".
        const code = /402|insufficient_funds|not enough credits/i.test(emsg) ? 402 : 502;
        return sendJson(res, code, { error: { message: emsg, type: "server_error", code: code === 402 ? "insufficient_credits" : "upstream_error" } });
      }
      try { res.end(); } catch {}
    }
    return;
  }

  // ----- Anthropic: POST /v1/messages, /anthropic/... -----
  if (req.method === "POST" && ["/v1/messages", "/anthropic/v1/messages", "/anthropic/messages"].includes(url.pathname)) {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "invalid JSON" } }); }
    if (!body.messages?.length) {
      return sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "messages required" } });
    }
    if (!TOKENS.length) {
      return sendJson(res, 503, { type: "error", error: { type: "api_error", message: "no puter tokens" } });
    }
    const { model, oaMessages, maxTokens, temperature, oaTools, oaToolChoice } = anthropicToOpenAI(body);
    const modelId = model;
    const stream = !!body.stream;
    try {
      const result = await puterComplete({
        messages: normalizeMessagesForPuter(oaMessages),
        model: modelId,
        tools: oaTools,
        tool_choice: oaToolChoice,
        maxTokens,
        temperature,
      });
      const anth = openaiResultToAnthropic(result, modelId);
      if (!stream) return sendJson(res, 200, anth);
      // Anthropic SSE
      res.writeHead(200, {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
        Connection: "keep-alive", "Access-Control-Allow-Origin": "*", "X-Accel-Buffering": "no",
      });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: anth.id, type: "message", role: "assistant", content: [], model: modelId, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
      let idx = 0;
      for (const block of anth.content) {
        if (block.type === "text") {
          res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: idx, content_block: { type: "text", text: "" } })}\n\n`);
          for (let i = 0; i < block.text.length; i += 40) {
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text: block.text.slice(i, i + 40) } })}\n\n`);
          }
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`);
          idx++;
        } else if (block.type === "tool_use") {
          res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: idx, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } })}\n\n`);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } })}\n\n`);
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`);
          idx++;
        }
      }
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: anth.stop_reason, stop_sequence: null }, usage: { output_tokens: anth.usage.output_tokens } })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      res.end();
      return;
    } catch (e) {
      console.error("[proxy] anthropic failed:", String(e).slice(0, 500));
      return sendJson(res, 502, { type: "error", error: { type: "api_error", message: String(e).slice(0, 500) } });
    }
  }

  // ----- UI: sign-in page -----
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = UI_HTML;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tokens") {
    let arr = [];
    try {
      const f = path.join(os.homedir(), ".opus", "tokens.json");
      if (fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        arr = Array.isArray(j) ? j : j.tokens || [];
      }
    } catch {}
    return sendJson(res, 200, {
      count: arr.length,
      tokens: arr.map((e, i) => {
        const t = typeof e === "string" ? e : e?.token || "";
        return { index: i, username: (typeof e === "object" && e?.username) || null, preview: t ? t.slice(0, 10) + "..." + t.slice(-6) : null };
      }),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/usage") {
    return sendJson(res, 200, STATS);
  }

  if (req.method === "POST" && url.pathname === "/api/save-token") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return sendJson(res, 400, { error: "invalid JSON" }); }
    const token = (body.token || "").trim();
    if (!token || token.length < 50) return sendJson(res, 400, { error: "token missing or too short" });
    try {
      const r = await fetch("https://api.puter.com/whoami", {
        headers: { Authorization: "Bearer " + token },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return sendJson(res, 401, { error: "token rejected by puter (HTTP " + r.status + ")" });
      const me = await r.json();
      savePuterToken(token, me?.username || null);
      console.log("[proxy] saved token for @" + (me?.username || "?") + ", total " + TOKENS.length);
      return sendJson(res, 200, { ok: true, username: me?.username || null, tokens: TOKENS.length });
    } catch (e) {
      return sendJson(res, 502, { error: String(e).slice(0, 300) });
    }
  }

  return sendJson(res, 404, { error: "not found. Use POST /v1/chat/completions, POST /v1/messages, GET /v1/models" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[puter-proxy] listening on http://127.0.0.1:${PORT}`);
  console.log(`[puter-proxy] tokens loaded: ${TOKENS.length}`);
  console.log(`[puter-proxy] OpenAI:    POST http://127.0.0.1:${PORT}/v1/chat/completions`);
  console.log(`[puter-proxy] Anthropic: POST http://127.0.0.1:${PORT}/v1/messages`);
  if (!TOKENS.length) {
    console.log("[puter-proxy] WARNING: no tokens. Set PUTER_TOKEN env or add rows to ~/puter-pool/data/pool.db then POST /api/reload-tokens");
  }
});
