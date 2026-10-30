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

## 公网部署

客户端只接受 https（`127.0.0.1` / `localhost` 例外），所以要把服务放在 TLS 反代后面：

```
玩家客户端 ──HTTPS──▶ Nginx / Caddy ──HTTP──▶ 127.0.0.1:8787 (server.mjs) ──▶ data/party.json
```

- `examples/nginx.conf`、`examples/Caddyfile`：现成反代配置，**关键是关掉 SSE 缓冲**
  （`proxy_buffering off` / `flush_interval -1`），否则成员列表和进度会卡住不更新。
- `examples/dango-party.service`：systemd，含基本加固（只允许写 `data/`）。
- 环境变量：`PORT` / `HOST` / `DATA_DIR` / `SECRET` / `QUIET=1`，`node server.mjs --help` 有完整说明。
- 数据：`data/party.json`（房间）+ `data/secret`（令牌签名密钥）。删掉 `party.json` 等于清空所有房间；
  删掉 `secret` 只影响每个人的登录态（会重新匿名登录一次）。

部署完自检：

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
