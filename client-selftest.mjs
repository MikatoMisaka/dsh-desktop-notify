/**
 * 自检脚本：把浏览器半边在 Node 里按真实形状接起来，验证两条链路：
 *   1. 什么时候该弹（默认只在最小化时）；
 *   2. 点通知把窗口拉起来后，会不会切到那条通知对应的会话。
 *
 * 不起浏览器、不发真实网络请求（fetch 被替换成记录器）。
 *
 * 用法：node client-selftest.mjs
 */
let loaded

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition
    },
  },
}

await import('./lib/client.js')

if (loaded === undefined) {
  console.error('客户端包没有通过 __ModuleLoader__.load 注册')
  process.exit(1)
}
if (loaded.id !== 'dsh-desktop-notify') {
  console.error('模块 id 不对：', loaded.id)
  process.exit(1)
}

const module = loaded.factory((name) => {
  throw new Error(`不应 require(${name})`)
})
const { apply, inject } = module
console.log('module id:', loaded.id, '| inject:', inject.join(','))

/** 最小 store：getSnapshot / subscribe / 手动 set。 */
function createStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const sessionStatus = createStore(new Map())
const sessionList = createStore({ phase: 'ready', ids: [], byId: {} })
const currentSession = createStore({ key: undefined })

/** 记录投递、诊断、以及"切到哪个会话"。 */
let posted = []
const diagnostics = []
const fallbacks = []
const opened = []
const focusCalls = []

/** 供 /pending 用的待跳转会话（取一次就没了，模拟 Host 的清理语义）。 */
let pendingSession = null

globalThis.fetch = async (url, init) => {
  const target = String(url)
  const method = init?.method ?? 'GET'

  if (target.endsWith('/config')) {
    return { ok: true, status: 200, json: async () => ({ trigger: 'unfocused', sound: true }) }
  }
  if (target.endsWith('/pending')) {
    if (method === 'POST') {
      const gone = pendingSession
      pendingSession = null
      return { ok: true, status: 200, json: async () => ({ ok: true, was: gone }) }
    }
    const value = pendingSession
    pendingSession = null
    return { ok: true, status: 200, json: async () => ({ sessionId: value, ageMs: value === null ? null : 1200 }) }
  }
  if (target.endsWith('/focus')) {
    focusCalls.push(JSON.parse(init?.body ?? '{}'))
    return { ok: true, status: 200 }
  }
  if (target.endsWith('/log')) {
    diagnostics.push(JSON.parse(init.body))
    return { ok: true, status: 200 }
  }
  posted.push(JSON.parse(init.body))
  return { ok: true, status: 200 }
}
globalThis.Notification = function Notification(title, options) {
  fallbacks.push({ title, body: options?.body })
}

/** 可控的窗口状态 + 可派发的事件。 */
const listeners = new Map()
const doc = {
  visibilityState: 'hidden',
  hasFocus: () => false,
  addEventListener(type, handler) {
    const set = listeners.get(type) ?? new Set()
    set.add(handler)
    listeners.set(type, set)
  },
  removeEventListener(type, handler) {
    listeners.get(type)?.delete(handler)
  },
}
globalThis.document = doc
globalThis.window = Object.assign(globalThis.window ?? {}, {
  addEventListener(type, handler) {
    doc.addEventListener(type, handler)
  },
  removeEventListener(type, handler) {
    doc.removeEventListener(type, handler)
  },
})

function emit(type) {
  for (const handler of [...(listeners.get(type) ?? [])]) handler()
}

