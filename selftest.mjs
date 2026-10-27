/**
 * 自检脚本：不启动 DSH，直接把插件的 Host 半边按真实 ctx 形状接起来跑一遍，
 * 验证路由注册、请求校验、脚本生成、PowerShell 调用这条链路。
 *
 * 用法：node .\selftest.mjs
 */
import { apply } from './lib/index.js'

/** 收集 apply 期间注册的路由。 */
const routes = []

/** 只实现 apply 用到的那几个面。 */
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
if (
  route === undefined ||
  logRoute === undefined ||
  configRoute === undefined ||
  pendingRoute === undefined ||
  focusRoute === undefined
) {
  console.error('路由不齐:', routes.map((candidate) => candidate.path).join(', '))
  process.exit(1)
}
console.log('route:', route.kind, route.path)
console.log('log route:', logRoute.kind, logRoute.path)
console.log('config route:', configRoute.kind, configRoute.path)
console.log('pending route:', pendingRoute.kind, pendingRoute.path)
console.log('focus route:', focusRoute.kind, focusRoute.path)

/** 极简 req：异步可迭代的 body + 大小写不敏感的表头。 */
function makeRequest({ method, headers, body }) {
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

/** 极简 res：记录状态码与响应体。 */
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

async function call(request) {
  const res = makeResponse()
  await route.handler(request, res)
  return { status: res.status, body: res.body }
}

const ok = await call(
  makeRequest({
    method: 'POST',
    headers: { host: '127.0.0.1:5441', 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'DSH 通知自检',
      body: '插件 Host 半边已就绪（这条由插件自己的代码发出）。',
      key: 'selftest',
    }),
  })
)
console.log('POST 合法请求 ->', ok.status, ok.body)

const badOrigin = await call(
  makeRequest({
    method: 'POST',
    headers: { host: '127.0.0.1:5441', origin: 'https://evil.example' },
    body: JSON.stringify({ title: 'x', body: 'y' }),
  })
)
console.log('POST 外部 Origin ->', badOrigin.status, badOrigin.body)

const wrongMethod = await call(makeRequest({ method: 'GET', headers: { host: '127.0.0.1:5441' } }))
console.log('GET ->', wrongMethod.status, wrongMethod.body)

const dup = await call(
  makeRequest({
    method: 'POST',
    headers: { host: '127.0.0.1:5441' },
    body: JSON.stringify({ title: 'DSH 通知自检', body: '重复键应当被去重', key: 'selftest' }),
  })
)
console.log('POST 同 key 立即重发 ->', dup.status, dup.body)

// pending：通知过哪个会话，窗口恢复时就要能取回来；取完要能被清掉。
const withSession = await call(
  makeRequest({
    method: 'POST',
    headers: { host: '127.0.0.1:5441' },
    body: JSON.stringify({ title: '带会话的通知', body: '用来验证点通知跳会话', key: 'pending-probe', sessionId: 'session-abc' }),
  })
)
console.log('POST 带 sessionId ->', withSession.status, withSession.body)

async function callPending(method) {
  const res = makeResponse()
  await pendingRoute.handler(makeRequest({ method, headers: { host: '127.0.0.1:5441' } }), res)
  return { status: res.status, body: res.body }
}

const pendingGet = await callPending('GET')
console.log('GET /pending ->', pendingGet.status, pendingGet.body)
if (!pendingGet.body.includes('session-abc')) {
  console.error('pending 没记下 sessionId')
  process.exit(1)
}

const cleared = await callPending('POST')
console.log('POST /pending（清空）->', cleared.status, cleared.body)

const afterClear = await callPending('GET')
console.log('再 GET /pending ->', afterClear.status, afterClear.body)
if (afterClear.body.includes('session-abc')) {
  console.error('pending 清空失败')
  process.exit(1)
}

// 给 PowerShell 子进程留出弹 toast 的时间。
await new Promise((resolve) => setTimeout(resolve, 2500))
console.log('done')
