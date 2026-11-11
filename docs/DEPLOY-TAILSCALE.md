# 用 Tailscale Funnel 部署（保姆级）

> 从 README 拆出来的一篇，适合「不想买域名、不想开端口、想几分钟跑起来」的场景。

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
