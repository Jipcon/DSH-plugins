/**
 * dsh-message-recall — node half。
 *
 * host 路由：
 *  - POST /bubble/recall { sessionId, targetSeq } → 撤回：
 *    在 targetSeq 之前的最后一个闭合回合（turn/end）处 fork 新版本
 *    （新会话不含目标消息及其之后全部内容），flush 持久化。
 *    「真正修改」只发生在这里；client 侧 pending 只是本地草稿态。
 *
 * 依赖服务：webServer（路由）、sessions（fork/flush）。
 */
import { appendFile, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
function settingsNamespace(value) {
  if (!NAMESPACE_PATTERN.test(value)) throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`);
  return value;
}

// ---------- 统一日志（host 落盘 $DSH_HOME/dsh-message-recall.log） ----------
let logFile = null;
const logBuffer = [];
let isFlushing = false;
const MAX_LOG_BUFFER = 1000; // 防御性上限：防止极端磁盘卡死时堆积内存

function resolveLogFile() {
  if (logFile !== null) return logFile;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  logFile = join(home, 'dsh-message-recall.log');
  return logFile;
}
function ts() { return new Date().toISOString(); }

/** 批处理自驱式落盘（彻底杜绝无界 Promise 链与闭包泄漏，合并 IO 提升吞吐）。 */
async function flushLogBuffer() {
  if (isFlushing) return;
  isFlushing = true;
  try {
    const file = resolveLogFile();
    await mkdir(dirname(file), { recursive: true });

    while (logBuffer.length > 0) {
      // 批量取出当前积攒的全部日志行
      const batch = logBuffer.splice(0, logBuffer.length);
      const content = batch.map((item) => item.line).join('\n') + '\n';
      try {
        await appendFile(file, content, 'utf8');
      } catch (e) {
        // 单次 IO 异常不抛，避免破坏进程
      }
      for (let i = 0; i < batch.length; i++) {
        batch[i].resolve();
      }
    }
  } catch (e) {
    // 目录创建或严重异常降级：清空当前积攒队列，释放等待的 Promise
    while (logBuffer.length > 0) {
      const item = logBuffer.shift();
      item?.resolve();
    }
  } finally {
    isFlushing = false;
    if (logBuffer.length > 0) {
      flushLogBuffer().catch(() => {});
    }
  }
}

/** 串行化写入（按需批量落盘，支持 Promise 返回供外部 await，无无界闭包链）。 */
function writeLog(level, tag, message, data) {
  const line = JSON.stringify({ t: ts(), level, tag, message, data: data ?? null });
  // 默认静默（仅落盘）；调试模式：环境变量 DSH_MESSAGE_RECALL_DEBUG=1 时输出控制台
  if (process.env.DSH_MESSAGE_RECALL_DEBUG === '1') {
    if (level === 'error') console.error('[dsh-message-recall]', tag, message, data ?? '');
    else if (level === 'warn') console.warn('[dsh-message-recall]', tag, message, data ?? '');
    else console.info('[dsh-message-recall]', tag, message, data ?? '');
  }

  // 容量上限防御：若积压超过 1000 条，丢弃最早日志，绝不把内存撑大
  if (logBuffer.length >= MAX_LOG_BUFFER) {
    const dropped = logBuffer.shift();
    dropped?.resolve();
  }

  return new Promise((resolve) => {
    logBuffer.push({ line, resolve });
    flushLogBuffer().catch(() => {});
  });
}

export const name = 'dsh-message-recall'
export const inject = ['webServer', 'sessions', 'settings', 'storageDomain']

/** 读取 JSON 请求体（带大小上限保护）。 */
function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // 超限：停止收集并继续消费 body（不 destroy——避免连接重置，handler 回 413）
        req.removeAllListeners('data');
        req.resume();
        reject(new Error('body-too-large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// ---------- 路由安全层（review S1-S3）：会话 id 白名单 / 同源校验 / JSON Content-Type ----------
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;
function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && SESSION_ID_PATTERN.test(value);
}
/** 同源校验：请求必须来自本 GUI 页面（Origin/Referer 与 Host 匹配）；无 Origin（同源/非浏览器）放行。 */
function requestFromSameOrigin(req) {
  try {
    const origin = req.headers?.origin || req.headers?.referer;
    if (!origin) return true;
    if (origin === 'null') return false; // sandbox iframe 拒绝
    const host = req.headers?.host;
    if (!host) return false;
    const u = new URL(origin);
    return u.host === host;
  } catch { return false; }
}
function isJsonContentType(req) {
  const ct = String(req.headers?.['content-type'] || '').toLowerCase();
  return ct === 'application/json' || ct.startsWith('application/json;');
}
/** 统一路由守卫：同源 + JSON Content-Type + 可选 sessionId 白名单。通过返回 true。 */
function guard(req, res, needSessionId, sessionId) {
  if (!requestFromSameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return false; }
  if (!isJsonContentType(req)) { sendJson(res, 415, { ok: false, error: 'unsupported-media-type' }); return false; }
  if (needSessionId && !validSessionId(sessionId)) { sendJson(res, 400, { ok: false, error: 'invalid-session-id' }); return false; }
  return true;
}

// ---------- 插件自更新（精简版：检测 + 手动更新；自动检测默认关） ----------
async function readOwnVersion() {
  try {
    const here = fileURLToPath(import.meta.url);
    const pkgPath = join(dirname(here), '..', 'package.json');
    const raw = await readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch (e) { return '0.0.0'; }
}
/** v2.4.0: 读取 dsh 宿主自身版本（从进程入口向上逐级找 @deepseek-ai/dsh 的 package.json）。 */
async function readDshVersion() {
  const candidates = [];
  // 路径1：进程入口向上逐级找
  try {
    let dir = path.dirname(process.argv[1] || "");
    for (let i = 0; i < 6; i++) { candidates.push(join(dir, "package.json")); const up = path.dirname(dir); if (up === dir) break; dir = up; }
  } catch (e) { /* ignore */ }
  // 路径2：Windows npm 全局前缀兜底（rc.1 实测 argv 上探失败时）
  try { const gp = process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "package.json") : null; if (gp) candidates.push(gp); } catch (e) { /* ignore */ }
  for (const c of candidates) {
    try {
      const p = JSON.parse(await readFile(c, "utf8"));
      if (p.name === "@deepseek-ai/dsh" && typeof p.version === "string") return p.version;
    } catch (e) { /* 下一个候选 */ }
  }
  return null;
}

async function fetchLatestVersion() {
  try {
    const resp = await fetch('https://registry.npmjs.org/dsh-message-recall/latest', {
      headers: { 'user-agent': 'dsh-message-recall-update-check', accept: 'application/json' }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data.version === 'string' ? data.version : null;
  } catch (e) { return null; }
}
/** 定位安装本插件的运行目录（遍历 $DSH_HOME/profiles 下各目录的 package.json）。 */
async function findPluginHomeDir() {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    const profilesRoot = join(home, 'profiles');
    const entries = await readdirSafe(profilesRoot);
    for (const name of entries) {
      const pkgPath = join(profilesRoot, name, 'package.json');
      try {
        const raw = await readFile(pkgPath, 'utf8');
        if (raw.includes('dsh-message-recall')) return join(profilesRoot, name);
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* ignore */ }
  return null;
}
async function readdirSafe(dir) {
  try { return await readdir(dir); } catch (e) { return []; }
}

/** 会话 id 白名单（版本关系 rowId/target/members 复用同一规则）。 */
function validRelationId(value) {
  return validSessionId(value);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * 版本关系（稳定侧栏条目）：登记一次编辑操作产生的会话家族。
 * 存放在 storageDomain 的 recall_relations 域中，随宿主持久化：
 * rowId 为稳定的侧栏条目标识（首个源会话 id），targetSessionId 为当前显示版本，
 * memberSessionIds 为明确登记的编辑版本（普通 fork 不自动合并）。
 * 旧数据缺少明确标记时不自动合并——只靠 parentId 推断会把普通 fork 也并入。
 */
const RELATIONS_DOMAIN = 'recall_relations';
const RELATIONS_TABLE = 'families';
function normalizeRelation(row) {
  if (!row || typeof row !== 'object') return null;
  if (!validRelationId(row.rowId)) return null;
  if (!validRelationId(row.targetSessionId)) return null;
  if (!Array.isArray(row.memberSessionIds) || row.memberSessionIds.length === 0) return null;
  const members = [];
  for (const id of row.memberSessionIds) {
    if (!validRelationId(id) || members.includes(id)) return null;
    members.push(id);
  }
  if (!members.includes(row.targetSessionId)) return null;
  return { rowId: row.rowId, targetSessionId: row.targetSessionId, memberSessionIds: members, updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now() };
}

/** 目标事件之前最近的 turn/end seq；无则 -1。 */
function findTurnEndBefore(events, targetIdx) {
  for (let i = targetIdx - 1; i >= 0; i--) {
    if (events[i].type === 'turn/end') return events[i].seq;
  }
  return -1;
}

/**
 * 折叠 agent 的 next-turn inbox 队列（与 dsh 的 inbox 投影同语义）。
 *
 * 入队写 `agent/inbox/spliced{target:'next-turn', start, removedCount?, inserted}`，
 * 被回合认领时写同 target 的移除记录。折叠后仍在队列里的就是"待处理"消息。
 *
 * @param events 完整事件序列。
 * @returns 仍待处理的消息数组。
 */
function foldPendingTurnInbox(events) {
  let queue = [];
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue;
    const splice = event.data;
    if (!splice || splice.target !== 'next-turn') continue;
    const inserted = Array.isArray(splice.inserted) ? splice.inserted : [];
    const removed = splice.removedCount ?? 0;
    const start = Number.isSafeInteger(splice.start) && splice.start >= 0 ? splice.start : 0;
    if (typeof queue.toSpliced === 'function') queue = queue.toSpliced(start, removed, ...inserted);
    else queue = [...queue.slice(0, start), ...inserted, ...queue.slice(start + removed)];
  }
  return queue;
}

/**
 * 撤回守卫：目标消息是否仍挂在待处理 inbox 里。
 *
 * 为什么必须拦：fork 以 turn/end 为边界，而 inbox 的入队记录在边界之后、认领记录之前，
 * 于是子会话的 seed 恰好包含"入队但未认领"的状态（inbox 投影会把它重建成待处理队列）。
 * 子会话开张后第一个回合发的是这条继承来的消息，用户编辑后的文本反而进不去—
 * 表现为"原消息被重发 + 编辑文本像插队"。
 *
 * 判定依据消息 id（认领前该消息还没有 user/message 事件，只能靠 id 匹配队列）。
 *
 * @param events 完整事件序列。
 * @param messageId 目标消息的消息 id；未知时传 null。
 * @returns 命中时返回该 id，否则 null。
 */
function pendingInboxMessageId(events, messageId) {
  if (typeof messageId !== 'string' || messageId.length === 0) return null;
  const queue = foldPendingTurnInbox(events);
  return queue.some((m) => m && m.id === messageId) ? messageId : null;
}

/**
 * 这条消息是否已经作为 user/message 进入会话记录（被回合认领过）。
 *
 * @param events 完整事件序列。
 * @param messageId 目标消息的消息 id。
 * @returns 已进入记录返回 true。
 */
function claimedInLog(events, messageId) {
  if (typeof messageId !== 'string' || messageId.length === 0) return false;
  return events.some((e) => e.type === 'user/message' && e.data && e.data.id === messageId);
}

/**
 * 目标消息所在回合是否仍在进行（最后一条 turn/end 之后仍有事件）。
 * 未闭合回合内撤回会把尚未落盘的输入截断掉，故一并拒绝。
 *
 * @param events 完整事件序列。
 * @returns 是否处于未闭合回合。
 */
function inOpenTurn(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn/end') return false;
    if (events[i].type === 'turn/start') return true;
  }
  return false;
}

/**
 * 撤回边界解析：返回目标消息之前最后闭合回合（turn/end）的事件 seq。
 * fork 由 client 端官方 RPC（ctx.sessions.fork）执行——child 才能进入会话列表。
 * 无闭合回合（未结束回合内）→ turn-open。
 */
function resolveBoundary(ctx, sessionId, targetSeq, targetMessageId) {
  const session = ctx.sessions.get(sessionId);
  if (!session) return { code: 'session-not-found', status: 404 };
  // v2.4.0: dsh 0.1.2 起 Session.events 移除，改用 snapshotEvents(fromSeq, toSeqExclusive)；
  // rc.2 旧宿主仍走 session.events。事件对象两代同构（seq/type 字段）。
  let events;
  if (typeof session.snapshotEvents === "function") {
    try { events = session.snapshotEvents(); } catch (e) { return { code: 'internal', status: 500, message: String(e?.message ?? e) }; }
  } else {
    events = session.events;
  }
  if (!Array.isArray(events)) return { code: 'internal', status: 500, message: 'events unavailable' };

  // 守卫 1（方向 2 核心，必须先于目标定位）：目标消息仍挂在待处理 inbox 时拒绝撤回。
  // 认领之前该消息还没有 user/message 事件（只有 inbox 入队记录），所以按消息 id 匹配队列，
  // 不能等 targetIdx 找到再做——那时它已经被认领，窗口就错过了。
  // 放行的前提：它已经作为 user/message 进入记录，说明回合已经跑过。
  if (pendingInboxMessageId(events, targetMessageId) !== null && !claimedInLog(events, targetMessageId)) {
    return {
      code: 'message-pending',
      status: 409,
      message: '该消息仍排在待处理队列里（尚未进入回合记录），此时撤回会把原消息带进新会话重发；请等这一回合处理完再撤回',
    };
  }

  const targetIdx = events.findIndex((e) => e.seq === targetSeq);
  if (targetIdx === -1) {
    return { code: 'invalid-target', status: 404, message: JSON.stringify({ targetSeq, eventsLen: events.length }) };
  }
  const boundary = findTurnEndBefore(events, targetIdx);
  if (boundary === -1) {
    // review M10：先判定目标之后是否有 turn/end（回合是否已闭合）——
    // 已闭合但无前置边界（如首回合消息）→ no-boundary（诊断准确，不是 turn-open）
    let hasLaterClose = false;
    for (let i = targetIdx + 1; i < events.length; i++) {
      if (events[i].type === 'turn/end') { hasLaterClose = true; break; }
    }
    // 守卫 2：目标在未闭合的回合内 → 一律按 turn-open 处理。
    // 此前只看"是否有前置边界"，会把跨回合场景误判成 no-boundary，而客户端对 no-boundary
    // 走 resetConversation（丢弃整个会话），对 turn-open 只提示等待——后者才是正确的。
    if (!hasLaterClose || inOpenTurn(events)) {
      return { code: 'turn-open', status: 409, message: '该消息所在回合尚未结束，无法截断；请等待回复完成（回合结束）后再撤回' };
    }
    return { code: 'no-boundary', status: 409, message: '该消息之前没有可截断的闭合回合边界（首条消息或跨回合场景）' };
  }
  // 守卫 2（续）：有前置边界但整个会话仍处于未闭合回合 → 同样拒绝。
  if (inOpenTurn(events)) {
    return { code: 'turn-open', status: 409, message: '当前回合尚未结束，无法截断；请等待回复完成（回合结束）后再撤回' };
  }
  return { boundary };
}

/** 仅测试用：暴露内部纯函数（不参与运行时行为）。 */
export const __test = { findTurnEndBefore, resolveBoundary, pendingInboxMessageId, inOpenTurn, writeLog, flushLogBuffer, getLogBuffer: () => logBuffer };

export function apply(ctx) {
  writeLog('info', 'host', 'apply: 路由注册开始');
  try {
    if (ctx.settings && typeof ctx.settings.register === 'function') {
      const dummySchema = (x) => x ?? {};
      dummySchema.toJSON = () => ({ type: 'object' });
      ctx.settings.register(settingsNamespace('dsh-message-recall'), dummySchema);
      writeLog('info', 'host', 'settings namespace 已注册（插件配置卡片可用）');
    }
  } catch (err) {
    writeLog('warn', 'host', 'settings namespace 注册失败（不影响核心功能）', { err: String(err?.message ?? err) });
  }
  // 版本关系域：随 storageDomain 持久化。一个家族一条记录（rowId → { target, members }）。
  // 记录为纯 JSON，读写边界由 normalizeRelation 校验；域不可用时以降级模式运行（仅内存）。
  let relationsTable = null;
  const relationsMemory = new Map();
  try {
    if (ctx.storageDomain && typeof ctx.storageDomain.open === 'function') {
      ctx.storageDomain.open({
        name: 'recall_relations',
        version: 1,
        tables: { families: { valueSchema: { parse: (v) => v } } },
      }).then(
        (domain) => {
          try {
            relationsTable = domain.table('families');
            writeLog('info', 'host', '版本关系域已打开（recall_relations）');
          } catch (e) {
            writeLog('warn', 'host', '版本关系表解析失败（以降级模式运行）', { err: String(e?.message ?? e) });
          }
        },
        (e) => { writeLog('warn', 'host', '版本关系域打开失败（以降级模式运行）', { err: String(e?.message ?? e) }); },
      );
    }
  } catch (e) {
    writeLog('warn', 'host', '版本关系域初始化异常（以降级模式运行）', { err: String(e?.message ?? e) });
  }
  const disposers = [];
  // client 日志上报路由（统一甄别，落盘 $DSH_HOME/dsh-message-recall.log）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/bubble/log',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        if (!guard(req, res, false)) return;
        const body = await readJsonBody(req, 256 * 1024);
        await writeLog(
          typeof body.level === 'string' ? body.level : 'info',
          typeof body.tag === 'string' ? body.tag : 'client',
          typeof body.message === 'string' ? body.message : '',
          body.data
        );
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    }
  }));
  // 草稿自动备份（覆盖式）：写 $DSH_HOME/dsh-message-recall/backups/<sessionId>.json
  function backupPath(sessionId) {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    return join(home, 'dsh-message-recall', 'backups', sessionId + '.json');
  }
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/bubble/backup',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false }); return; }
        const body = await readJsonBody(req, 512 * 1024);
        const { sessionId, pending } = body;
        if (!guard(req, res, true, sessionId) || !pending || typeof pending !== 'object') { sendJson(res, 400, { ok: false, error: 'invalid-request' }); return; }
        const file = backupPath(sessionId);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(pending, null, 2), 'utf8'); // 覆盖式
        sendJson(res, 200, { ok: true });
      } catch (err) {
        writeLog('warn', 'backup', '备份写入失败', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    }
  }));
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/bubble/backup/read',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false }); return; }
        const body = await readJsonBody(req);
        const { sessionId } = body;
        if (!guard(req, res, true, sessionId)) { return; }
        try {
          const raw = await readFile(backupPath(sessionId), 'utf8');
          const pending = JSON.parse(raw);
          sendJson(res, 200, { ok: true, pending });
        } catch (e) {
          sendJson(res, 200, { ok: true, pending: null }); // 无备份
        }
      } catch (err) {
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    }
  }));
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/bubble/backup/delete',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false }); return; }
        const body = await readJsonBody(req);
        const { sessionId } = body;
        if (!guard(req, res, true, sessionId)) { return; }
        await rm(backupPath(sessionId), { force: true });
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    }
  }));
  // 版本关系读写：GET /bubble/relations（全量，供侧栏投影扩展消费）；
  // POST /bubble/relations/register { rowId, targetSessionId, memberSessionIds }（登记/更新一个家族）；
  // POST /bubble/relations/retarget { rowId, targetSessionId }（翻页/切换目标，不新增成员）。
  function readAllRelations() {
    const out = [];
    try {
      if (relationsTable) {
        for (const [, value] of relationsTable.entries()) {
          const row = normalizeRelation(value);
          if (row) out.push(row);
        }
      } else {
        for (const value of relationsMemory.values()) {
          const row = normalizeRelation(value);
          if (row) out.push(row);
        }
      }
    } catch (e) { /* 读失败按空处理 */ }
    return out;
  }
  async function writeRelation(row) {
    const normalized = normalizeRelation(row);
    if (!normalized) throw new Error('invalid-relation');
    if (relationsTable) await relationsTable.put(normalized.rowId, normalized);
    else relationsMemory.set(normalized.rowId, normalized);
    return normalized;
  }
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/bubble/relations',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        if (!guard(req, res, false)) return;
        await readJsonBody(req, 16 * 1024);
        sendJson(res, 200, { ok: true, relations: readAllRelations() });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    }
  }));
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/bubble/relations/register',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        const body = await readJsonBody(req, 64 * 1024);
        if (!guard(req, res, false)) return;
        const saved = await writeRelation(body);
        writeLog('info', 'relations', '版本关系已登记', { rowId: saved.rowId, target: saved.targetSessionId, members: saved.memberSessionIds.length });
        sendJson(res, 200, { ok: true, relation: saved });
      } catch (err) {
        const message = String(err?.message ?? err);
        if (message === 'invalid-relation') { sendJson(res, 400, { ok: false, error: 'invalid-relation' }); return; }
        writeLog('warn', 'relations', '版本关系登记失败', { err: message });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    }
  }));
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/bubble/relations/retarget',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        const body = await readJsonBody(req, 16 * 1024);
        if (!guard(req, res, false)) return;
        const { rowId, targetSessionId } = body;
        if (typeof rowId !== 'string' || !validRelationId(targetSessionId)) {
          sendJson(res, 400, { ok: false, error: 'invalid-relation' });
          return;
        }
        const existing = readAllRelations().find((row) => row.rowId === rowId);
        if (!existing || !existing.memberSessionIds.includes(targetSessionId)) {
          sendJson(res, 404, { ok: false, error: 'relation-not-found' });
          return;
        }
        const saved = await writeRelation({ ...existing, targetSessionId, updatedAt: Date.now() });
        writeLog('info', 'relations', '版本目标已切换', { rowId, target: targetSessionId });
        sendJson(res, 200, { ok: true, relation: saved });
      } catch (err) {
        writeLog('warn', 'relations', '版本目标切换失败', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    }
  }));
  // 版本翻页器：恢复归档会话（幂等——未归档时为 no-op）。官方无 unarchive API，
  // 通过 workspaceRegistry 实例的排队操作把 sessionId 从归档集合移除。
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/bubble/unarchive',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        const body = await readJsonBody(req);
        const { sessionId } = body;
        if (!guard(req, res, true, sessionId)) { return; }
        let registry = null;
        try { registry = ctx.get('workspaceRegistry'); } catch (e) { /* service absent */ }
        if (!registry || typeof registry.enqueueOperation !== 'function' || typeof registry.requireState !== 'function' || typeof registry.setState !== 'function') {
          writeLog('warn', 'host', 'unarchive: workspaceRegistry 不可用');
          sendJson(res, 200, { ok: false, error: 'registry-unavailable' });
          return;
        }
        // review S3：存在性校验（与官方 archiveSession 的 sessionKnown 对齐）
        if (typeof registry.sessionKnown === 'function') {
          const known = await registry.sessionKnown(sessionId);
          if (!known) { sendJson(res, 404, { ok: false, error: 'session-not-found' }); return; }
        }
        const restored = await registry.enqueueOperation(async () => {
          const state = registry.requireState();
          const next = state.archivedSessionIds.filter((id) => id !== sessionId);
          if (next.length === state.archivedSessionIds.length) return false; // 未归档
          await registry.setState({ ...state, archivedSessionIds: next });
          return true;
        });
        writeLog('info', 'host', 'unarchive 完成', { sessionId, restored });
        sendJson(res, 200, { ok: true, restored });
      } catch (err) {
        writeLog('warn', 'host', 'unarchive 失败', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    }
  }));
    // 撤回路由
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/bubble/recall',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        const body = await readJsonBody(req);
        const { sessionId, targetSeq, targetMessageId } = body;
        if (!guard(req, res, true, sessionId) || typeof targetSeq !== 'number' || !Number.isFinite(targetSeq)) {
          sendJson(res, 400, { ok: false, error: 'invalid-request' });
          return;
        }
        // targetMessageId 是可选增强：带它才能在消息被认领之前识别"仍排在待处理队列"的情形。
        // 缺失时退化为不校验该守卫（旧客户端仍可用，只是少了这层保护）。
        const messageId = typeof targetMessageId === 'string' && targetMessageId.length > 0 ? targetMessageId : null;
        writeLog('info', 'recall', '收到撤回边界请求', { sessionId, targetSeq, hasMessageId: messageId !== null });
        const result = resolveBoundary(ctx, sessionId, targetSeq, messageId);
        if (result.code) {
          writeLog('warn', 'recall', '撤回被拒绝: ' + result.code, { sessionId, targetSeq, message: result.message });
          sendJson(res, result.status, { ok: false, error: result.code, message: result.message });
          return;
        }
        // fork 由 client 官方 RPC 执行（child 才能进会话列表并可打开）
        writeLog('info', 'recall', '边界就绪', { sessionId, targetSeq, boundary: result.boundary });
        sendJson(res, 200, { ok: true, boundary: result.boundary });
      } catch (err) {
        writeLog('error', 'recall', '/bubble/recall 异常', { message: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    }
  }));
  // 插件自更新：检查 npm 最新版本（只读）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/bubble/check-update',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        if (!guard(req, res, false)) return;
        const body = await readJsonBody(req, 16 * 1024);
        const current = await readOwnVersion();
        const latest = await fetchLatestVersion();
        const dshVersion = await readDshVersion();
        writeLog('info', 'host', 'check-update', { current, latest, dshVersion });
        sendJson(res, 200, { ok: true, current, latest, dshVersion });
      } catch (err) {
        writeLog('warn', 'host', 'check-update 失败', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    }
  }));
  // 插件自更新：执行 pnpm up（写操作——client 端必须用户显式确认后调用）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/bubble/update-plugin',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        if (!guard(req, res, false)) return;
        const body = await readJsonBody(req, 16 * 1024);
        const profileDir = await findPluginHomeDir();
        if (!profileDir) { sendJson(res, 200, { ok: false, error: 'profile-not-found' }); return; }
        writeLog('info', 'host', 'update-plugin 开始', { profileDir });
        const output = await new Promise((resolve) => {
          execFile('pnpm', ['up', 'dsh-message-recall'], { cwd: profileDir, timeout: 90000, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ err: err ? String(err.message || err) : null, stdout: String(stdout || '').slice(-1500), stderr: String(stderr || '').slice(-1500) });
          });
        });
        const ok = !output.err || output.stdout.includes('up to date') || output.stdout.includes('Done');
        writeLog('info', 'host', 'update-plugin 结果', { ok, err: output.err, outTail: output.stdout.slice(-200) });
        sendJson(res, 200, { ok, output: output.stdout.slice(-800) });
      } catch (err) {
        writeLog('warn', 'host', 'update-plugin 失败', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    }
  }));
  writeLog('info', 'host', 'apply: 路由注册完成');
  return () => {
    for (const d of disposers) { try { d(); } catch (e) { /* ignore */ } }
    writeLog('info', 'host', 'apply: 已卸载');
  };
}
