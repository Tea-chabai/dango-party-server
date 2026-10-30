# 部署方案手册

这份文档把「怎么把 `server.mjs` 暴露给玩家」的所有方案列全，每种都给出：

1. 前提条件
2. 服务器端命令
3. **客户端 `firebase.properties` 的完整内容**（可直接复制）
4. 注意事项

选哪种先看第 1 节的总览表，或者跳到第 6 节「按场景选」。

---

## 1. 先搞清楚客户端要什么

客户端只需要三个值，写在**游戏目录**的 `config/dangomusic/firebase.properties`：

```properties
apiKey=任意非空字符串
databaseUrl=https://...        # 必须以 https:// 开头
relayUrl=https://...           # 真正的请求地址；留空则直连 databaseUrl
```

硬性规则（写错了页面会显示 `Listen Together is not set up`）：

- `relayUrl` 只接受 `https://主机[:端口]`，或者本机的 `http://127.0.0.1[:端口]` / `http://localhost[:端口]`；
- `databaseUrl` 必须以 `https://` 开头——它只用来判断「配置齐了没」以及中转挂了之后的直连兜底；
- 配置文件放在游戏目录里，**优先于 jar 内自带的配置**，所以官方 release jar 也能接入你的服务器；
- 页面底部的「连接方式」只管一起听歌：`Direct`（直连）/ 跟随系统代理 / 手动代理。
  服务器是公网直连可达的就选 `Direct`，别让本地代理把请求吞了。

## 2. 方案总览

| # | 方案 | 要域名 | 要证书 | 要开端口 | 客户端 `relayUrl` |
| --- | --- | --- | --- | --- | --- |
| 2.1 | 本机 / 单机测试 | — | — | — | `http://127.0.0.1:8787` |
| 2.2 | Firebase（不部署本项目） | 不要 | 不要 | 不要 | 留空 |
| 2.3 | Node 自带 TLS + **IP 证书** | 不要 | LE 6 天短期 | 80 + 8443 | `https://<公网IP>:8443` |
| 2.4 | Node 自带 TLS + **域名证书** | 要 | acme / certbot | 80 或 DNS | `https://party.example.com:8443` |
| 2.5 | **Caddy** 反代 | 要 | 自动 | 80 / 443 | `https://party.example.com` |
| 2.6 | **Nginx** 反代 | 要 | 自备 | 80 / 443 | `https://party.example.com` |
| 2.7 | **Tailscale Funnel** | 不要 | 自动 | 不要 | `https://<机器>.<tailnet>.ts.net` |
| 2.8 | **Cloudflare Tunnel** | 要 | 自动 | 不要 | `https://party.example.com` |
| 2.9 | **Cloudflare 橙云** | 要 | 自动 | 80/443（或 8443） | `https://party.example.com` |
| 2.10 | 内网（不开端口） | 可选 | 见 2.7 / DNS-01 | 不要 | 隧道域名或内网域名 |

所有方案的服务端命令都一样，区别只在「有没有证书、谁终止 TLS」。启动参数见第 5 节。

---

## 2.1 本机测试（最简单）

前提：只要自己这台电脑能用。**不需要域名、证书，也不要求 https。**

```bash
node server.mjs                 # 监听 127.0.0.1:8787
```

客户端 `config/dangomusic/firebase.properties`：

```properties
apiKey=local-party
databaseUrl=https://127.0.0.1:8787
relayUrl=http://127.0.0.1:8787
```

说明：`relayUrl` 走 `http://127.0.0.1`（客户端只对 127.0.0.1 / localhost 放行 http）；
`databaseUrl` 只要以 `https://` 开头即可，实际不会用到它。

注意：别的电脑连不上 `127.0.0.1`；要给朋友用必须换下面任一方案。

---

## 2.2 Firebase（不部署本项目）

这是 mod 原本的后端，**最省事**：不用服务器、不用证书、不用开端口。

