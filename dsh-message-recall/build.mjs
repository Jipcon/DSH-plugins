/**
 * dsh-message-recall 构建脚本。
 *
 * 源码即产物：src/client.js 与 src/index.js 已是可直接加载的 ESM，
 * 构建只做一次拷贝。没有打包器、没有图标内联、没有转译步骤——
 * 由此不再依赖 assets/ 目录，也就不存在素材丢失导致构建失败的问题。
 *
 * 产物：
 *   src/client.js -> lib/client.js   （浏览器半边，模块表工厂）
 *   src/index.js  -> lib/index.js    （Node 半边，cordis 插件）
 *
 * 注意：lib/ 是生成物，不要直接编辑；改动一律落到 src/。
 *
 * 用法：node build.mjs
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

/** 源码 → 产物的一一对应。新增半边时在此登记。 */
const OUTPUTS = [
  ["src/client.js", "lib/client.js"],
  ["src/index.js", "lib/index.js"],
];

for (const [from, to] of OUTPUTS) {
  const target = join(root, to);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(root, from), target);
  console.log(`[dsh-message-recall] ${from} -> ${to}`);
}
