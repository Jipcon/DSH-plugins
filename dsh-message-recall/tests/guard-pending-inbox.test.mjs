/**
 * 撤回守卫回归测试：用真实会话日志核对"消息仍排在待处理队列时禁止撤回"这道守卫。
 *
 * 背景（用户实际遭遇的 bug）：
 *   对 session-9a908c4c 的最后一条消息发起编辑重发，host 以 boundary=420 计算 cut=422
 *   （= turn/end 的下一个 log offset），seed = events[0..422)。
 *   而那条消息当时还挂在 next-turn inbox 里：入队在 seq=421（index 422，正好是 seed 的最后一条），
 *   认领要等到 seq=423。于是 fork 出的 session-7bf8cf72 一开张 inbox 里就挂着它——
 *   子会话第一个回合发的是这条继承消息，用户编辑后的文本反而进不去，
 *   表现为"原消息被重发 + 编辑文本像插队"。
 *
 * 守卫：撤回前若目标消息仍在 next-turn inbox 队列且尚未进入 user/message 记录，直接拒绝
 * （host 返回 409 message-pending，客户端提示等待本回合结束）。
 *
 * 依赖本机 .dsh 会话日志（含出问题的那两个会话），属开发者回归工具，不随包发布。
 * 用法：node tmp-guard-test.mjs
 */
import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const BASE = process.env.USERPROFILE + '\\.dsh\\sessions\\--D-deepseek-harness--'
const OLD = 'session-9a908c4c-4538-408f-89e8-38a25361306d'
const NEW = 'session-7bf8cf72-d4d0-4bde-a185-17d723569dfa'
const MSG = 'c5bbb993-8e4f-4fcf-b2bf-b098599dac88'
// 新会话的 session/end-seed 落在 index 423 → seed = [0..423)，共 423 条。
// （inheritedEventCount=422 是逻辑序号上界，不是事件条数。）
const SEED_LEN = 423

/** dsh 会话日志是 zstd 帧容器（多帧拼接），单次解压只得第一帧，故按 magic 切帧。 */
function decodeFrames(buf) {
  const starts = []
  let i = buf.indexOf(MAGIC, 0)
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4) }
  const out = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { out.push(zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')) } catch { /* 截断帧 */ }
  }
  return out.join('')
}
async function loadEvents(id) {
  const text = decodeFrames(await readFile(`${BASE}\\${id}\\session.v3.jsonl.zstd`))
  return text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))
}

// ---- 以下四个函数与 lib/index.js 中的实现保持一致（host 文件有副作用，不能直接 import） ----
function foldPendingTurnInbox(events) {
  let queue = []
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const splice = event.data
    if (!splice || splice.target !== 'next-turn') continue
    const inserted = Array.isArray(splice.inserted) ? splice.inserted : []
    const removed = splice.removedCount ?? 0
    const start = Number.isSafeInteger(splice.start) && splice.start >= 0 ? splice.start : 0
    queue = queue.toSpliced(start, removed, ...inserted)
  }
  return queue
}
function pendingInboxMessageId(events, messageId) {
  if (typeof messageId !== 'string' || messageId.length === 0) return null
  return foldPendingTurnInbox(events).some(m => m && m.id === messageId) ? messageId : null
}
function claimedInLog(events, messageId) {
  if (typeof messageId !== 'string' || messageId.length === 0) return false
  return events.some(e => e.type === 'user/message' && e.data && e.data.id === messageId)
}
function inOpenTurn(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn/end') return false
    if (events[i].type === 'turn/start') return true
  }
  return false
}
function findTurnEndBefore(events, targetIdx) {
  for (let i = targetIdx - 1; i >= 0; i--) if (events[i].type === 'turn/end') return events[i].seq
  return -1
}
/** 守卫整体判定：null 表示放行，否则为拒绝码。 */
function guardVerdict(events, messageId, targetSeq) {
  if (pendingInboxMessageId(events, messageId) !== null && !claimedInLog(events, messageId)) return 'message-pending'
  const idx = events.findIndex(e => e.seq === targetSeq)
  if (idx === -1) return 'invalid-target'
  if (inOpenTurn(events)) return 'turn-open'
  return null
}

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

console.log('A. 取边界那一刻（seed = 前 423 条，即 host 当时看到的状态）')
{
  const seed = (await loadEvents(OLD)).slice(0, SEED_LEN)
  const queue = foldPendingTurnInbox(seed)
  console.log(`  末条=${seed[seed.length - 1]?.type}  待处理队列=${queue.length}`)
  for (const m of queue) {
    const t = (m.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
    console.log(`    待处理: id=${m.id?.slice(0, 8)} text=${JSON.stringify(t.slice(0, 34))}`)
  }
  check('seed 中存在未认领的待处理消息', queue.some(m => m.id === MSG), true)
  check('该消息尚未进入记录', claimedInLog(seed, MSG), false)
  check('守卫拒绝（bug 场景被拦下）', guardVerdict(seed, MSG, 425), 'message-pending')
}

console.log('\nB. 事后全量（消息已被认领，守卫应放行）')
{
  const all = await loadEvents(OLD)
  const idx = all.findIndex(e => e.type === 'user/message' && e.data?.id === MSG)
  console.log(`  队列=${foldPendingTurnInbox(all).length}  目标 idx=${idx} seq=${all[idx]?.seq}  前置边界=${findTurnEndBefore(all, idx)}`)
  check('队列已清空', foldPendingTurnInbox(all).length, 0)
  check('已进入记录', claimedInLog(all, MSG), true)
  check('守卫放行（不误伤正常撤回）', guardVerdict(all, MSG, 425), null)
}

console.log('\nC. 新会话 seed（bug 产物，仅作对照）')
{
  const seed = (await loadEvents(NEW)).slice(0, SEED_LEN)
  const queue = foldPendingTurnInbox(seed)
  console.log(`  被带入的待处理消息数=${queue.length}`)
  check('原消息确被 fork 带进新会话 inbox', queue.some(m => m.id === MSG), true)
}

console.log('\nD. 旧客户端兼容（不带 messageId 时守卫不启用）')
{
  const seed = (await loadEvents(OLD)).slice(0, SEED_LEN)
  check('缺少 id 时不误报', pendingInboxMessageId(seed, null), null)
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`)
process.exit(failures === 0 ? 0 : 1)
