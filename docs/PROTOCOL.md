# 协议说明

Dango Music 的「一起听歌」本来用 Firebase 实时数据库（RTDB）同步。它的同步层是抽象的
（`PartyTransport`），默认实现 `Firebase` 自己也没用官方 SDK，只是对着 RTDB 的 REST + SSE 接口发请求。

所以只要把 `relayUrl` 指向一个「看起来像 Firebase」的服务，客户端一行代码都不用改。
本项目的 `server.mjs` 就是这样一个服务：实现了客户端真正用到的那些调用，不多不少。

> 本文档按客户端 1.7.0 的 `Firebase.kt` / `FirebaseEndpoints.kt` / `PartyHttp.kt` / `ListenParty.kt`
> 的实际行为整理，用于说明本服务器在兼容什么。改客户端时请以客户端代码为准。

## 1. 地址与请求格式

客户端把三类请求打到 `relayUrl` 下：

| 客户端请求 | 用途 |
| --- | --- |
| `POST {relay}/id/v1/accounts:signUp?key={apiKey}` | 匿名登录 |
| `POST {relay}/token/v1/token?key={apiKey}` | 刷新令牌 |
| `{GET,PUT,POST,DELETE} {relay}/db/{路径}.json?auth={idToken}` | 数据库读写 |

约定：

- **每个响应都必须带 `X-Dango-Relay` 头**。客户端靠它判断「中转是活的」；没有这个头会认为中转挂了，
  60 秒内改去直连 `databaseUrl`（然后大概率失败）。
- `relayUrl` 只接受 `https://主机[:端口]` 或 `http://127.0.0.1[:端口]` / `http://localhost[:端口]`。
- 连接超时 5 秒，普通请求读超时 10 秒，SSE 长连接读超时 70 秒。
- 写请求用固定长度流式发送，**不会自动重发**（避免重复写入）。
- `PATCH` 不是标准 HTTP 方法：客户端发 `POST` 并带 `X-HTTP-Method-Override: PATCH`，
  服务器必须按 PATCH 处理。
- 条件写用 `if-match: <etag>` 请求头。

## 2. 认证

### 匿名登录

```
POST {relay}/id/v1/accounts:signUp?key={apiKey}
Content-Type: application/json

{"returnSecureToken":true}
```

响应（字段名照 Firebase，字符串数字不能改成数字）：

```json
{
  "localId": "每台电脑一个固定 uid",
  "idToken": "1 小时有效的令牌",
  "refreshToken": "长期有效的刷新令牌",
  "expiresIn": "3600"
}
```

### 刷新令牌

```
POST {relay}/token/v1/token?key={apiKey}
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=...
```

响应：`{ "id_token", "refresh_token", "expires_in": "3600", "user_id" }`。

客户端把 `uid` + `refreshToken` 存在 `config/dangomusic/firebase_auth.json`，
令牌到期前 5 分钟会自动刷新；`401` 会让它重走一次刷新。
这个文件是**个人凭据**（uid 决定房间里的身份，`refreshToken` 等于登录态），
打包整合包分发时不能带上，否则所有玩家会共用一个 uid —— 见 README 的对应警告。

## 3. 数据库 REST

`{路径}` 是斜杠分隔的 JSON 树路径，必须以 `.json` 结尾（`/db/rooms/D-ABCDE/state.json`）。
`auth` 查询参数是 idToken。

| 方法 | 语义 |
| --- | --- |
| `GET` | 返回该节点；不存在返回 `null`（HTTP 200），并带 `ETag` |
| `PUT` | 整个替换该节点；body 为 `null` 时等于删除 |
| `PATCH` | **浅合并**：body 对象的每个键替换对应子节点，值为 `null` 表示删除该子节点 |
| `DELETE` | 删除该节点 |

细节：

- **ETag**：`GET` 必须返回 `ETag` 响应头。节点不存在时客户端的约定值是 `"null_etag"`。
- **条件写**：`PUT` 带 `if-match` 且与当前 ETag 不符时返回 `412`；客户端会换个房间码重试。
  开房用的正是「先 `GET` 拿 ETag，再带上 `if-match` 写」，用来防止两个人抢同一个房间码。
- **服务端时间戳**：body 里任何 `{".sv":"timestamp"}`（可以嵌套）都要替换成服务器当前毫秒时间。
  客户端用它统一各人电脑的时钟差和播放进度。
- **空容器**：删空的对象要一并删掉（与 RTDB 一致）。
- 读请求可以带 `X-Firebase-ETag: true`（客户端读房间时带），服务器忽略即可，仍然返回 `ETag`。

## 4. 实时推送（SSE）

```
GET {relay}/db/{路径}.json?auth={idToken}
Accept: text/event-stream
```

连上后必须：

1. 先推一次整段数据的快照：

   ```
   event: put
   data: {"path":"/","data":{...当前节点...}}

   ```

   节点不存在时 `data` 为 `null`。客户端收到它会清空本地镜像。

2. 之后每次变化推一条，`path` 是**相对监听路径**的位置：

   ```
   event: put
   data: {"path":"/members/abc","data":{"name":"x","lastSeen":123}}
   ```

   ```
   event: patch
   data: {"path":"/members/abc","data":{"lastSeen":124}}
   ```

3. 至少每 70 秒要写点什么，否则客户端读超时重连。本项目每 25 秒发一次心跳
   （`event: keep-alive` + `data: null`，客户端会忽略不认识的事件）。

4. 客户端断线会自动重连；重连后重新走一遍「快照 + 增量」。令牌快过期时它也会主动断开重连。

## 5. 权限

照作者线上的 `database.rules.json` 翻译（本项目 `allowedWrite` / `allowedRead`）：

