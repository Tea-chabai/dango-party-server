#!/usr/bin/env node
/**
 * 协议一致性测试：完全照 DangoMusic 客户端（Firebase.kt / PartyHttp.kt）的写法跟服务器对话，
 * 模拟「房主 + 成员」两个人走完 开房 → 加入 → 心跳 → 同步状态 → 成员控制 → 关房。
 *
 *   npm test          （等价 node test/protocol.mjs）
 *
 * 测试自己会在随机端口拉起 server.mjs（数据目录用临时目录），跑完杀掉，不需要手动起服务。
 */
'use strict'

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dango-party-test-'))
const KEY = 'test-key'

let BASE = ''

let passed = 0
function ok(name, cond, extra) {
  if (cond) {
    passed++
    console.log('  ✓ ' + name)
  } else {
    console.error('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra) : ''))
    throw new Error('assertion failed: ' + name)
  }
}

// ---------------------------------------------------------------- 启服务器

function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR,
      QUIET: '1',
      TEST_PORT_READY: '1',
      // 测试默认固定口令；传 PARTY_KEY: undefined 可以测「自动生成」那条路
      PARTY_KEY: KEY,
      ...extraEnv,
    }
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('服务器 10 秒内没起来：\n' + out))
    }, 10_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const onData = (d) => {
      out += d
      const m = out.match(/PORT_READY (\d+)/)
      if (m) {
        clearTimeout(timer)
        resolve({ child, base: `http://127.0.0.1:${m[1]}` })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error('服务器提前退出（code ' + code + '）：\n' + out))
    })
  })
}

// ---------------------------------------------------------------- HTTP（照 PartyHttp.send）

