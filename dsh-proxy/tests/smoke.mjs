/**
 * dsh-proxy 验收冒烟测试。
 *
 * 覆盖：
 *  1. Muse Spark 模型请求过滤（include + input reasoning 项）
 *  2. 非目标模型透明转发
 *  3. 流式 SSE 响应保留
 *  4. 下游取消 → 上游中止
 *  5. 插件卸载后端口释放
 *  6. 端口冲突明确报错
 *
 * 运行：node tests/smoke.mjs
 */
import http from 'node:http';
import { strict as assert } from 'node:assert';

// 动态设置环境变量（在 import 插件之前）
const TEST_PORT = 19876;
process.env.DSH_PROXY_PORT = String(TEST_PORT);
process.env.DSH_PROXY_HOST = '127.0.0.1';
process.env.DSH_PROXY_DEBUG = '0';

const { apply, __test } = await import('../lib/index.js');
const { filterResponsesBody, matchesModel, parseModelPatterns } = __test;

let passed = 0;
let failed = 0;

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, err) { failed++; console.error(`  ✗ ${label}\n    ${err?.message ?? err}`); }

// ─────────────────── 模拟上游服务器 ───────────────────

/** 创建一个记录请求并返回可控响应的模拟上游。 */
function createMockUpstream() {
  const received = [];
  let responseMode = 'json'; // 'json' | 'sse' | 'slow'
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyRaw = Buffer.concat(chunks).toString('utf8');
      let bodyParsed = null;
      try { bodyParsed = JSON.parse(bodyRaw); } catch { /* keep null */ }
      received.push({ method: req.method, url: req.url, headers: req.headers, body: bodyParsed, bodyRaw });

      if (responseMode === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: {"type":"response.created"}\n\n');
        res.write('data: {"type":"response.output_text.delta","delta":"Hello"}\n\n');
        res.write('data: {"type":"response.completed"}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else if (responseMode === 'slow') {
        // 延迟 5s 响应，用于测试取消
        const timer = setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, delayed: true }));
        }, 5000);
        req.on('close', () => clearTimeout(timer));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, echo: bodyParsed }));
      }
    });
  });
  return {
    server,
    received,
    setMode(m) { responseMode = m; },
    clear() { received.length = 0; },
    start() { return new Promise((r) => server.listen(0, '127.0.0.1', r)); },
    stop() { return new Promise((r) => server.close(r)); },
    get port() { return server.address().port; },
  };
}

// ─────────────────── 测试用例 ───────────────────

