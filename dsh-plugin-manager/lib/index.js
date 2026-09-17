/**
 * dsh-plugin-manager — node half。
 *
 * 图形化插件管理插件的宿主半边：给浏览器“设置 → 插件 → 插件管理”页提供
 * 两组 POST + JSON 路由（与 dsh-message-recall / dsh-archived-cleaner 同款
 * webServer 路由形态与同源守卫）：
 *  - POST /plugin-manager/list                 → 当前 profile 的插件清单
 *  - POST /plugin-manager/uninstall { name, confirm: true } → 真正卸载
 *
 * “真正的卸载” = 三步持久化变更（与 `dsh plugin --profile <name> remove <pkg>`
 * 的最终状态一致），缺一不可：
 *  1. 从 <profile>/package.json 的 dependencies 里删除该包；
 *  2. 从同一文件 dsh.profile.bundles 层列表里移除该包（即停用其 patch 层）；
 *  3. best-effort 删除 <profile>/node_modules/<pkg>（Windows 下运行中文件
 *     可能删不掉，此时如实返回 filesRemoved:false，重启后可再清）。
 * 卸载后必须重启 DSH（Loader 组合是启动时决定的；live patchReload 只覆盖
 * 用户 patch 层，不覆盖 bundle 层）。lockfile（pnpm-lock.yaml）会残留已删
 * 条目——无害，下次 `dsh plugin --profile <name> install` 会自动修剪，
 * 响应里以 lockfileStale:true 提示。
 *
 * 安全策略（默认严格）：
 *  - 包名必须符合 npm 包名白名单（与桌面端 project-manager 同款正则），
 *    长度 ≤214；一切穿越（.. / \\ : 绝对路径）都不可能通过该正则；
 *  - 只卸载 dependencies 里真实存在的“外部包”；内置 bundle（在 bundles
 *    里但不在 dependencies 里，如 @deepseek-ai/dsh-base）拒绝 not-external；
 *  - 拒绝卸载自身（self），请用 `dsh plugin remove dsh-plugin-manager`；
 *  - 桌面端 profile（manifest name 为 @deepseek-ai/dsh-desktop-runtime）
 *    拒绝 unsupported-profile，请走桌面应用自带的插件管理器；
 *  - uninstall 要求 body.confirm === true，否则 400（confirm-required），
 *    与浏览器两步确认按钮配合，防误触；
 *  - 删除目录前做 resolve 前缀校验，限定在 <profile>/node_modules 内。
 *
 * profile 定位（零核心依赖，按优先级）：
 *  1. 命令行 --profile <name>（或 `dsh web` 别名）→ $DSH_HOME/profiles/<name>；
 *  2. 从本模块真实路径向上 walk，找第一个含 dsh.profile.bundles 的
 *     package.json（pnpm 安装形态：文件落在 <profile>/node_modules/.pnpm/… 下）；
 *  3. 扫描 $DSH_HOME 下各 profile 的 package.json，找 dependencies 含本插件的
 *     profile（多个时优先命令行具名、其次 web、否则按名排序首个）。
 *
 * 依赖服务：webServer（路由）。其余一律用同步 fs 直读写 profile 文件，
 * 不依赖 settings/loader 等服务，缺失也不影响加载。
 */
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-plugin-manager';
export const inject = ['webServer'];

const SELF = 'dsh-plugin-manager';
const DESKTOP_RUNTIME_MANIFEST = '@deepseek-ai/dsh-desktop-runtime';

// 与 apps/desktop/src/project-manager.ts 同款 npm 包名白名单。
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/;
const MAX_PACKAGE_NAME_LENGTH = 214;

/** 包名白名单校验：通过正则即天然排除一切路径穿越字符。 */
function validPackageName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PACKAGE_NAME_LENGTH
    && PACKAGE_NAME_PATTERN.test(value);
}

/** profile 名白名单：dsh 对 profile 名的约束（见 app-boot resolveProfileDir）。 */
function validProfileName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && value !== '.'
    && value !== '..'
    && value !== 'node_modules'
    && !value.includes('/')
    && !value.includes('\\');
}

// ---------- 统一日志（host 落盘 $DSH_HOME/dsh-plugin-manager.log，同步追加） ----------

function resolveLogFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'dsh-plugin-manager.log');
}

