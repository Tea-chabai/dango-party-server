# 与 `database.rules.json` 的逐条对照

DangoMusic 仓库里的 `database.rules.json` 是作者给 Firebase 写的安全规则。本项目不是 Firebase，
所以这些规则不会自动生效——需要我们在 `server.mjs` 里自己实现。本文档把每一条规则和实现对上，
方便以后客户端加字段时知道该改哪。

**状态说明**：✅ 已对齐 / ⚠️ 有意不同（附理由）/ 🧩 额外加固（规则里没有）。

## rooms/{code}

| Firebase 规则 | 本项目实现 | 状态 |
| --- | --- | --- |
| `.read: auth != null` | `allowedRead()`：登录用户可读 `rooms/{code}` 及以下 | ✅ |
| `.write: 不存在 \|\| host 是我 \|\| host 心跳 < now-600000` | `allowedWrite()` + `hostAbandoned()`（默认 10 分钟，`TAKEOVER_MIN` 可调） | ✅ |
| `.validate: $code.length <= 16` | `validateWrite()`：房间码 > 16 字符 → 400 | ✅ |
| `.validate: newData.hasChildren(['host'])` | 建房/更新必须带 `host` → 400 | ✅ |
| `.validate: host === auth.uid \|\| host === data.host` | 新建时 `host` 必须是自己；更新时只能保持原房主 → 400 | ✅ |
| `host` 字符串 ≤ 128 | 类型 + 长度校验 | ✅ |
| `hostName` ≤ 64 | 同上 | ✅ |
| `protocol` 是数字 | 同上 | ✅ |
| `memberControl` 是布尔 | 同上 | ✅ |
| `createdAt` 是数字 | 同上 | ✅ |
| `$other: { ".validate": false }` | **放行未知字段** | ⚠️ 见下 |

## rooms/{code}/members/{uid}

| Firebase 规则 | 本项目实现 | 状态 |
| --- | --- | --- |
| `.write: auth.uid === $uid && 房间存在` | `allowedWrite()`：uid 不匹配或房间不存在 → 403 | ✅ |
| `$uid.length <= 128` | 超长 → 400 | ✅ |
| `newData.hasChildren(['lastSeen'])` | PUT/PATCH 合并后缺 `lastSeen` → 400 | ✅ |
| `name` ≤ 64、`lastSeen` 是数字 | 类型 + 长度校验 | ✅ |
| `failedTrack`（1.7.5 新增：成员放不了哪首歌） | 字符串 ≤ 64，可缺省 | ✅ |
| `$other: false` | 放行未知字段 | ⚠️ 见下 |

## rooms/{code}/state

| Firebase 规则 | 本项目实现 | 状态 |
| --- | --- | --- |
| （继承父节点 `.write`：房主 / 可接管） | 仅房主可写 `state` | ✅（比规则严一点） |
| `trackId`/`duration`/`pos`/`at` 数字 `playing` 布尔 | 类型校验 | ✅ |
| `source` ≤ 16、`nativeId`/`mediaId`/`albumId` ≤ 64 | 长度校验 | ✅ |
| `name` ≤ 1024、`artists` ≤ 2048、`cover` ≤ 4096 | 长度校验 | ✅ |
| `$other: false` | 放行未知字段 | ⚠️ 见下 |

## rooms/{code}/req

| Firebase 规则 | 本项目实现 | 状态 |
| --- | --- | --- |
| `.write: 我是房间成员 && memberControl === true` | `allowedWrite()` 同款判断 | ✅ |
| `by` 字符串且 `=== auth.uid` | `by` 必须是自己 → 400 | ✅ |
| `id` ≤ 64、`byName` ≤ 64、`op` ≤ 16 | 长度校验（`op` 不做枚举，与规则一致） | ✅ |
| 歌曲字段长度/类型 | 与 `state` 同一套 | ✅ |
| `$other: false` | 放行未知字段 | ⚠️ 见下 |