async function call(method, pathname, { body, headers = {} } = {}) {
  const h = { ...headers }
  let realMethod = method
  if (method === 'PATCH') {
    realMethod = 'POST'
    h['X-HTTP-Method-Override'] = 'PATCH'
  }
  if (body !== undefined && body !== null) h['Content-Type'] = 'application/json; charset=utf-8'
  const res = await fetch(BASE + pathname, {
    method: realMethod,
    headers: h,
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = text === '' ? null : JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json, etag: res.headers.get('etag'), relayed: res.headers.get('x-dango-relay') !== null }
}

const auth = {
  signUp: () => call('POST', `/id/v1/accounts:signUp?key=${KEY}`, { body: { returnSecureToken: true } }),
  refresh: async (refreshToken) => {
    const res = await fetch(`${BASE}/token/v1/token?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refreshToken),
    })
    return { status: res.status, json: await res.json(), relayed: res.headers.get('x-dango-relay') !== null }
  },
}

function db(me) {
  const q = '?auth=' + me.idToken
  const req = (method, p, opts = {}) => call(method, `/db/${p}.json${q}`, opts)
  return {
    get: (p) => req('GET', p),
    getWithEtag: async (p) => {
      const r = await req('GET', p, { headers: { 'X-Firebase-ETag': 'true' } })
      return { value: r.json, etag: r.etag, status: r.status }
    },
    put: (p, value) => req('PUT', p, { body: value }),
    putIfUnchanged: (p, value, etag) => req('PUT', p, { body: value, headers: { 'if-match': etag } }),
    patch: (p, value) => req('PATCH', p, { body: value }),
    del: (p) => req('DELETE', p),
  }
}

const sv = { '.sv': 'timestamp' }

// ---------------------------------------------------------------- SSE（照 Firebase.listen）

function listen(me, p) {
  const events = []
  const url = `${BASE}/db/${p}.json?auth=${me.idToken}`
  const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
    let event = ''
    let buf = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          events.push({ event, data: data === 'null' ? null : JSON.parse(data) })
        }
      }
    })
  })
  req.on('error', () => {})
  return {
    status: () => req.res?.statusCode,
    relayed: () => req.res?.headers?.['x-dango-relay'] !== undefined,
    async waitFor(match, timeoutMs = 4000) {
      const until = Date.now() + timeoutMs
      let seen = 0
      while (Date.now() < until) {
        for (; seen < events.length; seen++) if (match(events[seen])) return events[seen]
        await new Promise((r) => setTimeout(r, 25))
      }
      return null
    },
    close() {
      req.destroy()
    },
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 场景

async function main() {
  const code = 'D-' + Array.from({ length: 5 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 30)]).join('')
  console.log(`server: ${BASE}`)
  console.log(`room:   ${code}\n`)

  console.log('1) 匿名登录 + 刷新令牌')
  const hAuth = await auth.signUp()
  ok('signUp 返回 200', hAuth.status === 200, hAuth)
  ok('响应带 X-Dango-Relay', hAuth.relayed)
  ok('有 localId / idToken / refreshToken', !!hAuth.json.localId && !!hAuth.json.idToken && !!hAuth.json.refreshToken)
  const mAuth = await auth.signUp()
  ok('第二个玩家 uid 不同', mAuth.json.localId !== hAuth.json.localId)
  const refreshed = await auth.refresh(hAuth.json.refreshToken)
  ok('刷新令牌 200 且 uid 不变', refreshed.status === 200 && refreshed.json.user_id === hAuth.json.localId, refreshed)

  const host = { idToken: hAuth.json.idToken, uid: hAuth.json.localId }
  const member = { idToken: mAuth.json.idToken, uid: mAuth.json.localId }
  const H = db(host)
  const M = db(member)

  console.log('\n2) 校时（PUT clock/{uid} + {".sv":"timestamp"}）')
  const before = Date.now()
  const clock = await H.put('clock/' + host.uid, sv)
  const after = Date.now()
  ok('返回服务器时间戳', typeof clock.json === 'number', clock)
  ok('时间戳落在本次请求区间内', clock.json >= before - 1000 && clock.json <= after + 1000, { before, clock: clock.json, after })

  console.log('\n3) 开房（读 ETag → 条件写）')
  const empty = await H.getWithEtag('rooms/' + code)
  ok('空房间 ETag 是 null_etag', empty.etag === '"null_etag"' && empty.value === null, empty)
  const room = {
    protocol: 3,
    host: host.uid,
    hostName: '房主',
    memberControl: true,
    createdAt: sv,
    members: { [host.uid]: { name: '房主', lastSeen: sv } },
  }
  const created = await H.putIfUnchanged('rooms/' + code, room, empty.etag)
  ok('条件写成功', created.status === 200, created)
  ok(
    'createdAt / lastSeen 被换成数字',
    typeof created.json.createdAt === 'number' && typeof created.json.members[host.uid].lastSeen === 'number',
    created.json,
  )

  console.log('\n4) 房主开始监听（SSE 首帧是整棵树）')
  const hostSse = listen(host, 'rooms/' + code)
  const first = await hostSse.waitFor((e) => e.event === 'put' && e.data?.path === '/')
  ok('收到 put "/" 快照', !!first && first.data.data.host === host.uid, first)
  ok('监听响应带 X-Dango-Relay', hostSse.relayed())

  console.log('\n5) 成员加入')
  const seenRoom = await M.get('rooms/' + code)
  ok('成员能读到房间', seenRoom.json?.protocol === 3, seenRoom)
  const joined = await M.put('rooms/' + code + '/members/' + member.uid, { name: '成员', lastSeen: sv })
  ok('成员写入自己的 members 节点', joined.status === 200)
  const joinEvent = await hostSse.waitFor((e) => e.data?.path === '/members/' + member.uid)
  ok('房主收到成员加入的 put 推送', !!joinEvent && joinEvent.data.data.name === '成员', joinEvent)

  const memberSse = listen(member, 'rooms/' + code)
  const mFirst = await memberSse.waitFor((e) => e.event === 'put' && e.data?.path === '/')
  ok('成员收到整间房快照', !!mFirst && mFirst.data.data.members[member.uid] !== undefined)

  console.log('\n6) 心跳（PATCH 浅合并）')
  const beat = await M.patch('rooms/' + code + '/members/' + member.uid, { lastSeen: sv })
  ok('心跳 200', beat.status === 200)
  const beatEvent = await hostSse.waitFor(
    (e) => e.event === 'patch' && e.data?.path === '/members/' + member.uid && typeof e.data.data?.lastSeen === 'number',
  )
  ok('房主收到心跳 patch', !!beatEvent, beatEvent)
  const stillHasName = await M.get('rooms/' + code + '/members/' + member.uid)
  ok('PATCH 没把 name 冲掉', stillHasName.json?.name === '成员', stillHasName)

  console.log('\n7) 房主同步播放状态')
  const state = {
    source: 'netease',
    trackId: 12345,
    nativeId: '12345',
    mediaId: '12345',
    albumId: '',
    name: '测试歌曲',
    artists: '测试歌手',
    cover: '',
    duration: 180000,
    pos: 42000,
    playing: true,
    at: sv,
  }
  const st = await H.put('rooms/' + code + '/state', state)
  ok('state 写入 200', st.status === 200)
  const stateEvent = await memberSse.waitFor((e) => e.data?.path === '/state')
  ok('成员收到 /state 推送且 at 是数字', !!stateEvent && typeof stateEvent.data.data.at === 'number', stateEvent)

  console.log('\n8) 成员控制（req 请求）')
  const reqBody = { id: 'r1', by: member.uid, byName: '成员', op: 'next', pos: 0, at: sv }
  const req = await M.put('rooms/' + code + '/req', reqBody)
  ok('memberControl=true 时成员可写 req', req.status === 200, req)
  const reqEvent = await hostSse.waitFor((e) => e.data?.path === '/req')
  ok('房主收到 /req 推送', !!reqEvent && reqEvent.data.data.op === 'next', reqEvent)

  const off = await H.patch('rooms/' + code, { memberControl: false })
  ok('房主关闭成员控制', off.status === 200)
  const offEvent = await memberSse.waitFor(
    (e) => e.event === 'patch' && e.data?.path === '/' && e.data.data.memberControl === false,
  )
  ok('成员收到 memberControl=false 的 patch', !!offEvent, offEvent)
  const reqDenied = await M.put('rooms/' + code + '/req', { ...reqBody, id: 'r2' })
  ok('关闭后成员写 req 被拒（403）', reqDenied.status === 403, reqDenied)

  console.log('\n9) 权限边界')
  const otherWrite = await M.put('rooms/' + code + '/members/' + host.uid, { name: '篡改', lastSeen: sv })
  ok('成员不能写别人的 members 节点（403）', otherWrite.status === 403, otherWrite)
  const stateByMember = await M.put('rooms/' + code + '/state', state)
  ok('成员不能写 state（403）', stateByMember.status === 403, stateByMember)
  const badToken = await call('GET', `/db/rooms/${code}.json?auth=nonsense`)
  ok('错误令牌 401', badToken.status === 401, badToken)
  const listRooms = await M.get('rooms')
  ok('不能列房间目录（403）', listRooms.status === 403, listRooms)
  const otherClock = await M.get('clock/' + host.uid)
  ok('不能读别人的 clock 节点（403）', otherClock.status === 403, otherClock)

  console.log('\n10) 陈旧 ETag（抢码）')
  const staleTag = (await H.getWithEtag('rooms/' + code)).etag
  await H.patch('rooms/' + code, { memberControl: true })
  const stale = await H.putIfUnchanged('rooms/' + code, { host: host.uid }, staleTag)
  ok('用旧 ETag 写入失败（412）', stale.status === 412, stale)

  console.log('\n11) 成员离开 → 房主关房')
  const bye = await M.del('rooms/' + code + '/members/' + member.uid)
  ok('成员删除自己的成员节点', bye.status === 200)
  const byeEvent = await hostSse.waitFor((e) => e.data?.path === '/members/' + member.uid && e.data.data === null)
  ok('房主收到成员离开（put null）', !!byeEvent, byeEvent)

  const closed = await H.del('rooms/' + code)
  ok('房主关房 200', closed.status === 200)
  const closedEvent = await memberSse.waitFor(
    (e) => e.event === 'put' && e.data?.path === '/' && e.data.data === null,
  )
  ok('成员收到房间关闭（put "/" null）', !!closedEvent, closedEvent)

  const gone = await H.get('rooms/' + code)
  ok('房间确实没了', gone.json === null, gone)

  hostSse.close()
  memberSse.close()
  await sleep(50)
  return passed
}

// ---------------------------------------------------------------- 入口

let child = null
const cleanup = () => {
  try {
    child?.kill('SIGTERM')
  } catch {}
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true })
  } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

const server = await startServer()
child = server.child
BASE = server.base

/** 额外的第 12 组：PARTY_KEY（共享口令）生效时，错误的 apiKey 拿不到身份 */
async function testPartyKey() {
  console.log('\n12) PARTY_KEY 共享口令')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dango-party-key-'))
  const srv = await startServer({ PARTY_KEY: 'test-key', DATA_DIR: dataDir })
  const post = (key) =>
    fetch(`${srv.base}/id/v1/accounts:signUp?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"returnSecureToken":true}',
    })
  try {
    const wrong = await post('wrong-key')
    ok('错误 apiKey 被拒（403）', wrong.status === 403, wrong.status)
    const good = await post('test-key')
    ok('正确 apiKey 可以通过', good.status === 200, good.status)
    const health = await fetch(`${srv.base}/healthz`)
    ok('健康检查仍然公开', health.status === 200, health.status)
  } finally {
    try {
      srv.child.kill('SIGTERM')
    } catch {}
    try {
      fs.rmSync(dataDir, { recursive: true, force: true })
    } catch {}
  }
}

