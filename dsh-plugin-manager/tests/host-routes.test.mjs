/**
 * dsh-plugin-manager 宿主路由回归测试。
 *
 * 用临时 $DSH_HOME + 最小 profile 驱动真实 apply(ctx) 注册的两个路由
 * （mock webServer + mock req/res，不开真实端口），锁定：
 *  - list：200 + 三分法清单；
 *  - uninstall：缺 confirm → 400；成功 → 200 且 manifest/文件变更；
 *    重复卸载 → 404；卸载自身 → 400；非法包名 → 400；
 *  - 守卫：GET → 405；非 JSON → 415；
 *  - disposer 释放路由。
 *
 * 用法：node tests/host-routes.test.mjs（断言失败时非零退出）
 */
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

// —— 临时 profile：web 含 SELF + 受害包 ——
const home = mkdtempSync(join(tmpdir(), 'dsh-pm-routes-'));
process.env.DSH_HOME = home;
const profileDir = join(home, 'profiles', 'web');
mkdirSync(profileDir, { recursive: true });
writeJson(join(profileDir, 'package.json'), {
  name: 'dsh-profile-web',
  private: true,
  dependencies: { 'dsh-plugin-manager': '1.0.0', 'victim-plugin': '9.9.9' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'victim-plugin', 'dsh-plugin-manager'] } },
});
for (const [pkg, manifest] of [
  ['victim-plugin', { name: 'victim-plugin', version: '9.9.9', dsh: { bundle: { patch: './cordis.patch.yml' } } }],
  ['dsh-plugin-manager', { name: 'dsh-plugin-manager', version: '1.0.0' }],
]) {
  const dir = join(profileDir, 'node_modules', pkg);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'package.json'), manifest);
}

const { apply } = await import('../src/index.js');

const routes = new Map();
const ctx = {
  webServer: {
    register(entry) {
      routes.set(entry.path, entry);
      return () => { routes.delete(entry.path); };
    },
  },
};

let passed = 0;
const queue = [];
function check(name, fn) {
  queue.push([name, fn]);
}

function mockReq({ method = 'POST', body = {}, rawBody = null, contentType = 'application/json' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { host: '127.0.0.1:1', 'content-type': contentType };
  process.nextTick(() => {
    const raw = rawBody !== null ? rawBody : JSON.stringify(body);
    if (raw.length > 0) req.emit('data', Buffer.from(raw));
    req.emit('end');
  });
  return req;
}

function mockRes() {
  let settle;
  const done = new Promise((r) => { settle = r; });
  const res = {
    status: null,
    headers: null,
    payload: null,
    writeHead(s, h) { this.status = s; this.headers = h; },
    end(b) {
      try { this.payload = JSON.parse(String(b)); } catch { this.payload = String(b); }
      settle();
    },
  };
  return { res, done };
}

async function call(path, opts) {
  const entry = routes.get(path);
  assert.ok(entry, `路由已注册: ${path}`);
  const req = mockReq(opts);
  const { res, done } = mockRes();
  await entry.handler(req, res);
  await done;
  return res;
}

const dispose = apply(ctx);

check('注册了两条路由', () => {
  assert.ok(routes.has('/plugin-manager/list'));
  assert.ok(routes.has('/plugin-manager/uninstall'));
});

check('list 返回三分法清单', async () => {
  const res = await call('/plugin-manager/list', {});
  assert.equal(res.status, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.profile.name, 'web');
  const byName = Object.fromEntries(res.payload.plugins.map((p) => [p.name, p]));
  assert.equal(byName['victim-plugin'].canUninstall, true);
  assert.equal(byName['victim-plugin'].version, '9.9.9');
  assert.equal(byName['dsh-plugin-manager'].canUninstall, false);
  assert.equal(byName['@deepseek-ai/dsh-base'].reason, 'builtin');
});

check('uninstall 缺 confirm 被拒绝', async () => {
  const res = await call('/plugin-manager/uninstall', { body: { name: 'victim-plugin' } });
  assert.equal(res.status, 400);
  assert.equal(res.payload.error, 'confirm-required');
  assert.ok(existsSync(join(profileDir, 'node_modules', 'victim-plugin', 'package.json')));
});

check('uninstall 成功并持久化', async () => {
  const res = await call('/plugin-manager/uninstall', { body: { name: 'victim-plugin', confirm: true } });
  assert.equal(res.status, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.name, 'victim-plugin');
  assert.equal(res.payload.restartRequired, true);
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  assert.ok(!Object.hasOwn(manifest.dependencies, 'victim-plugin'));
  assert.ok(!manifest.dsh.profile.bundles.includes('victim-plugin'));
  assert.equal(existsSync(join(profileDir, 'node_modules', 'victim-plugin')), false);
});

check('重复卸载返回 404', async () => {
  const res = await call('/plugin-manager/uninstall', { body: { name: 'victim-plugin', confirm: true } });
  assert.equal(res.status, 404);
  assert.equal(res.payload.error, 'not-installed');
});

check('卸载自身被拒绝', async () => {
  const res = await call('/plugin-manager/uninstall', { body: { name: 'dsh-plugin-manager', confirm: true } });
  assert.equal(res.status, 400);
  assert.equal(res.payload.error, 'self');
});

check('非法包名被拒绝', async () => {
  for (const bad of ['../evil', 'a/b', '']) {
    const res = await call('/plugin-manager/uninstall', { body: { name: bad, confirm: true } });
    assert.equal(res.status, 400);
    assert.equal(res.payload.error, 'invalid-name');
  }
});

check('守卫：GET 与非 JSON', async () => {
  const get = await call('/plugin-manager/list', { method: 'GET' });
  assert.equal(get.status, 405);
  const nonJson = await call('/plugin-manager/list', { contentType: 'text/plain', rawBody: '{}' });
  assert.equal(nonJson.status, 415);
});

check('disposer 释放路由', () => {
  dispose();
  assert.equal(routes.size, 0);
});

for (const [name, fn] of queue) { await fn(); passed++; console.log(`ok - ${name}`); }
console.log(`\n${passed} passed`);
