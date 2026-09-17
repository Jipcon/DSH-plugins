/**
 * dsh-plugin-manager 清单分类 / profile 发现 / 卸载变更回归测试。
 *
 * 用临时目录搭建最小 profile（package.json + node_modules 桩），锁定：
 *  - listProfilePlugins：外部包 / 内置 bundle / 自身三分法与可卸载标记；
 *  - findProfileDir：anchor 上探与 scan 扫描两条发现路径；
 *  - uninstallProfilePackage：删 dependencies、删 bundles 层、删文件，
 *    以及 self / 内置 / 缺失三类拒绝码。
 *
 * 用法：node tests/manifest-mutation.test.mjs（断言失败时非零退出）
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { __test } from '../src/index.js';

const {
  readProfileManifestIfProfile,
  findProfileDir,
  listProfilePlugins,
  uninstallProfilePackage,
  SELF,
} = __test;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** 搭建一个最小 profile，返回 { home, profileDir }。 */
function makeProfile(home, profileName, { scoped = true } = {}) {
  const profileDir = join(home, 'profiles', profileName);
  mkdirSync(profileDir, { recursive: true });
  const dependencies = {
    [SELF]: '1.0.0',
    'some-external': '1.2.3',
  };
  if (scoped) dependencies['@scope/other'] = 'file:../other';
  writeJson(join(profileDir, 'package.json'), {
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies,
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', 'some-external', '@scope/other', SELF].filter(
          (b) => scoped || !b.startsWith('@scope'),
        ),
      },
    },
  });
  const extDir = join(profileDir, 'node_modules', 'some-external');
  mkdirSync(extDir, { recursive: true });
  writeJson(join(extDir, 'package.json'), {
    name: 'some-external',
    version: '1.2.3',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  });
  writeFileSync(join(extDir, 'index.js'), 'export const x = 1;\n');
  if (scoped) {
    const scopedDir = join(profileDir, 'node_modules', '@scope', 'other');
    mkdirSync(scopedDir, { recursive: true });
    // 纯库：无 dsh.bundle 声明 → isBundle 为 false，但仍可卸载
    writeJson(join(scopedDir, 'package.json'), { name: '@scope/other', version: '0.0.1' });
  }
  const selfDir = join(profileDir, 'node_modules', SELF);
  mkdirSync(selfDir, { recursive: true });
  writeJson(join(selfDir, 'package.json'), { name: SELF, version: '1.0.0' });
  return { home, profileDir };
}

const home = mkdtempSync(join(tmpdir(), 'dsh-pm-home-'));
const { profileDir } = makeProfile(home, 'web');
const env = { DSH_HOME: home };

// —— 非 profile 目录识别 ——
check('readProfileManifestIfProfile 拒绝非 profile', () => {
  assert.equal(readProfileManifestIfProfile(join(tmpdir(), 'dsh-pm-definitely-missing')), null);
  assert.equal(readProfileManifestIfProfile(tmpdir()), null);
  assert.notEqual(readProfileManifestIfProfile(profileDir), null);
});

// —— 清单三分法 ——
check('listProfilePlugins 分类与标记', () => {
  const { profile, plugins } = listProfilePlugins(profileDir, 'web');
  assert.equal(profile.name, 'web');
  assert.equal(profile.dir, profileDir);
  const byName = Object.fromEntries(plugins.map((p) => [p.name, p]));
  assert.equal(byName['some-external'].external, true);
  assert.equal(byName['some-external'].canUninstall, true);
  assert.equal(byName['some-external'].enabled, true);
  assert.equal(byName['some-external'].isBundle, true);
  assert.equal(byName['some-external'].version, '1.2.3');
  assert.equal(byName['@scope/other'].external, true);
  assert.equal(byName['@scope/other'].canUninstall, true);
  assert.equal(byName['@scope/other'].isBundle, false);
  assert.equal(byName[SELF].isSelf, true);
  assert.equal(byName[SELF].canUninstall, false);
  assert.equal(byName[SELF].reason, 'self');
  assert.equal(byName['@deepseek-ai/dsh-base'].external, false);
  assert.equal(byName['@deepseek-ai/dsh-base'].canUninstall, false);
  assert.equal(byName['@deepseek-ai/dsh-base'].reason, 'builtin');
});

