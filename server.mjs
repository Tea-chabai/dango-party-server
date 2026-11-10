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

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Dango Music 一起听歌 · 自建同步后端

用法:
  node server.mjs                 默认监听 127.0.0.1:8787，数据存在 ./data
  PORT=9000 node server.mjs       换端口（PORT=0 由系统分配，启动后打印实际端口）
  HOST=0.0.0.0 node server.mjs    监听所有网卡

  # 自带 TLS（不需要 Nginx / Caddy）：证书可以用 acme.sh / certbot 签
  TLS_CERT=/path/fullchain.pem TLS_KEY=/path/privkey.pem PORT=8443 node server.mjs

环境变量:
  PORT       监听端口（默认 8787）
  HOST       监听地址（默认 127.0.0.1）
  DATA_DIR   数据目录（默认 ./data，里面有 party.json 和 secret）
  SECRET     令牌签名密钥（默认随机生成并存进 DATA_DIR/secret）
  PARTY_KEY  共享口令；不设则自动生成随机口令存进 DATA_DIR/apikey.txt（重启复用），
             设 none 关掉校验，设具体值就用它
  PUBLIC_URL 公网地址（如 https://xxx.tailnet.ts.net）：填了就写进生成的样例配置
             data/firebase.properties.example，复制成 firebase.properties 即可发给玩家
  TLS_CERT   PEM 证书路径（和 TLS_KEY 一起给才会启用 https）
  TLS_KEY    PEM 私钥路径
  ADMIN_TOKEN 运维口令：GET /admin/rooms、DELETE /admin/rooms/<码>、GET /admin/stats；
             不设则自动生成存 data/admintoken.txt，设 none 关闭
  MAX_ROOMS  房间上限（默认 500）
  RATE_SIGNUP 每分钟登录次数上限（默认 60，0 = 不限）
  TAKEOVER_MIN 房主多少分钟没心跳算废弃、可被接管（默认 10，和作者 Firebase 规则一致；
             客户端自己写死 11 分钟，比服务端多留 1 分钟余量）
  QUIET=1    只打印启动信息，不打印每次读写

