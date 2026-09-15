/**
 * dsh-proxy — host 侧本地 HTTP 代理插件。
 *
 * 架构：DSH pi-ai 适配器 → 本插件 (127.0.0.1:PORT) → OpenCode 上游
 *
 * 职责：
 *  1. 启动本地 HTTP 监听（绑定 127.0.0.1，端口可配置）。
 *  2. 定向处理 OpenCode Muse Spark 模型的 /responses 请求：
 *     - 从 include 中移除 reasoning.encrypted_content
 *     - 从 input 中过滤历史原生 reasoning 项
 *  3. 透明转发响应：保留流式 SSE、工具调用、用量与错误信息。
 *  4. 用户取消时同步中止上游请求（AbortController）。
 *  5. 卸载/重载时关闭监听与在途连接；端口冲突明确报错。
 *
 * 配置（环境变量）：
 *  DSH_PROXY_HOST     监听地址，默认 127.0.0.1
 *  DSH_PROXY_PORT     监听端口，默认 8787
 *  DSH_PROXY_UPSTREAM 上游基地址，默认 https://opencode.ai/zen/v1
 *  DSH_PROXY_MODELS   需过滤的模型 id 列表（逗号分隔，支持 * 通配），默认 muse-spark*
 *  DSH_PROXY_DEBUG    设为 1 时输出控制台日志
 */
import http from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const name = 'dsh-proxy';
export const inject = [];

// ─────────────────────────── 日志 ───────────────────────────

let logFile = null;
const logBuffer = [];
let isFlushing = false;
const MAX_LOG_BUFFER = 500;

function resolveLogFile() {
  if (logFile !== null) return logFile;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  logFile = join(home, 'dsh-proxy.log');
  return logFile;
}

function ts() { return new Date().toISOString(); }

async function flushLogBuffer() {
  if (isFlushing) return;
  isFlushing = true;
  try {
    const file = resolveLogFile();
    await mkdir(dirname(file), { recursive: true });
    while (logBuffer.length > 0) {
      const batch = logBuffer.splice(0, logBuffer.length);
      const content = batch.map((item) => item.line).join('\n') + '\n';
      try { await appendFile(file, content, 'utf8'); } catch { /* 磁盘异常不破坏进程 */ }
      for (const item of batch) item.resolve();
    }
  } catch {
    while (logBuffer.length > 0) logBuffer.shift()?.resolve();
  } finally {
    isFlushing = false;
    if (logBuffer.length > 0) flushLogBuffer().catch(() => {});
  }
}

function writeLog(level, tag, message, data) {
  const line = JSON.stringify({ t: ts(), level, tag, message, data: data ?? null });
  if (process.env.DSH_PROXY_DEBUG === '1') {
    const prefix = `[dsh-proxy] ${tag}`;
    if (level === 'error') console.error(prefix, message, data ?? '');
    else if (level === 'warn') console.warn(prefix, message, data ?? '');
    else console.info(prefix, message, data ?? '');
  }
  if (logBuffer.length >= MAX_LOG_BUFFER) logBuffer.shift()?.resolve();
  return new Promise((resolve) => {
    logBuffer.push({ line, resolve });
    flushLogBuffer().catch(() => {});
  });
}

// ─────────────────────────── 配置 ───────────────────────────

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_UPSTREAM = 'https://opencode.ai/zen/v1';
const DEFAULT_MODELS = 'muse-spark*';

/**
 * 解析模型匹配模式列表。
 * 支持：精确 id、`prefix*` 通配、`/regex/` 正则。
 */
function parseModelPatterns(raw) {
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    if (s.startsWith('/') && s.endsWith('/') && s.length > 2) {
      try { return new RegExp(s.slice(1, -1), 'i'); } catch { /* 无效正则降级为字面量 */ }
    }
    return s;
  });
}

function matchesModel(modelId, patterns) {
  if (typeof modelId !== 'string' || modelId.length === 0) return false;
  for (const p of patterns) {
    if (p instanceof RegExp) { if (p.test(modelId)) return true; }
    else if (typeof p === 'string') {
      if (p.endsWith('*')) { if (modelId.startsWith(p.slice(0, -1))) return true; }
      else if (p === modelId) return true;
    }
  }
  return false;
}

function loadConfig() {
  const env = process.env;
  const port = Number(env.DSH_PROXY_PORT || DEFAULT_PORT);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`dsh-proxy: DSH_PROXY_PORT 无效 (${env.DSH_PROXY_PORT})，需为 1-65535 的整数`);
  }
  return {
    host: env.DSH_PROXY_HOST || DEFAULT_HOST,
    port,
    upstream: (env.DSH_PROXY_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/+$/, ''),
    models: parseModelPatterns(env.DSH_PROXY_MODELS || DEFAULT_MODELS),
  };
}

// ─────────────────────────── 请求体过滤 ───────────────────────────

