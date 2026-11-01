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
- 自带协议一致性测试（37 项，模拟房主 + 成员跑完整流程）

> 不是 DangoMusic 官方项目，也不是 Firebase 的替代品实现；只是「让客户端连到自己机器」的这一小块。
>
> 📦 **要打包整合包发出去？先看下面「打包整合包时：不要带上 uid 文件」**——
> `config/dangomusic/firebase_auth.json` 是个人凭据，带上它会让所有玩家共用同一个身份。

## 快速开始

```bash
# 需要 Node 18+
git clone https://github.com/<you>/dango-party-server.git
cd dango-party-server

node server.mjs          # 默认 http://127.0.0.1:8787
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
| **Tailscale Funnel** | 不要 | 自动 | 不要 | `https://<机器>.<tailnet>.ts.net` |
| **Cloudflare Tunnel** | 要 | 自动 | 不要 | `https://party.example.com` |
| **Cloudflare 橙云** | 要 | 自动 | 80/443（或 8443） | `https://party.example.com` |

**完整的服务器命令、每种方案对应的客户端 `firebase.properties` 原文、注意事项**
都在 **[docs/DEPLOY.md](docs/DEPLOY.md)**（2.1 ~ 2.10 节，可整段复制）。
最省事的 **Tailscale Funnel** 因为最常用，完整走法在下面单独写了一节。

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

推荐给「私人服 + 几个朋友」：不用域名、不用证书、不用开端口，一条命令拿到
`https://<机器>.<tailnet>.ts.net`。其它方案见 [docs/DEPLOY.md](docs/DEPLOY.md)。

**原理**：你的机器出站连到 Tailscale 边缘，公网访问时由 Tailscale 终止 TLS 再转发给本机 8787，
所以不占本机 80/443，和 MC 服务器、网站都不冲突，也不用改防火墙。

### 1. 一次性准备（约 5 分钟）

