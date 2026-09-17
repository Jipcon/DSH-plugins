/**
 * dsh-codex-auth — node half（host 桥接）。
 *
 * 背景：dsh-llm-pi-ai 底层早已为 `openai-codex`（ChatGPT Plus/Pro 订阅）注册了
 * OAuth 登录流（`ctx.authorization` 上 key 为 `llm-pi-ai/openai-codex` 的 flow，
 * 方法只有 `oauth`），但 Web「设置 → 模型」页明确不支持 OAuth 提供方
 * （"Providers that sign in with OAuth, such as Codex, are not supported here yet."），
 * 所以账号登录能力对普通用户不可见。本插件只做一件事：给这个已存在的 flow 配一个
 * 浏览器可达的 surface——host 侧用 webServer 路由桥接 `authorization.begin()` 的
 * 整场交互（notice 流 + 串行 prompt），浏览器侧用设置卡片渲染并回填答案。
 *
 * 已知的生产组合缺口（第一版哑火的根因，详见 ./authorization.js 头部）：
 * dsh-base 系组合根本没有挂载 `dsh-authorization`，`ctx.authorization` 在运行时
 * 不存在，dsh-llm-pi-ai 的 Codex 等 OAuth 流也因此从未注册。所以本插件启动时先补缝：
 * 组合自带就用自带的，缺失就就地 `provide` 本地兼容实现；dsh-llm-pi-ai 会在缝出现后
 * 自动把 Codex 流注册上来，本桥接再与之对话。也正因为此，inject 里绝不能写
 * 'authorization'（写了会让本插件纤程永远 pending、apply 永不执行）。
 *
 * pi-ai 的 openai-codex 登录内部只有两种走法（见 pi-ai `auth/oauth/openai-codex.js`）：
 *  - 先弹一个 `select` 让用户选 `browser`（默认）还是 `device_code`（headless）；
 *  - `device_code`：下发一个 `device_code` notice（verificationUri + userCode），
 *    host 侧内部轮询直到用户在 ChatGPT 页输完码，全程无需再问；
 *  - `browser`：host 起一个 `127.0.0.1:1455` 本地回调服务，下发 `auth_url` notice，
 *    同时 race 一个 `manual_code` prompt（用户在浏览器完成登录后，把回调 URL/授权码
 *    粘回来；若本地回调先收到码，prompt 会被 flow 自己撤回）。
 * 本桥接把开头的 `select` 直接按 `/start` 的 `loginMethod` 代答，浏览器侧只需处理
 * 后面的 notice + 最多一个 `manual_code` 输入。
 *
 * host 路由（均为 POST + JSON，同源守卫）：
 *  - POST /codex-auth/status  {} → flow/record/进行中尝试的摘要
 *  - POST /codex-auth/start   { loginMethod: 'device_code'|'browser' } → 后台起一次 begin
 *  - POST /codex-auth/poll    {} → 本次尝试的 notices + 待答 prompt + 终态
 *  - POST /codex-auth/answer  { text } → 回答待答 prompt（select/text/secret/manual_code）
 *  - POST /codex-auth/cancel  {} → 撤回本次尝试（等价于登录页点取消）
 *  - POST /codex-auth/signout {} → 删除本地已存记录（仅本地遗忘，不通知发行方撤销）
 *
 * 并发：按 seam 语义每个 key 同时只允许一次 begin；本插件再收敛为全局单 active，
 * `/start` 在已有 running 尝试时回 409 `already-in-flight`。
 *
 * 安全：
 *  - 同源 + JSON Content-Type 守卫（与 dsh-plugin-manager 同款）；
 *  - 下发的 notice 按 seam 约定永不携带机密；回填的授权码只在内存停留、不落日志；
 *  - `/signout` 只是 `deleteRecord`，服务端订阅关系不受影响（与官方语义一致）。
 *
 * 依赖服务：webServer（路由）、credentials（记录读写）；authorization 按需补（见下）。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthorizationService } from './authorization.js';

export const name = 'dsh-codex-auth';
// 见头部注释：'authorization' 绝不能进 inject（生产组合里没有它，写了就永远 pending）。
export const inject = ['webServer', 'credentials'];

const CODEX_KEY = 'llm-pi-ai/openai-codex';
const BROWSER_ID = 'browser';
const DEVICE_ID = 'device_code';

// ---------- 日志（host 落盘 $DSH_HOME/dsh-codex-auth.log，同步追加，授权码永不记录） ----------

function resolveLogFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'dsh-codex-auth.log');
}

function writeLog(level, tag, message, data) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    tag,
    message,
    data: data ?? null,
  });
  if (process.env.DSH_CODEX_AUTH_DEBUG === '1') {
    if (level === 'error') console.error('[dsh-codex-auth]', tag, message, data ?? '');
    else if (level === 'warn') console.warn('[dsh-codex-auth]', tag, message, data ?? '');
    else console.info('[dsh-codex-auth]', tag, message, data ?? '');
  }
  try {
    const file = resolveLogFile();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, line + '\n', 'utf8');
  } catch { /* 磁盘异常不破坏进程 */ }
}