/**
 * 对 OpenAI Responses API 请求体执行定向过滤：
 *  - include: 移除 "reasoning.encrypted_content"
 *  - input:   移除 type === "reasoning" 的历史项
 * 返回 { body, changed, removedInclude, removedInput }。
 */
function filterResponsesBody(parsed) {
  if (!parsed || typeof parsed !== 'object') return { body: parsed, changed: false, removedInclude: 0, removedInput: 0 };
  const next = { ...parsed };
  let changed = false;
  let removedInclude = 0;
  let removedInput = 0;

  if (Array.isArray(next.include)) {
    const kept = next.include.filter((x) => {
      if (x === 'reasoning.encrypted_content') { removedInclude++; return false; }
      return true;
    });
    if (removedInclude > 0) { next.include = kept; changed = true; }
  }

  if (Array.isArray(next.input)) {
    const kept = next.input.filter((item) => {
      if (item && typeof item === 'object' && item.type === 'reasoning') { removedInput++; return false; }
      return true;
    });
    if (removedInput > 0) { next.input = kept; changed = true; }
  }

  return { body: next, changed, removedInclude, removedInput };
}

// ─────────────────────────── 代理核心 ───────────────────────────

/** 判断路径是否为 OpenAI Responses 端点。 */
function isResponsesPath(pathname) {
  return pathname === '/responses' || pathname.endsWith('/responses');
}

/** 读取请求体为 Buffer（带上限保护）。 */
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 构造转发用 headers：剔除逐跳头，保留其余。 */
function buildUpstreamHeaders(req, bodyLength) {
  const skip = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade']);
  const headers = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const key = req.rawHeaders[i].toLowerCase();
    if (skip.has(key)) continue;
    // 合并重复头（如 cookie）
    if (headers[key] !== undefined) headers[key] += ', ' + req.rawHeaders[i + 1];
    else headers[key] = req.rawHeaders[i + 1];
  }
  if (bodyLength !== null && bodyLength !== undefined) headers['content-length'] = String(bodyLength);
  return headers;
}

/**
 * 启动代理服务器。
 * 返回 { server, address, close(), inFlightCount }。
 */