1. 注册 Tailscale（免费档够用），在**跑 server.mjs 的那台机器**上安装并登录：
   - **Windows**：装 [Tailscale for Windows](https://tailscale.com/download/windows)，托盘图标登录；
     CLI 在 `C:\Program Files\Tailscale\tailscale.exe`
   - **Linux**：`curl -fsSL https://tailscale.com/install.sh | sh`，然后 `sudo tailscale up`
2. 管理台 → **DNS**：打开 **MagicDNS** 和 **HTTPS Certificates**（不开会报 `tailnet has no HTTPS`）
3. 管理台 → **访问控制**：给这台机器开 Funnel。注意这一步**不是**在「通用访问规则」（`src/dst/ip` 全开
   那条允许的是 tailnet 内部互访）里点，而是在策略文件的 `nodeAttrs` 里加 `funnel` 属性——
   切到 JSON / 策略文件视图，保留原有规则，加上：

   ```json
   "nodeAttrs": [
     { "target": ["*"], "attr": ["funnel"] }
   ]
   ```

   （把 `"*"` 换成具体机器名或 `"tag:xxx"` 可以只授权某一台。）
   另一种更省事的办法：直接在服务器上跑一次 `tailscale funnel 8787`，它会打印
   `https://login.tailscale.com/f/funnel?node=...` 这样的链接，点开同意即可，不用手改策略。

### 2. 暴露本机 8787

先确认服务在跑（日志里是 `listening on http://127.0.0.1:8787`），然后：

```bash
tailscale funnel --bg 8787      # 后台常驻（推荐）
tailscale funnel status         # 看地址，形如 https://myhost.tailxxxx.ts.net
```

Windows PowerShell（管理员）：

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" funnel --bg 8787
& "C:\Program Files\Tailscale\tailscale.exe" funnel status
```

### 3. 验证

```bash
curl https://myhost.tailxxxx.ts.net/healthz
# {"ok":true,"uptimeSec":3,"rooms":0,"listeners":0}
```

### 4. 客户端配置

把地址换成 `tailscale funnel status` 里显示的那个，**不带端口**。
最省事的是**让服务器把地址写进样例**：启动时加 `PUBLIC_URL`，它生成的
`data/firebase.properties.example` 里地址就已经填好，你复制成 `firebase.properties` 就能发：

```bash
PUBLIC_URL=https://myhost.tailxxxx.ts.net node server.mjs
# 日志：样例配置已生成：data/firebase.properties.example
```

样例内容（apiKey 是服务器自动生成的随机口令，重启不变，存在 `data/apikey.txt`）：

```properties
apiKey=dango-xxxxxxxxxxxx
databaseUrl=https://myhost.tailxxxx.ts.net
relayUrl=https://myhost.tailxxxx.ts.net
```

Funnel 只支持 443 / 8443 / 10000，`funnel 8787` 会自动映射到 443。
发给玩家照旧用 `player/` 里的 `安装配置.bat`（把它旁边的 `firebase.properties` 换成你改好的那份）。

### 5. 日常维护

| 想做的事 | 命令 |
| --- | --- |
| 看当前映射 / 地址 | `tailscale funnel status` |
| 关掉 | `tailscale funnel reset` |
| 换了 server.mjs 的端口 | 先 `reset`，再 `tailscale funnel --bg 新端口` |
| 重启机器 | 不用管：`--bg` 存在节点状态里，Tailscale 服务自启会恢复 |
| 改了机器名或 tailnet 名 | 域名会变，玩家配置要跟着更新 |

### 6. 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 登录被拒、日志 403 `invalid api key` | 客户端 `firebase.properties` 的 `apiKey` 和服务器 `data/apikey.txt` 里的不一致：把这个文件抄过去，或启动时 `PARTY_KEY=none` 关掉校验 |
| `Funnel is not enabled on your tailnet` | 管理台 Access Controls 没开 `funnel` 属性，按提示链接授权 |
| `tailnet has no HTTPS` / 证书报错 | 管理台 DNS 里 MagicDNS + HTTPS Certificates 没开 |
| `502` / 网页打不开 | 本机 8787 没跑或端口不对：先 `curl http://127.0.0.1:8787/healthz` |
| `curl` 一直挂着不返回（TLS 握手成功、但没有 HTTP 状态码） | 节点那边没人接：`funnel status` 里的目标端口要和 `server.mjs` 实际监听一致，且服务确实在跑 |
| 浏览器能开、游戏里连不上 | `relayUrl` 写成了带端口，或「连接方式」选了代理；改成不带端口 + `Direct` |
| 用一阵突然全断 | 机器睡眠/关机、或 Tailscale 退出；`tailscale status` 看节点是否在线 |

判断"是不是真的通了"最省事的两条命令：

```bash
curl -sv https://<机器>.<tailnet>.ts.net/healthz   # 看 appconnect 之后有没有 HTTP 状态行
tailscale funnel status                            # 看目标端口对不对
```

### 7. 注意

- 证书由 Tailscale 自动签（公共受信），**不用配 `TLS_CERT`**；
- 流量走 Tailscale 中继，多几十毫秒延迟；一起听歌靠服务端校时补偿，基本无感；
- 地址就是房间入口，别贴到公开群；官方定位是个人小流量实验，别当生产服务。

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
| 1.7.0 | 3 | 成员控制 + QQ / 酷狗音源 |
| 1.6.x | 2 | 有 `req`，但只有 QQ |
| 更早 | 1 | 只有网易云；不认 `memberControl`，只能房主控制 |

服务器不校验 `apiKey`（客户端只是把它拼进 URL），所以**服务端不需要跟着客户端升级**。

## 运维接口（服主用）

服务端自带三个运维接口，玩家客户端用不到：

| 接口 | 作用 |
| --- | --- |
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
- **单调时钟**：服务器时间基于 `performance.now()`，系统时间被 NTP/手动调整时不会回跳
  （回跳会让 `lastSeen`、`at` 的推算错乱）。

## 与 MusicParty / mpsync 的关系

[MusicParty/mpsync](https://github.com/zihe114514/mpsync) 是另一套「服务器一起听」实现（服务端 mod + 开放线协议，
配套客户端 MuoniumPlayer）。两者**协议不兼容**、面向的客户端也不同，但思路互相借鉴，本项目从它那里学了几件事：

| 借鉴点 | 本项目里的落地 |
| --- | --- |
| 运维视角（他们的 `/mp list` 给 OP 看全部房间、能踢人关房） | `GET /admin/rooms`、`DELETE /admin/rooms/<码>`、`GET /admin/stats` |
| 校验与安全默认值（他们校验直链时长、平台白名单） | 照 Firebase 规则的 `.validate` 做字段校验 + 单次写入 32 KB 上限 |
| 时钟纪律（他们文档里 soft/hard 漂移 + 冷却的三档策略） | 服务端改用单调时钟，系统时间调整不会让时间戳回跳 |
| 「core 不许碰 Minecraft」的编译期守卫 | 测试断言 `server.mjs` 只 import `node:` 内置模块、零依赖 |
| 开放协议文档（他们的 `docs/接入指南.md`） | 本项目的 [docs/PROTOCOL.md](docs/PROTOCOL.md)：客户端实际发了什么、服务器该回什么 |

差异：mpsync 的房间是**全服共享**、服务端权威调度、会员解析的直链全房共享；DangoMusic 的房间是
**按房间码的私有房**、每台客户端用自己的账号取流。后者是客户端写死的协议，服务端改不了，
所以本项目只做「把 Firebase 换掉」，不试图改播放模型。

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
