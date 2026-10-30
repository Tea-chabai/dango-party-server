#!/usr/bin/env node
/**
 * Dango Music「一起听歌」自建同步后端（单文件，无第三方依赖）。
 *
 * 它模仿 Firebase 实时数据库的那一小部分接口，客户端不用改一行代码，只要在
 *   .minecraft/config/dangomusic/firebase.properties
 * 里把 relayUrl（以及 databaseUrl）指向这台服务器即可：
 *
 *   apiKey=local-party
 *   databaseUrl=https://party.example.com
 *   relayUrl=https://party.example.com
 *
 * 三个路径前缀和客户端 FirebaseEndpoints.kt 里的约定一一对应：
 *   /id/v1/accounts:signUp   匿名登录（换成一台电脑一个固定 uid）
 *   /token/v1/token          刷新令牌
 *   /db/<路径>.json          实时数据库的读写 / 删除 / 条件写 / SSE 长连接
 *
 * 每个响应都会带 X-Dango-Relay 头：客户端靠它判断「中转是活的」，
 * 没有这个头会认为中转挂了、60 秒内改去直连。
 *
 * 数据结构与作者线上服务一致：
 *   rooms/D-XXXXX = { protocol, host, hostName, memberControl, createdAt,
 *                     members/{uid} = { name, lastSeen },
 *                     state = { 歌名/歌手/进度… }, req = { 成员的操作请求 } }
 *   clock/{uid}  = 服务器时间（客户端用它校准时钟）
 *
 * 权限也照 database.rules.json 翻译：房主才能重建/关房，成员只能写自己的
 * members 节点，只有房主开着「允许成员控制」时成员才能写 req。
 */
'use strict'

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Dango Music 一起听歌 · 自建同步后端

用法:
  node server.mjs                 默认监听 127.0.0.1:8787，数据存在 ./data
  PORT=9000 node server.mjs       换端口（PORT=0 由系统分配，启动后打印实际端口）
  HOST=0.0.0.0 node server.mjs    监听所有网卡（生产环境请放在 HTTPS 反代后面）

环境变量:
  PORT       监听端口（默认 8787）
  HOST       监听地址（默认 127.0.0.1）
  DATA_DIR   数据目录（默认 ./data，里面有 party.json 和 secret）
  SECRET     令牌签名密钥（默认随机生成并存进 DATA_DIR/secret）
  QUIET=1    只打印启动信息，不打印每次读写

