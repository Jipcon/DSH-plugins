/**
 * dsh-codex-auth 构建脚本。
 *
 * lib/index.js 为 host 半边源码（直接维护）；src/client.js 为浏览器半边源码，
 * 构建只做一次拷贝：src/client.js -> lib/client.js（模块表工厂，原样加载）。
 *
 * 用法：node build.mjs
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

const OUTPUTS = [
  ["src/client.js", "lib/client.js"],
];

for (const [from, to] of OUTPUTS) {
  const target = join(root, to);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(root, from), target);
  console.log(`[dsh-codex-auth] ${from} -> ${to}`);
}