function writeLog(level, tag, message, data) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    tag,
    message,
    data: data ?? null,
  });
  if (process.env.DSH_PLUGIN_MANAGER_DEBUG === '1') {
    if (level === 'error') console.error('[dsh-plugin-manager]', tag, message, data ?? '');
    else if (level === 'warn') console.warn('[dsh-plugin-manager]', tag, message, data ?? '');
    else console.info('[dsh-plugin-manager]', tag, message, data ?? '');
  }
  try {
    const file = resolveLogFile();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, line + '\n', 'utf8');
  } catch { /* 磁盘异常不破坏进程 */ }
}

// ---------- 请求解析与路由守卫（与 dsh-archived-cleaner 同款） ----------

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        req.removeAllListeners('data');
        req.resume();
        reject(new Error('body-too-large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolvePromise(text ? JSON.parse(text) : {});
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function requestFromSameOrigin(req) {
  try {
    const origin = req.headers?.origin || req.headers?.referer;
    if (!origin) return true;
    if (origin === 'null') return false;
    const host = req.headers?.host;
    if (!host) return false;
    return new URL(origin).host === host;
  } catch { return false; }
}

function isJsonContentType(req) {
  const ct = String(req.headers?.['content-type'] || '').toLowerCase();
  return ct === 'application/json' || ct.startsWith('application/json;');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 同源 + JSON Content-Type 守卫，通过返回 true。 */
function guard(req, res) {
  if (!requestFromSameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return false; }
  if (!isJsonContentType(req)) { sendJson(res, 415, { ok: false, error: 'unsupported-media-type' }); return false; }
  return true;
}

// ---------- profile 发现与清单读写（纯函数为主，便于单测） ----------

function resolveDshHome(env = process.env) {
  const override = env?.DSH_HOME;
  if (typeof override === 'string' && override.trim() !== '') return override;
  return join(homedir(), '.dsh');
}

/** 从命令行解析 profile 名：`--profile <name>` / `--profile=<name>` / `dsh web` 别名。 */
function profileNameFromArgv(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile' && typeof argv[i + 1] === 'string' && argv[i + 1] !== '') {
      return argv[i + 1];
    }
    if (argv[i].startsWith('--profile=')) {
      const v = argv[i].slice('--profile='.length);
      if (v !== '') return v;
    }
  }
  if (argv[0] === 'web') return 'web';
  return undefined;
}

/** 目录是否为 profile（package.json 含 dsh.profile.bundles 数组）→ 返回解析后 manifest。 */
function readProfileManifestIfProfile(dir) {
  let raw;
  try {
    raw = readFileSync(join(dir, 'package.json'), 'utf8');
  } catch { return null; }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch { return null; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.every((b) => typeof b === 'string')) return null;
  return manifest;
}

/**
 * 定位当前进程的 profile 目录。
 * @param ownDir - 本模块所在目录（调用方传 dirname(fileURLToPath(import.meta.url))）。
 * @param env - 环境变量表（默认 process.env），便于单测注入。
 * @param argv - 命令行参数（默认 process.argv.slice(2)），便于单测注入。
 * @returns { dir, name, via } 或 null（找不到）。
 */
function findProfileDir(ownDir, env = process.env, argv = process.argv.slice(2)) {
  const home = resolveDshHome(env);
  const named = profileNameFromArgv(argv);
  if (named !== undefined && validProfileName(named)) {
    const dir = join(home, 'profiles', named);
    if (readProfileManifestIfProfile(dir) !== null) {
      return { dir, name: named, via: 'argv' };
    }
  }
  // pnpm 安装形态：本文件落在 <profile>/node_modules/.pnpm/… 下，向上找 profile 根。
  let cur = resolve(ownDir);
  for (let i = 0; i < 14; i++) {
    if (readProfileManifestIfProfile(cur) !== null) {
      return { dir: cur, name: basename(cur), via: 'anchor' };
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // file: 链接安装（本文件在 profile 之外）：扫描 profiles，找依赖了本插件的。
  let entries;
  try {
    entries = readdirSync(join(home, 'profiles'), { withFileTypes: true });
  } catch { entries = []; }
  const candidates = [];
  for (const entry of entries) {
    let isDir = false;
    try { isDir = entry.isDirectory(); } catch { isDir = false; }
    if (!isDir || entry.name === 'node_modules') continue;
    const dir = join(home, 'profiles', entry.name);
    const manifest = readProfileManifestIfProfile(dir);
    if (manifest === null) continue;
    const deps = manifest.dependencies;
    if (deps && typeof deps === 'object' && Object.hasOwn(deps, SELF)) {
      candidates.push({ dir, name: entry.name });
    }
  }
  if (candidates.length === 1) return { ...candidates[0], via: 'scan' };
  if (candidates.length > 1) {
    const preferred = (named !== undefined && candidates.find((c) => c.name === named))
      || candidates.find((c) => c.name === 'web')
      || [...candidates].sort((a, b) => a.name.localeCompare(b.name))[0];
    return { ...preferred, via: 'scan-preferred' };
  }
  return null;
}

/** 读已安装包的 manifest（版本号 / dsh.bundle 判定），缺失返回 null。 */
function readInstalledPackage(profileDir, packageName) {
  const manifestPath = join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json');
  let raw;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch { return null; }
  try {
    const manifest = JSON.parse(raw);
    if (!manifest || typeof manifest !== 'object') return null;
    return manifest;
  } catch { return null; }
}

/** 取首个非空字符串（trim 后），都没有返回 null。 */
function pickDisplayString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim();
  }
  return null;
}

/**
 * best-effort 从已安装包的浏览器半边推断显示名（兼容尚未声明 dsh.displayName 的老版本）。
 * 只解析 lib/client.js（构建产物）首个 title:"..." / subtitle|subLong|sub|description:"..."，
 * 用法处的 title: TEXT.xxx（无引号）不会命中；失败返回 null，绝不抛。
 */
function inferDisplayFromClientJs(profileDir, packageName) {
  try {
    if (!validPackageName(packageName)) return null;
    const base = join(profileDir, 'node_modules', ...packageName.split('/'));
    const candidates = [join(base, 'lib', 'client.js'), join(base, 'src', 'client.js')];
    for (const file of candidates) {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch { continue; }
      if (typeof text !== 'string' || text.length === 0) continue;
      if (text.length > 512 * 1024) text = text.slice(0, 512 * 1024);
      const titleMatch = text.match(/title\s*:\s*"((?:[^"\\]|\\.){1,80})"/);
      if (!titleMatch) continue;
      const subMatch = text.match(/(?:subtitle|subLong|displayDescription|description|sub)\s*:\s*"((?:[^"\\]|\\.){1,160})"/);
      return {
        displayName: titleMatch[1],
        description: subMatch ? subMatch[1] : null,
      };
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 解析插件显示信息：开发名（npm 包名）vs 显示名（插件页卡片标题）可能不一样，
 * 例如 dsh-archived-cleaner → 已归档会话清理，dsh-codex-auth → Codex 账号登录（ChatGPT），
 * dsh-message-recall → MessageRecall。优先级：
 *  1. 已安装 manifest 的声明式字段：dsh.displayName / dsh.title / displayName / title；
 *  2. best-effort 解析已安装包 lib/client.js 的 TEXT.title（兼容老版本）；
 *  3. 回落开发名本身。
 * 描述优先级：dsh.displayDescription 等短字段 > client.js 推断的副标题 > package.json description（长）。
 */
