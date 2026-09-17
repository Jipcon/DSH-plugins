/**
 * dsh-codex-auth 烟雾测试：不启动 DSH，只校验插件骨架与关键字符串。
 *
 * 用法：node tests/smoke.mjs
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pluginDir = dirname(root);
let failures = 0;

function check(cond, message) {
  if (cond) console.log(`ok - ${message}`);
  else { failures++; console.error(`FAIL - ${message}`); }
}

const pkg = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'));
check(pkg.name === 'dsh-codex-auth', 'package.json name');
check(pkg.main === 'lib/index.js', 'package.json main');
check(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('slots'), 'dsh.client.inject 含 slots');
check(pkg.dsh?.client?.inject.includes('remote.settings'), 'dsh.client.inject 含 remote.settings');

const host = await import(pathToFileURL(join(pluginDir, 'lib/index.js')).href);
check(host.name === 'dsh-codex-auth', 'host name 导出');
check(Array.isArray(host.inject) && host.inject.includes('webServer'), 'host inject 含 webServer');
check(host.inject.includes('credentials'), 'host inject 含 credentials');
check(!host.inject.includes('authorization'), 'host inject 不含 authorization（生产组合没有它，写了就永远 pending）');
check(typeof host.apply === 'function', 'host apply 为函数');
check(host.__test?.CODEX_KEY === 'llm-pi-ai/openai-codex', 'CODEX_KEY 正确');

const seam = await import(pathToFileURL(join(pluginDir, 'lib/authorization.js')).href);
check(typeof seam.AuthorizationService === 'function', '本地 authorization 实现可导入');
check(typeof seam.AuthorizationDeclinedError === 'function', 'DECLINED 错误类可导入');

const clientSrc = await readFile(join(pluginDir, 'src/client.js'), 'utf8');
for (const s of [
  'dsh-codex-auth',
  'settings.plugin.item',
  'settings.section',
  'codex-auth',
  'CodexAuthPanel',
  'CodexAuthSection',
  '/codex-auth/status',
  '/codex-auth/start',
  '/codex-auth/poll',
  '/codex-auth/answer',
  '/codex-auth/cancel',
  '/codex-auth/signout',
  'openai-codex',
  'remote.settings',
]) {
  check(clientSrc.includes(s), `client 含 ${s}`);
}

const libClient = await readFile(join(pluginDir, 'lib/client.js'), 'utf8');
check(libClient === clientSrc, 'lib/client.js 与 src/client.js 一致（已构建）');

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
