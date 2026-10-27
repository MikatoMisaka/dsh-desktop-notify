/**
 * 自检脚本：把浏览器半边在 Node 里按真实形状接起来，验证：
 *   1. 什么时候该弹（三档 trigger、子智能体、限流之外的边界）；
 *   2. 点通知之后的置顶与跳会话（含"没点就不许跳"）；
 *   3. 设置行与它和 Host 默认值的优先级。
 *
 * 关键：喂的是**真实**会话行形状（displayTitle / origin / parentId / retainedBy），
 * 不是编辑出来的假字段——早先就是因为用了不存在的 parentSessionId/depth，
 * 自检一直绿而子智能体过滤其实完全没生效。
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

/** 假 react：只够跑设置行组件。 */
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children } }
  },
  useState(initial) {
    return [initial, () => {}]
  },
}

const module = loaded.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`不应 require(${name})`)
})
const { apply, inject } = module
console.log('module id:', loaded.id, '| inject:', inject.join(','))

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

/** 记录：投递 / 诊断 / 置顶 / 消费 / 导航，以及它们之间的顺序。 */
let posted = []
const diagnostics = []
const fallbacks = []
const focusCalls = []
const acks = []
const opened = []
const order = []

/** /pending 的应答（模拟 Host：只有真点过才给 sessionId）。 */
let pendingReply = { sessionId: null, token: null, source: 'none' }

/** /config 延迟应答，用来验证"用户先选、配置后到"的竞态。 */
let releaseConfig
const configGate = new Promise((resolve) => {
  releaseConfig = resolve
})

const storage = new Map()