// ---------- 请求解析与路由守卫（与 dsh-plugin-manager 同款） ----------

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        req.removeAllListeners('data');
        req.resume();
        reject(new Error('body-too-large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolvePromise(text ? JSON.parse(text) : {});
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function requestFromSameOrigin(req) {
  try {
    const origin = req.headers?.origin || req.headers?.referer;
    if (!origin) return true;
    if (origin === 'null') return false;
    const host = req.headers?.host;
    if (!host) return false;
    return new URL(origin).host === host;
  } catch { return false; }
}

function isJsonContentType(req) {
  const ct = String(req.headers?.['content-type'] || '').toLowerCase();
  return ct === 'application/json' || ct.startsWith('application/json;');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function guard(req, res) {
  if (!requestFromSameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return false; }
  if (!isJsonContentType(req)) { sendJson(res, 415, { ok: false, error: 'unsupported-media-type' }); return false; }
  return true;
}

// ---------- 尝试状态机（全局单 active，与 seam 的 one-attempt-per-key 对齐） ----------

let noticeSeq = 0;
let attemptSeq = 0;
/** @type {null | { id:number, loginMethod:string, startedAt:string, controller:AbortController, notices:any[], pending:null|{seq:number,kind:string,message:string,placeholder?:string,options?:any[],deferred:{resolve:(v:string)=>void,reject:(e:unknown)=>void}}, status:'running'|'authorized'|'cancelled'|'failed', outcome:any, error:string|null, errorCode:string|null }} */
let active = null;

function summarizeActive() {
  if (!active) return null;
  return {
    id: active.id,
    loginMethod: active.loginMethod,
    status: active.status,
    startedAt: active.startedAt,
    noticeCount: active.notices.length,
    hasPending: active.pending !== null,
    outcome: active.outcome,
    error: active.error,
    errorCode: active.errorCode,
  };
}

function publicPending() {
  if (!active?.pending) return null;
  const { deferred, ...rest } = active.pending;
  void deferred;
  return rest;
}

function errorOf(err) {
  if (err && typeof err === 'object') {
    return {
      message: String(err.message ?? err),
      code: typeof err.code === 'string' ? err.code : null,
    };
  }
  return { message: String(err), code: null };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 查 Codex 流，查不到就短暂重试：本插件补缝后，dsh-llm-pi-ai 的
 * `ctx.inject(['authorization'], …)` 回调是异步触发的，启动瞬间或缝刚补上时
 * 流可能还没注册上来。只在缺失时等，最多约 1.5s。
 */
async function describeCodexFlow(authorization) {
  for (let i = 0; i < 6; i++) {
    let entry = null;
    try { entry = authorization.describe(CODEX_KEY) ?? null; } catch { entry = null; }
    if (entry) return entry;
    await sleep(250);
  }
  return null;
}

export function apply(ctx) {
  writeLog('info', 'host', 'apply: 路由注册开始');
  const disposers = [];
  const ownDir = dirname(fileURLToPath(import.meta.url));
  void ownDir;

  // —— authorization 缝：组合自带就用自带的，缺失就就地补本地实现 ——
  // dsh-llm-pi-ai 用 ctx.inject(['authorization'], …) 等缝出现后才注册 Codex 流，
  // 所以补上之后底层流会自动挂上来（可能滞后几毫秒，/status 每次现查，无需等待）。
  let localAuthorization = null;
  let seamWarning = null;
  function authorization() {
    let current = null;
    try { current = ctx.get('authorization'); } catch { current = null; }
    if (current) return current;
    if (localAuthorization) return localAuthorization;
    const provided = new AuthorizationService(ctx);
    try {
      const disposeProvided = ctx.provide('authorization', provided);
      disposers.push(() => { try { disposeProvided(); } catch { /* ignore */ } });
    } catch (err) {
      // 并发或未来官方自带导致重复提供：回读现成的用，不硬碰。
      try { current = ctx.get('authorization'); } catch { current = null; }
      if (current) return current;
      seamWarning = `cannot provide local authorization service: ${err?.message ?? err}`;
      writeLog('warn', 'host', '本地 authorization 提供失败', { err: String(err?.message ?? err) });
      return null;
    }
    localAuthorization = provided;
    writeLog('info', 'host', '组合缺失 authorization 缝，已就地提供本地兼容实现');
    return localAuthorization;
  }

  function services() {
    let auth = null;
    try { auth = authorization(); } catch (err) {
      seamWarning = String(err?.message ?? err);
      auth = null;
    }
    let creds = null;
    try { creds = ctx.credentials; } catch { creds = null; }
    return { authorization: auth, credentials: creds };
  }

  function unavailableMessage() {
    return seamWarning || 'authorization/credentials 服务缺失';
  }

  // —— 状态：flow 是否存在 + 本地记录是否已配置 + 进行中尝试摘要 ——
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/codex-auth/status',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        if (!guard(req, res)) return;
        await readJsonBody(req, 16 * 1024).catch(() => ({}));
        const { authorization, credentials } = services();
        if (!authorization || !credentials) {
          sendJson(res, 503, { ok: false, error: 'service-unavailable', message: unavailableMessage() });
          return;
        }
        let flow = null;
        try {
          const entry = await describeCodexFlow(authorization);
          flow = entry ? {
            key: entry.key,
            label: entry.label,
            methods: (entry.methods || []).map((m) => ({ id: m.id, label: m.label })),
            inFlight: !!entry.inFlight,
          } : null;
        } catch (err) {
          writeLog('warn', 'host', '/codex-auth/status describe flow 失败', { err: String(err?.message ?? err) });
        }
        let record = null;
        try {
          const info = await credentials.describeRecord(CODEX_KEY);
          record = {
            configured: !!info.configured,
            ...(info.kind === undefined ? {} : { kind: info.kind }),
            writable: info.writable !== false,
          };
        } catch (err) {
          writeLog('warn', 'host', '/codex-auth/status describeRecord 失败', { err: String(err?.message ?? err) });
          record = { configured: false, writable: true, unknown: true };
        }
        sendJson(res, 200, { ok: true, key: CODEX_KEY, flow, record, active: summarizeActive() });
      } catch (err) {
        writeLog('warn', 'host', '/codex-auth/status 异常', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    },
  }));

  // —— 开始：后台起一次 authorization.begin，立即返回 attemptId，交互走 /poll + /answer ——
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/codex-auth/start',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        if (!guard(req, res)) return;
        let body = {};
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: 'invalid-request' }); return; }
        const loginMethod = body?.loginMethod === BROWSER_ID ? BROWSER_ID : DEVICE_ID;
        const { authorization } = services();
        if (!authorization) { sendJson(res, 503, { ok: false, error: 'service-unavailable', message: unavailableMessage() }); return; }
        if (active && active.status === 'running') {
          sendJson(res, 409, { ok: false, error: 'already-in-flight', message: '已有一次登录在进行中，先完成或取消它', active: summarizeActive() });
          return;
        }
        let flow = null;
        try { flow = await describeCodexFlow(authorization); } catch (err) {
          sendJson(res, 500, { ok: false, error: 'internal', message: String(err?.message ?? err) });
          return;
        }
        if (!flow) {
          sendJson(res, 503, {
            ok: false,
            error: 'no-flow',
            message: '底层还没有注册 llm-pi-ai/openai-codex 登录流（dsh-llm-pi-ai 未挂载、版本过旧，或刚启动还在注册中——稍等几秒重试）',
          });
          return;
        }
        const method = flow.methods?.[0]?.id;
        if (!method) {
          sendJson(res, 503, { ok: false, error: 'no-method', message: '登录流没有可用方法' });
          return;
        }
        const id = ++attemptSeq;
        const controller = new AbortController();
        active = {
          id,
          loginMethod,
          startedAt: new Date().toISOString(),
          controller,
          notices: [],
          pending: null,
          status: 'running',
          outcome: null,
          error: null,
          errorCode: null,
        };
        writeLog('info', 'attempt', '登录尝试开始', { id, loginMethod, method });
        const attempt = active;
        const interaction = {
          notify(notice) {
            try {
              attempt.notices.push({ seq: noticeSeq++, ...(notice ?? {}) });
            } catch (err) {
              writeLog('warn', 'attempt', 'notify 记录失败', { id, err: String(err?.message ?? err) });
            }
          },
          prompt(prompt) {
            return new Promise((resolve, reject) => {
              try {
                // Codex 登录开头的方法二选一由 /start 代答，不打扰浏览器侧。
                // 注意两点实测坑：
                //  1. 到这里的是 harness 中性词（restate 之后）：字段叫 kind 不叫 type，
                //     且方法选择器的 kind 是 'text' 而非 'select'（但照样带 options）。
                //  2. 因此只认 options 内容，不认 kind/type 取值。
                const rawOptions = Array.isArray(prompt?.options) ? prompt.options : undefined;
                const ids = rawOptions ? rawOptions.map((o) => o?.id) : [];
                if (ids.includes(BROWSER_ID) && ids.includes(DEVICE_ID)) {
                  resolve(active.loginMethod);
                  return;
                }
                const seq = noticeSeq++;
                attempt.pending = {
                  seq,
                  kind: prompt?.kind ?? prompt?.type ?? 'text',
                  message: prompt?.message ?? '请输入',
                  ...(prompt?.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
                  ...(rawOptions === undefined ? {} : { options: rawOptions }),
                  deferred: { resolve, reject },
                };
                const sig = prompt?.signal;
                if (sig) {
                  if (sig.aborted) {
                    if (attempt.pending?.seq === seq) attempt.pending = null;
                    reject(new Error('prompt-withdrawn'));
                    return;
                  }
                  sig.addEventListener('abort', () => {
                    if (attempt.pending?.seq === seq) attempt.pending = null;
                    reject(new Error('prompt-withdrawn'));
                  }, { once: true });
                }
              } catch (err) { reject(err); }
            });
          },
        };
        // 后台跑，不阻塞 HTTP 响应；终态由 /poll 查询。
        void authorization.begin({
          key: CODEX_KEY,
          method,
          interaction,
          signal: controller.signal,
        }).then((outcome) => {
          if (active !== attempt) return;
          attempt.status = outcome?.status ?? 'authorized';
          attempt.outcome = outcome;
          attempt.pending = null;
          writeLog('info', 'attempt', '登录尝试结算', { id, status: attempt.status });
        }).catch((err) => {
          if (active !== attempt) return;
          const { message, code } = errorOf(err);
          attempt.status = 'failed';
          attempt.error = message;
          attempt.errorCode = code;
          attempt.pending = null;
          writeLog('warn', 'attempt', '登录尝试失败', { id, err: message, code });
        });
        sendJson(res, 200, { ok: true, attemptId: id, loginMethod, active: summarizeActive() });
      } catch (err) {
        writeLog('warn', 'host', '/codex-auth/start 异常', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    },
  }));

  // —— 轮询：notices 全量 + 待答 prompt + 终态（client 每 ~800ms 问一次即可） ——
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/codex-auth/poll',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        if (!guard(req, res)) return;
        await readJsonBody(req, 16 * 1024).catch(() => ({}));
        if (!active) { sendJson(res, 200, { ok: true, active: null }); return; }
        sendJson(res, 200, {
          ok: true,
          active: summarizeActive(),
          notices: active.notices,
          pending: publicPending(),
          outcome: active.outcome,
          error: active.error,
          errorCode: active.errorCode,
        });
      } catch (err) {
        writeLog('warn', 'host', '/codex-auth/poll 异常', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    },
  }));

  // —— 回填：回答当前待答 prompt（授权码只过内存，不落日志） ——
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/codex-auth/answer',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        if (!guard(req, res)) return;
        let body = {};
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: 'invalid-request' }); return; }
        if (!active || active.status !== 'running') { sendJson(res, 409, { ok: false, error: 'no-attempt', message: '没有进行中的登录' }); return; }
        const pending = active.pending;
        if (!pending) { sendJson(res, 409, { ok: false, error: 'no-pending', message: '当前没有待回答的问题' }); return; }
        // 带 options 的 prompt 一律按选项校验（不管 kind 是 select 还是 text：
        // Codex 的方法选择器 kind 就是 'text'）。方法选择器正常已被代答，
        // 走到这里的是上游新增的其它选项型问题，原样透出让用户点选。
        if (Array.isArray(pending.options) && pending.options.length > 0) {
          const text = typeof body?.text === 'string' ? body.text : (typeof body?.option === 'string' ? body.option : '');
          const allowed = pending.options.map((o) => o?.id);
          if (!text || !allowed.includes(text)) {
            sendJson(res, 400, { ok: false, error: 'invalid-option', message: '选项不合法', allowed });
            return;
          }
          pending.deferred.resolve(text);
          active.pending = null;
          writeLog('info', 'attempt', '已回答选项型 prompt', { id: active.id });
          sendJson(res, 200, { ok: true });
          return;
        }
        const text = typeof body?.text === 'string' ? body.text : '';
        if (text.trim() === '') { sendJson(res, 400, { ok: false, error: 'empty-answer', message: '回答不能为空' }); return; }
        pending.deferred.resolve(text);
        active.pending = null;
        writeLog('info', 'attempt', '已回填 prompt 回答（内容不记录）', { id: active.id, kind: pending.kind });
        sendJson(res, 200, { ok: true });
      } catch (err) {
        writeLog('warn', 'host', '/codex-auth/answer 异常', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    },
  }));

  // —— 取消：撤回本次尝试（flow 会以 cancelled 结算） ——
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/codex-auth/cancel',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        if (!guard(req, res)) return;
        await readJsonBody(req, 16 * 1024).catch(() => ({}));
        if (!active || active.status !== 'running') { sendJson(res, 200, { ok: true, cancelled: false }); return; }
        const { authorization } = services();
        try { active.controller.abort(); } catch { /* ignore */ }
        try { authorization?.cancel(CODEX_KEY); } catch { /* ignore */ }
        writeLog('info', 'attempt', '已请求取消', { id: active.id });
        sendJson(res, 200, { ok: true, cancelled: true, active: summarizeActive() });
      } catch (err) {
        writeLog('warn', 'host', '/codex-auth/cancel 异常', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    },
  }));

  // —— 退出：删除本地已存记录（仅本地遗忘，不通知发行方撤销，与官方语义一致） ——
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/codex-auth/signout',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        if (!guard(req, res)) return;
        await readJsonBody(req, 16 * 1024).catch(() => ({}));
        const { credentials } = services();
        if (!credentials) { sendJson(res, 503, { ok: false, error: 'service-unavailable' }); return; }
        try {
          await credentials.deleteRecord(CODEX_KEY);
        } catch (err) {
          writeLog('warn', 'host', '/codex-auth/signout 删除失败', { err: String(err?.message ?? err) });
          sendJson(res, 500, { ok: false, error: 'signout-failed', message: String(err?.message ?? err) });
          return;
        }
        writeLog('info', 'host', '已退出登录（本地记录已删除）');
        sendJson(res, 200, { ok: true });
      } catch (err) {
        writeLog('warn', 'host', '/codex-auth/signout 异常', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    },
  }));

  writeLog('info', 'host', 'apply: 路由注册完成');
  return () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    try { active?.controller.abort(); } catch { /* ignore */ }
    writeLog('info', 'host', 'apply: 已卸载');
  };
}

/** 仅测试用：暴露内部常量与键（不参与运行时行为）。 */
export const __test = {
  CODEX_KEY,
  BROWSER_ID,
  DEVICE_ID,
};