// —— anchor 上探：pnpm  virtual store 深处的 ownDir ——
check('findProfileDir anchor 上探', () => {
  const deep = join(profileDir, 'node_modules', '.pnpm', 'some-external@1.2.3', 'node_modules', 'some-external', 'lib');
  mkdirSync(deep, { recursive: true });
  const found = findProfileDir(deep, env, []);
  assert.notEqual(found, null);
  assert.equal(found.dir, profileDir);
  assert.equal(found.name, 'web');
  assert.equal(found.via, 'anchor');
});

// —— argv 优先 ——
check('findProfileDir argv 优先', () => {
  makeProfile(home, 'tui', { scoped: false });
  const found = findProfileDir(join(tmpdir(), 'dsh-pm-nowhere'), env, ['--profile', 'tui']);
  assert.notEqual(found, null);
  assert.equal(found.name, 'tui');
  assert.equal(found.via, 'argv');
});

// —— scan：ownDir 在 profile 之外（file: 链接安装） ——
check('findProfileDir scan 兜底', () => {
  const found = findProfileDir(join(homedir()), env, []);
  assert.notEqual(found, null);
  // web 与 tui 都依赖了 SELF，多个候选时优先 web
  assert.equal(found.name, 'web');
  assert.ok(found.via === 'scan-preferred' || found.via === 'scan');
});

// —— 找不到时返回 null ——
check('findProfileDir 无候选返回 null', () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'dsh-pm-empty-'));
  assert.equal(findProfileDir(join(tmpdir(), 'dsh-pm-nowhere'), { DSH_HOME: emptyHome }, []), null);
});

// —— 真正卸载：manifest + 文件 ——
check('uninstall 删除依赖/bundle 层/文件', () => {
  const before = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  assert.ok(Object.hasOwn(before.dependencies, 'some-external'));
  assert.ok(before.dsh.profile.bundles.includes('some-external'));
  const result = uninstallProfilePackage(profileDir, 'some-external');
  assert.equal(result.version, '1.2.3');
  assert.equal(result.removedFromBundles, true);
  assert.equal(result.filesRemoved, true);
  const after = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  assert.ok(!Object.hasOwn(after.dependencies, 'some-external'));
  assert.ok(!after.dsh.profile.bundles.includes('some-external'));
  // 未动其它条目
  assert.ok(Object.hasOwn(after.dependencies, '@scope/other'));
  assert.ok(after.dsh.profile.bundles.includes('@scope/other'));
  assert.ok(existsSync(join(profileDir, 'node_modules', '@scope', 'other', 'package.json')));
  assert.equal(existsSync(join(profileDir, 'node_modules', 'some-external')), false);
});

// —— 卸载 scope 包：路径拼装正确 ——
check('uninstall 支持 scope 包', () => {
  const result = uninstallProfilePackage(profileDir, '@scope/other');
  assert.equal(result.removedFromBundles, true);
  assert.equal(result.filesRemoved, true);
  assert.equal(existsSync(join(profileDir, 'node_modules', '@scope', 'other')), false);
});

// —— 三类拒绝 ——
check('uninstall 拒绝自身/内置/缺失', () => {
  assert.throws(() => uninstallProfilePackage(profileDir, SELF), (e) => e.code === 'self');
  assert.throws(
    () => uninstallProfilePackage(profileDir, '@deepseek-ai/dsh-base'),
    (e) => e.code === 'not-external',
  );
  assert.throws(
    () => uninstallProfilePackage(profileDir, 'no-such-plugin'),
    (e) => e.code === 'not-installed',
  );
  // 自身与内置包的清单条目必须原样保留
  const after = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  assert.ok(Object.hasOwn(after.dependencies, SELF));
  assert.ok(after.dsh.profile.bundles.includes('@deepseek-ai/dsh-base'));
});

// —— 桌面端 profile 拒绝 ——
check('桌面端 profile 被拒绝', () => {
  const dir = join(home, 'profiles', 'desktop');
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'package.json'), {
    name: '@deepseek-ai/dsh-desktop-runtime',
    private: true,
    version: '0.0.0',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  });
  assert.throws(() => listProfilePlugins(dir, 'desktop'), (e) => e.code === 'unsupported-profile');
  assert.throws(() => uninstallProfilePackage(dir, 'whatever'), (e) => e.code === 'unsupported-profile');
});

console.log(`\n${passed} passed`);