| 路径 | 读 | 写 |
| --- | --- | --- |
| `rooms`（列表） | ❌ | ❌ |
| `rooms/{code}` | ✅ | 房间不存在时任何人都能建；存在时只有房主能改；房主 10 分钟没心跳时别人可以接管 |
| `rooms/{code}/members/{uid}` | ✅ | 只有 `uid` 自己能写 |
| `rooms/{code}/state` | ✅ | 只有房主 |
| `rooms/{code}/memberControl` | ✅ | 只有房主 |
| `rooms/{code}/req` | ✅ | 房间成员，且 `memberControl === true` |
| `clock/{uid}` | 只有自己 | 只有自己 |

违反返回 `403`（客户端会显示「成员控制被数据库拒绝了…」这类提示），令牌无效返回 `401`。

## 6. 数据结构

```
rooms/D-ABCDE
├── protocol: 3                 客户端协议版本（1/2/3）
├── host: "<uid>"               房主
├── hostName: "玩家名"
├── memberControl: true         是否允许成员切歌
├── createdAt: <服务器时间>
├── members
│   └── "<uid>": { name: "玩家名", lastSeen: <服务器时间> }
├── state                       房主当前播放的歌
│   ├── source: "netease" | "qq" | "kugou"
│   ├── trackId / nativeId / mediaId / albumId
│   ├── name / artists / cover / duration
│   ├── pos: 毫秒进度
│   ├── playing: true | false
│   └── at: <服务器时间>        进度对应的时刻（成员用它推算现在该放到哪）
└── req                         成员的操作请求，会被下一条覆盖
    ├── id / by / byName
    ├── op: "play" | "next" | "prev" | "pause" | "resume" | "seek"
    ├── pos / at
    └── （play 时还有歌曲字段）
```

`clock/{uid}` 存一个数字，只用于开场时的时钟校准。

## 7. 客户端调用序列

| 时机 | 调用 |
| --- | --- |
| 开房 | 登录 → `PUT clock/{uid}`（校时）→ 循环 8 次：`GET rooms/{code}` 拿 ETag → `PUT rooms/{code}` 带 `if-match` → 成功后开始 SSE 监听 |
| 加入 | 登录 → 校时 → `GET rooms/{code}`（看 `protocol` / 是否废弃）→ `PUT rooms/{code}/members/{uid}` → SSE 监听 |
| 心跳 | 每 30 秒 `PATCH rooms/{code}/members/{uid}` `{lastSeen: 服务器时间}` |
| 放歌 | 状态有变化（切歌 / 暂停 / 拖动超过 1.5 秒 / 每 30 秒兜底）时 `PUT rooms/{code}/state` |
| 成员控制 | 成员 `PUT rooms/{code}/req`；房主收到推送后执行，再把新状态写回 `state` |
| 关房 / 离开 | 房主 `DELETE rooms/{code}`，成员 `DELETE rooms/{code}/members/{uid}` |

成员列表：客户端只显示 90 秒内有心跳的成员；房主 11 分钟没心跳的房间算废弃，可以被新房间接管
（服务器侧清理阈值是 10 分钟，比客户端宽 1 分钟，避免时钟差导致被规则拒绝）。

## 8. 服务端侧的额外约束（不是协议要求，但本实现会执行）

客户端的 Firebase 规则里还有一层 `.validate`（字段类型/长度），本项目照它实现了校验，越界写会返回
`400 INVALID_ARGUMENT`：

| 字段 | 限制 |
| --- | --- |
| 房间码 | ≤ 16 字符 |
| `host` / `members.{uid}` | ≤ 128 字符 |
| `hostName` / `name` / `byName` | ≤ 64 字符 |
| `source` / `op` | ≤ 16 字符 |
| `nativeId` / `mediaId` / `albumId` / `req.id` | ≤ 64 字符 |
| `state.name` / `req.name` | ≤ 1024 字符 |
| `state.artists` / `req.artists` | ≤ 2048 字符 |
| `cover` | ≤ 4096 字符 |
| `trackId` / `duration` / `pos` / `at` / `lastSeen` / `createdAt` / `protocol` | 数字 |
| `playing` / `memberControl` | 布尔 |
| 单次写入整体 | ≤ 32 KB |

未知字段**放行**（将来客户端加字段不该炸房），这一点和 Firebase 规则的「禁止未知字段」不同，是有意为之。

除了字段长度/类型，规则里还有几条「结构约束」，本实现同样执行（越界返回 `400`）：

- 建房时 `host` 必须是自己；更新时只能保持原房主（不能把房主改成别人）；
- `members/{uid}` 写入后必须带 `lastSeen`（`PATCH` 按合并后的结果判断）；
- `req.by` 必须等于自己的 uid；
- `clock/{uid}` 必须是数字（`{".sv":"timestamp"}` 落地后）。

逐条对照（包括有意不同的地方和理由）见 **[docs/RULES.md](RULES.md)**。

另外两项不属于协议、只影响运维：

- **服务器时间用单调时钟**：`{".sv":"timestamp"}` 回填的时间基于 `performance.now()`，系统时间被
  NTP/手动调整时不会回跳。
- **`/admin/*` 运维接口**（列房间、强制关房、统计），用独立口令，和玩家客户端无关；
  详见 README 的「运维接口」。

## 9. 兼容性

- 房间的 `protocol` 决定能用的功能：`3` = 成员控制 + QQ/酷狗音源；`2` = QQ；`1` = 只有网易云。
- 老客户端不认识 `memberControl` / `req`：它们能加入、能跟着放，但只能房主控制，且新房对它们来说
  可能提示「需要更新版本」，这是客户端的判断，不是服务器。
- 服务器不校验 `apiKey`（客户端只是把它拼进 URL），所以换客户端版本不需要改服务器。