接口（给 Dango Music 客户端用，等价于 Firebase 实时数据库的一小部分）:
  POST /id/v1/accounts:signUp     匿名登录
  POST /token/v1/token            刷新令牌
  GET|PUT|PATCH|DELETE /db/<路径>.json
  GET /db/<路径>.json + Accept: text/event-stream   实时推送
  GET /healthz                    健康检查`)
  process.exit(0)
}

if (argv.includes('--version') || argv.includes('-V')) {
  console.log('dango-party-server ' + (process.env.npm_package_version || '1.0.0'))
  process.exit(0)
}

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const DATA_DIR = process.env.DATA_DIR || path.join(HERE, 'data')
const DATA_FILE = path.join(DATA_DIR, 'party.json')
const SECRET_FILE = path.join(DATA_DIR, 'secret')
const QUIET = process.env.QUIET === '1'

/** 客户端认的「中转正常」标记头（PartyHttp.RELAY_HEADER） */
const RELAY_HEADER = 'X-Dango-Relay'
/** SSE 心跳：客户端读超时 70 秒，原版 Firebase 每 30 秒发一次 */
const KEEPALIVE_MS = 25_000
/** 房主超过这么久没心跳，房间算废弃，可以被别人接管（和作者线上的规则一致） */
const ABANDONED_MS = 10 * 60_000
/** 房间彻底没人后多久从内存里清掉 */
const ROOM_TTL_MS = 60 * 60_000

// ---------------------------------------------------------------- 小工具

const now = () => Date.now()
const log = (...a) => { if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...a) }

function seg(p) {
  return String(p).split('/').filter((s) => s.length > 0)
}

function keyOf(a) {
  return '/' + a.join('/')
}

function isPrefix(a, b) {
  if (a.length > b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function logPath(a) {
  return keyOf(a) || '/'
}

// ---------------------------------------------------------------- 持久化

fs.mkdirSync(DATA_DIR, { recursive: true })

function loadSecret() {
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim()
    if (s.length >= 32) return s
  } catch {}
  const s = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(SECRET_FILE, s)
  return s
}

const SECRET = process.env.SECRET || loadSecret()

/** 整棵树 + 每个路径的版本号（ETag 用） */
const tree = { root: {}, versions: Object.create(null), rev: 0 }

try {
  if (fs.existsSync(DATA_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    if (saved && typeof saved.root === 'object') tree.root = saved.root
    if (saved && typeof saved.versions === 'object') tree.versions = saved.versions
    if (saved && Number.isFinite(saved.rev)) tree.rev = saved.rev
    log(`loaded ${Object.keys(tree.root.rooms || {}).length} room(s) from ${DATA_FILE}`)
  }
} catch (e) {
  log('cannot load data file, starting empty:', e.message)
}

let saveTimer = null

function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const tmp = DATA_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ root: tree.root, versions: tree.versions, rev: tree.rev }))
      fs.renameSync(tmp, DATA_FILE)
    } catch (e) {
      log('save failed:', e.message)
    }
  }, 800)
}

function saveNow() {
  if (saveTimer) return
  try {
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify({ root: tree.root, versions: tree.versions, rev: tree.rev }))
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE)
  } catch (e) {
    log('save failed:', e.message)
  }
}

// ---------------------------------------------------------------- 数据树

function getNode(a) {
  let n = tree.root
  for (const s of a) {
    if (n === null || typeof n !== 'object' || Array.isArray(n)) return undefined
    if (!Object.prototype.hasOwnProperty.call(n, s)) return undefined
    n = n[s]
  }
  return n
}

/** 和 Firebase 一样：删空的容器一起删掉 */
function pruneEmpty(obj) {
  let empty = true
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      if (pruneEmpty(v)) delete obj[k]
    } else {
      empty = false
      continue
    }
    empty = false
  }
  return empty
}

function setAt(a, value) {
  if (a.length === 0) {
    tree.root = value && typeof value === 'object' ? value : {}
    return
  }
  let n = tree.root
  for (let i = 0; i < a.length - 1; i++) {
    const s = a[i]
    if (n[s] === null || typeof n[s] !== 'object' || Array.isArray(n[s])) n[s] = {}
    n = n[s]
  }
  const last = a[a.length - 1]
  if (value === null || value === undefined) delete n[last]
  else n[last] = value
  pruneEmpty(tree.root)
}

/** PATCH：浅合并，值为 null 表示删掉那个子项 */
function mergeAt(a, patch) {
  const current = getNode(a)
  const base = current !== null && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete base[k]
    else base[k] = v
  }
  setAt(a, Object.keys(base).length === 0 ? null : base)
}

function bump(a) {
  for (let i = a.length; i >= 0; i--) {
    const k = keyOf(a.slice(0, i)) || '/'
    tree.versions[k] = ++tree.rev
  }
}

function etagOf(a) {
  const v = getNode(a)
  if (v === undefined) return '"null_etag"'
  const k = keyOf(a) || '/'
  return '"v' + (tree.versions[k] || 0) + '"'
}

/** 递归把 {".sv":"timestamp"} 换成服务器毫秒时间（客户端就靠它对齐进度） */
function resolveTimestamps(v) {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(resolveTimestamps)
  const keys = Object.keys(v)
  if (keys.length === 1 && keys[0] === '.sv' && v['.sv'] === 'timestamp') return now()
  const out = {}
  for (const k of keys) out[k] = resolveTimestamps(v[k])
  return out
}

// ---------------------------------------------------------------- 订阅（SSE）

/** path: 段数组；res: http 响应；alive 用于超时清理 */
const SUBSCRIBERS = new Set()

function writeEvent(res, event, data) {
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')
}

/**
 * 一次写入后通知监听者，路径换算成相对监听路径：
 *   - 变化在监听路径之内：put / patch，附相对路径
 *   - 变化在监听路径之上（祖先进来变化）：整棵树再发一次快照
 */
function broadcast(kind, changed, data) {
  for (const sub of SUBSCRIBERS) {
    try {
      if (isPrefix(sub.path, changed)) {
        const rel = '/' + changed.slice(sub.path.length).join('/')
        writeEvent(sub.res, kind, { path: rel, data })
      } else if (isPrefix(changed, sub.path)) {
        const node = getNode(sub.path)
        writeEvent(sub.res, 'put', { path: '/', data: node === undefined ? null : node })
      }
    } catch (e) {
      closeSub(sub)
    }
  }
}

function closeSub(sub) {
  SUBSCRIBERS.delete(sub)
  try {
    sub.res.end()
  } catch {}
  clearInterval(sub.timer)
}

// ---------------------------------------------------------------- 令牌

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url')
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url')

function issueId(uid) {
  const exp = now() + 3600_000
  const body = uid + '.' + exp
  return body + '.' + hmac(body)
}

function verifyId(token) {
  if (typeof token !== 'string' || token.length > 512) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [uid, exp, sig] = parts
  if (hmac(uid + '.' + exp) !== sig) return null
  if (Number(exp) < now()) return null
  return uid
}

function issueRefresh(uid) {
  return b64(uid) + '.' + hmac('refresh.' + uid)
}

function verifyRefresh(token) {
  if (typeof token !== 'string') return null
  const i = token.lastIndexOf('.')
  if (i <= 0) return null
  let uid
  try {
    uid = Buffer.from(token.slice(0, i), 'base64url').toString('utf8')
  } catch {
    return null
  }
  if (hmac('refresh.' + uid) !== token.slice(i + 1)) return null
  return uid
}

// ---------------------------------------------------------------- 权限（照 database.rules.json 翻译）

function hostAbandoned(room) {
  const seen = room?.members?.[room?.host]?.lastSeen
  return typeof seen === 'number' && now() - seen > ABANDONED_MS
}

/** 读：房间只能按房间码读（不能列目录），clock 只能读自己的 */
function allowedRead(uid, a) {
  if (a.length === 0) return false
  if (a[0] === 'rooms') return a.length >= 2
  if (a[0] === 'clock') return a.length === 2 && a[1] === uid
  return false
}

function allowedWrite(uid, a) {
  if (a[0] === 'clock') return a.length === 2 && a[1] === uid
  if (a[0] !== 'rooms' || a.length < 2) return false
  const code = a[1]
  const rest = a.slice(2)
  const room = getNode(['rooms', code])

  if (rest.length === 0) {
    if (room === undefined) return true
    if (room?.host === uid) return true
    return hostAbandoned(room)
  }
  if (room === undefined) return false
  if (rest[0] === 'members') {
    if (rest.length < 2) return false
    return rest[1] === uid
  }
  if (rest[0] === 'req') {
    if (room.memberControl !== true) return false
    return typeof room.members === 'object' && room.members !== null && Object.prototype.hasOwnProperty.call(room.members, uid)
  }
  if (rest[0] === 'state' || rest[0] === 'memberControl') return room.host === uid
  return false
}

// ---------------------------------------------------------------- HTTP

function baseHeaders(extra) {
  return {
    [RELAY_HEADER]: '1',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extra,
  }
}

function sendJson(res, code, body, headers) {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(code, baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...headers }))
  res.end(text)
}

function fail(res, code, message) {
  sendJson(res, code, { error: { code, message } })
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new HttpError(413, 'request body too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 解析 JSON 请求体；坏了就是 400，而不是 500 */
function parseJson(text, what) {
  if (text === '' || text === undefined) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'invalid JSON in ' + what)
  }
}

const server = http.createServer(async (req, res) => {
  const started = now()
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname
  const q = url.searchParams
  let code = 200

  try {
    if (p === '/' || p === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        rooms: Object.keys(tree.root.rooms || {}).length,
        listeners: SUBSCRIBERS.size,
      })
      return
    }

    // ------------------------------------------------------- 匿名登录 / 刷新令牌
    if (p.startsWith('/id/')) {
      if (!p.endsWith('/v1/accounts:signUp') && !p.endsWith(':signUp')) return fail(res, 404, 'not found')
      if (req.method !== 'POST') return fail(res, 405, 'method not allowed')
      await readBody(req) // 请求体是 {"returnSecureToken":true}，这里不需要
      const uid = crypto.randomUUID()
      sendJson(res, 200, {
        kind: 'identitytoolkit#SignupNewUserResponse',
        localId: uid,
        idToken: issueId(uid),
        refreshToken: issueRefresh(uid),
        expiresIn: '3600',
        email: '',
      })
      log('signUp ->', uid.slice(0, 8))
      return
    }

    if (p.startsWith('/token/')) {
      if (req.method !== 'POST') return fail(res, 405, 'method not allowed')
      const form = new URLSearchParams(await readBody(req))
      const uid = verifyRefresh(form.get('refresh_token'))
      if (!uid) return fail(res, 401, 'INVALID_REFRESH_TOKEN')
      sendJson(res, 200, {
        access_token: issueId(uid),
        id_token: issueId(uid),
        refresh_token: issueRefresh(uid),
        expires_in: '3600',
        token_type: 'Bearer',
        user_id: uid,
        project_id: 'dango-party',
      })
      return
    }

    // ------------------------------------------------------- 实时数据库
    let dbPath = null
    if (p.startsWith('/db/')) dbPath = p.slice(4)
    else if (p.endsWith('.json')) dbPath = p
    if (dbPath !== null) {
      const a = seg(decodeURIComponent(dbPath.replace(/\.json$/, '')))
      const uid = verifyId(q.get('auth'))
      if (!uid) {
        code = 401
        return fail(res, 401, 'PERMISSION_DENIED: invalid or expired token')
      }

      let method = req.method
      const override = req.headers['x-http-method-override']
      if (typeof override === 'string' && override) method = override.toUpperCase()

      const wantsStream = (req.headers.accept || '').includes('text/event-stream')
      if (method === 'GET') {
        if (!allowedRead(uid, a)) {
          code = 403
          return fail(res, 403, 'PERMISSION_DENIED: cannot read ' + logPath(a))
        }
        if (wantsStream) {
          code = 200
          return openStream(req, res, a, uid)
        }
        const node = getNode(a)
        code = 200
        return sendJson(res, 200, node === undefined ? null : node, { ETag: etagOf(a) })
      }

      const text = method === 'DELETE' ? '' : await readBody(req)

      if (!allowedWrite(uid, a)) {
        code = 403
        return fail(res, 403, 'PERMISSION_DENIED: rule violation at ' + logPath(a))
      }

      if (method === 'DELETE') {
        setAt(a, undefined)
        bump(a)
        broadcast('put', a, null)
        scheduleSave()
        code = 200
        log('del', logPath(a), 'by', uid.slice(0, 8))
        return sendJson(res, 200, null, { ETag: etagOf(a) })
      }

      if (method === 'PUT') {
        const ifMatch = req.headers['if-match']
        if (typeof ifMatch === 'string' && ifMatch && ifMatch !== etagOf(a)) {
          code = 412
          return fail(res, 412, 'PRECONDITION_FAILED: etag mismatch at ' + logPath(a))
        }
        const value = resolveTimestamps(parseJson(text, 'PUT body'))
        setAt(a, value)
        bump(a)
        broadcast('put', a, value)
        scheduleSave()
        code = 200
        log('put', logPath(a), 'by', uid.slice(0, 8))
        return sendJson(res, 200, value, { ETag: etagOf(a) })
      }

      if (method === 'PATCH') {
        const patch = resolveTimestamps(parseJson(text || '{}', 'PATCH body'))
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return fail(res, 400, 'PATCH body must be an object')
        mergeAt(a, patch)
        bump(a)
        broadcast('patch', a, patch)
        scheduleSave()
        code = 200
        log('patch', logPath(a), 'by', uid.slice(0, 8))
        return sendJson(res, 200, getNode(a) ?? null, { ETag: etagOf(a) })
      }

      code = 405
      return fail(res, 405, 'method not allowed: ' + method)
    }

    code = 404
    return fail(res, 404, 'not found: ' + p)
  } catch (e) {
    if (!res.headersSent) {
      const status = e instanceof HttpError ? e.status : 500
      code = status
      fail(res, status, e instanceof HttpError ? e.message : 'internal error: ' + e.message)
    } else {
      try { res.end() } catch {}
    }
    log('error', req.method, p, e.message)
  } finally {
    log(`[${code}] ${req.method} ${p}${q.get('auth') ? '' : ''} ${now() - started}ms`)
  }
})

function openStream(req, res, a, uid) {
  res.writeHead(200, baseHeaders({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  }))
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  const sub = { path: a, res, timer: null }
  SUBSCRIBERS.add(sub)

  const node = getNode(a)
  writeEvent(res, 'put', { path: '/', data: node === undefined ? null : node })
  sub.timer = setInterval(() => {
    try {
      res.write('event: keep-alive\ndata: null\n\n')
    } catch {
      closeSub(sub)
    }
  }, KEEPALIVE_MS)

  const drop = () => closeSub(sub)
  req.on('close', drop)
  req.on('error', drop)
  res.on('close', drop)
  res.on('error', drop)
  log('listen', logPath(a), 'by', uid.slice(0, 8), '->', SUBSCRIBERS.size, 'listener(s)')
}

// ---------------------------------------------------------------- 清理：废弃房间

setInterval(() => {
  const rooms = tree.root.rooms
  if (!rooms || typeof rooms !== 'object') return
  for (const code of Object.keys(rooms)) {
    const room = rooms[code]
    if (!room || typeof room !== 'object') continue
    const seen = room?.members?.[room?.host]?.lastSeen
    const last = typeof seen === 'number' ? seen : 0
    if (now() - last > ROOM_TTL_MS) {
      setAt(['rooms', code], undefined)
      bump(['rooms', code])
      broadcast('put', ['rooms', code], null)
      log('gc room', code)
    }
  }
}, 5 * 60_000)

process.on('SIGINT', () => { saveNow(); log('bye'); process.exit(0) })
process.on('SIGTERM', () => { saveNow(); log('bye'); process.exit(0) })

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[X] 端口 ${PORT} 已被占用：可能已经有一台服务器在跑，或者别的程序占着这个端口。`)
    console.error('    换端口：PORT=9000 node server.mjs')
    console.error('    确认是不是它在跑：curl http://127.0.0.1:' + PORT + '/healthz')
  } else {
    console.error('[X] 服务器启动失败：' + e.message)
  }
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  const actual = server.address().port
  log(`Dango party server listening on http://${HOST}:${actual}`)
  log('  /id/v1/accounts:signUp  /token/v1/token  /db/<path>.json')
  log('  data: ' + DATA_FILE)
  if (process.env.TEST_PORT_READY === '1') console.log('PORT_READY ' + actual)
})
