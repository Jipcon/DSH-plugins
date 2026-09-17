/**
 * dsh-archived-cleaner 删除广播回归测试（侧栏僵尸行）。
 *
 * 回归场景：删除成功后若不通知客户端，各客户端 sessions list store 里还留着
 * 该行；unarchive 又把它从归档集摘掉，该行随即以"未分组"在侧栏复活，点击即
 * session/not-found。修复要求 deleteOneArchived 在 ok:true 前必经
 * ctx.emit('api-session/removed', sessionId)（官方转发事件，各客户端
 * handleSessionRemoved 幂等丢行），而拒绝/失败路径一律不 emit。
 *
 * 用 $DSH_HOME 指向临时空目录：stat 走 miss 兜底（readdir 为空），不断言
 * fileDeleted，只断言注册表清理与广播语义，不碰真实会话数据。
 *
 * 用法：node tests/delete-notify.test.mjs（断言失败时非零退出）
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test } from '../src/index.js';

const { deleteOneArchived } = __test;

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'archived-cleaner-test-'));

const ID = 'session-898a52d1-94c9-4b97-bd55-d9484a565623';

/** 构造假 host ctx：get 按表返回服务，属性访问抛错（无 inject 语义），emit 留痕。 */
function fakeCtx({ archived = [ID], agent = undefined } = {}) {
  const emitted = [];
  const remaining = [...archived];
  const services = {
    workspaceRegistry: {
      get archivedSessionIds() { return [...remaining]; },
      list: () => [],
      unarchiveSession: async (id) => {
        const at = remaining.indexOf(id);
        if (at !== -1) remaining.splice(at, 1);
      },
    },
    sessions: { get: () => undefined },
    agents: { get: () => (agent === undefined ? undefined : agent) },
    sessionPersistence: { stat: async () => undefined },
    storageDomain: undefined,
  };
  const target = {
    get: (name) => services[name],
    emit: (event, payload) => { emitted.push([event, payload]); },
  };
  const ctx = new Proxy(target, {
    get(t, prop) {
      if (prop === 'get' || prop === 'emit') return t[prop];
      if (typeof prop === 'string' && !(prop in t)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return t[prop];
    },
  });
  return { ctx, emitted, remaining };
}

let passed = 0;
const awaited = [];

// 1. 删除成功 → 归档集摘掉 + 广播移除（核心回归断言）
awaited.push((async () => {
  const { ctx, emitted, remaining } = fakeCtx();
  const r = await deleteOneArchived(ctx, ID);
  assert.equal(r.ok, true, `expected ok:true, got ${JSON.stringify(r)}`);
  assert.ok(!remaining.includes(ID), 'archived set should drop the id');
  assert.ok(
    emitted.some(([e, id]) => e === 'api-session/removed' && id === ID),
    `expected api-session/removed for ${ID}, got ${JSON.stringify(emitted)}`,
  );
  passed++;
  console.log('ok - 删除成功时摘归档集并广播 api-session/removed');
})());

// 2. live 会话拒绝删除 → 不广播（仍藏在归档里，不会现形）
awaited.push((async () => {
  const { ctx, emitted } = fakeCtx({ agent: { status: 'running' } });
  const r = await deleteOneArchived(ctx, ID);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'live-session');
  assert.equal(emitted.length, 0, 'refused delete must not emit');
  passed++;
  console.log('ok - live 会话拒绝删除且不广播');
})());

// 3. 非归档 id 拒绝 → 不广播
awaited.push((async () => {
  const { ctx, emitted } = fakeCtx({ archived: [] });
  const r = await deleteOneArchived(ctx, ID);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not-archived');
  assert.equal(emitted.length, 0, 'rejected delete must not emit');
  passed++;
  console.log('ok - 非归档 id 拒绝且不广播');
})());

await Promise.all(awaited);
console.log(`\n${passed} passed`);