async function startProxy(cfg) {
  const inFlight = new Set();

  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    const record = { abort };
    inFlight.add(record);

    // 下游提前关闭 → 中止上游（仅在响应尚未正常结束时触发）
    let downstreamClosed = false;
    const onDownstreamClose = () => {
      if (downstreamClosed) return;
      downstreamClosed = true;
      if (!res.writableEnded) abort.abort(new Error('downstream-closed'));
    };
    res.on('close', onDownstreamClose);

    const pathname = (req.url || '/').split('?')[0];
    const targetUrl = cfg.upstream + (req.url || '/');

    try {
      // ── 读取并可能修改请求体 ──
      let bodyBuf = null;
      const hasBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
      if (hasBody) bodyBuf = await readBody(req);

      let filterApplied = false;
      let modelId = null;
      let removedInclude = 0;
      let removedInput = 0;

      if (bodyBuf && isResponsesPath(pathname)) {
        try {
          const parsed = JSON.parse(bodyBuf.toString('utf8'));
          modelId = typeof parsed?.model === 'string' ? parsed.model : null;
          if (modelId && matchesModel(modelId, cfg.models)) {
            const result = filterResponsesBody(parsed);
            if (result.changed) {
              bodyBuf = Buffer.from(JSON.stringify(result.body), 'utf8');
              filterApplied = true;
              removedInclude = result.removedInclude;
              removedInput = result.removedInput;
            }
          }
        } catch (e) {
          writeLog('warn', 'filter', '请求体 JSON 解析失败，原样转发', { path: pathname, err: String(e?.message ?? e) });
        }
      }

      writeLog('info', 'request', `${req.method} ${pathname}`, {
        model: modelId, filterApplied, removedInclude, removedInput, target: targetUrl,
      });

      // ── 转发至上游 ──
      const headers = buildUpstreamHeaders(req, bodyBuf ? bodyBuf.length : null);

      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: bodyBuf ?? undefined,
        signal: abort.signal,
        redirect: 'manual',
      });

      // ── 回写响应头 ──
      const respHeaders = {};
      upstream.headers.forEach((value, key) => {
        const lk = key.toLowerCase();
        // 剔除逐跳头与由 Node 自行管理的头
        if (lk === 'transfer-encoding' || lk === 'connection' || lk === 'keep-alive') return;
        respHeaders[key] = value;
      });
      res.writeHead(upstream.status, respHeaders);

      // ── 流式回写响应体 ──
      if (!upstream.body) { res.end(); return; }

      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            const ok = res.write(Buffer.from(value));
            // 背压：等待 drain
            if (!ok && !downstreamClosed) {
              await new Promise((r) => res.once('drain', r));
            }
          }
        }
      } catch (e) {
        if (abort.signal.aborted) {
          writeLog('info', 'abort', '上游流因下游取消而中止', { path: pathname });
        } else {
          writeLog('warn', 'stream', '上游流读取异常', { path: pathname, err: String(e?.message ?? e) });
        }
      } finally {
        try { reader.releaseLock(); } catch { /* noop */ }
      }

      if (!downstreamClosed) { try { res.end(); } catch { /* noop */ } }
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (abort.signal.aborted || msg.includes('abort') || msg.includes('downstream-closed')) {
        writeLog('info', 'abort', '请求被取消', { path: pathname });
        if (!res.headersSent) {
          res.writeHead(499, { 'content-type': 'application/json; charset=utf-8' });
        }
        try { res.end(JSON.stringify({ error: { message: 'client closed request', type: 'cancelled' } })); } catch { /* noop */ }
      } else {
        writeLog('error', 'proxy', '代理转发失败', { path: pathname, err: msg });
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        }
        try { res.end(JSON.stringify({ error: { message: 'proxy upstream error', detail: msg, type: 'proxy_error' } })); } catch { /* noop */ }
      }
    } finally {
      inFlight.delete(record);
    }
  });

  // ── 绑定端口（冲突时明确报错） ──
  await new Promise((resolve, reject) => {
    const onError = (e) => {
      server.removeListener('error', onError);
      if (e.code === 'EADDRINUSE') {
        reject(new Error(
          `dsh-proxy: 端口 ${cfg.host}:${cfg.port} 已被占用。` +
          `请通过环境变量 DSH_PROXY_PORT 指定其他端口，或关闭占用该端口的进程。`
        ));
      } else if (e.code === 'EACCES') {
        reject(new Error(`dsh-proxy: 无权限绑定 ${cfg.host}:${cfg.port}（EACCES）。`));
      } else {
        reject(e);
      }
    };
    server.once('error', onError);
    server.listen(cfg.port, cfg.host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  // 运行期 socket 错误不应崩溃进程
  server.on('error', (e) => {
    writeLog('error', 'server', '运行期服务器错误', { err: String(e?.message ?? e) });
  });

  return {
    server,
    address: server.address(),
    get inFlightCount() { return inFlight.size; },
    async close() {
      // 中止所有在途请求
      for (const r of [...inFlight]) {
        try { r.abort.abort(new Error('proxy-shutdown')); } catch { /* noop */ }
      }
      // 关闭监听（等待现有连接结束）
      await new Promise((resolve) => server.close(() => resolve()));
      // 强制销毁残留连接（Node 18.2+）
      if (typeof server.closeAllConnections === 'function') {
        try { server.closeAllConnections(); } catch { /* noop */ }
      }
    },
  };
}

// ─────────────────────────── 插件入口 ───────────────────────────

/**
 * Cordis apply 入口。
 * 异步启动代理；启动失败（如端口冲突）时抛出，使插件加载明确失败。
 * 返回 disposer：卸载时关闭监听与在途连接。
 */
export async function apply(ctx) {
  const cfg = loadConfig();

  writeLog('info', 'startup', '正在启动代理', {
    host: cfg.host, port: cfg.port, upstream: cfg.upstream, models: cfg.models.map(String),
  });

  const proxy = await startProxy(cfg);

  const addr = proxy.address;
  const listenStr = `http://${addr.address}:${addr.port}`;
  writeLog('info', 'startup', `代理已启动 → ${listenStr}，上游 ${cfg.upstream}`, {
    models: cfg.models.map(String),
  });

  // 在控制台输出关键信息（无论是否 debug 模式）
  console.info(
    `[dsh-proxy] 监听 ${listenStr} → 上游 ${cfg.upstream}\n` +
    `[dsh-proxy] 过滤模型: ${cfg.models.map(String).join(', ')}\n` +
    `[dsh-proxy] 请将 pi-ai 提供方的 baseURL 设置为 ${listenStr}`
  );

  // 将代理信息挂到 ctx 上，方便其他插件或测试发现
  try {
    if (ctx && typeof ctx === 'object') {
      ctx['dsh-proxy'] = { url: listenStr, upstream: cfg.upstream, models: cfg.models };
    }
  } catch { /* noop */ }

  // ── disposer ──
  return async () => {
    writeLog('info', 'shutdown', '插件卸载，正在关闭代理');
    await proxy.close();
    writeLog('info', 'shutdown', `代理已关闭，在途连接数: ${proxy.inFlightCount}`);
    console.info('[dsh-proxy] 代理已关闭，端口已释放');
  };
}

// ─────────────────────────── 测试导出 ───────────────────────────

/** 仅测试用：暴露内部纯函数。 */
export const __test = {
  filterResponsesBody,
  matchesModel,
  parseModelPatterns,
  isResponsesPath,
  loadConfig,
  startProxy,
  writeLog,
};
