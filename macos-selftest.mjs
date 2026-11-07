/**
 * macOS 适配自检（任何平台上都能跑：用 `platform: 'darwin'` 让 Host 走 mac 分支）。
 *
 * 验的是「委派」这条链路，而不是 Windows 的 toast：
 *   正文由 Host 拼好（含回复预览、会话名、限流、去重）→ 原样回给浏览器半边 →
 *   由渲染进程的 `new Notification()` 弹出、点击直接跳会话。
 *
 * 用法：node macos-selftest.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './lib/index.js'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-notify-macos-'))

const routes = []
const eventHandlers = new Map()

const ctx = {
  effect(factory) {
    const dispose = factory()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  on(name, handler) {
    eventHandlers.set(name, handler)
    return () => eventHandlers.delete(name)
  },
  webServer: {
    register(spec) {
      routes.push(spec)
      return () => {}
    },
  },
  logger: { warn() {}, info() {}, debug() {} },
}

// protocol:false 与 dryRun 在 mac 分支上都不起作用，写在这里是为了证明
// 「即使把 Windows 的开关原样传进来，也不会去 spawn powershell / 写注册表」。
apply(ctx, { platform: 'darwin', dryRun: true, protocol: false, dataDir })

const HOST = '127.0.0.1:5441'

function makeRequest({ method, headers = {}, body }) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    destroy() {},
  }
}

function makeResponse() {
  const res = {
    status: 0,
    body: '',
    writeHead(status) {
      res.status = status
    },
    end(payload) {
      res.body = payload ?? ''
    },
  }
  return res
}

async function call(target, request) {
  const res = makeResponse()
  await target.handler(request, res)
  return { status: res.status, body: res.body }
}

const post = (payload) =>
  makeRequest({
    method: 'POST',
    headers: { host: HOST, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

const get = () => makeRequest({ method: 'GET', headers: { host: HOST } })

const expect = (condition, message) => {
  if (!condition) {
    console.error('断言失败：', message)
    process.exit(1)
  }
}

const pick = (suffix) => routes.find((candidate) => candidate.path.endsWith(suffix))
const notifyRoute = pick('/notify')
const configRoute = pick('/config')
const focusRoute = pick('/focus')
const pendingRoute = pick('/pending')

console.log('路由数 ->', routes.length)
expect(routes.length === 5, '五条路由必须都注册（notify / log / config / pending / focus）')
expect(notifyRoute && configRoute && focusRoute && pendingRoute, '路由不齐')

// ── 能力声明 ──────────────────────────────────────────────────────────
const config = await call(configRoute, get())
const cfg = JSON.parse(config.body)
console.log('GET /config ->', config.body)
expect(cfg.platform === 'darwin', '/config 必须报 darwin')
expect(cfg.capabilities?.toast === false, 'macOS 上 Host 不该自己弹 toast')
expect(cfg.capabilities?.delegate === true, 'macOS 上必须开委派')
expect(cfg.protocol === false, 'macOS 上不得登记 dsh-notify: 协议')
expect(cfg.aumidState === 'unsupported', 'macOS 上不该做 AUMID 探测')

// ── 空通知仍然要拒 ────────────────────────────────────────────────────
const empty = await call(notifyRoute, post({}))
console.log('POST 空 body ->', empty.status, empty.body)
expect(empty.status === 400, '两个字段都空必须 400')

// ── 回复预览：Host 拼正文，原样委派出去 ───────────────────────────────
const agentStatus = eventHandlers.get('agent/status')
expect(typeof agentStatus === 'function', '没有订阅 agent/status，预览拿不到回复')
agentStatus({
  status: 'idle',
  agent: {
    id: 'session-mac',
    session: {
      header: { id: 'session-mac' },
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: '看看这个方案' }] },
        { role: 'assistant', content: [{ type: 'text', text: '方案可行，把第二步的权限校验补上。' }] },
      ],
    },
  },
})

const delegated = await call(
  notifyRoute,
  post({ kind: 'complete', label: '方案评审', preview: true, sessionId: 'session-mac', key: 'mac-complete' })
)
const payload = JSON.parse(delegated.body)
console.log('POST 完成通知 ->', delegated.status, delegated.body)
expect(delegated.status === 200, '完成通知应当 200')
expect(payload.ok === true, '应当回 ok')
expect(payload.delegate === 'darwin', '必须告诉浏览器半边"这条你来弹"')
expect(typeof payload.body === 'string' && payload.body.includes('方案可行'), '委派正文没有带上回复预览')
expect(payload.body.includes('方案评审'), '委派正文丢了会话名')
// 行数组是给系统通知用的：会话名一行、预览一行，客户端用换行拼回去
expect(Array.isArray(payload.lines) && payload.lines.length === 2, '委派应当给出两行（会话名 / 预览）')
expect(payload.lines[0] === '方案评审', '委派第一行应当是会话名')
expect(payload.body === payload.lines.join('\n'), 'body 应当等于 lines 用换行拼接')
expect(typeof payload.title === 'string' && payload.title !== '', '委派时必须给出标题')
expect(payload.sessionId === 'session-mac', '委派时要回带 sessionId，点击才能跳会话')

// ── 提问类通知：会话名与细节也分两行 ───────────────────────────────────
const pendingNotify = await call(
  notifyRoute,
  post({ kind: 'pending', label: '方案评审', detail: '会话停下来等你回答。', key: 'mac-pending', sessionId: 'session-mac' })
)
const pendingPayload = JSON.parse(pendingNotify.body)
console.log('POST 提问通知 ->', pendingNotify.status, pendingNotify.body)
expect(pendingNotify.status === 200 && pendingPayload.delegate === 'darwin', '提问通知同样要委派')
expect(pendingPayload.body === '方案评审\n会话停下来等你回答。', '提问通知也该是"会话名 / 细节"两行')

// ── 去重依旧生效 ──────────────────────────────────────────────────────
const dup = await call(
  notifyRoute,
  post({ title: 'DSH 有问题要问你', body: '方案评审：会话停下来等你回答。', key: 'mac-pending' })
)
console.log('POST 同 key 立即重发 ->', dup.status, dup.body)
expect(JSON.parse(dup.body).skipped === 'duplicate', '委派路径也要保持 1.5s 同 key 去重')

// ── 点击落点：Host 不记 token，/pending 不该凭空指路 ───────────────────
const pendingGet = await call(pendingRoute, get())
console.log('GET /pending ->', pendingGet.status, pendingGet.body)
expect(JSON.parse(pendingGet.body).sessionId === null, 'macOS 走本地点击，Host 不该有 pending')

// ── 置顶/前台：Host 不做，交回浏览器半边 ──────────────────────────────
const focus = await call(focusRoute, post({ reason: 'notification-click' }))
console.log('POST /focus ->', focus.status, focus.body)
expect(focus.status === 200 && JSON.parse(focus.body).ok === false, 'macOS 上 /focus 应当回 false')
expect(JSON.parse(focus.body).delegate === 'darwin', '/focus 应当说明该由浏览器半边处理')

// ── 日志：确实走了委派分支，而不是 Windows 的 dry-run ───────────────────
const logText = readFileSync(join(dataDir, 'host.log'), 'utf8')
const lines = logText.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
const kinds = new Set(lines.map((line) => line.kind))
console.log('日志事件 ->', [...kinds].join(', '))
expect(kinds.has('host-ready'), '日志里应当有 host-ready')
expect(kinds.has('notify-delegated'), '日志里应当有 notify-delegated')
expect(!kinds.has('notify-dry-run'), 'macOS 分支不该走 Windows 的 show()/dry-run')
expect(!kinds.has('notify-exit'), 'macOS 分支不该 spawn PowerShell')
expect(lines.find((line) => line.kind === 'host-ready')?.platform === 'darwin', 'host-ready 应当带平台')

try {
  rmSync(dataDir, { recursive: true, force: true })
} catch {
  // 在系统临时目录里，删不掉无所谓。
}
console.log('macOS 委派链路全部符合预期')