function resolveDisplayInfo(profileDir, packageName, installed) {
  const declaredName = pickDisplayString(
    installed?.dsh?.displayName,
    installed?.dsh?.title,
    installed?.displayName,
    installed?.title,
  );
  const declaredShortDesc = pickDisplayString(
    installed?.dsh?.displayDescription,
    installed?.dsh?.subtitle,
    installed?.dsh?.subLong,
    installed?.dsh?.description,
  );
  const genericDesc = pickDisplayString(installed?.description);
  if (declaredName) {
    if (declaredShortDesc) return { displayName: declaredName, description: declaredShortDesc };
    // 新声明只有显示名、副标题缺失时：仍尝试从 client.js 补副标题，避免回落到长 description。
    const inferredForDesc = inferDisplayFromClientJs(profileDir, packageName);
    return {
      displayName: declaredName,
      description: inferredForDesc?.description ?? genericDesc,
    };
  }
  const inferred = inferDisplayFromClientJs(profileDir, packageName);
  if (inferred?.displayName) {
    return {
      displayName: inferred.displayName,
      description: declaredShortDesc ?? inferred.description ?? genericDesc,
    };
  }
  return { displayName: packageName, description: declaredShortDesc ?? genericDesc };
}

/**
 * 列出 profile 插件：外部依赖在前（可卸载），内置 bundle 与自身在后（只读说明）。
 * @returns { profile: { name, dir }, plugins: [...] }
 * @throws { err } 找不得 profile（err.code 'profile-not-found'）或桌面端（'unsupported-profile'）。
 */
