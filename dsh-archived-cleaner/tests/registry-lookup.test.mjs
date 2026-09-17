/**
 * dsh-archived-cleaner 服务定位回归测试（H2：异常屏蔽）。
 *
 * 回归场景：旧进程的 inject 仍只有 webServer 时，`ctx.workspaceRegistry` 这类
 * 属性访问会直接抛 `cannot get property ... without inject`（见 vendor/cordis
 * reflect.ts）。旧 getRegistry 把属性访问与 ctx.get 包在同一个 try 里，第一行
 * 一抛就跳过本可成功的 ctx.get 兜底，于是 list/delete 全报 registry-unavailable。
 *
 * 本测试用 Proxy 模拟“无 inject 的 Cordis 上下文”：属性访问一律抛错，
 * 只有 ctx.get(name) 能拿到服务。新实现必须经由 ctx.get 拿到服务；
 * 旧实现（单 try）在该上下文下返回 null。
 *
 * 用法：node tests/registry-lookup.test.mjs（断言失败时非零退出）
 */
import { strict as assert } from 'node:assert';
import { __test } from '../src/index.js';

const { getRegistry, getSessions, getAgents, getPersistence, getStorageDomain } = __test;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

/**
 * 构造“无 inject”的假 ctx：与 Cordis 一致——属性访问抛 without inject，
 * ctx.get() 则不需要 inject，直接返回服务或 undefined。
 */
function cordisCtxWithoutInject(services) {
  const target = {
    get(name) {
      return services[name];
    },
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'get') return t.get;
      if (prop === 'then' || prop === Symbol.toPrimitive) return undefined;
      if (typeof prop === 'string' && !(prop in t)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return t[prop];
    },
  });
}

const fakeRegistry = { archivedSessionIds: ['session-abc'] };
const fakeSessions = { get: () => undefined };
const fakeAgents = { get: () => undefined };
const fakePersistence = { stat: async () => undefined };
const fakeStorage = { open: async () => null };

check('无 inject 时 getRegistry 经 ctx.get 拿到服务（不报 unavailable）', () => {
  const ctx = cordisCtxWithoutInject({ workspaceRegistry: fakeRegistry });
  assert.equal(getRegistry(ctx), fakeRegistry);
});

check('无 inject 时 getSessions/getAgents/getPersistence/getStorageDomain 均经 ctx.get 拿到', () => {
  const ctx = cordisCtxWithoutInject({
    sessions: fakeSessions,
    agents: fakeAgents,
    sessionPersistence: fakePersistence,
    storageDomain: fakeStorage,
  });
  assert.equal(getSessions(ctx), fakeSessions);
  assert.equal(getAgents(ctx), fakeAgents);
  assert.equal(getPersistence(ctx), fakePersistence);
  assert.equal(getStorageDomain(ctx), fakeStorage);
});

check('服务真缺失时返回 null（调用方走 503 降级）', () => {
  const ctx = cordisCtxWithoutInject({});
  assert.equal(getRegistry(ctx), null);
  assert.equal(getSessions(ctx), null);
  assert.equal(getAgents(ctx), null);
  assert.equal(getPersistence(ctx), null);
  assert.equal(getStorageDomain(ctx), null);
});

check('有 inject 的普通 ctx（属性直接挂载）同样可用', () => {
  const ctx = {
    get: () => undefined,
    workspaceRegistry: fakeRegistry,
    sessions: fakeSessions,
    agents: fakeAgents,
    sessionPersistence: fakePersistence,
    storageDomain: fakeStorage,
  };
  assert.equal(getRegistry(ctx), fakeRegistry);
  assert.equal(getSessions(ctx), fakeSessions);
  assert.equal(getAgents(ctx), fakeAgents);
  assert.equal(getPersistence(ctx), fakePersistence);
  assert.equal(getStorageDomain(ctx), fakeStorage);
});

console.log(`\n${passed} passed`);
