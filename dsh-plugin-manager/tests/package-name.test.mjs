/**
 * dsh-plugin-manager 包名 / profile 名 / 命令行解析回归测试。
 *
 * 锁定宿主卸载入口的安全边界：包名白名单必须拒绝一切路径穿越写法，
 * profile 名必须拒绝分隔符与保留名，--profile 解析必须覆盖三种形态。
 *
 * 用法：node tests/package-name.test.mjs（断言失败时非零退出）
 */
import { strict as assert } from 'node:assert';
import { __test } from '../src/index.js';

const { validPackageName, validProfileName, profileNameFromArgv, resolveDshHome } = __test;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// —— 包名白名单：放行合法形态 ——
check('合法包名通过', () => {
  assert.equal(validPackageName('dsh-proxy'), true);
  assert.equal(validPackageName('dsh-plugin-manager'), true);
  assert.equal(validPackageName('@scope/dsh-foo'), true);
  assert.equal(validPackageName('a'), true);
  assert.equal(validPackageName('foo.bar-baz_qux~1'), true);
});

// —— 包名白名单：拒绝穿越与非法形态 ——
check('穿越与非法包名拒绝', () => {
  assert.equal(validPackageName('../evil'), false);
  assert.equal(validPackageName('a/b'), false);
  assert.equal(validPackageName('@scope/../../x'), false);
  assert.equal(validPackageName('c:\\windows\\x'), false);
  assert.equal(validPackageName('/abs/path'), false);
  assert.equal(validPackageName(''), false);
  assert.equal(validPackageName(null), false);
  assert.equal(validPackageName(undefined), false);
  assert.equal(validPackageName('ABC'), false);
  assert.equal(validPackageName('-lead'), false);
  assert.equal(validPackageName('@noslash'), false);
  assert.equal(validPackageName('has space'), false);
  assert.equal(validPackageName('x'.repeat(215)), false);
  assert.equal(validPackageName('x'.repeat(214)), true);
});

// —— profile 名：拒绝分隔符与保留名 ——
check('profile 名校验', () => {
  assert.equal(validProfileName('web'), true);
  assert.equal(validProfileName('my-profile_1'), true);
  assert.equal(validProfileName(''), false);
  assert.equal(validProfileName('.'), false);
  assert.equal(validProfileName('..'), false);
  assert.equal(validProfileName('node_modules'), false);
  assert.equal(validProfileName('a/b'), false);
  assert.equal(validProfileName('a\\b'), false);
});

// —— 命令行解析 ——
check('--profile 三种形态', () => {
  assert.equal(profileNameFromArgv(['--profile', 'web']), 'web');
  assert.equal(profileNameFromArgv(['--profile=tui', '--patch', 'x.yml']), 'tui');
  assert.equal(profileNameFromArgv(['web', '--port', '8080']), 'web');
  assert.equal(profileNameFromArgv(['--profile', '']), undefined);
  assert.equal(profileNameFromArgv(['headless', 'hello']), undefined);
  assert.equal(profileNameFromArgv([]), undefined);
});

// —— DSH_HOME 解析 ——
check('DSH_HOME 优先于默认', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'D:\\custom\\.dsh' }), 'D:\\custom\\.dsh');
  assert.equal(resolveDshHome({ DSH_HOME: '  ' }).endsWith('.dsh'), true);
  assert.equal(resolveDshHome({}).endsWith('.dsh'), true);
});

console.log(`\n${passed} passed`);