function listProfilePlugins(profileDir, profileName) {
  const manifest = readProfileManifestIfProfile(profileDir);
  if (manifest === null) {
    const err = new Error(`profile manifest not found: ${profileDir}`);
    err.code = 'profile-not-found';
    throw err;
  }
  if (manifest.name === DESKTOP_RUNTIME_MANIFEST) {
    const err = new Error('desktop profile is managed by the Desktop app plugin manager');
    err.code = 'unsupported-profile';
    throw err;
  }
  const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object'
    ? manifest.dependencies
    : {};
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const plugins = [];
  for (const depName of Object.keys(dependencies).sort((a, b) => a.localeCompare(b))) {
    const installed = validPackageName(depName) ? readInstalledPackage(profileDir, depName) : null;
    const patch = installed?.dsh?.bundle?.patch;
    const display = resolveDisplayInfo(profileDir, depName, installed);
    plugins.push({
      name: depName,
      displayName: display.displayName,
      description: display.description,
      version: typeof installed?.version === 'string' ? installed.version : null,
      spec: typeof dependencies[depName] === 'string' ? dependencies[depName] : null,
      external: true,
      enabled: bundles.includes(depName),
      isBundle: typeof patch === 'string' && patch !== '',
      installed: installed !== null,
      isSelf: depName === SELF,
      canUninstall: depName !== SELF,
      reason: depName === SELF ? 'self' : null,
    });
  }
  for (const bundleName of bundles) {
    if (Object.hasOwn(dependencies, bundleName)) continue;
    plugins.push({
      name: bundleName,
      displayName: bundleName,
      description: null,
      version: null,
      spec: null,
      external: false,
      enabled: true,
      isBundle: true,
      installed: true,
      isSelf: false,
      canUninstall: false,
      reason: 'builtin',
    });
  }
  return { profile: { name: profileName, dir: profileDir }, plugins };
}

/**
 * 真正卸载一个外部插件：删 dependencies → 删 bundles 层 → best-effort 删文件。
 * 调用前必须已做包名校验与 confirm 检查；本函数每次都重读清单，并发 CLI
 * 改动不会基于过期快照写回（先读后写同一文件，极端并发下以后写者为准，
 * 与 `dsh plugin` CLI 的行为一致）。
 * @returns { version, removedFromBundles, filesRemoved }
 * @throws { err } code: not-installed | not-external | self | unsupported-profile
 */
