/**
 * dsh-codex-auth 本地 seam + 桥接的端到端测试（不启动 DSH）。
 *
 * 复刻生产组合的关键事实：`ctx` 上没有 `authorization` 服务（dsh-base 系组合
 * 没挂 dsh-authorization）。验证：
 *  1. apply 照常跑完（不再因 inject 缺服务而 pending）并就地 provide 本地实现；
 *  2. 组合自带 authorization 时直接用自带的，不重复提供；
 *  3. llm-pi-ai 式 `ctx.inject(['authorization'], …)` 注册流后，
 *     /start→/poll→/answer→authorized 全链路跑通；
 *  4. 无提交的 flow 被拒 NOT_COMMITTED；重复 begin 被拒 ALREADY_IN_FLIGHT；
 *     无 flow 的 key 被拒 NO_FLOW；取消结算为 cancelled。
 *
 * 用法：node tests/port.mjs
 */
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pluginDir = dirname(root);
const host = await import(pathToFileURL(join(pluginDir, 'lib/index.js')).href);
const { AuthorizationService } = await import(pathToFileURL(join(pluginDir, 'lib/authorization.js')).href);

let failures = 0;
function check(cond, message) {
  if (cond) console.log(`ok - ${message}`);
  else { failures++; console.error(`FAIL - ${message}`); }
}
async function expectCode(promise, code, message) {
  try {
    await promise;
    check(false, `${message}（期望抛 ${code}，实际成功）`);
  } catch (err) {
    check(err?.code === code, `${message}（code=${err?.code}）`);
  }
}

/** 伪 Cordis ctx：provide/get/inject/on/emit/effect 的最小语义。 */
function fakeCtx() {
  const services = {};
  const injectWaiters = [];
  const handlers = {};
  const ctx = {
    services,
    provideCalls: 0,
    provide(name, value) {
      if (Object.hasOwn(services, name)) throw new Error(`duplicate service "${name}"`);
      ctx.provideCalls++;
      services[name] = value;
      ctx[name] = value;
      for (const w of injectWaiters.splice(0)) {
        if (w.names.every((n) => Object.hasOwn(services, n))) w.cb(ctx);
        else injectWaiters.push(w);
      }
      return () => { delete services[name]; delete ctx[name]; };
    },
    get(name) { return services[name]; },
    inject(names, cb) {
      if (names.every((n) => Object.hasOwn(services, n))) cb(ctx);
      else injectWaiters.push({ names, cb });
    },
    on(event, cb) {
      (handlers[event] ??= []).push(cb);
      return () => { handlers[event] = (handlers[event] || []).filter((f) => f !== cb); };
    },
    emit(event, ...args) {
      for (const f of [...(handlers[event] || [])]) f(...args);
    },
    effect(fn) {
      const it = fn();
      const cleanups = [];
      let r = it.next();
      while (!r.done) {
        if (typeof r.value === 'function') cleanups.push(r.value);
        r = it.next();
      }
      return () => { for (const f of cleanups) { try { f(); } catch { /* ignore */ } } };
    },
    logger: { warn() {}, debug() {}, info() {} },
    fire(event, ...args) {
      for (const f of [...(handlers[event] || [])]) f(...args);
    },
  };
  return ctx;
}

function fakeCredentials(ctx) {
  const records = new Map();
  return {
    async describeRecord(key) {
      const r = records.get(key);
      return r ? { configured: true, kind: r.kind, writable: true } : { configured: false, writable: true };
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key));
      if (next === undefined) records.delete(key);
      else records.set(key, next);
      ctx.fire('credentials/record-updated', key);
      return records.get(key);
    },
    async deleteRecord(key) { records.delete(key); },
  };
}

function fakeWebServer() {
  const routes = new Map();
  return {
    routes,
    register(def) { routes.set(def.path, def.handler); return () => { routes.delete(def.path); }; },
  };
}

function call(routes, path, body) {
  return new Promise((resolve, reject) => {
    const chunks = [Buffer.from(JSON.stringify(body ?? {}))];
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      on(ev, fn) {
        if (ev === 'data') setImmediate(() => fn(chunks[0]));
        if (ev === 'end') setImmediate(fn);
        return req;
      },
      removeAllListeners() {},
      resume() {},
    };
    const res = {
      writeHead() {},
      end(b) { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } },
    };
    routes.get(path)(req, res);
  });
}

const surface = () => ({ notify() {}, prompt: async () => 'x' });
const CODEX = 'llm-pi-ai/openai-codex';

// ---------- 1. 本地 seam 基础语义 ----------
{
  const ctx = fakeCtx();
  ctx.credentials = fakeCredentials(ctx);
  const auth = new AuthorizationService(ctx);
  await expectCode(auth.begin({ key: CODEX, interaction: surface() }), 'NO_FLOW', '无 flow 时 NO_FLOW');
  const dispose = auth.registerFlow({
    key: CODEX,
    label: 'OpenAI Codex',
    methods: [{ id: 'oauth', label: 'x' }],
    async run(session) {
      session.notify({ message: 'hi' });
      await session.prompt({ kind: 'text', message: 'q' });
      await ctx.credentials.modifyRecord(CODEX, async () => ({ kind: 'grant', payload: {} }));
    },
  });
  check(auth.list().length === 1 && auth.describe(CODEX)?.label === 'OpenAI Codex', 'list/describe 可见已登记流');
  try {
    auth.registerFlow({
      key: CODEX, label: 'dup', methods: [{ id: 'oauth', label: 'x' }],
      async run() {},
    });
    check(false, '重复登记应抛 DUPLICATE_FLOW');
  } catch (err) {
    check(err?.code === 'DUPLICATE_FLOW', '重复登记 DUPLICATE_FLOW');
  }
  await expectCode(auth.begin({ key: CODEX, method: 'nope', interaction: surface() }), 'UNKNOWN_METHOD', '未知方法 UNKNOWN_METHOD');
  const first = auth.begin({ key: CODEX, interaction: { notify() {}, prompt: () => new Promise(() => {}) } });
  await expectCode(auth.begin({ key: CODEX, interaction: surface() }), 'ALREADY_IN_FLIGHT', '并发 begin 被拒');
  auth.cancel(CODEX);
  check((await first).status === 'cancelled', 'cancel 后结算为 cancelled');
  check((await auth.begin({ key: CODEX, interaction: surface() })).status === 'authorized', '提交后 authorized');
  let settled = null;
  ctx.on('authorization/settled', (key, st) => { settled = [key, st]; });
  await auth.begin({ key: CODEX, interaction: surface() });
  check(settled?.[0] === CODEX && settled?.[1] === 'authorized', 'settled 事件带正确终态');
  dispose();
  check(auth.list().length === 0, '注销后流消失');
}