globalThis.fetch = async (url, init) => {
  const target = String(url)
  const method = init?.method ?? 'GET'

  if (target.endsWith('/config')) {
    const value = await configGate
    return { ok: true, status: 200, json: async () => value }
  }
  if (target.endsWith('/pending')) {
    if (method === 'POST') {
      acks.push(JSON.parse(init.body ?? '{}'))
      order.push('ack')
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    return { ok: true, status: 200, json: async () => pendingReply }
  }
  if (target.endsWith('/focus')) {
    focusCalls.push(JSON.parse(init?.body ?? '{}'))
    order.push('focus')
    return { ok: true, status: 200 }
  }
  if (target.endsWith('/log')) {
    diagnostics.push(JSON.parse(init.body))
    return { ok: true, status: 200 }
  }
  posted.push(JSON.parse(init.body))
  order.push('notify')
  return { ok: true, status: 200 }
}
globalThis.Notification = function Notification(title, options) {
  fallbacks.push({ title, body: options?.body })
}

/** 可控的窗口状态 + 可派发事件。 */
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
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
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

let registered = null
let localeRegistered = null

const ctx = {
  effect(factory) {
    const dispose = factory()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  inject(_deps, callback) {
    callback({
      effect(factory) {
        const dispose = factory()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      locale: {
        register(namespace, dictionaries) {
          localeRegistered = { namespace, dictionaries }
          return () => {}
        },
      },
      slots: {
        inject(_name, factory) {
          return factory()
        },
        register(options, component) {
          registered = { options, component }
          return () => {}
        },
      },
    })
  },
  uiSession: { sessionStatus, current: currentSession },
  sessions: { list: sessionList },
  uiWorkspace: {
    openSession(sessionId) {
      opened.push(sessionId)
      order.push('navigate')
    },
  },
}

apply(ctx)

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function status(entries) {
  const map = new Map()
  for (const [id, value] of Object.entries(entries)) map.set(id, value)
  sessionStatus.set(map)
}

function rows(entries) {
  const byId = {}
  for (const [id, value] of Object.entries(entries)) byId[id] = { id, ...value }
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

// ── 设置行 + "用户先选、配置后到"的竞态 ────────────────────────────────
expect(registered !== null, '没有注册设置项')
expect(registered.options.name === 'settings.general.item', '设置槽位不对')
expect(registered.options.id === 'desktop-notify', '设置项 id 不对')
expect(registered.options.order === 18, 'order 应该避开 17（ui-chat 已占用）')
expect(localeRegistered !== null && localeRegistered.namespace === 'desktop-notify', '没有注册设置文案')
expect(
  typeof localeRegistered.dictionaries.zh.title === 'string' && typeof localeRegistered.dictionaries.en.title === 'string',
  '中英文案缺失'
)

const tree = registered.component({ t: (key) => key })
const buttons = tree.props.children[1].props.children.flat()
expect(buttons.length === 3, '应该有三个档位')
expect(buttons[0].props['data-active'] === 'true', '默认档位应该是 unfocused')

// 用户先点“总是提醒”，然后 Host 的 /config 才到（返回 minimized）
buttons[2].props.onClick()
await flush()
expect(storage.get('dsh-desktop-notify:trigger') === 'always', '选择没有落盘')
releaseConfig({ trigger: 'minimized', sound: true })
await flush()
console.log('设置行 -> 三个档位；用户先选 always，/config 后到未覆盖')
expect(storage.get('dsh-desktop-notify:trigger') === 'always', '/config 覆盖了用户选择')

// 前台盯着会话也应该弹（证明 always 真的生效，而不是只写进了 localStorage）
rows({ s1: { displayTitle: '整理本周会议纪要', retainedBy: { mainView: 1 } } })
doc.visibilityState = 'visible'
doc.hasFocus = () => true
status({ s1: { running: true, pendingInteraction: undefined } })
status({ s1: { running: false, pendingInteraction: undefined } })
const alwaysDone = await take('always 档下正看着也弹')
expect(alwaysDone.length === 1, 'always 档没生效')

// 切回默认档继续后面的用例
buttons[0].props.onClick()
await flush()

// ── 触发判定（默认 unfocused）────────────────────────────────────────
doc.visibilityState = 'visible'
doc.hasFocus = () => true
rows({ s1: { displayTitle: '整理本周会议纪要' } })
status({})
await take('初始')

status({ s1: { running: true, pendingInteraction: undefined } })
status({ s1: { running: false, pendingInteraction: undefined } })
const backgroundDone = await take('前台但停在别的会话 -> 弹')
expect(backgroundDone.length === 1, '不在看的会话跑完应当弹')

rows({ s1: { displayTitle: '整理本周会议纪要', retainedBy: { mainView: 1 } } })
status({ s1: { running: true, pendingInteraction: undefined } })
status({ s1: { running: false, pendingInteraction: undefined } })
const watchingDone = await take('正看着该会话 -> 不弹')
expect(watchingDone.length === 0, '正看着的会话不该弹')

doc.visibilityState = 'hidden'
doc.hasFocus = () => false
rows({ s1: { displayTitle: '整理本周会议纪要' } })
status({ s1: { running: true, pendingInteraction: undefined } })
status({ s1: { running: false, pendingInteraction: undefined } })
const done = await take('最小化后完成 -> 弹')
expect(done.length === 1 && done[0].sessionId === 's1', '完成通知没带 sessionId')

// ── 待回答交互的差分 ─────────────────────────────────────────────────
status({ s1: { running: true, pendingInteraction: { kind: 'question', callId: 'call-1' } } })
const asked = await take('出现提问 -> 弹')
expect(asked.length === 1 && asked[0].title === 'DSH 有问题要问你', '提问文案不对')

// 同一张卡 hide/reveal（callId 不变，对象换了）：不该重复提醒
status({ s1: { running: true, pendingInteraction: { kind: 'question', callId: 'call-1' } } })
const repeated = await take('同一张卡重挂载 -> 不重复弹')
expect(repeated.length === 0, '同一张交互卡不该重复提醒')

// 同一轮里换成工具确认（callId 变了）：应该弹
status({ s1: { running: true, pendingInteraction: { kind: 'approval', callId: 'call-2', toolName: 'shell' } } })
const approval = await take('换成工具确认 -> 弹')
expect(approval.length === 1 && approval[0].title === 'DSH 需要你确认', '确认文案不对')
expect(approval[0].body.includes('shell'), '确认正文应当带工具名')

// ── 子智能体（真实行形状：origin + parentId）───────────────────────────
rows({ s3: { displayTitle: '子任务：抓取页面', origin: 'subagent', parentId: 's1' } })
status({ s3: { running: true, pendingInteraction: undefined } })
status({ s3: { running: false, pendingInteraction: undefined } })
const child = await take('子智能体完成 -> 不弹')
expect(child.length === 0, '子智能体不该单独弹')

// ── 会话短暂消失（墓碑）──────────────────────────────────────────────
rows({ s4: { displayTitle: '转码任务' } })
status({ s4: { running: true, pendingInteraction: undefined } })
await take('跑起来')
rows({})                        // 会话从快照里消失（存档/重连抖动）
status({})
await take('消失')
rows({ s4: { displayTitle: '转码任务' } })
status({ s4: { running: false, pendingInteraction: undefined } })
const back = await take('重新出现且已完成 -> 弹')
expect(back.length === 1, '会话短暂消失期间的那个完成被漏掉了')

// ── 点通知：置顶 + 跳会话 ────────────────────────────────────────────
order.length = 0
pendingReply = { sessionId: 's1', token: 'tok-1', source: 'click' }
doc.visibilityState = 'visible'
doc.hasFocus = () => false
currentSession.set({ key: 's2' })
emit('visibilitychange')
await flush()
console.log('点通知后 ->', `导航 ${opened.join(',') || '无'} / 置顶 ${focusCalls.length} 次 / 消费 ${acks.length} 次`)
expect(opened.length === 1 && opened[0] === 's1', '没有切到被点的会话')
expect(focusCalls.length === 1, '没焦点时应当补一次置顶')
expect(acks.length === 1 && acks[0].token === 'tok-1', '没有按 token 消费')
expect(order.indexOf('navigate') < order.indexOf('ack'), '应当先导航成功再消费 pending')

// 已经在该会话：不重复跳，但要消费
opened.length = 0
focusCalls.length = 0
acks.length = 0
pendingReply = { sessionId: 's1', token: 'tok-2', source: 'click' }
currentSession.set({ key: 's1' })
emit('visibilitychange')
await flush()
console.log('已在目标会话 ->', `导航 ${opened.length} 次 / 消费 ${acks.length} 次`)
expect(opened.length === 0 && acks.length === 1, '已在目标会话应只消费不导航')

// 没点过通知：不许跳（这是"自己切回窗口被劫持"的回归测试）
opened.length = 0
acks.length = 0
pendingReply = { sessionId: null, token: null, source: 'none' }
currentSession.set({ key: 's2' })
emit('focus')
await flush()
console.log('没点过通知 ->', `导航 ${opened.length} 次`)
expect(opened.length === 0, '没点通知却跳了会话')

// ── 断链兜底 ─────────────────────────────────────────────────────────
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

// ── 诊断 ─────────────────────────────────────────────────────────────
const events = diagnostics.map((item) => item.event)
for (const required of ['client-apply', 'transition', 'navigate', 'settings-registered']) {
  expect(events.includes(required), `没有发出 ${required} 诊断`)
}
console.log('诊断日志 ->', diagnostics.length, '条，事件类型：', [...new Set(events)].join(', '))
console.log('全部判定符合预期')