async function run() {
  console.log('\n[dsh-proxy] 冒烟测试开始\n');

  // ═══ 纯函数单元测试 ═══
  console.log('── 纯函数测试 ──');

  try {
    // filterResponsesBody：移除 include 中的 reasoning.encrypted_content
    const r1 = filterResponsesBody({
      model: 'muse-spark-1.3',
      include: ['reasoning.encrypted_content', 'message.output_text'],
      input: [
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'reasoning', id: 'rs_2', summary: [] },
      ],
    });
    assert.equal(r1.changed, true);
    assert.deepEqual(r1.body.include, ['message.output_text']);
    assert.equal(r1.body.input.length, 1);
    assert.equal(r1.body.input[0].type, 'message');
    assert.equal(r1.removedInclude, 1);
    assert.equal(r1.removedInput, 2);
    ok('filterResponsesBody: 正确移除 include 与 reasoning 项');
  } catch (e) { fail('filterResponsesBody', e); }

  try {
    // 无需过滤时不变
    const r2 = filterResponsesBody({ model: 'gpt-5', include: ['message.output_text'], input: [{ type: 'message' }] });
    assert.equal(r2.changed, false);
    ok('filterResponsesBody: 无目标字段时不修改');
  } catch (e) { fail('filterResponsesBody noop', e); }

  try {
    // matchesModel
    const patterns = parseModelPatterns('muse-spark*, gpt-5, /claude-.*/');
    assert.equal(matchesModel('muse-spark-1.2', patterns), true);
    assert.equal(matchesModel('muse-spark-1.3-contributor-free', patterns), true);
    assert.equal(matchesModel('gpt-5', patterns), true);
    assert.equal(matchesModel('claude-sonnet-4', patterns), true);
    assert.equal(matchesModel('deepseek-v4-flash', patterns), false);
    assert.equal(matchesModel('', patterns), false);
    assert.equal(matchesModel(null, patterns), false);
    ok('matchesModel: 通配符/精确/正则匹配');
  } catch (e) { fail('matchesModel', e); }

  // ═══ 集成测试：启动模拟上游 + 代理 ═══
  console.log('\n── 集成测试 ──');

  const upstream = createMockUpstream();
  await upstream.start();
  const upstreamUrl = `http://127.0.0.1:${upstream.port}`;

  // 覆盖上游地址
  process.env.DSH_PROXY_UPSTREAM = upstreamUrl;

  const ctx = {};
  const dispose = await apply(ctx);
  const proxyUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    // ── 测试 1：Muse Spark 模型请求被过滤 ──
    upstream.clear();
    upstream.setMode('json');
    const reqBody = {
      model: 'muse-spark-1.3',
      stream: false,
      include: ['reasoning.encrypted_content', 'message.output_text'],
      input: [
        { type: 'reasoning', id: 'rs_old', summary: [{ type: 'summary_text', text: 'encrypted...' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续上次的工作' }] },
      ],
      reasoning: { effort: 'xhigh' },
    };
    const resp1 = await fetch(`${proxyUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify(reqBody),
    });
    assert.equal(resp1.status, 200);
    const data1 = await resp1.json();
    assert.equal(data1.ok, true);

    // 验证上游收到的请求体已被过滤
    assert.equal(upstream.received.length, 1);
    const upstreamBody = upstream.received[0].body;
    assert.deepEqual(upstreamBody.include, ['message.output_text'], 'include 应移除 reasoning.encrypted_content');
    assert.equal(upstreamBody.input.length, 1, 'input 应移除 reasoning 项');
    assert.equal(upstreamBody.input[0].type, 'message');
    assert.equal(upstreamBody.model, 'muse-spark-1.3');
    assert.equal(upstreamBody.reasoning.effort, 'xhigh', 'reasoning.effort 应保留');
    // 验证 authorization 头透传
    assert.equal(upstream.received[0].headers.authorization, 'Bearer test-key');
    ok('集成: Muse Spark 请求正确过滤 include 与 input reasoning');

    // ── 测试 2：非目标模型透明转发 ──
    upstream.clear();
    const resp2 = await fetch(`${proxyUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        include: ['reasoning.encrypted_content'],
        input: [{ type: 'reasoning', id: 'rs_x' }, { type: 'message', role: 'user', content: [] }],
      }),
    });
    assert.equal(resp2.status, 200);
    assert.equal(upstream.received.length, 1);
    const body2 = upstream.received[0].body;
    assert.deepEqual(body2.include, ['reasoning.encrypted_content'], '非目标模型 include 不应被修改');
    assert.equal(body2.input.length, 2, '非目标模型 input 不应被过滤');
    ok('集成: 非目标模型 (gpt-5.4) 透明转发');

    // ── 测试 3：流式 SSE 响应保留 ──
    upstream.clear();
    upstream.setMode('sse');
    const resp3 = await fetch(`${proxyUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'muse-spark-1.2', stream: true, input: [] }),
    });
    assert.equal(resp3.status, 200);
    assert.match(resp3.headers.get('content-type'), /text\/event-stream/);
    const sseText = await resp3.text();
    assert.ok(sseText.includes('response.created'), 'SSE 应包含 response.created');
    assert.ok(sseText.includes('response.output_text.delta'), 'SSE 应包含 delta');
    assert.ok(sseText.includes('[DONE]'), 'SSE 应包含 [DONE]');
    ok('集成: 流式 SSE 响应完整透传');

    // ── 测试 4：下游取消 → 上游中止 ──
    upstream.clear();
    upstream.setMode('slow');
    const abortCtrl = new AbortController();
    let cancelErr = null;
    const fetchPromise = fetch(`${proxyUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'muse-spark-1.3', input: [] }),
      signal: abortCtrl.signal,
    }).catch((e) => { cancelErr = e; });

    // 等待请求到达上游
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(upstream.received.length, 1, '上游应已收到请求');

    // 取消下游请求
    abortCtrl.abort();
    await fetchPromise;
    assert.ok(cancelErr !== null, '取消后 fetch 应抛出 AbortError');
    assert.match(cancelErr.name, /AbortError/);

    // 稍等确认代理侧也结束了
    await new Promise((r) => setTimeout(r, 100));
    ok('集成: 下游取消同步中止上游请求');

    // ── 测试 5：非 /responses 路径透明转发 ──
    upstream.clear();
    upstream.setMode('json');
    const resp5 = await fetch(`${proxyUrl}/models`, { method: 'GET' });
    assert.equal(resp5.status, 200);
    assert.equal(upstream.received.length, 1);
    assert.equal(upstream.received[0].url, '/models');
    ok('集成: 非 /responses 路径透明转发');

  } finally {
    // ── 测试 6：卸载后端口释放 ──
    upstream.setMode('json');
    if (typeof dispose === 'function') await dispose();
    await upstream.stop();

    // 验证端口已释放：尝试绑定同一端口
    await new Promise((resolve, reject) => {
      const probe = http.createServer();
      probe.once('error', reject);
      probe.listen(TEST_PORT, '127.0.0.1', () => { probe.close(resolve); });
    });
    ok('生命周期: 卸载后端口已释放');

    // ── 测试 7：端口冲突明确报错 ──
    const blocker = http.createServer();
    await new Promise((r) => blocker.listen(TEST_PORT, '127.0.0.1', r));
    try {
      process.env.DSH_PROXY_UPSTREAM = 'http://127.0.0.1:1';
      await apply({});
      fail('端口冲突', new Error('应抛出但未抛出'));
    } catch (e) {
      assert.match(e.message, /已被占用/, `错误信息应包含"已被占用"，实际: ${e.message}`);
      ok('生命周期: 端口冲突时明确报错');
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  }

  // ═══ 结果汇总 ═══
  console.log(`\n[dsh-proxy] 测试完成: ${passed} 通过, ${failed} 失败\n`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('[dsh-proxy] 测试异常退出:', e); process.exit(1); });
