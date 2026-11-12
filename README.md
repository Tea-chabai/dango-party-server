# Dango Music · 一起听歌自建后端

![node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

给 [DangoMusic](https://github.com/Sorihiko/DangoMusic) 的「一起听歌」用的**自建同步后端**。
一个单文件 Node 服务，等价于 Firebase 实时数据库的一小部分接口，**客户端一行代码都不用改**，
只要把一份 `firebase.properties` 发给玩家即可。

- 房间同步：谁在放哪首歌、放到第几秒、暂停/继续、成员列表、成员控制
- **音频不经过服务器**：每个人用自己的账号（网易云 / QQ / 酷狗）拉流，服务器只转发元数据和进度
- 零依赖、单文件、数据落盘，1 核 256MB 的小机器足够十几个人同时听
- 自带协议一致性测试（88 项，模拟房主 + 成员跑完整流程）

> 不是 DangoMusic 官方项目，也不是 Firebase 的替代品实现；只是「让客户端连到自己机器」的这一小块。
>
> 📦 **要打包整合包发出去？先看下面「打包整合包时：不要带上 uid 文件」**——
> `config/dangomusic/firebase_auth.json` 是个人凭据，带上它会让所有玩家共用同一个身份。

## 文档导航

| 我想… | 看这篇 |
|---|---|
| 十分钟跑起来看看 | 下面「快速开始」 |
| 装成系统服务（Linux / Windows 开机自启） | **[docs/DEPLOY-OS.md](docs/DEPLOY-OS.md)** |
| 选一个对外入口（Cloudflare Tunnel / Nginx / 反代） | [docs/DEPLOY.md](docs/DEPLOY.md) |
| 用 Tailscale Funnel 白嫖（不开端口） | [docs/DEPLOY-TAILSCALE.md](docs/DEPLOY-TAILSCALE.md) |
| 从 Windows 迁到 Debian 12 | [docs/MIGRATE.md](docs/MIGRATE.md) |
| 定期重启、日志清理 | [docs/MAINTENANCE.md](docs/MAINTENANCE.md) |
| 协议细节 / 权限规则 | [docs/PROTOCOL.md](docs/PROTOCOL.md) · [docs/RULES.md](docs/RULES.md) |
| 和 MusicParty / mpsync 有什么区别 | [docs/COMPARISON.md](docs/COMPARISON.md) |
| 国内访问为什么慢、能不能优化 | [docs/PERF.md](docs/PERF.md) |


## 快速开始

```bash
# 需要 Node 18+
git clone https://github.com/<you>/dango-party-server.git
cd dango-party-server

node server.mjs          # 默认 http://127.0.0.1:8787

启动后你会看到大概这样（`run.bat` 双开即用）：

```text
============================================================

    Dango Music · 一起听歌 · 自建服务器

============================================================

    Node 版本      v24.16.0
    监听地址       http://127.0.0.1:8787
    自检地址       http://127.0.0.1:8787/healthz

    换端口         先 set PORT=9000，再运行本脚本
    停止服务       关闭这个窗口，或者按 Ctrl+C

------------------------------------------------------------

    下面会打印 apiKey、运维口令、配置文件位置

------------------------------------------------------------

17:31:29 loaded 1 room(s) from E:\git\dango-party-server\data\party.json
17:31:29 Dango party server listening on http://127.0.0.1:8787
17:31:29   /id/v1/accounts:signUp  /token/v1/token  /db/<path>.json
17:31:29   data: E:\git\dango-party-server\data\party.json
17:31:29   明文 http：本机测试可以；要给别的玩家用，请配 TLS_CERT/TLS_KEY 或放在 HTTPS 反代后面
17:31:29   apiKey: dango-XXXXXXXXXXXX   （客户端 firebase.properties 里的 apiKey 必须和它一致）
17:31:29   运维口令: adm-XXXXXXXXXXXX   （GET /admin/rooms、DELETE /admin/rooms/<码>、GET /admin/stats）
17:31:29   限速：登录 60/分钟；房间上限 500；房主接管窗口 10 分钟
17:31:29   样例配置已生成：...\data\firebase.properties.example
```

看到 `apiKey` 和 `运维口令` 就先截图/复制存好，后面配客户端和管理页面都要用。
npm test                 # 协议测试：自己拉起服务器，跑完自动关掉
```

Windows 上也可以直接双击 `启动服务器.bat`（关闭窗口即停止服务器）。

本机先验证（不用域名、不用 TLS）：

1. 起服务。启动日志会打印 `apiKey: dango-xxxx`，并**自动生成一份样例配置**
   `data/firebase.properties.example`（apiKey 已经对好，地址是占位符；只生成一次，之后不会覆盖）。
2. 把它复制一份命名为 `firebase.properties`，地址改成本机的 `https://127.0.0.1:8787` /
   `http://127.0.0.1:8787`，放进游戏目录的 `config/dangomusic/`：

   ```properties
   apiKey=dango-xxxx（照抄启动日志或样例文件里的）
   databaseUrl=https://127.0.0.1:8787
   relayUrl=http://127.0.0.1:8787
   ```

   （想固定成文档里的 `apiKey=local-party`，就在启动前设 `PARTY_KEY=local-party`。）
3. 进游戏按 `M` → 左侧 `♬ 一起听歌` → 底部**「连接方式」选 `Direct`** → `Create a room`。
   服务器窗口打印 `put /rooms/D-XXXXX`、页面出现房间码，就通了。

## 部署方案（多选一）

客户端只要求一个**受信任证书的 https 入口**（`127.0.0.1` / `localhost` 例外，它们允许 http），
至于这个入口由谁提供——Node 自己、Caddy/Nginx、隧道、还是 Google——客户端不关心。
所以下面这些都能用，按自己的条件挑一个：

| 方案 | 要域名 | 要证书 | 要开端口 | 客户端 `relayUrl` |
| --- | --- | --- | --- | --- |
| **本机测试** | — | — | — | `http://127.0.0.1:8787` |
| **Firebase**（不部署本项目） | 不要 | 不要 | 不要 | 留空 |
| **Node 自带 TLS + IP 证书** | 不要 | LE 6 天短期 | 80 + 8443 | `https://<公网IP>:8443` |
| **Node 自带 TLS + 域名证书** | 要 | acme / certbot | 80 或 DNS | `https://party.example.com:8443` |
| **Caddy 反代** | 要 | 自动 | 80 / 443 | `https://party.example.com` |
| **Nginx 反代** | 要 | 自备 | 80 / 443 | `https://party.example.com` |
| **Nginx 非标准端口 + 泛域名证书**（2.6b） | 要 | 自备（如 `*.nyaneko.org`） | 例如 7716/8787 | `https://music.nyaneko.org:8787` |
| **Cloudflare Tunnel**（2.12，推荐） | 不要 | Cloudflare 托管域名 | 只出站 | \https://music.nyaneko.org\ |
| **Tailscale Funnel** | 不要 | 自动 | 不要 | `https://<机器>.<tailnet>.ts.net` |
| **Cloudflare Tunnel** | 要 | 自动 | 不要 | `https://party.example.com` |
| **Cloudflare 橙云** | 要 | 自动 | 80/443（或 8443） | `https://party.example.com` |
| **EasyTier 中继**（配合客户端 EasyTier 模式） | 要（11010） | 不需要 | UDP/TCP 11010 | 客户端填 `tcp://<中继IP>:11010` |

**完整的服务器命令、每种方案对应的客户端 `firebase.properties` 原文、注意事项**
都在 **[docs/DEPLOY.md](docs/DEPLOY.md)**（2.1 ~ 2.11 节，可整段复制）。
现成的 nginx 站点样例：[examples/nginx-music.conf](examples/nginx-music.conf)（非标准端口 + 泛域名证书，2.6b）。
最省事的 **Tailscale Funnel** 因为最常用，完整走法在下面单独写了一节。

> **EasyTier 中继**（2.11）只负责**组网**，不提供同步接口——同步服务仍然是本项目的 `node server.mjs`。
> 客户端里的「EasyTier 模式」会连你自建的中继；**本项目不内置任何公共节点**，玩家留空就只能局域网直连。

> **一个入站端口都不能开？** 那就只剩三条：**Tailscale Funnel**（最推荐，纯出站）、
> **Cloudflare Tunnel**（要域名，纯出站）、**Firebase**（连服务器都不用）。
> 其它方案至少要开一个入站端口（Node 自带 TLS 用 8443、反代用 443），
> IP 证书那条还必须开 80（HTTP-01 验证）。

### 三种最常见的配置原文

本机测试：

```properties
apiKey=local-party
databaseUrl=https://127.0.0.1:8787
relayUrl=http://127.0.0.1:8787
```

公网 https（IP 证书 / 域名 / 反代 / 隧道都一样，只是地址不同）：

```properties
apiKey=local-party
databaseUrl=https://party.example.com
relayUrl=https://party.example.com
```

直接用 Firebase（服务器都不用开）：

```properties
apiKey=AIzaSy...
databaseUrl=https://xxx-default-rtdb.firebaseio.com
relayUrl=
```

> 规则：`relayUrl` 只接受 `https://主机[:端口]` 或本机 `http://127.0.0.1[:端口]` / `http://localhost[:端口]`；
> `databaseUrl` 必须以 `https://` 开头；配置文件放在**游戏目录**里，优先于 jar 内自带的配置。

### 一句话选型

- 只想先跑起来 → **本机** / **Tailscale Funnel**；
- 有公网 IP、想长期稳 → **Node 自带 TLS + IP 证书**（记得自动续期）；
- 玩家都在墙外、懒得运维 → **Firebase**；
- 想隐藏源站 / 抗打 → **Cloudflare**（需要域名）。

### 几个共同的坑

- **内网 `http://192.168.x.x:8787` 不行**：客户端只放行 https，`http://` 只对 `127.0.0.1` / `localhost` 生效；
- **自签证书不行**：客户端是 Java，默认不信任自签 CA；
- **SSE 必须不缓冲**：Nginx `proxy_buffering off`、Caddy `flush_interval -1`（Node 直出 / 隧道没这问题）；
- **6 天 IP 证书必须自动续期**，一次失败就全断；
- **`firebase_auth.json` 不能进整合包**，见下一节。

## 用 Tailscale Funnel 部署（保姆级）

不想买域名、不想开端口、想十分钟内跑起来？整篇步骤已拆到
**[docs/DEPLOY-TAILSCALE.md](docs/DEPLOY-TAILSCALE.md)**：一次性准备 → 暴露 8787 → 验证 → 客户端配置 → 日常维护 → 排错。

## 发给玩家

`player/` 目录就是给玩家的包，改一处域名后打包发出去：

| 文件 | 作用 |
| --- | --- |
| `player/firebase.properties` | 把两处 `party.example.com` 改成你的服务器域名（用 Firebase 就换成 Firebase 的两个值）；<br>**也可以把服务器生成的 `data/firebase.properties.example` 复制改名后用**（apiKey 已对好） |
| `player/安装配置.bat` | 玩家双击即装到 `.minecraft/config/dangomusic/`；PCL/HMCL 用户可把实例目录拖上去 |
| `player/安装说明.txt` | 操作步骤、Direct 连接方式、常见问题 |

> 配置文件放在**游戏目录**里，优先于 jar 内自带的配置，所以玩家用**官方 release jar**（任何版本）
> 也能接入你的服务器，不需要重新打包。`X-Dango-Relay`、登录接口这些都在服务端处理。
>
> `install` 类 `.bat` 是 **GBK + CRLF** 编码（中文 Windows 的 cmd 默认 GBK），用编辑器改过之后
> 记得存回 GBK，否则会出现 `'xxx' 不是内部或外部命令`。

## ⚠️ 打包整合包时：不要带上 uid 文件

「一起听歌」的身份是**每台游戏安装一个匿名 uid**（不是 IP、也不是玩家名），存在
`config/dangomusic/firebase_auth.json` 里。**这个文件是个人凭据，绝对不能进整合包。**

如果整合包打包了它，所有装这个包的玩家会**共用同一个 uid**：

- 在服务器眼里这些客户端是**同一个人**：房间的 `host` 认的就是这个 uid，所以拿到包的每个人
  都能以房主权限改房间、改播放状态、关房；
- 成员列表里这些玩家只算一个人，`(you)` 会标错人，房主/成员判断乱套；
- `refreshToken` 跟着泄露，拿到它的人能以这个身份连你的服务器（不装游戏也能用）；
- 有人退出时会把 `members/{uid}` 删掉，等于把别人的心跳节点一起删了，房间看起来就没人在。

整合包里 `config/dangomusic/` 各文件的处理方式：

| 文件 | 整合包里要不要带 | 说明 |
| --- | --- | --- |
| `firebase.properties` | ✅ **要带**（改成你的域名） | 服务器地址，功能靠它 |
| `firebase_auth.json` | ❌ **绝对不要** | 匿名 uid + 刷新令牌，等于这个人的身份 |
| `netease_session.json` / `qq_session.json` / `kugou_session.json` | ❌ 不要 | 音乐账号登录态 |
| `netease_cookie.txt` | ❌ 不要 | 网易云 Cookie |
| `config.json` | ⚠️ 不建议 | 你的个人设置会强加给所有玩家 |
| `party_proxy.json` | ⚠️ 不建议 | 会把你的连接方式（如 Direct）写死给别人 |
| `update_check.json` | 无所谓 | 只是缓存 |

正确的打包方式：整合包里只放 `config/dangomusic/firebase.properties`，或者什么都不放、让玩家跑
`player/安装配置.bat`。客户端首次进入一起听歌页面时会自己重新生成 `firebase_auth.json`（新的 uid），
所以删掉它不影响功能，只会让这个玩家变成"新身份"。

**如果已经打包发出去了**：把上述文件从包里删掉；服务器端再删一次 `data/secret`（所有人重新登录、
旧令牌全部失效），否则泄露的 `refreshToken` 依然能用。

## 工作原理

DangoMusic 的同步层是抽象的（`PartyTransport`），默认实现是个手写的 Firebase 客户端，
只用到 RTDB 的几个 REST 调用 + 一个 SSE 长连接。客户端把 `relayUrl` 拼在这三个前缀前面：

| 前缀 | 用途 |
| --- | --- |
| `/id/v1/accounts:signUp` | 匿名登录，一台电脑一个固定 uid |
| `/token/v1/token` | 刷新令牌（1 小时有效） |
| `/db/<路径>.json` | 读写 + `ETag` / `if-match` 条件写 + `{".sv":"timestamp"}` 服务端时间戳 + SSE 推送 |

只要这三个前缀的行为对得上，客户端就完全无感。协议细节（含请求/响应示例、权限矩阵、数据布局、
客户端调用时序）都在 **[docs/PROTOCOL.md](docs/PROTOCOL.md)**。

权限照作者线上的 `database.rules.json` 翻译：房主才能改房间 / 写 `state`，成员只能写自己的
`members/{uid}`，只有房主开了「允许成员控制」成员才能写 `req`；房间不能列目录；房主 10 分钟没心跳
可以被接管。

## 兼容性

| 客户端 | 房间 `protocol` | 说明 |
| --- | --- | --- |
| 1.7.5 | 3 | 协议未变；新增 `members.failedTrack`（成员放不了哪首歌），服务端只做长度校验 |
| 1.7.3 ~ 1.7.4 | 3 | 协议未变；1.7.3 起客户端优先走「当前服务器」通道，本服务端作为兜底 |
| 1.7.0 | 3 | 成员控制 + QQ / 酷狗音源 |
| 1.6.x | 2 | 有 `req`，但只有 QQ |
| 更早 | 1 | 只有网易云；不认 `memberControl`，只能房主控制 |

服务器不校验 `apiKey`（客户端只是把它拼进 URL），所以**服务端不需要跟着客户端升级**。

## 日志

> 换机器（含 Windows → Debian 12）的完整步骤见 **[docs/MIGRATE.md](docs/MIGRATE.md)**。


控制台只打「有信息量」的行：登录、建房、加入、状态变更、关房、被拒绝的请求。

**以下请求不再刷屏**（其余照常打印）：
- 成员心跳：`PATCH rooms/<码>/members/<uid>`（只带 `lastSeen`）→ 写入 `data/heartbeat.log`；
- WebUI 轮询：`GET /admin/rooms`、`GET /admin/stats`（页面每 2 秒一次）；
- 探活：`GET /healthz`。

心跳写文件的细节：
而是追加到 `data/heartbeat.log`（超过 5 MB 自动滚一份 `.1`）：

```text
2026-11-10T18:20:40.838Z patch /rooms/D-T1/members/5f79be4d… by 5f79be4d
```

想临时看心跳：`Get-Content data\heartbeat.log -Tail 20`（Windows）/ `tail -f data/heartbeat.log`。

## 运维接口（服主用）

服务端自带三个运维接口，玩家客户端用不到：

| 接口 | 作用 |
| --- | --- |
| `GET /ui` | **浏览器控制台**：房间列表、成员、当前歌曲、统计，可直接关房/踢人（口令在 `data/admintoken.txt`，页面里填一次存在浏览器） |
| `GET /admin/rooms` | 列出所有房间（房间码、房主、成员、当前歌、存活时长） |
| `DELETE /admin/rooms/<码>` | 强制关房（等同房主点 `Close room`，在线成员会收到关闭推送） |
| `GET /admin/stats` | 版本、协议版本、房间数、在线监听、登录/写入/拒绝计数 |

口令在启动时自动生成并打印，存在 `data/admintoken.txt`（`ADMIN_TOKEN=xxx` 覆盖，`ADMIN_TOKEN=none` 关闭）：

```bash
curl -H "Authorization: Bearer <口令>" http://127.0.0.1:8787/admin/rooms
curl -X DELETE "http://127.0.0.1:8787/admin/rooms/D-ABCDE?token=<口令>"
```

## 安全与配额

- **apiKey 共享口令**（`PARTY_KEY`）：挡掉被证书透明日志扫到域名的爬虫，不让它们白拿身份；
- **字段校验**：照 `database.rules.json` 的 `.validate` 检查类型/长度（含「建房 host 必须是自己」
  「成员节点必须有 lastSeen」「`req.by` 必须是自己」「`clock` 必须是数字」），单次写入 ≤ 32 KB；
  逐条对照见 **[docs/RULES.md](docs/RULES.md)**；
- **登录限速**：默认 60 次/分钟（`RATE_SIGNUP` 调整，`0` 关闭）；
- **房间上限**：默认 500（`MAX_ROOMS` 调整）；
- **房主接管窗口**：默认 10 分钟没心跳算废弃、可被接管（`TAKEOVER_MIN` 可调；和作者 Firebase 规则一致，
  客户端自己写死 11 分钟、比服务端多留 1 分钟余量，避免时钟差卡在边界上）；
- **单调时钟**：服务器时间基于 `performance.now()`，系统时间被 NTP/手动调整时不会回跳
  （回跳会让 `lastSeen`、`at` 的推算错乱）。

## 与 MusicParty / mpsync 的关系

一句话：它们做的是「房间里的歌单与娱乐玩法」，本项目只做「把同一个播放状态同步给所有人」。
不是竞品，也不冲突。详细对比见 **[docs/COMPARISON.md](docs/COMPARISON.md)**。

## 排错

| 现象 | 处理 |
| --- | --- |
| 页面红字 `Listen Together is not set up (missing firebase.properties)` | 配置文件位置不对，或 `databaseUrl` 不是 `https://` 开头 |
| 一直转圈 / 提示连不上 | 先 `curl https://域名/healthz`；再看游戏里「连接方式」是不是该选 `Direct` |
| 双击 bat 报 `'xxx' 不是内部或外部命令` | bat 被存成了 UTF-8，用 GBK 重新保存（或直接用仓库里的原文件） |
| `EADDRINUSE 127.0.0.1:8787` | 已经有一台在跑：先关掉那个窗口 / 结束 `node.exe`，或 `PORT=9000 node server.mjs` |
| 成员列表不刷新、歌不同步 | 反代没关缓冲（`proxy_buffering off`），或防火墙掐了长连接 |
| `401` | 令牌过期且刷新失败，重启客户端；服务器 `data/secret` 变过也会这样 |
| `412` | 房间码被别人抢了，客户端会自动换码重试（正常） |

服务器日志会打印每次读写（`put /rooms/D-XXXXX/state by 1a2b3c4d`）和在线监听数；`QUIET=1` 只保留启动信息。

## 项目结构

```
server.mjs                单文件服务器（HTTP + ETag + SSE + 权限 + 落盘 + 可选 TLS）
test/protocol.mjs         协议一致性测试（npm test，自动拉起服务器）
docs/DEPLOY.md            部署方案手册：每种方案的服务器命令 + 客户端配置原文
docs/PROTOCOL.md          协议说明：客户端到底发了什么、服务器该回什么
examples/                 Nginx / Caddy / systemd 配置
player/                   给玩家的配置包（改成你的域名后发出去）
启动服务器.bat            Windows 双击起服务（GBK + CRLF）
```

## 开发

```bash
npm test        # 37 项协议断言，随机端口 + 临时数据目录，跑完自动清理
node server.mjs --help
```

改协议相关代码前先看 `docs/PROTOCOL.md`；改完 `npm test` 必须全绿。
仓库没有运行时依赖，所以不需要 `npm install`。

## 许可证与声明

MIT（见 [LICENSE](LICENSE)）。

- 本项目是独立的服务端实现，**未使用** DangoMusic 的源码；接口行为按其客户端（GPL-3.0）的公开行为对齐，
  仅用于互操作。
- DangoMusic、相关名称与素材的版权归其作者 [Sorihiko](https://github.com/Sorihiko) 所有。
- 自建服务器没有账号体系，**请只在自己的小圈子里用**；不要公开分发服务器地址，也不要把
  `data/secret` 提交到仓库。

---

## 附：一个可以直接用的公共实例

感谢你看到这里。如果你财力或技术不足、暂时不想自己搭，可以直接用我维护的这一台：

```properties
apiKey=dango-DR58anJowkCP
databaseUrl=https://music.nyaneko.org
relayUrl=https://music.nyaneko.org
```

- 放进 `<游戏目录>/config/dangomusic/firebase.properties`，重启游戏即可；
- 走 Cloudflare Tunnel，**没有开放任何入站端口**，你连 `443` 都不需要能通；
- 这台机器我自己也在用，**随时可能维护或下线**，别当生产环境；
- 它就是一个普通的本项目实例，没有账号体系（匿名 uid + 共享口令），请不要在上面做坏事。
