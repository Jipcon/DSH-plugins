/**
 * dsh-plugin-manager 浏览器半边注册冒烟测试。
 *
 * 在 Node 里 stub window.__ModuleLoader__ 与最小 React（hooks 仅记调用、
 * createElement 透传），加载 src/client.js，断言：
 *  - 工厂 id 为 dsh-plugin-manager，仅注入 slots；
 *  - apply(ctx) 向 settings.plugins.tab 注册 id=plugin-manager、order=5、
 *    label=插件管理 的 Tab，且返回的 disposer 可释放。
 *
 * 用法：node tests/client-smoke.test.mjs（断言失败时非零退出）
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(root, '..', 'src', 'client.js'), 'utf8');

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) { captured = entry; },
  },
};

const ReactStub = {
  createElement: (...args) => ({ __el: true, args }),
  Fragment: 'fragment',
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
};

function fakeRequire(name) {
  assert.equal(name, 'react', 'client 只应依赖 react');
  return ReactStub;
}

// 去掉首尾的 load 包裹无法直接 import（顶层引用 window），用 Function 求值。
const runFactory = new Function('window', 'require', 'module', 'exports', source);
runFactory(globalThis.window, fakeRequire, {}, {});
delete globalThis.window;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check('模块工厂已注册', () => {
  assert.ok(captured, '应调用 window.__ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-plugin-manager');
  assert.equal(typeof captured.factory, 'function');
});

const plugin = captured.factory(fakeRequire);

check('插件元信息', () => {
  assert.equal(plugin.name, 'dsh-plugin-manager');
  assert.deepEqual(plugin.inject, ['slots']);
  assert.equal(typeof plugin.apply, 'function');
});

check('注册插件管理 Tab', () => {
  const registered = [];
  const fakeCtx = {
    slots: {
      inject(slot, setup) {
        assert.equal(slot, 'settings.plugins.tab');
        const disposer = setup();
        return () => { disposer?.(); };
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
    },
  };
  const dispose = plugin.apply(fakeCtx);
  assert.equal(registered.length, 1);
  const [{ options, component }] = registered;
  assert.equal(options.name, 'settings.plugins.tab');
  assert.equal(options.id, 'plugin-manager');
  assert.equal(options.order, 5);
  assert.equal(options.label, '插件管理');
  assert.equal(typeof component, 'function');
  assert.equal(typeof dispose, 'function');
  dispose();
});

check('Tab 组件可渲染（hooks stub 下不抛）', () => {
  const registered = [];
  const fakeCtx = {
    slots: {
      inject(_slot, setup) { return setup(); },
      register(_options, component) { registered.push(component); return () => {}; },
    },
  };
  plugin.apply(fakeCtx);
  const Tab = registered[0];
  const el = Tab({});
  assert.ok(el && el.__el, '应返回 React element');
});

console.log(`\n${passed} passed`);
