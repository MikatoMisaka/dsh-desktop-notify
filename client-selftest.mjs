/**
 * 自检脚本：把浏览器半边在 Node 里按真实形状接起来，验证触发判定。
 * 不起浏览器、不发网络请求（fetch 被替换成记录器），只验证「什么时候该弹」。
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

/** 记录所有投递请求与浏览器通知回退。 */
let posted = []
const diagnostics = []
const fallbacks = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.endsWith('/config')) {
    return { ok: true, status: 200, json: async () => ({ notifyWhenFocused: false, sound: true }) }
  }
  const payload = JSON.parse(init.body)
  if (target.endsWith('/log')) diagnostics.push(payload)
  else posted.push(payload)
  return { ok: true, status: 200 }
}
globalThis.Notification = function Notification(title, options) {
  fallbacks.push({ title, body: options?.body })
}

/** 可控的窗口前台状态。 */
const doc = { visibilityState: 'hidden', hasFocus: () => false }
globalThis.document = doc

const ctx = {
  effect(factory) {
    const dispose = factory()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  uiSession: { sessionStatus },
  sessions: { list: sessionList },
}

apply(ctx)

/** 投递是串行 Promise 队列，读结果前要让微任务跑完。 */
const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
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

// 1. 先把会话挂进列表（标题来自列表行）
rows({ s1: { title: '整理本周会议纪要' } })

// 2. 基线：没有任何会话状态时不弹
status({})
await take('初始')

// 3. 开始跑 —— 不该弹
status({ s1: { running: true, pendingInteraction: undefined, completionUnread: false } })
await take('开始运行')

// 4. 跑完 —— 应该弹「任务完成」
status({ s1: { running: false, pendingInteraction: undefined, completionUnread: true } })
const done = await take('运行结束')

// 5. 跑着跑着停下来问你 —— 应该弹「有问题要问你」
status({ s1: { running: true, pendingInteraction: undefined, completionUnread: false } })
status({ s1: { running: true, pendingInteraction: { kind: 'question' }, completionUnread: false } })
await take('出现提问')

// 6. 你回答后继续跑完 —— 完成时因为之前有交互，不应该重复弹「完成」
status({ s1: { running: true, pendingInteraction: undefined, completionUnread: false } })
status({ s1: { running: false, pendingInteraction: undefined, completionUnread: true } })
await take('交互后完成')

// 7. 工具确认：应弹「需要你确认」，并带工具名
status({ s1: { running: true, pendingInteraction: undefined } })
status({ s1: { running: true, pendingInteraction: { kind: 'approval', toolName: 'shell' } } })
await take('工具确认')

// 8. 你正盯着这个会话：不该弹
rows({ s1: { title: '整理本周会议纪要', retainedBy: { mainView: 1 } } })
doc.visibilityState = 'visible'
doc.hasFocus = () => true
status({ s1: { running: true, pendingInteraction: undefined } })
status({ s1: { running: false, pendingInteraction: undefined } })
await take('前台盯着该会话时完成')

// 9. 后台会话完成、你在看前台：应该弹
rows({
  s1: { title: '整理本周会议纪要', retainedBy: { mainView: 1 } },
  s2: { title: '后台批量转码' },
})
status({
  s1: { running: false, pendingInteraction: undefined },
  s2: { running: true, pendingInteraction: undefined },
})
status({
  s1: { running: false, pendingInteraction: undefined },
  s2: { running: false, pendingInteraction: undefined },
})
await take('后台会话完成')

// 10. 子智能体/派生会话完成：不该弹（交给父会话那一轮统一提醒）
rows({ s3: { title: '子任务：抓取页面', depth: 1, parentSessionId: 's1' } })
status({ s3: { running: true, pendingInteraction: undefined } })
status({ s3: { running: false, pendingInteraction: undefined } })
await take('子智能体完成')

// 11. Host 路由不可用时的回退
globalThis.fetch = async () => {
  throw new Error('route down')
}
status({ s2: { running: true, pendingInteraction: undefined } })
status({ s2: { running: false, pendingInteraction: undefined } })
await flush()
console.log('回退到浏览器通知 ->', fallbacks.length, fallbacks.map((item) => item.title).join(' ; '))

if (done.length !== 1 || done[0].title !== 'DSH · 任务已完成') {
  console.error('任务完成判定不对')
  process.exit(1)
}
if (fallbacks.length < 1) {
  console.error('Host 路由失败后没有回退')
  process.exit(1)
}

// 12. 诊断日志必须真的发：client-apply + 每次判定各一条
const events = diagnostics.map((item) => item.event)
if (!events.includes('client-apply')) {
  console.error('没有发出 client-apply 诊断')
  process.exit(1)
}
if (!events.includes('transition')) {
  console.error('没有发出 transition 诊断')
  process.exit(1)
}
console.log('诊断日志 ->', diagnostics.length, '条，事件类型：', [...new Set(events)].join(', '))
console.log('全部判定符合预期')
