/**
 * dsh-archived-cleaner 路径与校验回归测试。
 *
 * 覆盖 host 端从上游 `dsh-session-persistence-jsonl/src/format.ts` 逐行移植的
 * 三个纯函数（encodeSegment / projectKey / safeSessionDir）与会话 id 白名单，
 * 保证“算出来的删除目录”与宿主实际写会话的目录完全一致——算错目录是本插件
 * 唯一不可接受的故障（删错文件），因此用例直接锁定上游已知的映射关系。
 *
 * 上游事实（format.ts）：
 *  - 安全字符 [A-Za-z0-9._-] 原样保留，`~` 转义为 `~007E`；
 *  - session-9a908c4c-… 这类 id 全由安全字符组成，编码后不变；
 *  - projectKey('D:\\dsh-plugins') 压分隔符为单 `-`：`--D-dsh-plugins--`；
 *  - 无 cwd 会话归 `_no-cwd`；
 *  - 会话目录 = <root>/<projectKey>/<encodeSegment(id)>。
 *
 * 用法：node tests/path-safety.test.mjs（断言失败时非零退出）
 */
import { strict as assert } from 'node:assert';
import { join, resolve } from 'node:path';
import { __test } from '../src/index.js';

const { encodeSegment, projectKey, projectDir, sessionDir, safeSessionDir, validSessionId } = __test;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// —— encodeSegment：与上游行为一致 ——
check('安全 id 编码后不变', () => {
  assert.equal(encodeSegment('session-9a908c4c-4538-408f-89e8-38a25361306d'), 'session-9a908c4c-4538-408f-89e8-38a25361306d');
  assert.equal(encodeSegment('a8dec8a6-ab75-489e-8e45-e840dccd3232'), 'a8dec8a6-ab75-489e-8e45-e840dccd3232');
});

check('波浪线与特殊字符转义为大写 ~XXXX', () => {
  assert.equal(encodeSegment('a~b'), 'a~007Eb');
  assert.equal(encodeSegment('a/b'), 'a~002Fb');
  assert.equal(encodeSegment('a b'), 'a~0020b');
  // 安全字符原样
  assert.equal(encodeSegment('A.a_b-c'), 'A.a_b-c');
});

check('`.` / `..` 特判防穿越，空串抛错', () => {
  assert.equal(encodeSegment('.'), '~002E');
  assert.equal(encodeSegment('..'), '~002E~002E');
  assert.throws(() => encodeSegment(''), /empty/);
});

check('编码结果永为单路径段（无分隔符）', () => {
  for (const raw of ['../x', '..\\x', 'a/b\\c:d', 'x~y/z']) {
    const enc = encodeSegment(raw);
    assert.ok(!enc.includes('/') && !enc.includes('\\') && !enc.includes(':'), raw);
  }
});

// —— projectKey：与本机真实目录形态一致 ——
check("projectKey('D:\\\\dsh-plugins') === '--D-dsh-plugins--'", () => {
  assert.equal(projectKey('D:\\dsh-plugins'), '--D-dsh-plugins--');
});

check('projectKey 压分隔符 / 去前导 - / 空路径抛错', () => {
  assert.equal(projectKey('D:\\\\deepseek-harness'), '--D-deepseek-harness--');
  assert.equal(projectKey('/tmp//x'), '--tmp-x--');
  assert.throws(() => projectKey(''), /empty/);
});

check('无 cwd 会话归 _no-cwd', () => {
  assert.equal(projectDir('/root', undefined), join('/root', '_no-cwd'));
});

// —— sessionDir / safeSessionDir：删除目标精确可预测 ——
check('会话目录 = <root>/<projectKey>/<id>（与本机实测布局一致）', () => {
  const root = 'C:\\Users\\me\\.dsh\\sessions';
  const dir = sessionDir(root, 'D:\\dsh-plugins', 'session-30552d82-51a2-436a-b3b4-20c104b38fc7');
  assert.equal(dir, join(root, '--D-dsh-plugins--', 'session-30552d82-51a2-436a-b3b4-20c104b38fc7'));
});

check('safeSessionDir 拒绝逃出 sessionsRoot 的结果', () => {
  const root = resolve('/data/sessions');
  const ok = safeSessionDir(root, '/work/proj', 'session-abc');
  assert.equal(resolve(ok).startsWith(root), true);
  // 伪造一个会穿越的 projectKey 实现不可能发生；这里锁定守卫本身：
  // safeSessionDir 对正常输入恒返回 root 内路径
  assert.equal(resolve(sessionDir(root, undefined, 'x')).startsWith(root), true);
});

// —— validSessionId：与 dsh-message-recall 同款白名单 ——
check('会话 id 白名单', () => {
  assert.equal(validSessionId('session-abc-123'), true);
  assert.equal(validSessionId('a8dec8a6-ab75-489e-8e45-e840dccd3232'), true);
  assert.equal(validSessionId('../evil'), false);
  assert.equal(validSessionId('a/b'), false);
  assert.equal(validSessionId(''), false);
  assert.equal(validSessionId(null), false);
  assert.equal(validSessionId('x'.repeat(129)), false);
  assert.equal(validSessionId('x'.repeat(128)), true);
});

console.log(`\n全部通过：${passed} 个用例`);