接口（给 Dango Music 客户端用，等价于 Firebase 实时数据库的一小部分）:
  POST /id/v1/accounts:signUp     匿名登录
  POST /token/v1/token            刷新令牌
  GET|PUT|PATCH|DELETE /db/<路径>.json
  GET /db/<路径>.json + Accept: text/event-stream   实时推送
  GET /healthz                    健康检查（含版本、协议版本、房间数、在线监听数）
  GET /admin/rooms                运维：列房间；DELETE /admin/rooms/<码> 强制关房
  GET /admin/stats                运维：统计`)
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

/** 运维控制台页面（和 server.mjs 放在一起；改了直接刷新页面就生效） */
const UI_FILE = path.join(HERE, 'ui.html')

function readUiHtml() {
  try {
    return fs.readFileSync(UI_FILE, 'utf8')
  } catch {
    return '<!doctype html><meta charset="utf-8"><p>找不到 ui.html，请把它和 server.mjs 放在同一目录。</p>'
  }
}

/**
 * 共享口令（客户端 firebase.properties 里的 apiKey 必须和它一致）。
 *   不设 PARTY_KEY      → 自动生成一个随机口令，存在 data/apikey.txt，重启复用（方便直接分发）
 *   设 PARTY_KEY=xxx    → 用这个值
 *   设 PARTY_KEY=none   → 关掉校验（谁都能匿名登录，仅本机测试用）
 */
const APIKEY_FILE = path.join(DATA_DIR, 'apikey.txt')

function loadOrCreateKey() {
  const explicit = (process.env.PARTY_KEY || '').trim()
  if (explicit === 'none' || explicit === '0' || explicit === 'off') return ''
  if (explicit) return explicit
  try {
    const saved = fs.readFileSync(APIKEY_FILE, 'utf8').trim()
    if (saved) return saved
  } catch {}
  const key = 'dango-' + crypto.randomBytes(9).toString('base64url')
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(APIKEY_FILE, key + '\n', { mode: 0o600 })
  } catch (e) {
    console.error('[!] 写不进去 ' + APIKEY_FILE + '：' + e.message + '（口令只在本次运行有效）')
  }
  return key
}

const PARTY_KEY = loadOrCreateKey()

/**
 * 运维口令：只用来读 /admin/*（列房间、强制关房、看统计）。玩家客户端用不到它。
 *   不设 ADMIN_TOKEN → 自动生成，存 data/admintoken.txt（重启复用），启动日志会打印
 *   设 ADMIN_TOKEN=none → 关掉 /admin/*（返回 404）
 */
const ADMIN_FILE = path.join(DATA_DIR, 'admintoken.txt')

function loadOrCreateAdminToken() {
  const explicit = (process.env.ADMIN_TOKEN || '').trim()
  if (explicit === 'none' || explicit === '0' || explicit === 'off') return ''
  if (explicit) return explicit
  try {
    const saved = fs.readFileSync(ADMIN_FILE, 'utf8').trim()
    if (saved) return saved
  } catch {}
  const token = 'adm-' + crypto.randomBytes(12).toString('base64url')
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(ADMIN_FILE, token + '\n', { mode: 0o600 })
  } catch (e) {
    console.error('[!] 写不进去 ' + ADMIN_FILE + '：' + e.message)
  }
  return token
}

const ADMIN_TOKEN = loadOrCreateAdminToken()

/** 全局登录限速：一分钟窗口，防止有人刷号把 party.json 撑爆（参考 mpsync 的安全策略） */
let signupWindow = { start: 0, count: 0 }

function signupAllowed() {
  if (!RATE_SIGNUP_PER_MIN) return true
  const t = now()
  if (t - signupWindow.start > 60_000) signupWindow = { start: t, count: 0 }
  return ++signupWindow.count <= RATE_SIGNUP_PER_MIN
}

function roomCount() {
  const rooms = tree.root.rooms
  return rooms && typeof rooms === 'object' ? Object.keys(rooms).length : 0
}

/** 公开地址（可选）：填了就写进给玩家分发的配置文件，例如 https://xxx.tailnet.ts.net */
const PUBLIC_URL = (() => {
  const raw = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  if (/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(raw)) return raw
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$/.test(raw)) return raw
  console.error('[!] PUBLIC_URL 格式不对（只接受 https://主机[:端口] 或本机 http://127.0.0.1[:端口]）：' + raw)
  return ''
})()

/** 读旧配置里的 databaseUrl/relayUrl（手改过的地址别被冲掉） */
function readPrevConfig(file) {
  try {
    const out = {}
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const s = line.trim()
      if (!s || s.startsWith('#') || s.startsWith('!')) continue
      const i = s.indexOf('=')
      if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim()
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 给腐竹的「样例配置」：data/firebase.properties.example
 *   - 只在不存在时生成一份；之后**不覆盖**（地址是腐竹自己改的）
 *   - 口令变了就只同步 apiKey 那一行，其它行原样保留
 * 腐竹把它复制成 firebase.properties，改掉 party.example.com 就能发给玩家。
 */
function writeSampleConfig(url) {
  const file = path.join(DATA_DIR, 'firebase.properties.example')
  const prev = readPrevConfig(file)
  const key = PARTY_KEY || 'local-party'

  if (prev.apiKey) {
    if (prev.apiKey !== key) {
      try {
        const text = fs.readFileSync(file, 'utf8').replace(/^apiKey=.*$/m, 'apiKey=' + key)
        fs.writeFileSync(file, text)
      } catch (e) {
        console.error('[!] 更新 ' + file + ' 失败：' + e.message)
      }
    }
    return { file, created: false }
  }

  // 第一次生成：地址优先用 PUBLIC_URL，其次沿用旧文件（兼容上一版写出的 firebase.properties）
  const legacy = readPrevConfig(path.join(DATA_DIR, 'firebase.properties'))
  const target = url || legacy.databaseUrl || legacy.relayUrl || 'https://party.example.com'
  const text = [
    '# Dango Music 一起听歌 —— 样例配置（服务器生成，请复制成 firebase.properties 后使用）',
    '# 放到 <游戏目录>/config/dangomusic/firebase.properties',
    '# 把下面两处 party.example.com 换成你的服务器地址（https，不带端口除非你开了非标准端口）',
    '# apiKey 必须和服务器一致，否则登录会被拒（403）',
    '',
    'apiKey=' + key,
    'databaseUrl=' + target,
    'relayUrl=' + target,
    '',
  ].join('\n')
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(file, text)
    return { file, created: true }
  } catch (e) {
    console.error('[!] 写不进去 ' + file + '：' + e.message)
    return { file: '', created: false }
  }
}


/** 客户端认的「中转正常」标记头（PartyHttp.RELAY_HEADER） */
const RELAY_HEADER = 'X-Dango-Relay'
/** SSE 心跳：客户端读超时 70 秒，原版 Firebase 每 30 秒发一次 */
const KEEPALIVE_MS = 25_000
/** 房主超过这么久没心跳，房间算废弃，可以被别人接管（和作者线上的规则一致） */
/**
 * 房主多久没心跳算「废弃」，可以被别人接管同一个房间码。
 * 跟作者 Firebase 规则（database.rules.json 里的 600000 毫秒）保持一致：10 分钟。
 * 客户端自己写死 11 分钟（ListenParty.ABANDONED_MS）——比服务端多 1 分钟，是作者故意的：
 * 客户端 11 分钟时才去试，服务端 10 分钟就已经放行，避免两边时钟差一点卡在边界上被拒。
 * TAKEOVER_MIN 可调，但改小只会放宽服务端的写权限（客户端仍按 11 分钟判断）。
 */
const TAKEOVER_MIN = Math.max(1, Number(process.env.TAKEOVER_MIN ?? 10))
const ABANDONED_MS = TAKEOVER_MIN * 60_000
/** 房间彻底没人后多久从内存里清掉 */
const ROOM_TTL_MS = 60 * 60_000
/** 单次写入的 JSON 上限（房间状态本来就是几 KB 的元数据） */
const MAX_VALUE_BYTES = 32 * 1024
/** 全局房间上限，防止被刷爆存储 */
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 500)
/** 每分钟允许的匿名登录数（0 = 不限）；按进程计，跨代理也有效 */
const RATE_SIGNUP_PER_MIN = Number(process.env.RATE_SIGNUP ?? 60)
/** 房间协议版本（客户端 1.7.0 = 3），只在 /healthz 里露出来方便排查 */
const PROTOCOL_VERSION = 3

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const STATS = { signups: 0, writes: 0, deletes: 0, listens: 0, rejected: 0 }

// ---------------------------------------------------------------- 小工具

/**
 * 服务器时间。用 performance.now() 当单调基准，避免系统时钟被 NTP/手动调整后
 * 时间戳回跳（会破坏 lastSeen / at / pos 的推算，参考 MusicParty/mpsync 的时钟纪律）。
 * 偏差异常（>5s，比如刚从休眠醒来）时重新锚定。
 */
const CLOCK = { wall: Date.now(), mono: performance.now(), last: Date.now() }

function serverTime() {
  const estimated = CLOCK.wall + (performance.now() - CLOCK.mono)
  const sys = Date.now()
  if (Math.abs(sys - estimated) > 5000) {
    CLOCK.wall = sys
    CLOCK.mono = performance.now()
    CLOCK.last = sys
    return sys
  }
  CLOCK.last = Math.max(CLOCK.last, Math.round(estimated))
  return CLOCK.last
}

const now = () => serverTime()
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

// ---------------------------------------------------------------- 字段校验

/**
 * 照 database.rules.json 的 .validate 翻译的字段约束。
 * Firebase 那边越界会被规则拒绝，我们自己实现时容易漏掉——这里补上，防止有人塞垃圾把存储刷爆。
 * 未知字段放行（客户端将来加字段不该炸），但整块大小有上限。
 */
function checkFields(v, spec) {
  for (const [k, want] of Object.entries(spec)) {
    const val = v[k]
    if (val === undefined || val === null) continue
    if (want === 'number') {
      if (typeof val !== 'number') return k + ' 必须是数字'
    } else if (want === 'boolean') {
      if (typeof val !== 'boolean') return k + ' 必须是布尔值'
    } else if (typeof val !== 'string') {
      return k + ' 必须是字符串'
    } else if (val.length > want) {
      return `${k} 太长（${val.length} > ${want}）`
    }
  }
  return null
}

/** 返回错误字符串表示拒绝，null 表示通过 */
function validateWrite(a, value, uid, isPatch = false) {
  if (value === null || value === undefined) return null

  // clock/{uid}：规则要求 newData.isNumber()，只允许写自己的时钟
  if (a[0] === 'clock') {
    if (a.length !== 2) return 'clock 只允许 clock/{uid}'
    if (typeof value !== 'number') return 'clock 的值必须是数字'
    return null
  }
  if (a[0] !== 'rooms' || a.length < 2) {
    if (typeof value === 'object' && !Array.isArray(value)) {
      try {
        if (Buffer.byteLength(JSON.stringify(value)) > MAX_VALUE_BYTES) return '写入内容太大'
      } catch {}
    }
    return null
  }
  if (typeof value !== 'object' || Array.isArray(value)) return '写入内容必须是 JSON 对象'
  let bytes = 0
  try {
    bytes = Buffer.byteLength(JSON.stringify(value))
  } catch {
    return '写入内容无法序列化'
  }
  if (bytes > MAX_VALUE_BYTES) return `写入内容太大（${bytes} > ${MAX_VALUE_BYTES} 字节）`

  if (a[1].length > 16) return '房间码太长'
  const rest = a.slice(2)

  if (rest.length === 0) {
    const err = checkFields(value, {
      host: 128,
      hostName: 64,
      protocol: 'number',
      memberControl: 'boolean',
      createdAt: 'number',
    })
    if (err) return err
    // 规则：newData.hasChildren(['host']) 且 host 只能是自己，或保持原来的房主
    const current = getNode(a)
    const currentHost = current && typeof current === 'object' ? current.host : undefined
    const newHost = isPatch && value.host === undefined ? currentHost : value.host
    if (newHost === undefined || newHost === null) return '缺少 host'
    if (currentHost === undefined) {
      if (newHost !== uid) return 'host 必须是自己（不能替别人建房）'
    } else if (newHost !== currentHost && newHost !== uid) {
      return '不能把房主改成别人'
    }
    return null
  }
  if (rest[0] === 'members') {
    if (rest.length < 2) return '缺少成员 uid'
    if (rest[1].length > 128) return '成员 uid 太长'
    const err = checkFields(value, { name: 64, lastSeen: 'number', failedTrack: 64 })
    if (err) return err
    // 规则：newData.hasChildren(['lastSeen'])（PATCH 时看合并后的结果）
    const merged = isPatch ? { ...(getNode(a) || {}), ...value } : value
    if (merged.lastSeen === undefined || merged.lastSeen === null) return '缺少 lastSeen'
    return null
  }
  if (rest[0] === 'state') {
    return checkFields(value, {
      trackId: 'number',
      source: 16,
      nativeId: 64,
      mediaId: 64,
      albumId: 64,
      name: 1024,
      artists: 2048,
      cover: 4096,
      duration: 'number',
      pos: 'number',
      playing: 'boolean',
      at: 'number',
    })
  }
  if (rest[0] === 'req') {
    const err = checkFields(value, {
      id: 64,
      by: 128,
      byName: 64,
      op: 16,
      trackId: 'number',
      source: 16,
      nativeId: 64,
      mediaId: 64,
      albumId: 64,
      name: 1024,
      artists: 2048,
      cover: 4096,
      duration: 'number',
      pos: 'number',
      at: 'number',
    })
    if (err) return err
    // 规则：newData.child('by').val() === auth.uid
    if (value.by !== undefined && value.by !== null && value.by !== uid) return 'req.by 必须是自己的 uid'
    return null
  }
  if (rest[0] === 'stream') {
    // 房主发布的播放直链（会员歌曲共享）：只校验形状，不校验内容是否真能播
    const err = checkFields(value, {
      url: 2048,
      source: 16,
      key: 64,
      by: 128,
      at: 'number',
      expiresAt: 'number',
      trial: 'boolean',
      gain: 'number',
      peak: 'number',
    })
    if (err) return err
    if (typeof value.url !== 'string' || value.url.length < 8) return 'stream.url 看起来不是链接'
    if (!/^https?:\/\//.test(value.url)) return 'stream.url 必须是 http(s) 链接'
    if (value.by !== undefined && value.by !== null && value.by !== uid) return 'stream.by 必须是自己的 uid'
    return null
  }
  if (rest[0] === 'streamAsk') {
    const err = checkFields(value, { key: 64, by: 128, at: 'number' })
    if (err) return err
    if (value.by !== undefined && value.by !== null && value.by !== uid) return 'streamAsk.by 必须是自己的 uid'
    return null
  }
  if (rest[0] === 'memberControl') return typeof value === 'boolean' ? null : 'memberControl 必须是布尔值'
  return null
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
  if (rest[0] === 'state' || rest[0] === 'memberControl' || rest[0] === 'stream') return room.host === uid
  if (rest[0] === 'streamAsk') {
    // 「补链接」请求：房间成员都能发（房主没会员时，让有会员的成员补一条直链）
    return typeof room.members === 'object' && room.members !== null && Object.prototype.hasOwnProperty.call(room.members, uid)
  }
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

const handler = async (req, res) => {
  const started = now()
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname
  const q = url.searchParams
  let code = 200

  try {
    if (p === '/' || p === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        server: 'dango-party-server/' + VERSION,
        protocol: PROTOCOL_VERSION,
        uptimeSec: Math.round(process.uptime()),
        rooms: roomCount(),
        listeners: SUBSCRIBERS.size,
        signups: STATS.signups,
      })
      return
    }

    // ------------------------------------------------------- 运维接口（玩家用不到）
    // ------------------------------------------------------- 运维控制台（浏览器打开 /ui）
    if (p === '/ui' || p === '/ui/') {
      if (!ADMIN_TOKEN) return fail(res, 404, 'admin api disabled')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(readUiHtml())
      return
    }

    if (p === '/admin/rooms' || p === '/admin/stats' || p.startsWith('/admin/rooms/')) {
      if (!ADMIN_TOKEN) return fail(res, 404, 'admin api disabled')
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      const token = bearer || q.get('token') || ''
      if (token !== ADMIN_TOKEN) {
        code = 403
        STATS.rejected++
        return fail(res, 403, 'PERMISSION_DENIED: bad admin token')
      }
      if (p === '/admin/stats') {
        sendJson(res, 200, {
          ok: true,
          server: 'dango-party-server/' + VERSION,
          protocol: PROTOCOL_VERSION,
          uptimeSec: Math.round(process.uptime()),
          rooms: roomCount(),
          listeners: SUBSCRIBERS.size,
          ...STATS,
        })
        return
      }
      const km = p.match(/^\/admin\/rooms\/([^/]+)\/members\/([^/]+)$/)
      if (km) {
        if (req.method !== 'DELETE') return fail(res, 405, 'method not allowed')
        const kc = decodeURIComponent(km[1])
        const ku = decodeURIComponent(km[2])
        if (getNode(['rooms', kc, 'members', ku]) === undefined) return fail(res, 404, 'member not found')
        setAt(['rooms', kc, 'members', ku], undefined)
        bump(['rooms', kc, 'members', ku])
        broadcast('put', ['rooms', kc, 'members', ku], null)
        scheduleSave()
        log('admin kicked', ku.slice(0, 8), 'from', kc)
        return sendJson(res, 200, { ok: true, kicked: ku })
      }

      const m = p.match(/^\/admin\/rooms(?:\/(.+))?$/)
      const target = m && m[1] ? decodeURIComponent(m[1]) : ''
      if (!target) {
        if (req.method !== 'GET') return fail(res, 405, 'method not allowed')
        const rooms = tree.root.rooms && typeof tree.root.rooms === 'object' ? tree.root.rooms : {}
        const list = Object.entries(rooms).map(([code_, r]) => ({
          code: code_,
          host: r?.host,
          hostName: r?.hostName,
          protocol: r?.protocol,
          memberControl: r?.memberControl,
          members: Object.entries(r?.members || {}).map(([uid, mm]) => ({ uid, name: mm?.name, lastSeen: mm?.lastSeen })),
          state: r?.state ? { name: r.state.name, playing: r.state.playing, pos: r.state.pos, at: r.state.at } : null,
          ageMs: typeof r?.createdAt === 'number' ? now() - r.createdAt : null,
        }))
        sendJson(res, 200, { ok: true, rooms: list })
        return
      }
      // 强制关掉某个房间（等同于房主点「Close room」）
      if (req.method !== 'DELETE') return fail(res, 405, 'method not allowed')
      if (getNode(['rooms', target]) === undefined) return fail(res, 404, 'room not found')
      setAt(['rooms', target], undefined)
      bump(['rooms', target])
      broadcast('put', ['rooms', target], null)
      scheduleSave()
      log('admin closed room', target)
      sendJson(res, 200, { ok: true, closed: target })
      return
    }

    // ------------------------------------------------------- 匿名登录 / 刷新令牌
    // 设了 PARTY_KEY 之后，登录只认带正确 key 的请求（客户端配置里的 apiKey 就是它）。
    // 这样即使域名被扫描器发现（ts.net 证书会进 CT 日志，必然会被扫），也发不出新身份。
    if (p.startsWith('/id/')) {
      if (!p.endsWith('/v1/accounts:signUp') && !p.endsWith(':signUp')) return fail(res, 404, 'not found')
      if (req.method !== 'POST') return fail(res, 405, 'method not allowed')
      if (PARTY_KEY && q.get('key') !== PARTY_KEY) {
        code = 403
        STATS.rejected++
        log('signUp rejected: bad key')
        return fail(res, 403, 'PERMISSION_DENIED: invalid api key')
      }
      if (!signupAllowed()) {
        code = 429
        STATS.rejected++
        log('signUp rejected: rate limit')
        return fail(res, 429, 'too many sign-ups, retry later')
      }
      await readBody(req) // 请求体是 {"returnSecureToken":true}，这里不需要
      STATS.signups++
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
      if (PARTY_KEY && q.get('key') !== PARTY_KEY) {
        code = 403
        return fail(res, 403, 'PERMISSION_DENIED: invalid api key')
      }
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
        STATS.deletes++
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
        // 新建房间时检查总量上限（房主已经存在则不重复计数）
        if (a.length === 2 && a[0] === 'rooms' && getNode(a) === undefined && roomCount() >= MAX_ROOMS) {
          code = 429
          STATS.rejected++
          return fail(res, 429, `too many rooms (limit ${MAX_ROOMS}), 请联系服主清理`)
        }
        const invalid = validateWrite(a, value, uid, false)
        if (invalid) {
          code = 400
          STATS.rejected++
          log('rejected write', logPath(a) + ': ' + invalid)
          return fail(res, 400, 'INVALID_ARGUMENT: ' + invalid)
        }
        setAt(a, value)
        bump(a)
        broadcast('put', a, value)
        scheduleSave()
        STATS.writes++
        code = 200
        log('put', logPath(a), 'by', uid.slice(0, 8))
        return sendJson(res, 200, value, { ETag: etagOf(a) })
      }

      if (method === 'PATCH') {
        const patch = resolveTimestamps(parseJson(text || '{}', 'PATCH body'))
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return fail(res, 400, 'PATCH body must be an object')
        const invalid = validateWrite(a, patch, uid, true)
        if (invalid) {
          code = 400
          STATS.rejected++
          log('rejected patch', logPath(a) + ': ' + invalid)
          return fail(res, 400, 'INVALID_ARGUMENT: ' + invalid)
        }
        mergeAt(a, patch)
        bump(a)
        broadcast('patch', a, patch)
        scheduleSave()
        STATS.writes++
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
}

// 有证书就直接用 Node 自己终止 TLS（不用 Nginx / Caddy）；没有就走明文 http（本机测试 / 反代后面）
const TLS_CERT = process.env.TLS_CERT || ''
const TLS_KEY = process.env.TLS_KEY || ''
const TLS = Boolean(TLS_CERT && TLS_KEY)

function loadTlsOptions() {
  try {
    return { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }
  } catch (e) {
    console.error('[X] 读不到证书文件：' + e.message)
    console.error('    TLS_CERT=' + TLS_CERT)
    console.error('    TLS_KEY=' + TLS_KEY)
    process.exit(1)
  }
}

const server = TLS ? https.createServer(loadTlsOptions(), handler) : http.createServer(handler)

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
  STATS.listens++

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
  const scheme = TLS ? 'https' : 'http'
  log(`Dango party server listening on ${scheme}://${HOST}:${actual}`)
  log('  /id/v1/accounts:signUp  /token/v1/token  /db/<path>.json')
  log('  data: ' + DATA_FILE)
  log('')
  if (TLS) {
    log('  TLS: ' + TLS_CERT)
    log(`  客户端 relayUrl 填 ${scheme}://<域名或 IP>:${actual}`)
  } else {
    log('  明文 http：本机测试可以；要给别的玩家用，请配 TLS_CERT/TLS_KEY 或放在 HTTPS 反代后面')
  }
  log('')
  if (PARTY_KEY) {
    log('  apiKey: ' + PARTY_KEY + '   （客户端 firebase.properties 里的 apiKey 必须和它一致）')
    log('          已存在 ' + APIKEY_FILE + '，删掉它即可换新口令')
  } else {
    log('  apiKey 校验已关闭（PARTY_KEY=none）：谁都能匿名登录，只适合本机测试')
  }
  if (ADMIN_TOKEN) {
    log('  运维口令: ' + ADMIN_TOKEN + '   （GET /admin/rooms、DELETE /admin/rooms/<码>、GET /admin/stats）')
    log('          用 Authorization: Bearer <口令> 或 ?token=<口令>；存在 ' + ADMIN_FILE)
  } else {
    log('  运维接口已关闭（ADMIN_TOKEN=none）')
  }
  log('')
  log(`  限速：登录 ${RATE_SIGNUP_PER_MIN || '不限'}/分钟；房间上限 ${MAX_ROOMS}；房主接管窗口 ${TAKEOVER_MIN} 分钟`)
  const cfgUrl = PUBLIC_URL || (TLS ? `${scheme}://127.0.0.1:${actual}` : '')
  const sample = writeSampleConfig(cfgUrl)
  if (sample.file) {
    if (sample.created) {
      log('  样例配置已生成：' + sample.file)
      log('    复制成 firebase.properties，把 party.example.com 换成你的地址后发给玩家')
      log('    （以后不会再覆盖它；换口令只同步里面的 apiKey 那一行）')
    } else {
      log('  样例配置：' + sample.file + '（已存在，未改动）')
    }
  }
  if (process.env.TEST_PORT_READY === '1') console.log('PORT_READY ' + actual)
})
