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

1. 起服务。
2. 配置写到游戏目录的 `config/dangomusic/firebase.properties`：

   ```properties
   apiKey=local-party
   databaseUrl=https://127.0.0.1:8787
   relayUrl=http://127.0.0.1:8787
   ```

3. 进游戏按 `M` → 左侧 `♬ 一起听歌` → 底部**「连接方式」选 `Direct`** → `Create a room`。
   服务器窗口打印 `put /rooms/D-XXXXX`、页面出现房间码，就通了。

## 发给玩家

`player/` 目录就是给玩家的包，改一处域名后打包发出去：

| 文件 | 作用 |
| --- | --- |
| `player/firebase.properties` | 把两处 `party.example.com` 改成你的服务器域名 |
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


## 公网部署

**不一定需要 Nginx。** 客户端只要求一个**受信任证书的 https 入口**（`127.0.0.1` / `localhost` 例外），
至于这个 https 是谁提供的，它不关心。

| 方案 | 适合 | 说明 |
| --- | --- | --- |
| **Node 自带 TLS** | 机器上不想再装东西 | `TLS_CERT` / `TLS_KEY` 直接起 https，见下 |
| **Caddy** | 想要证书自动续期 | 三行 Caddyfile，见 `examples/Caddyfile` |
| **Nginx** | 已经有 Nginx 在跑 | `examples/nginx.conf`，记得关 SSE 缓冲 |
| **Cloudflare Tunnel / frp / Tailscale** | 没公网 IP、不想开端口 | 隧道给一个受信 https 域名 |

### 先解决证书：有公网 IP 但没有受信任证书

**从 2026 年起 Let's Encrypt 可以给公网 IP 签证书了**（IP 证书强制 6 天有效期），
所以有公网 IP 时不一定非要域名。

| 情况 | 做法 |
| --- | --- |
| 有公网 IP，**80 端口可达** | 直接签 IP 证书（见下），客户端填 `https://<你的IP>:8443` |
| 有公网 IP，但 **80 不通**（家用宽带常见） | 弄个域名走 DNS-01（不占端口）：`CF_Token=xxx acme.sh --issue --dns dns_cf -d party.example.com` |
| 只有内网 IP / 不想开端口 | 隧道：`tailscale funnel --bg 8787`（给一个受信的 `*.ts.net`），或 Cloudflare Tunnel |

#### IP 证书（不需要域名）

```bash
# Certbot ≥ 5.4（--ip-address 是 5.3 加的，webroot 支持 IP 要 5.4）
certbot --version

# 先用 staging 试通，再删掉 --staging 拿正式证书
sudo certbot certonly --staging \
  --preferred-profile shortlived \
  --standalone \
  --ip-address 203.0.113.10

# 正式签发
sudo certbot certonly \
  --preferred-profile shortlived \
  --standalone \
  --ip-address 203.0.113.10
```

产物在 `/etc/letsencrypt/live/<IP>/fullchain.pem` 和 `privkey.pem`。要点：

- **只有 6 天有效期**（`shortlived` 是 IP 证书的硬性要求），必须让 `certbot renew` 自动跑，
  并且配上续期后重启服务的钩子，否则一周后玩家就连不上：
  ```bash
  certbot reconfigure --preferred-profile shortlived --ip-address 203.0.113.10 \
    --deploy-hook 'systemctl restart dango-party'
  ```
- 验证走 **HTTP-01（80 端口）**，签发和每次续期都需要 80 可达；`--standalone` 会临时占用 80，
  如果 80 上有别的服务，改用 `--webroot -w /var/www/html`。
- 客户端直接填 `https://203.0.113.10:8443`（IP 形式的 https 客户端接受）。
- 嫌 6 天太紧（一次续期失败就断服），就用域名 + DNS-01，90/45 天更稳。

#### 域名证书

拿到证书后起服务：

```bash
# acme.sh 的产物在 ~/.acme.sh/<域名>/；certbot 在 /etc/letsencrypt/live/<域名>/
TLS_CERT=/root/.acme.sh/party.example.com/fullchain.cer \
TLS_KEY=/root/.acme.sh/party.example.com/party.example.com.key \
HOST=0.0.0.0 PORT=8443 node server.mjs
```

客户端 `relayUrl=https://party.example.com:8443`（走隧道的话通常是 `https://xxx.ts.net`，不用带端口）。

别用自签证书：客户端是 Java，默认不信任自签 CA，除非给每台玩家的 JVM 导入证书（`keytool -importcert`），
不值得。

### 方案 A：让 server.mjs 自己上 TLS（不用反代）

```bash
# 1. 签证书（二选一）
acme.sh --issue --standalone -d party.example.com          # 或者
certbot certonly --standalone -d party.example.com

# 2. 直接起 https（443 需要 root 或 CAP_NET_BIND_SERVICE，用 8443 最省事）
HOST=0.0.0.0 PORT=8443 \
  TLS_CERT=/etc/letsencrypt/live/party.example.com/fullchain.pem \
  TLS_KEY=/etc/letsencrypt/live/party.example.com/privkey.pem \
  node server.mjs
```

客户端配置写 `relayUrl=https://party.example.com:8443`（`relayUrl` 支持带端口）。
证书续期后重启服务即可（`systemctl restart`）。

省掉反代的好处：没有 SSE 缓冲的坑，少一层配置；坏处是证书续期要自己管。

### 方案 B / C：Caddy 或 Nginx

```
玩家客户端 ──HTTPS──▶ Nginx / Caddy ──HTTP──▶ 127.0.0.1:8787 (server.mjs) ──▶ data/party.json
```

- `examples/nginx.conf`、`examples/Caddyfile`：现成配置，**关键是关掉 SSE 缓冲**
  （`proxy_buffering off` / `flush_interval -1`），否则成员列表和进度会卡住不更新。
- `examples/dango-party.service`：systemd，含基本加固（只允许写 `data/`）。
- 环境变量：`PORT` / `HOST` / `DATA_DIR` / `SECRET` / `TLS_CERT` / `TLS_KEY` / `QUIET=1`，
  `node server.mjs --help` 有完整说明。
- 数据：`data/party.json`（房间）+ `data/secret`（令牌签名密钥）。删掉 `party.json` 等于清空所有房间；
  删掉 `secret` 只影响每个人的登录态（会重新匿名登录一次）。

### ⚠️ 内网直接 `http://192.168.x.x:8787` 不行

客户端的 `relayUrl` 只接受 `https://…`，`http://` 只放行 `127.0.0.1` / `localhost`。所以「内网 IP + http」这条路走不通。

内网也想用的话，两个办法：

- **Cloudflare Tunnel / frp**：隧道给你一个受信的 https 域名，不用公网 IP、不用开端口；
- **给一个解析到内网 IP 的域名签证书**：用 DNS-01（`acme.sh --issue --dns dns_cf -d party.party.lan`）签，
  不占 80 端口，然后 `TLS_CERT`/`TLS_KEY` 起在 8443，玩家配 `https://party.party.lan:8443`。
  自签证书不行——客户端是 Java，默认不信任自签 CA。

部署完自检（把域名换成你的）：

```bash
curl -s https://party.example.com/healthz
# {"ok":true,"uptimeSec":42,"rooms":0,"listeners":0}
```

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
server.mjs                单文件服务器（HTTP + ETag + SSE + 权限 + 落盘）
test/protocol.mjs         协议一致性测试（npm test，自动拉起服务器）
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