// ---------- 2. 无提交的 flow 被拒 ----------
{
  const ctx = fakeCtx();
  ctx.credentials = fakeCredentials(ctx);
  const auth = new AuthorizationService(ctx);
  auth.registerFlow({
    key: CODEX, label: 'x', methods: [{ id: 'oauth', label: 'x' }],
    async run() { /* 故意不提交 */ },
  });
  await expectCode(auth.begin({ key: CODEX, interaction: surface() }), 'NOT_COMMITTED', '无提交 NOT_COMMITTED');
}

// ---------- 3. 插件在缺缝组合里自补 + 全链路 ----------
{
  const ctx = fakeCtx();
  ctx.credentials = fakeCredentials(ctx);
  const webServer = fakeWebServer();
  ctx.webServer = webServer;
  const dispose = host.apply(ctx);

  // llm-pi-ai 式：缝出现后才注册 Codex 流（先挂等待器，/status 触发补缝时同步点火）。
  ctx.inject(['authorization'], (c) => {
    c.authorization.registerFlow({
      key: CODEX,
      label: 'OpenAI Codex',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      async run(session) {
        // 真实形状：方法选择器的 kind 是 'text'（不是 'select'），但带 options，
        // 桥接必须按 loginMethod 代答，绝不能把它暴露成待答 prompt。
        const picked = await session.prompt({
          kind: 'text',
          message: 'Select OpenAI Codex login method:',
          options: [{ id: 'browser', label: 'B' }, { id: 'device_code', label: 'D' }],
        });
        if (picked !== 'device_code') throw new Error('picker not auto-answered, got ' + picked);
        session.notify({ message: 'go', verificationUri: 'https://example/verify', userCode: 'ABCD-1234' });
        const ans = await session.prompt({ type: 'text', message: 'paste code' });
        if (ans !== 'SECRET') throw new Error('bad code');
        await ctx.credentials.modifyRecord(CODEX, async () => ({ kind: 'grant', payload: { type: 'oauth' } }));
      },
    });
  });

  // 补缝是惰性的：第一次实际用到 authorization 时才 provide（避免启动期副作用）。
  const s0 = await call(webServer.routes, '/codex-auth/status', {});
  check(ctx.get('authorization') instanceof AuthorizationService, '缺缝时插件就地提供了本地实现');

  // 稍等一个 tick 让 inject 回调跑完（本 fake 是同步的，此处直接继续）。
  check(s0.ok && s0.flow?.key === CODEX, 'status 可见 Codex 流');
  check(s0.record?.configured === false, '初始未登录');
  const st = await call(webServer.routes, '/codex-auth/start', { loginMethod: 'device_code' });
  check(st.ok && st.attemptId === 1, 'start 接受 device_code');
  await new Promise((r) => setTimeout(r, 50));
  const p1 = await call(webServer.routes, '/codex-auth/poll', {});
  check(p1.active?.status === 'running', 'poll 显示 running');
  check(p1.notices?.some((n) => n.userCode === 'ABCD-1234'), 'poll 下发 device 码');
  check(p1.pending?.message === 'paste code', 'poll 暴露待答 prompt');
  const bad = await call(webServer.routes, '/codex-auth/answer', { text: '' });
  check(bad.ok === false && bad.error === 'empty-answer', '空回答被拒');
  check((await call(webServer.routes, '/codex-auth/answer', { text: 'SECRET' })).ok === true, '回填授权码成功');
  await new Promise((r) => setTimeout(r, 50));
  const p2 = await call(webServer.routes, '/codex-auth/poll', {});
  check(p2.active?.status === 'authorized', '终态 authorized');
  const s1 = await call(webServer.routes, '/codex-auth/status', {});
  check(s1.record?.configured === true, '登录后记录已配置');
  check((await call(webServer.routes, '/codex-auth/signout', {})).ok === true, '退出登录成功');
  const s2 = await call(webServer.routes, '/codex-auth/status', {});
  check(s2.record?.configured === false, '退出后记录已清除');
  dispose();
}

// ---------- 4. 组合自带 seam 时不重复提供 ----------
{
  const ctx = fakeCtx();
  ctx.credentials = fakeCredentials(ctx);
  const webServer = fakeWebServer();
  ctx.webServer = webServer;
  const native = new AuthorizationService(ctx);
  ctx.provide('authorization', native);
  const before = ctx.provideCalls;
  const dispose = host.apply(ctx);
  check(ctx.provideCalls === before, '自带 seam 时不重复提供');
  check(ctx.get('authorization') === native, '使用组合自带的 seam');
  dispose();
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