function uninstallProfilePackage(profileDir, packageName) {
  if (packageName === SELF) {
    const err = new Error('refusing to uninstall self; use `dsh plugin remove` instead');
    err.code = 'self';
    throw err;
  }
  const manifestPath = join(profileDir, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (cause) {
    const err = new Error(`cannot read profile manifest: ${manifestPath}`);
    err.code = 'profile-not-found';
    err.cause = cause;
    throw err;
  }
  if (manifest?.name === DESKTOP_RUNTIME_MANIFEST) {
    const err = new Error('desktop profile is managed by the Desktop app plugin manager');
    err.code = 'unsupported-profile';
    throw err;
  }
  const dependencies = manifest?.dependencies && typeof manifest.dependencies === 'object'
    ? { ...manifest.dependencies }
    : {};
  if (!Object.hasOwn(dependencies, packageName)) {
    const bundles = manifest?.dsh?.profile?.bundles;
    const err = new Error(
      Array.isArray(bundles) && bundles.includes(packageName)
        ? `built-in bundle ${packageName} cannot be uninstalled`
        : `package ${packageName} is not installed in this profile`,
    );
    err.code = Array.isArray(bundles) && bundles.includes(packageName) ? 'not-external' : 'not-installed';
    throw err;
  }
  const version = typeof dependencies[packageName] === 'string' ? dependencies[packageName] : null;
  delete dependencies[packageName];
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? [...manifest.dsh.profile.bundles] : [];
  const removedFromBundles = bundles.includes(packageName);
  const nextBundles = bundles.filter((b) => b !== packageName);
  const next = {
    ...manifest,
    dependencies,
    dsh: {
      ...(manifest.dsh ?? {}),
      profile: {
        ...(manifest.dsh?.profile ?? {}),
        bundles: nextBundles,
      },
    },
  };
  writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  // —— best-effort 删文件：限定在 <profile>/node_modules 内（纵深防御） ——
  const modulesBase = resolve(join(profileDir, 'node_modules'));
  const target = resolve(join(profileDir, 'node_modules', ...packageName.split('/')));
  if (target === modulesBase || !target.startsWith(modulesBase + sep)) {
    const err = new Error(`refusing to delete outside profile node_modules: ${target}`);
    err.code = 'invalid-name';
    throw err;
  }
  let filesRemoved = false;
  try {
    rmSync(target, { recursive: true, force: true });
    filesRemoved = !existsSync(target);
  } catch {
    filesRemoved = !existsSync(target);
  }
  return { version, removedFromBundles, filesRemoved };
}

function profileErrorStatus(err) {
  if (err?.code === 'profile-not-found') return 503;
  if (err?.code === 'unsupported-profile') return 400;
  return 500;
}

// ---------- 路由 ----------

export function apply(ctx) {
  writeLog('info', 'host', 'apply: 路由注册开始');
  const disposers = [];
  const ownDir = dirname(fileURLToPath(import.meta.url));

  function locateProfile() {
    const found = findProfileDir(ownDir);
    if (found === null) {
      const err = new Error('cannot locate the active profile directory');
      err.code = 'profile-not-found';
      throw err;
    }
    return found;
  }

  // 清单
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/plugin-manager/list',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        if (!guard(req, res)) return;
        await readJsonBody(req, 16 * 1024).catch(() => ({}));
        let found;
        try {
          found = locateProfile();
        } catch (err) {
          writeLog('warn', 'host', '/plugin-manager/list 定位 profile 失败', { err: String(err?.message ?? err) });
          sendJson(res, profileErrorStatus(err), { ok: false, error: err?.code ?? 'internal' });
          return;
        }
        try {
          const snapshot = listProfilePlugins(found.dir, found.name);
          sendJson(res, 200, { ok: true, ...snapshot });
        } catch (err) {
          writeLog('warn', 'host', '/plugin-manager/list 读取清单失败', { err: String(err?.message ?? err) });
          sendJson(res, profileErrorStatus(err), { ok: false, error: err?.code ?? 'internal' });
        }
      } catch (err) {
        writeLog('warn', 'host', '/plugin-manager/list 异常', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    },
  }));

  // 卸载（两步确认：confirm !== true 直接 400）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/plugin-manager/uninstall',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        let body;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid-request' });
          return;
        }
        if (!guard(req, res)) return;
        const packageName = body?.name;
        if (!validPackageName(packageName)) {
          sendJson(res, 400, { ok: false, error: 'invalid-name', message: '包名不合法' });
          return;
        }
        if (body?.confirm !== true) {
          sendJson(res, 400, { ok: false, error: 'confirm-required', message: '卸载需要显式二次确认（confirm: true）' });
          return;
        }
        let found;
        try {
          found = locateProfile();
        } catch (err) {
          writeLog('warn', 'host', '/plugin-manager/uninstall 定位 profile 失败', { err: String(err?.message ?? err) });
          sendJson(res, profileErrorStatus(err), { ok: false, error: err?.code ?? 'internal' });
          return;
        }
        writeLog('info', 'uninstall', '收到卸载请求', { name: packageName, profile: found.name, via: found.via });
        try {
          const result = uninstallProfilePackage(found.dir, packageName);
          writeLog('info', 'uninstall', '卸载完成（需重启生效）', { name: packageName, ...result });
          sendJson(res, 200, {
            ok: true,
            name: packageName,
            profile: found.name,
            ...result,
            restartRequired: true,
            lockfileStale: true,
            message: `已卸载 ${packageName}，重启 DSH 后生效；lockfile 残留条目可在重启后运行 dsh plugin --profile ${found.name} install 修剪`,
          });
        } catch (err) {
          const status = err?.code === 'not-installed' ? 404
            : err?.code === 'not-external' || err?.code === 'self' || err?.code === 'invalid-name' ? 400
            : profileErrorStatus(err);
          writeLog('warn', 'host', '/plugin-manager/uninstall 失败', {
            name: packageName,
            err: String(err?.message ?? err),
            code: err?.code ?? null,
          });
          sendJson(res, status, { ok: false, error: err?.code ?? 'internal', message: String(err?.message ?? err) });
        }
      } catch (err) {
        writeLog('warn', 'host', '/plugin-manager/uninstall 异常', { err: String(err?.message ?? err) });
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    },
  }));

  writeLog('info', 'host', 'apply: 路由注册完成');
  return () => {
    for (const d of disposers) { try { d(); } catch { /* ignore */ } }
    writeLog('info', 'host', 'apply: 已卸载');
  };
}

/** 仅测试用：暴露内部纯函数（不参与运行时行为）。 */
export const __test = {
  validPackageName,
  validProfileName,
  resolveDshHome,
  profileNameFromArgv,
  readProfileManifestIfProfile,
  findProfileDir,
  listProfilePlugins,
  uninstallProfilePackage,
  resolveDisplayInfo,
  inferDisplayFromClientJs,
  SELF,
};