## rooms/{code}/stream 与 streamAsk（本项目新增，作者规则里还没有）

给「一起听歌」加「共享播放直链」用的两个节点（会员歌曲可以让房间里的无会员玩家也听到完整版）：

| 节点 | 谁能写 | 字段与校验 |
| --- | --- | --- |
| `stream` | 只有房主 | `url`（≤2048，必须 http(s)）、`source` ≤16、`key` ≤64、`by`（=自己的 uid）、`at`/`expiresAt` 数字、`trial` 布尔、`gain`/`peak` 数字 |
| `streamAsk` | 任何房间成员 | `key` ≤64、`by`（=自己的 uid）、`at` 数字 |

用法：房主拿到完整版直链后写 `stream`；成员看到 `stream` 为空/过期时可以用 `streamAsk` 请求补链接，有能力的成员再写 `stream`
（本项目服务端允许成员写 `streamAsk`，但 `stream` 仍限房主，避免互相覆盖）。

⚠️ 这两个节点**不在作者仓库的 `database.rules.json` 里**。走作者的 Firebase 时，必须先在规则里加对应子树
（`$other: false` 会拒绝未知字段），否则房主写入会 `PERMISSION_DENIED`；自建服务端已经支持。

## clock/{uid}

| Firebase 规则 | 本项目实现 | 状态 |
| --- | --- | --- |
| `.read/.write: auth.uid === $uid` | 只允许读写自己的 `clock/{uid}` | ✅ |
| `.validate: newData.isNumber()` | `{".sv":"timestamp"}` 落地后必须是数字，否则 400 | ✅ |

## 有意不同的地方（以及为什么）

**未知字段放行（`$other: false` 那几条）**：Firebase 会直接拒绝多出来的字段；我们选择放行。
理由是客户端升级可能加字段（1.7.0 的 `protocol` 就从 2 涨到 3，`req` 也是后加的），
严格拒绝会让「服务端没升级 + 客户端升级」这个组合直接崩房。代价是这些字段不参与校验，
所以另外加了**单次写入 32 KB 上限**兜底。

如果你更想要 Firebase 那种严格模式，可以在 `validateWrite()` 里针对 `state` / `req` / `members`
补一个「未知键就拒绝」，并把 `docs/PROTOCOL.md` 的字段表同步更新。

**接管窗口 10 分钟（和规则一致）**：作者规则写的是 `now - 600000`，本项目默认也是 10 分钟
（`TAKEOVER_MIN` 可调）。为什么客户端是 11 分钟而服务端是 10 分钟：客户端的 11 分钟写死在
`ListenParty.ABANDONED_MS` 里，作者故意比服务端多留 1 分钟，避免两边时钟差一点点就卡在边界上被规则拒绝。
本项目保持这个关系，不擅自定义更短的窗口——服务端比客户端早，只是放行权限；客户端比服务端早，
才会出现「客户端以为可以接管、服务端拒绝」的报错。

**接管后的写入范围**：Firebase 的 `.write` 是继承的，所以「房主心跳超时」后别人连 `state`
都能写；本项目只允许接管者整体重建房间节点，`state`/`memberControl` 仍限房主。实际等价
（客户端接管走的是新建房间），但更保守。

## 额外加固（规则里没有，我们加的）

| 项 | 说明 |
| --- | --- |
| 单次写入 ≤ 32 KB | 防止有人塞大 JSON 撑爆 `data/party.json` |
| 登录限速 `RATE_SIGNUP`（默认 60/分钟） | 防止刷号 |
| 房间上限 `MAX_ROOMS`（默认 500） | 防止刷房 |
| 单调时钟 | `{".sv":"timestamp"}` 用 `performance.now()` 锚定，系统时间调整不会回跳 |
| 运维接口 `ADMIN_TOKEN` | 列房间 / 强制关房 / 统计，与玩家口令分开 |

以上改动都有对应的测试（`npm test`，第 14、15 组）。