/** 第 13 组：不设 PARTY_KEY 时自动生成口令 + 样例配置（只生成一次、地址不被覆盖） */
async function testAutoKey() {
  console.log('\n13) 自动生成 apiKey 与样例配置')
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dango-party-auto-'))
  const srv = await startServer({ PARTY_KEY: undefined, PUBLIC_URL: 'https://party.test', DATA_DIR: dataDir })
  try {
    const keyFile = path.join(dataDir, 'apikey.txt')
    ok('生成了 data/apikey.txt', fs.existsSync(keyFile))
    const key = fs.readFileSync(keyFile, 'utf8').trim()
    ok('口令看起来是随机的', /^dango-[A-Za-z0-9_-]{8,}$/.test(key), key)

    const cfgFile = path.join(dataDir, 'firebase.properties.example')
    ok('生成了样例配置 data/firebase.properties.example', fs.existsSync(cfgFile))
    const cfg = fs.readFileSync(cfgFile, 'utf8')
    ok('样例里的 apiKey 与口令一致', cfg.includes('apiKey=' + key), cfg)
    ok('样例里填了 PUBLIC_URL', cfg.includes('relayUrl=https://party.test'), cfg)

    const good = await fetch(`${srv.base}/id/v1/accounts:signUp?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"returnSecureToken":true}',
    })
    ok('用自动生成的口令能登录', good.status === 200, good.status)
    const wrong = await fetch(`${srv.base}/id/v1/accounts:signUp?key=nope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"returnSecureToken":true}',
    })
    ok('别的口令被拒', wrong.status === 403, wrong.status)

    // 模拟腐竹把地址改成了自己的，然后再重启（不带 PUBLIC_URL）
    fs.writeFileSync(cfgFile, cfg.replaceAll('https://party.test', 'https://my.party.example'))
    srv.child.kill('SIGTERM')
    await sleep(300)
    const again = await startServer({ PARTY_KEY: undefined, DATA_DIR: dataDir })
    try {
      ok('重启后口令不变', fs.readFileSync(keyFile, 'utf8').trim() === key)
      const cfg2 = fs.readFileSync(cfgFile, 'utf8')
      ok('手改的地址没被覆盖', cfg2.includes('relayUrl=https://my.party.example'), cfg2)
      ok('样例里 apiKey 仍是同一个', cfg2.includes('apiKey=' + key), cfg2)
    } finally {
      try {
        again.child.kill('SIGTERM')
      } catch {}
    }

    // 换口令后再启动：只同步 apiKey 那一行，地址保持原样
    await sleep(300)
    const third = await startServer({ PARTY_KEY: 'changed-key', DATA_DIR: dataDir })
    try {
      const cfg3 = fs.readFileSync(cfgFile, 'utf8')
      ok('换口令后样例里的 apiKey 被同步', cfg3.includes('apiKey=changed-key'), cfg3)
      ok('换口令后地址依然没动', cfg3.includes('relayUrl=https://my.party.example'), cfg3)
    } finally {
      try {
        third.child.kill('SIGTERM')
      } catch {}
    }
  } finally {
    try {
      srv.child.kill('SIGTERM')
    } catch {}
    try {
      fs.rmSync(dataDir, { recursive: true, force: true })
    } catch {}
  }
}

main()
  .then(testPartyKey)
  .then(testAutoKey)
  .then(() => {
    console.log(`\n全部通过：${passed} 项`)
    cleanup()
    process.exit(0)
  })
  .catch((e) => {
    console.error('\n失败：' + e.message)
    cleanup()
    process.exit(1)
  })