const ctx = {
  effect(factory) {
    const dispose = factory()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  uiSession: { sessionStatus, current: currentSession },
  sessions: { list: sessionList },
  uiWorkspace: {
    openSession(sessionId) {
      opened.push(sessionId)
    },
  },
}

apply(ctx)

/** 投递是串行 Promise 队列，读结果前要让微任务跑完。 */
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function status(entries) {
  const map = new Map()
  for (const [id, value] of Object.entries(entries)) map.set(id, value)
  sessionStatus.set(map)
}

function rows(entries) {
  const byId = {}
  for (const [id, value] of Object.entries(entries)) byId[id] = { sessionId: id, ...value }
  sessionList.set({ phase: 'ready', ids: Object.keys(byId), byId })
}

async function take(label) {
  await flush()
  const out = posted
  posted = []
  console.log(`${label} -> ${out.length} 条｜${out.map((item) => `${item.title} :: ${item.body}`).join(' ; ')}`)
  return out
}

const expect = (condition, message) => {
  if (!condition) {
    console.error('断言失败：', message)
    process.exit(1)
  }
}

// ── 触发判定（默认 trigger: unfocused）────────────────────
rows({ s1: { title: '整理本周会议纪要' } })
status({})
await take('初始')

// 1. 窗口可见、但你在别的会话上 —— 应该弹
doc.visibilityState = 'visible'
doc.hasFocus = () => true
status({ s1: { running: true, pendingInteraction: undefined } })
status({ s1: { running: false, pendingInteraction: undefined } })
const backgroundDone = await take('窗口在前台但停在别的会话')

// 2. 窗口可见、你正看着这个会话 —— 不该弹
rows({ s1: { title: '整理本周会议纪要', retainedBy: { mainView: 1 } } })
status({ s1: { running: true, pendingInteraction: undefined } })
status({ s1: { running: false, pendingInteraction: undefined } })
const watchingDone = await take('正看着该会话时完成')

// 3. 最小化后跑完 —— 应该弹
doc.visibilityState = 'hidden'
doc.hasFocus = () => false
status({ s1: { running: true, pendingInteraction: undefined } })
status({ s1: { running: false, pendingInteraction: undefined } })
const done = await take('最小化后完成')

// 4. 最小化时出现提问 —— 应该弹
status({ s1: { running: true, pendingInteraction: undefined } })
status({ s1: { running: true, pendingInteraction: { kind: 'question' } } })
const asked = await take('最小化时提问')

// 5. 最小化时工具确认 —— 应该弹，带工具名
status({ s1: { running: true, pendingInteraction: undefined } })
status({ s1: { running: true, pendingInteraction: { kind: 'approval', toolName: 'shell' } } })
const approval = await take('最小化时工具确认')

// 6. 子智能体完成 —— 不该弹
rows({ s3: { title: '子任务：抓取页面', depth: 1, parentSessionId: 's1' } })
status({ s3: { running: true, pendingInteraction: undefined } })
status({ s3: { running: false, pendingInteraction: undefined } })
const child = await take('子智能体完成')

// 7. 通知里必须带上 sessionId —— 点通知才知道跳哪
expect(done.length === 1 && done[0].sessionId === 's1', '完成通知没带 sessionId')
expect(asked.length === 1 && asked[0].sessionId === 's1', '提问通知没带 sessionId')
expect(backgroundDone.length === 1, '不在前台时应该弹')
expect(watchingDone.length === 0, '正看着该会话时不该弹')

// ── 点通知 → 窗口恢复 → 切会话 ─────────────────────────────
// 模拟：主机记下"刚才那条通知是 s1 的"，窗口从最小化恢复
pendingSession = 's1'
doc.visibilityState = 'visible'
currentSession.set({ key: 's2' })
emit('visibilitychange')
await flush()
console.log('窗口恢复后切到 ->', opened.length === 0 ? '（没有触发）' : opened.join(','))
expect(opened.length === 1 && opened[0] === 's1', '窗口恢复后没有切到 s1')
console.log('置顶请求 ->', focusCalls.length, '次')
expect(focusCalls.length >= 1, '窗口恢复后没有请求置顶')

// 7. 已经在那个会话上，就不要重复切
opened.length = 0
pendingSession = 's1'
currentSession.set({ key: 's1' })
emit('visibilitychange')
await flush()
console.log('已经在该会话 ->', opened.length === 0 ? '没重复切（正确）' : opened.join(','))
expect(opened.length === 0, '已经在该会话却重复切了')

// 8. 没有 pending 时不要乱切
pendingSession = null
emit('focus')
await flush()
console.log('无 pending 时 focus ->', opened.length === 0 ? '没切（正确）' : opened.join(','))
expect(opened.length === 0, '没有 pending 却切了会话')

// ── 断链兜底 ──────────────────────────────────────────────
const realFetch = globalThis.fetch
globalThis.fetch = async () => {
  throw new Error('route down')
}
doc.visibilityState = 'hidden'
status({ s1: { running: true, pendingInteraction: undefined } })
status({ s1: { running: false, pendingInteraction: undefined } })
await flush()
console.log('回退到浏览器通知 ->', fallbacks.length, fallbacks.map((item) => item.title).join(' ; '))
expect(fallbacks.length >= 1, 'Host 路由失败后没有回退')
globalThis.fetch = realFetch

// ── 诊断 ─────────────────────────────────────────────────
const events = diagnostics.map((item) => item.event)
expect(events.includes('client-apply'), '没有发出 client-apply 诊断')
expect(events.includes('config'), '没有发出 config 诊断')
expect(events.includes('transition'), '没有发出 transition 诊断')
expect(events.includes('navigate'), '没有发出 navigate 诊断')
console.log('诊断日志 ->', diagnostics.length, '条，事件类型：', [...new Set(events)].join(', '))

expect(asked[0].title === 'DSH 有问题要问你', '提问文案不对')
expect(approval[0].title === 'DSH 需要你确认', '确认文案不对')
expect(child.length === 0, '子智能体不该弹')
console.log('全部判定符合预期')
