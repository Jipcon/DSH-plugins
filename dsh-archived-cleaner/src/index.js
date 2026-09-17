/**
 * dsh-archived-cleaner — node half。
 *
 * 已归档会话的彻底删除插件。背景：DSH 官方只有归档（archive），没有删除——
 * 会话日志（$DSH_HOME/sessions 下按项目分组的 session 目录）只会越积越多，
 * 撤回类插件每次编辑重发都会再留一个归档副本。
 *
 * host 路由（均为 POST + JSON）：
 *  - POST /archived-cleaner/list                 → 已归档会话清单（含 live/running 标记与文件大小）
 *  - POST /archived-cleaner/delete      { sessionId }            → 删除单个已归档会话
 *  - POST /archived-cleaner/delete-many { sessionIds: [...] }    → 批量删除（逐个返回结果）
 *  - POST /archived-cleaner/clear       { confirm: true }        → 清空全部已归档（快照式，跳过 live）
 *
 * 删除一个会话 = 四步（顺序固定）：
 *  1. 删文件：$DSH_HOME/sessions/<projectKey>/<encodeSegment(id)> 整个目录
 *     （路径算法与 dsh-session-persistence-jsonl/src/format.ts 同构）；
 *  2. 清注册表：从各 workspace 的 sessionIds detach + 从 archivedSessionIds 移除
 *    （只用 workspaceRegistry / workspace 实体的公开方法，不碰内部 state）；
 *  3. 顺手清理：session_projcache 缓存文档 + recall_relations 版本关系（均为 best-effort）。
 *  4. 广播移除：emit('api-session/removed') 让各客户端 sessions list store 丢行——
 *     否则客户端旧行还在，unarchive 后会以"未分组"在侧栏复活，点击即 session/not-found。
 *
 * 安全策略（默认严格，不设宽松档）：
 *  - 仅接受 archivedSessionIds 里的 id，非归档一律拒绝（not-archived）；
 *  - live session（ctx.sessions.get 命中）或有 live agent（ctx.agents.get 命中，
 *    尤其是 status === 'running'）一律拒绝（live-session），避免删正在写的文件；
 *  - clear 要求 body.confirm === true，否则 400（confirm-required）；
 *  - sessionId 白名单校验 + 同源校验 + JSON Content-Type（与 dsh-message-recall 同款 guard）。
 *
 * 依赖服务：硬依赖仅 webServer（inject，路由注册必需）；workspaceRegistry
 *（归档集合/清理）、sessions + agents（live/running 守卫）、sessionPersistence
 *（header 与文件定位）、storageDomain（recall_relations 修剪）一律经 ctx.get()
 * 动态读取，缺失走 503/降级，不阻塞插件加载（message-recall 同款形态）。路由层
 * 保留 503 降级，以防服务中途不可用。
 */
import { readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export const name = 'dsh-archived-cleaner';
// 路由唯一硬依赖 webServer。其余服务（workspaceRegistry / sessions / agents /
// sessionPersistence / storageDomain）一律经 ctx.get() 动态读取 + 503 降级，
// 不进 inject：inject 是硬等待，改它必须重启宿主才生效，且缺任意一个都会让
// 整个插件 pending（路由全挂）；而 ctx.get() 不需要 inject（见 vendor/cordis
// reflect.ts），live reload / 重启语义都更稳。之前把 6 个全写进 inject，又把
// ctx.workspaceRegistry 属性访问与 ctx.get 包在同一个 try 里——旧进程（inject
// 仍只有 webServer）跑到属性访问直接抛 `without inject`，catch 后 return null，
// 根本没走到 ctx.get 兜底，于是 list/delete 全报 registry-unavailable。
export const inject = ['webServer'];

// ---------- 统一日志（host 落盘 $DSH_HOME/dsh-archived-cleaner.log） ----------
let logFile = null;
const logBuffer = [];
let isFlushing = false;
const MAX_LOG_BUFFER = 500;

function resolveLogFile() {
  if (logFile !== null) return logFile;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  logFile = join(home, 'dsh-archived-cleaner.log');
  return logFile;
}
function ts() { return new Date().toISOString(); }

async function flushLogBuffer() {
  if (isFlushing) return;
  isFlushing = true;
  try {
    const { appendFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const file = resolveLogFile();
    await (await import('node:fs/promises')).mkdir(dirname(file), { recursive: true });
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
  if (process.env.DSH_ARCHIVED_CLEANER_DEBUG === '1') {
    if (level === 'error') console.error('[dsh-archived-cleaner]', tag, message, data ?? '');
    else if (level === 'warn') console.warn('[dsh-archived-cleaner]', tag, message, data ?? '');
    else console.info('[dsh-archived-cleaner]', tag, message, data ?? '');
  }
  if (logBuffer.length >= MAX_LOG_BUFFER) logBuffer.shift()?.resolve();
  return new Promise((resolve) => {
    logBuffer.push({ line, resolve });
    flushLogBuffer().catch(() => {});
  });
}

// ---------- 路径算法（与 session-persistence-jsonl/src/format.ts 同构） ----------
/**
 * 把任意字符串编码为单个安全路径段（SessionId 未校验，必须先编码再拼路径）。
 * 与上游 encodeSegment 逐行同构：安全字符原样，`~` 与其余字符变 `~XXXX`（大写 hex），
 * `.` / `..` 特判防穿越。空串抛错。
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/**
 * 会话所属项目目录名。与上游 projectKey 同构：分隔符（/ \ :）压成单个 `-`，
 * 其余按 encodeSegment 同款转义，截断 251 字符后包 `--`。
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root';
  return `--${slug.slice(0, 251)}--`;
}

function projectDir(root, cwd) {
  if (cwd === undefined) return join(root, '_no-cwd');
  return join(root, projectKey(cwd));
}

function sessionDir(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id));
}

/** 解析 $DSH_HOME 下的 sessions / storages 根目录。 */
function resolveRoots() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return { home, sessionsRoot: join(home, 'sessions'), storagesRoot: join(home, 'storages') };
}

/**
 * 计算会话目录并断言它仍在 sessionsRoot 内（纵深防御：encodeSegment /
 * projectKey 本已保证单段，resolve 前缀校验防未来改动引入穿越）。
 */
function safeSessionDir(sessionsRoot, cwd, id) {
  const dir = sessionDir(sessionsRoot, cwd, id);
  const rel = resolve(dir);
  const base = resolve(sessionsRoot);
  if (rel !== base && !rel.startsWith(base + sep)) {
    throw new Error(`refusing to delete outside sessions root: ${dir}`);
  }
  return dir;
}

// ---------- 请求解析与路由守卫 ----------
function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
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
        resolve(text ? JSON.parse(text) : {});
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;
function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && SESSION_ID_PATTERN.test(value);
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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
/** 同源 + JSON Content-Type 守卫，通过返回 true。 */
function guard(req, res) {
  if (!requestFromSameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return false; }
  if (!isJsonContentType(req)) { sendJson(res, 415, { ok: false, error: 'unsupported-media-type' }); return false; }
  return true;
}

// ---------- 服务定位（只用 ctx.get：不需要 inject，缺失时返回 null） ----------
// 注意：不要用 `ctx.workspaceRegistry` 这类属性访问——它要求 inject 声明，
// 未声明直接抛 `without inject`；而 ctx.get() 明确不需要 inject（reflect.ts）。
// 两次尝试必须各自独立 try/catch：合在一个 try 里时第一行一抛就会跳过第二行。
function getRegistry(ctx) {
  try {
    if (typeof ctx.get === 'function') {
      const v = ctx.get('workspaceRegistry');
      if (v !== undefined && v !== null) return v;
    }
  } catch { /* get 失败则继续看属性访问（兼容旧上下文） */ }
  try {
    const v = ctx.workspaceRegistry;
    if (v !== undefined && v !== null) return v;
  } catch { /* without inject：预期内，返回 null 走 503 降级 */ }
  return null;
}
function getSessions(ctx) {
  try {
    if (typeof ctx.get === 'function') {
      const v = ctx.get('sessions');
      if (v !== undefined && v !== null) return v;
    }
  } catch { /* ignore */ }
  try {
    const v = ctx.sessions;
    if (v !== undefined && v !== null) return v;
  } catch { /* without inject */ }
  return null;
}
function getAgents(ctx) {
  try {
    if (typeof ctx.get === 'function') {
      const v = ctx.get('agents');
      if (v !== undefined && v !== null) return v;
    }
  } catch { /* ignore */ }
  try {
    const v = ctx.agents;
    if (v !== undefined && v !== null) return v;
  } catch { /* without inject */ }
  return null;
}
function getPersistence(ctx) {
  try {
    if (typeof ctx.get === 'function') {
      const v = ctx.get('sessionPersistence');
      if (v !== undefined && v !== null) return v;
    }
  } catch { /* ignore */ }
  try {
    const v = ctx.sessionPersistence;
    if (v !== undefined && v !== null) return v;
  } catch { /* without inject */ }
  return null;
}
function getStorageDomain(ctx) {
  try {
    if (typeof ctx.get === 'function') {
      const v = ctx.get('storageDomain');
      if (v !== undefined && v !== null) return v;
    }
  } catch { /* ignore */ }
  try {
    const v = ctx.storageDomain;
    if (v !== undefined && v !== null) return v;
  } catch { /* without inject */ }
  return null;
}

/** live 判定：内存里还有 session 或 agent 即视为 live（running 另行标注）。 */
function liveInfo(ctx, sessionId) {
  let live = false;
  let running = false;
  try {
    const sessions = getSessions(ctx);
    if (sessions && typeof sessions.get === 'function' && sessions.get(sessionId) !== undefined) live = true;
  } catch { /* ignore */ }
  try {
    const agents = getAgents(ctx);
    if (agents && typeof agents.get === 'function') {
      const agent = agents.get(sessionId);
      if (agent !== undefined && agent !== null) {
        live = true;
        if (agent.status === 'running') running = true;
      }
    }
  } catch { /* ignore */ }
  return { live, running };
}

async function statSession(ctx, sessionId) {
  try {
    const persistence = getPersistence(ctx);
    if (!persistence || typeof persistence.stat !== 'function') return undefined;
    return await persistence.stat(sessionId);
  } catch {
    return undefined; // stat 失败按未知处理，不阻塞删除流程
  }
}

// ---------- 删除核心 ----------
/**
 * 删除单个已归档会话。调用方保证入参已做白名单校验。
 * @returns { ok, id, fileDeleted, cleanedRegistry, prunedRelations, error?, message? }
 */
async function deleteOneArchived(ctx, sessionId) {
  const registry = getRegistry(ctx);
  if (!registry) {
    writeLog('warn', 'delete', 'workspaceRegistry 不可用', {
      sessionId,
      hasGet: typeof ctx.get === 'function',
      // 诊断用：为 null 说明服务尚未提供或 fiber 非 active（strict），重启后仍出现请贴这行日志
      viaGet: (() => { try { return ctx.get?.('workspaceRegistry') === undefined ? 'undefined' : typeof ctx.get?.('workspaceRegistry'); } catch (e) { return `throw:${String(e?.message ?? e).slice(0, 80)}`; } })(),
    });
    return { ok: false, id: sessionId, error: 'registry-unavailable' };
  }

  let archived;
  try {
    archived = [...registry.archivedSessionIds];
  } catch (err) {
    writeLog('warn', 'delete', '读取归档集合失败', { sessionId, err: String(err?.message ?? err) });
    return { ok: false, id: sessionId, error: 'registry-unavailable' };
  }
  if (!archived.includes(sessionId)) {
    return { ok: false, id: sessionId, error: 'not-archived', message: '该会话不在已归档集合中（仅允许删除已归档会话）' };
  }

  const { live, running } = liveInfo(ctx, sessionId);
  if (live) {
    writeLog('warn', 'delete', '拒绝删除 live 会话', { sessionId, running });
    return {
      ok: false, id: sessionId, error: 'live-session',
      message: running ? '该会话正在运行中，请等待其结束后再删除' : '该会话仍在内存中（可能正被打开），请关闭后再删除',
    };
  }

  // —— 1. 删文件 ——
  const { sessionsRoot, storagesRoot } = resolveRoots();
  const snap = await statSession(ctx, sessionId);
  let fileDeleted = false;
  try {
    if (snap && snap.header) {
      const dir = safeSessionDir(sessionsRoot, snap.header.cwd, sessionId);
      await rm(dir, { recursive: true, force: true });
      fileDeleted = true;
    } else {
      // stat  Miss：按目录名兜底扫描（会话可能从未落盘，或 header 已不可读）。
      // 只删精确匹配 encodeSegment(id) 的子目录，不做模糊匹配。
      const wanted = encodeSegment(sessionId);
      let found = 0;
      let projects = [];
      try { projects = await readdir(sessionsRoot, { withFileTypes: true }); } catch { projects = []; }
      for (const p of projects) {
        if (!p.isDirectory()) continue;
        const candidate = join(sessionsRoot, p.name, wanted);
        try {
          await rm(candidate, { recursive: true, force: true });
          found++;
        } catch { /* 单个候选失败不中断 */ }
      }
      fileDeleted = found > 0;
    }
  } catch (err) {
    writeLog('warn', 'delete', '会话文件删除失败', { sessionId, err: String(err?.message ?? err) });
    return { ok: false, id: sessionId, error: 'file-delete-failed', message: String(err?.message ?? err) };
  }

  // —— 2. 清注册表（detach + unarchive，只用公开方法） ——
  let cleanedRegistry = false;
  try {
    let workspaces = [];
    try { workspaces = registry.list() ?? []; } catch { workspaces = []; }
    for (const ws of workspaces) {
      try {
        const ids = ws.sessionIds ?? [];
        if (Array.isArray(ids) && ids.includes(sessionId) && typeof ws.detachSession === 'function') {
          await ws.detachSession(sessionId);
        }
      } catch (err) {
        writeLog('warn', 'delete', 'workspace detach 失败（继续）', {
          sessionId, workspace: String(ws?.id ?? ws?.path ?? '?'), err: String(err?.message ?? err),
        });
      }
    }
    if (typeof registry.unarchiveSession === 'function') {
      await registry.unarchiveSession(sessionId); // 幂等：不在集合中直接返回
    }
    cleanedRegistry = true;
  } catch (err) {
    writeLog('warn', 'delete', '注册表清理失败', { sessionId, err: String(err?.message ?? err) });
    return { ok: false, id: sessionId, fileDeleted, error: 'registry-cleanup-failed', message: String(err?.message ?? err) };
  }

  // —— 3a. 顺手清 projection 缓存（best-effort） ——
  try {
    if (/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      await rm(join(storagesRoot, 'session_projcache', 'sessions', `${sessionId}.json`), { force: true });
    }
  } catch { /* 缓存残留无害 */ }

  // —— 3b. 顺手修剪 recall_relations 版本关系（best-effort） ——
  // 被删的多半是撤回/编辑留下的旧版本；家族里留下指向不存在会话的成员会导致翻页器预加载失败，
  // 因此把删除的 id 从成员里摘掉；目标被删或成员被掏空则整行删掉（侧栏回落到独立会话显示）。
  let prunedRelations = false;
  try {
    const storageDomain = getStorageDomain(ctx);
    if (storageDomain && typeof storageDomain.open === 'function') {
      const domain = await storageDomain.open({
        name: 'recall_relations',
        version: 1,
        tables: { families: { valueSchema: { parse: (v) => v } } },
      });
      const table = domain.table('families');
      if (table && typeof table.entries === 'function') {
        for (const [rowId, value] of table.entries()) {
          try {
            const row = value;
            if (!row || typeof row !== 'object' || !Array.isArray(row.memberSessionIds)) continue;
            if (!row.memberSessionIds.includes(sessionId)) continue;
            const members = row.memberSessionIds.filter((id) => id !== sessionId);
            if (members.length === 0 || row.targetSessionId === sessionId) {
              if (typeof table.delete === 'function') await table.delete(rowId);
              prunedRelations = true;
            } else {
              await table.put(rowId, { ...row, memberSessionIds: members, updatedAt: Date.now() });
              prunedRelations = true;
            }
          } catch { /* 单行失败不中断 */ }
        }
      }
    }
  } catch { /* 域不存在或打不开均忽略（可能没装 message-recall） */ }

  // —— 4. 通知侧栏：该会话已彻底消失（与 session/disposed 同语义） ——
  // 不 emit 的话，各客户端 sessions list store 里还留着该行；第 2 步又把它从
  // 归档集摘掉，该行会立刻以"未分组"在侧栏现形，点击即 session/not-found。
  // 走官方转发的 api-session/removed 通道（api-remotes/remote-events.ts），各
  // 客户端 handleSessionRemoved 幂等丢行；重连/刷新重拉的基线本来就不含它
  // （文件已删、非 live），故不存在复活。emit 失败不影响删除结果。
  try {
    if (typeof ctx.emit === 'function') ctx.emit('api-session/removed', sessionId);
  } catch { /* 事件总线异常忽略 */ }

  writeLog('info', 'delete', '已归档会话已删除', { sessionId, fileDeleted, cleanedRegistry, prunedRelations });
  return { ok: true, id: sessionId, fileDeleted, cleanedRegistry, prunedRelations };
}

// ---------- 路由 ----------
export function apply(ctx) {
  writeLog('info', 'host', 'apply: 路由注册开始');
  const disposers = [];

  // 清单
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/archived-cleaner/list',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        if (!guard(req, res)) return;
        await readJsonBody(req, 16 * 1024).catch(() => ({}));
        const registry = getRegistry(ctx);
        if (!registry) { sendJson(res, 200, { ok: false, error: 'registry-unavailable' }); return; }
        let archived;
        try { archived = [...registry.archivedSessionIds]; }
        catch { sendJson(res, 200, { ok: false, error: 'registry-unavailable' }); return; }
        const entries = [];
        for (const id of archived) {
          const sid = String(id);
          const { live, running } = liveInfo(ctx, sid);
          const snap = await statSession(ctx, sid);
          entries.push({
            id: sid,
            cwd: snap?.header?.cwd ?? null,
            createdAt: typeof snap?.header?.createdAt === 'number' ? snap.header.createdAt : null,
            parentSession: snap?.header?.parentSession ?? null,
            sizeBytes: typeof snap?.sizeBytes === 'number' ? snap.sizeBytes : null,
            persisted: snap !== undefined,
            live, running,
          });
        }
        sendJson(res, 200, { ok: true, archived: entries });
      } catch (err) {
        writeLog('warn', 'host', '/archived-cleaner/list 失败', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    },
  }));

  // 删除单个
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/archived-cleaner/delete',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        let body;
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: 'invalid-request' }); return; }
        if (!guard(req, res)) return;
        const { sessionId } = body ?? {};
        if (!validSessionId(sessionId)) { sendJson(res, 400, { ok: false, error: 'invalid-session-id' }); return; }
        writeLog('info', 'delete', '收到删除请求', { sessionId });
        const result = await deleteOneArchived(ctx, sessionId);
        if (!result.ok) {
          const status = result.error === 'not-archived' ? 404
            : result.error === 'live-session' ? 409
            : result.error === 'invalid-session-id' ? 400
            : result.error === 'registry-unavailable' ? 503 : 500;
          sendJson(res, status, result);
          return;
        }
        sendJson(res, 200, result);
      } catch (err) {
        writeLog('warn', 'host', '/archived-cleaner/delete 异常', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    },
  }));

  // 批量删除
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/archived-cleaner/delete-many',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        let body;
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: 'invalid-request' }); return; }
        if (!guard(req, res)) return;
        const ids = body?.sessionIds;
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) {
          sendJson(res, 400, { ok: false, error: 'invalid-request', message: 'sessionIds 需为 1-200 个会话 id 数组' });
          return;
        }
        const seen = new Set();
        const queue = [];
        for (const id of ids) {
          if (!validSessionId(id)) { sendJson(res, 400, { ok: false, error: 'invalid-session-id', id }); return; }
          if (!seen.has(id)) { seen.add(id); queue.push(id); }
        }
        writeLog('info', 'delete', '收到批量删除请求', { count: queue.length });
        const results = [];
        for (const id of queue) results.push(await deleteOneArchived(ctx, id));
        const deleted = results.filter((r) => r.ok).length;
        writeLog('info', 'delete', '批量删除完成', { total: results.length, deleted });
        sendJson(res, 200, { ok: true, total: results.length, deleted, results });
      } catch (err) {
        writeLog('warn', 'host', '/archived-cleaner/delete-many 异常', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    },
  }));

  // 一键清空（快照式：先拍归档集合快照，逐个删除，live 自动跳过并计入 skipped）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/archived-cleaner/clear',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        let body;
        try { body = await readJsonBody(req, 16 * 1024); } catch { sendJson(res, 400, { ok: false, error: 'invalid-request' }); return; }
        if (!guard(req, res)) return;
        if (!body || body.confirm !== true) {
          sendJson(res, 400, { ok: false, error: 'confirm-required', message: '清空全部已归档需要显式确认（confirm: true）' });
          return;
        }
        const registry = getRegistry(ctx);
        if (!registry) { sendJson(res, 200, { ok: false, error: 'registry-unavailable' }); return; }
        let snapshot;
        try { snapshot = [...registry.archivedSessionIds].map(String); }
        catch { sendJson(res, 200, { ok: false, error: 'registry-unavailable' }); return; }
        writeLog('info', 'delete', '收到一键清空请求', { total: snapshot.length });
        const results = [];
        for (const id of snapshot) results.push(await deleteOneArchived(ctx, id));
        const deleted = results.filter((r) => r.ok).length;
        const skipped = results.filter((r) => !r.ok).map((r) => ({ id: r.id, error: r.error }));
        writeLog('info', 'delete', '一键清空完成', { total: results.length, deleted, skipped: skipped.length });
        sendJson(res, 200, { ok: true, total: results.length, deleted, skipped, results });
      } catch (err) {
        writeLog('warn', 'host', '/archived-cleaner/clear 异常', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    },
  }));

  writeLog('info', 'host', 'apply: 路由注册完成');
  return () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    writeLog('info', 'host', 'apply: 已卸载');
  };
}

/** 仅测试用：暴露内部纯函数（不参与运行时行为）。 */
export const __test = { encodeSegment, projectKey, projectDir, sessionDir, safeSessionDir, validSessionId, getRegistry, getSessions, getAgents, getPersistence, getStorageDomain, deleteOneArchived };