1. 建 Firebase 项目 → Authentication 开启「匿名」→ 建 Realtime Database；
2. 数据库规则粘贴 [database.rules.json](https://github.com/Sorihiko/DangoMusic/blob/main/database.rules.json)
   （1.7.0 版规则，含 `memberControl` / `req`，旧规则会导致成员控制被拒）；
3. 项目设置 → 添加 Web 应用 → 抄 `apiKey` 与 `databaseURL`。

客户端配置：

```properties
apiKey=AIzaSy...
databaseUrl=https://xxx-default-rtdb.firebaseio.com
relayUrl=
```

注意：

- 数据在 Google；免费档限额大致 100 并发连接 / 1 GB 存储 / 10 GB 月流量，房间只同步文本，够用；
- **中国大陆直连 `identitytoolkit.googleapis.com` / `*.firebaseio.com` 常不通**，表现为建房转圈；
  解决：玩家在「连接方式」里开系统代理 / 手动代理，或者用 2.2b 的中转。

### 2.2b Firebase + 自建中转（国内可用）

在一台能连 Google 的机器上（VPS / Cloudflare Worker）做反代，暴露 `/id` `/token` `/db` 三个前缀并透传，
响应加 `X-Dango-Relay` 头；然后把 `relayUrl` 指向它：

```properties
apiKey=AIzaSy...
databaseUrl=https://xxx-default-rtdb.firebaseio.com
relayUrl=https://relay.example.com
```

注意：中转挂了会退回直连（客户端有 60 秒冷却），所以国内玩家的体验取决于中转的稳定性。

---

## 2.3 Node 自带 TLS + IP 证书（有公网 IP，不想买域名）

前提：公网 IP、**80 端口可达**（Let's Encrypt 的 IP 证书只能用 HTTP-01 验证）、Certbot ≥ 5.4。

```bash
# 先用 staging 试通，再删掉 --staging 正式签
sudo certbot certonly --staging --preferred-profile shortlived --standalone --ip-address 203.0.113.10
sudo certbot certonly           --preferred-profile shortlived --standalone --ip-address 203.0.113.10

# 起服务（443 需要 root，用 8443 最省事）
HOST=0.0.0.0 PORT=8443 \
  TLS_CERT=/etc/letsencrypt/live/203.0.113.10/fullchain.pem \
  TLS_KEY=/etc/letsencrypt/live/203.0.113.10/privkey.pem \
  node server.mjs
```

客户端配置：

```properties
apiKey=local-party
databaseUrl=https://203.0.113.10:8443
relayUrl=https://203.0.113.10:8443
```

注意：

- **IP 证书只有 6 天**，必须自动续期并重启服务，否则一周后全断：
  `certbot reconfigure --preferred-profile shortlived --ip-address 203.0.113.10 --deploy-hook 'systemctl restart dango-party'`
- 80 被别的服务占着时用 `--webroot -w /var/www/html`（别用 `--standalone`）；
- `/etc/letsencrypt/live/…` 默认只有 root 能读，node 用普通用户跑的话要在 deploy hook 里复制一份并 chown。

---

## 2.4 Node 自带 TLS + 域名证书

前提：域名 A 记录指向服务器；80 可达，或者用 DNS-01。

```bash
# 80 可达
acme.sh --issue -d party.example.com --standalone

# 80 不通（不占端口）
CF_Token=xxx acme.sh --issue --dns dns_cf -d party.example.com

HOST=0.0.0.0 PORT=8443 \
  TLS_CERT=/root/.acme.sh/party.example.com/fullchain.cer \
  TLS_KEY=/root/.acme.sh/party.example.com/party.example.com.key \
  node server.mjs
```

客户端配置：

```properties
apiKey=local-party
databaseUrl=https://party.example.com:8443
relayUrl=https://party.example.com:8443
```

注意：`acme.sh` 自带 cron 续期；续期后要重启服务（`--reloadcmd 'systemctl restart dango-party'`）。

---

## 2.5 Caddy 反代（证书自动续，配置最少）

前提：域名；80 + 443 可达（Caddy 用 HTTP-01 自动签证书，也可配 DNS 插件）。

```
# /etc/caddy/Caddyfile，见 examples/Caddyfile
party.example.com {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
}
```

```bash
node server.mjs                      # 内部仍是 http 127.0.0.1:8787
caddy run --config /etc/caddy/Caddyfile
```

客户端配置：

```properties
apiKey=local-party
databaseUrl=https://party.example.com
relayUrl=https://party.example.com
```

注意：`flush_interval -1` 是 SSE 的关键，**漏了会导致成员列表不刷新、进度不动**。

---

## 2.6 Nginx 反代

前提：域名 + 证书（可以 certbot 签）。

配置见 [examples/nginx.conf](../examples/nginx.conf)，核心三行：

```nginx
proxy_http_version 1.1;
proxy_buffering off;      # SSE 必须
proxy_read_timeout 1h;
```

```bash
node server.mjs                      # 内部 http 127.0.0.1:8787
nginx -t && nginx -s reload
```

客户端配置同 2.5：

```properties
apiKey=local-party
databaseUrl=https://party.example.com
relayUrl=https://party.example.com
```

注意：Nginx 回源端口随意（本机 8787 即可）；对外是 443。

---

## 2.7 Tailscale Funnel（零证书、零端口、不用域名）

**完整步骤（准备 / Windows·Linux 命令 / 验证 / 排错）写在 README 的
「用 Tailscale Funnel 部署（保姆级）」一节**，这里只记和本项目相关、容易踩的点：

- **原理**：机器出站连到 Tailscale 边缘，公网访问 `https://<机器>.<tailnet>.ts.net` 时由 Tailscale
  终止 TLS 再转发到本机端口 —— 所以不用开入站端口、不用公网 IP、不用证书，也不占本机 80/443。
- 只能暴露 **443 / 8443 / 10000**；`tailscale funnel --bg 8787` 会自动映射到 443，客户端**不写端口**。
- 客户端配置：

  ```properties
  apiKey=local-party
  databaseUrl=https://myhost.tailxxxx.ts.net
  relayUrl=https://myhost.tailxxxx.ts.net
  ```

- `--bg` 存在节点状态里，Tailscale 服务开机自启会恢复；Tailscale 退出/机器关机则全断。
- 地址由「机器名 + tailnet 名」组成，任何一个改了域名就变，玩家配置要跟着更新。
- 流量走中继多几十毫秒延迟，本项目有 `clock` 校时，够用。

---

## 2.8 Cloudflare Tunnel（要域名，不开端口）

前提：域名托管在 Cloudflare（NS 指过去）；装 `cloudflared`。

```bash
cloudflared tunnel login
cloudflared tunnel create dango-party
cloudflared tunnel route dns dango-party party.example.com
# config.yml: ingress 指向 http://127.0.0.1:8787
cloudflared tunnel run dango-party
```

客户端配置：

```properties
apiKey=local-party
databaseUrl=https://party.example.com
relayUrl=https://party.example.com
```

注意：

- 不给 `/db/*` 加缓存规则的话一般也没问题（服务端响应带 `Cache-Control: no-store`），
  但保险起见在 Cache Rules 里对 `/db/*` 设 Bypass；
- Cloudflare 空闲连接 100 秒超时，本项目 SSE 每 25 秒心跳，不会断；
- 想临时试（没有域名）：`cloudflared tunnel --url http://127.0.0.1:8787` 会给一个
  `https://xxx.trycloudflare.com`，但每次重启都变，只适合临时测试。

---

## 2.9 Cloudflare 橙云（要域名，隐藏源站）

前提：域名托管在 Cloudflare；源站开 80/443（或 Cloudflare 支持的端口，8443 在列表内）。

DNS 里把 `party` 记录指到服务器 IP 并打开橙色云朵，源站直接跑：

```bash
HOST=0.0.0.0 PORT=8443 \
  TLS_CERT=/etc/letsencrypt/live/party.example.com/fullchain.pem \
  TLS_KEY=/etc/letsencrypt/live/party.example.com/privkey.pem \
  node server.mjs
```

（Cloudflare 支持回源 8443 的 https，也可以用 2.3 的 IP 证书，因为源站证书 Cloudflare 会校验。）

客户端配置：

```properties
apiKey=local-party
databaseUrl=https://party.example.com
relayUrl=https://party.example.com
```

注意：橙云会缓存 GET —— 我们已带 `no-store`，但仍建议对 `/db/*` 关缓存。

---

## 2.10 内网（不想开端口 / 没有公网 IP）

**一个入站端口都不许开的时候**（比如服务器只放行 MC 端口），只剩纯出站或免服务端的三条：

| 方案 | 为什么行 | 代价 |
| --- | --- | --- |
| **Tailscale Funnel**（2.7） | 你的机器出站连 Tailscale 边缘，公网 443 是 Tailscale 的，不是你的 | 依赖 Tailscale 常驻，多几十毫秒延迟 |
| **Cloudflare Tunnel**（2.8） | `cloudflared` 出站长连接 | 要一个托管在 Cloudflare 的域名 |
| **Firebase**（2.2） | 根本没有自建服务端 | 数据在 Google，国内直连常不通 |

反过来，**下面这些在「禁 80/443」的环境下用不了**：

- Nginx / Caddy 反代（要监听 443）；
- Let's Encrypt 的 **IP 证书**（HTTP-01 验证必须占用 80）；
- 用自签证书顶替（客户端是 Java，默认不信任自签 CA）。

如果只是禁 80/443、但允许 **8443** 之类的端口，还可以：域名 + DNS-01 签证书（签发不占 80）+
`TLS_CERT` 起在 8443，客户端填 `https://party.example.com:8443`；Cloudflare 橙云也能回源 8443。

内网（没有公网入口）另外两条：

- **Tailscale Funnel**：见 2.7，完全不开端口，玩家也不需要装 Tailscale；
- **内网域名 + DNS-01**：给一个解析到内网 IP 的域名用 DNS-01 签真证书（不占 80 端口），
  `TLS_CERT` 起在 8443，客户端填 `https://party.party.lan:8443`。

⚠️ **不要指望 `http://192.168.1.5:8787`**：客户端只放行 `https://…`，`http://` 只对
`127.0.0.1` / `localhost` 生效。自签证书也不行（Java 默认不信任自签 CA）。

---

## 3. 服务端启动参数（所有方案共用）

```bash
node server.mjs                                  # 默认 127.0.0.1:8787
PORT=8443 HOST=0.0.0.0 node server.mjs           # 换地址端口
TLS_CERT=... TLS_KEY=... PORT=8443 node server.mjs   # 自带 TLS
DATA_DIR=/opt/dango-party/data node server.mjs   # 数据目录
QUIET=1 node server.mjs                          # 只打启动信息
```

完整列表：`node server.mjs --help`。systemd 单元见 [examples/dango-party.service](../examples/dango-party.service)。

---

## 4. 验证清单（每种方案都一样）

1. 服务器：`curl https://<你的地址>/healthz` → `{"ok":true,...}`（本机就是 `http://127.0.0.1:8787/healthz`）；
2. 客户端：进游戏按 `M` → `♬ 一起听歌` → 连接方式选 `Direct` → `Create a room`；
3. 服务器窗口打印 `put /rooms/D-XXXXX`，页面出现房间码 → 通了；
4. 另一台机器用同一个配置 `Join` 房间码，两边同步切歌 → 完整可用。

排错见 README 的「排错」表。

---

## 5. 按场景选

| 你的情况 | 推荐 |
| --- | --- |
| 只是想先看看效果 | 2.1 本机 |
| 玩家都在墙外 / 都有代理，不想运维 | 2.2 Firebase |
| 有公网 IP，能开 80，想长期稳 | 2.3 IP 证书（记得自动续期） |
| 有公网 IP，80 不通 | 2.5 Caddy + 域名 DNS-01（或 2.7 Funnel） |
| 不想开任何端口 | 2.7 Tailscale Funnel |
| 想隐藏源站 IP / 抗打 | 2.8 或 2.9 Cloudflare |
| 纯内网 / 只有局域网 | 2.7 Funnel 最省事 |

---

## 6. 几个共同的坑

- **别把 `firebase_auth.json` 打进整合包**：那是玩家的匿名 uid + 刷新令牌，详见 README 的警告小节。
- **SSE 必须不缓冲**：Nginx `proxy_buffering off`、Caddy `flush_interval -1`；Node 直出/隧道没有这个问题。
- **6 天 IP 证书必须自动化续期**，一次失败就全断。
- **`data/secret` 不要泄露**：令牌签名密钥，删掉等于所有人重新登录。
- **别公开分发服务器地址**：没有账号体系，知道地址就能连。
