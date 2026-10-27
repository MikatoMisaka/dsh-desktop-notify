/**
 * 自检脚本：不启动 DSH，直接把 Host 半边按真实 ctx 形状接起来跑一遍。
 * 覆盖：路由注册、来源校验、Content-Type、限流去重、pending 的 token 语义、真实弹通知。
 *
 * 用法：node selftest.mjs        （会真的弹一条通知，用来验证通知通道本身）
 */
import { apply } from './lib/index.js'

/** 收集 apply 期间注册的路由。 */
const routes = []

const ctx = {
  effect(factory) {
    const dispose = factory()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  webServer: {
    register(spec) {
      routes.push(spec)
      return () => {}
    },
  },
  logger: { warn() {}, info() {}, debug() {} },
}

// protocol:false —— 自检不往真实注册表写东西；这也让 /pending 走"退路模式"分支。
apply(ctx, { protocol: false })

if (routes.length !== 5) {
  console.error('期望注册 5 条路由（notify + log + config + pending + focus），实际', routes.length)
  process.exit(1)
}

const route = routes.find((candidate) => candidate.path.endsWith('/notify'))
const logRoute = routes.find((candidate) => candidate.path.endsWith('/log'))
const configRoute = routes.find((candidate) => candidate.path.endsWith('/config'))
const pendingRoute = routes.find((candidate) => candidate.path.endsWith('/pending'))
const focusRoute = routes.find((candidate) => candidate.path.endsWith('/focus'))
if (!route || !logRoute || !configRoute || !pendingRoute || !focusRoute) {
  console.error('路由不齐:', routes.map((candidate) => candidate.path).join(', '))
  process.exit(1)
}
for (const candidate of routes) console.log('route:', candidate.kind, candidate.path)

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

const json = (payload) => JSON.stringify(payload)
const post = (payload, headers = {}) =>
  makeRequest({
    method: 'POST',
    headers: { host: HOST, 'content-type': 'application/json', ...headers },
    body: json(payload),
  })

const expect = (condition, message) => {
  if (!condition) {
    console.error('断言失败：', message)
    process.exit(1)
  }
}

// ── 来源与 Content-Type ────────────────────────────────────────────────
const noType = await call(route, makeRequest({ method: 'POST', headers: { host: HOST }, body: json({ title: 'x', body: 'y' }) }))
console.log('POST 无 Content-Type ->', noType.status)
expect(noType.status === 403, 'no-cors 的 text/plain 请求必须被拒')

const crossPort = await call(route, post({ title: 'x', body: 'y' }, { origin: 'http://127.0.0.1:3000' }))
console.log('POST 跨端口 Origin ->', crossPort.status)
expect(crossPort.status === 403, '不同 authority 的 Origin 必须被拒')

const crossSite = await call(route, post({ title: 'x', body: 'y' }, { 'sec-fetch-site': 'cross-site' }))
console.log('POST sec-fetch-site=cross-site ->', crossSite.status)
expect(crossSite.status === 403, 'cross-site 必须被拒')

const foreignHost = await call(
  route,
  makeRequest({ method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' }, body: json({ title: 'x', body: 'y' }) })
)
console.log('POST 非本机 Host ->', foreignHost.status)
expect(foreignHost.status === 403, '域名 Host 必须被拒（DNS rebinding）')

const sameOrigin = await call(
  route,
  post({ title: 'DSH 通知自检', body: '同 authority 的请求应当放行。', key: 'selftest' }, { origin: `http://${HOST}` })
)
console.log('POST 同 authority Origin ->', sameOrigin.status, sameOrigin.body)
expect(sameOrigin.status === 200 && JSON.parse(sameOrigin.body).ok === true, '同 authority 应当放行并成功')

// ── 方法 ─────────────────────────────────────────────────────────────
const wrongMethod = await call(route, makeRequest({ method: 'GET', headers: { host: HOST } }))
console.log('GET /notify ->', wrongMethod.status)
expect(wrongMethod.status === 405, 'GET 应当 405')

// ── 空通知 ───────────────────────────────────────────────────────────
const empty = await call(route, post({}))
console.log('POST 空 body ->', empty.status, empty.body)
expect(empty.status === 400, '两个字段都空必须 400（否则会弹一条空白 toast）')

// ── 去重 ─────────────────────────────────────────────────────────────
const dup = await call(route, post({ title: 'DSH 通知自检', body: '重复键应当被去重', key: 'selftest' }))
console.log('POST 同 key 立即重发 ->', dup.status, dup.body)
expect(JSON.parse(dup.body).skipped === 'duplicate', '同 key 1.5s 内应当去重')

// ── pending：一条通知一个 token ───────────────────────────────────────
const withSession = await call(route, post({ title: '带会话的通知', body: '用来验证点通知跳会话', key: 'pending-probe', sessionId: 'session-abc' }))
console.log('POST 带 sessionId ->', withSession.status, withSession.body)

const pendingGet = await call(pendingRoute, makeRequest({ method: 'GET', headers: { host: HOST } }))
console.log('GET /pending（退路模式）->', pendingGet.status, pendingGet.body)
expect(JSON.parse(pendingGet.body).sessionId === 'session-abc', '退路模式应当返回最近一条通知的会话')

const cleared = await call(pendingRoute, post({ clear: true }))
console.log('POST /pending 清空 ->', cleared.status, cleared.body)

const afterClear = await call(pendingRoute, makeRequest({ method: 'GET', headers: { host: HOST } }))
console.log('再 GET /pending ->', afterClear.status, afterClear.body)
expect(JSON.parse(afterClear.body).sessionId === null, '清空后不应再返回会话')

// ── 配置路由 ─────────────────────────────────────────────────────────
const config = await call(configRoute, makeRequest({ method: 'GET', headers: { host: HOST } }))
console.log('GET /config ->', config.status, config.body)

// 给 PowerShell 子进程留出弹 toast 的时间。
await new Promise((resolve) => setTimeout(resolve, 2500))
console.log('done')
