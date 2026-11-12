# 中国网络下的访问性能（实测结论）

> 结论先说：**成本在「Cloudflare 边缘 → 隧道连接器（洛杉矶） → 源站」这一段，客户端侧怎么调都只值 0.1 秒。**
> 想质变只有两条路：ICP 备案后直连，或把源站搬到境外。本项目当前选择：**接受现状**。

## 1. 现状拓扑

```
玩家/浏览器
   │  https://music.nyaneko.org
   ▼
Cloudflare 边缘（104.21.88.68 / 172.67.173.163，橙云）
   │  Cloudflare Tunnel（cloudflared 出站连接到 LAX01/07/08）
   ▼
Debian 12 源站 43.248.116.149
   └ 127.0.0.1:8789  node server.mjs
```

源站**不开放任何入站端口**，`nginx`（80/443）只是备用通道，因为域名的 443 直连会被运营商按 SNI 重置（见第 4 节）。

## 2. 实测数据

### 2.1 一次请求花在哪（浏览器视角，走代理）

| 阶段 | 耗时 |
|---|---|
| TCP connect 到 CF 边缘 | 0.20 ~ 0.28 s |
| TLS 握手 | 0.35 ~ 0.58 s |
| **CF 边缘 → 隧道(LAX) → 回源** | **1.0 ~ 1.1 s** |
| 合计（首字节） | 1.1 ~ 1.5 s |

从服务器自己访问公网入口（`curl https://music.nyaneko.org/healthz`）：

```
QUIC   : 1.53 / 1.62 / 1.61 / 1.64 / 2.80 s
HTTP/2 : 1.33 / 1.65 / 1.71 / 1.73 / 1.70 s   ← 采用，更稳
```

### 2.2 各边缘 IP 的回程延迟（服务器侧 TCP 握手）

| 边缘 IP | connect |
|---|---|
| 198.41.192.107（隧道用） | 192 ms |
| 198.41.200.113（隧道用） | 193 ms |
| 172.64.80.1 | 210 ms |
| 104.18.32.115 | 251 ms |
| 162.159.140.220 | 287 ms |

隧道只认 `region1/2.v2.argotunnel.com`（198.41.192/200.x），这些已经是最快的一批。

### 2.3 服务器与 Cloudflare 之间的纯带宽（对照）

| 测试 | 速度 |
|---|---|
| 服务器 → `speed.cloudflare.com` 1 MB | **624 KB/s** |
| 服务器 → `speed.cloudflare.com` 256 KB | 179 KB/s |
| 本机 → `speed.cloudflare.com` 100 KB | 91 KB/s |

带宽不是瓶颈，**延迟和跨境段**才是。

## 3. 试过但无效的方案

| 方案 | 操作 | 结果 |
|---|---|---|
| 优选 IP（隧道协议） | `cloudflared --edge <web IP>:7844`（QUIC） | ❌ `failed to dial`，非隧道端点 |
| 优选 IP（HTTP/2） | `cloudflared --edge <web IP>:443` | ❌ 证书过期 2020，cloudflared 拒绝 |
| 换 zone | 用 `linandtea.cn` 的 IP（104.21.62.47 / 172.67.220.60） | ❌ TLS 握手 2.4–4.1 s，更差 |
| 优选域名（SaaS 方案的前置验证） | 把 `time.is`、`cf.090227.xyz` 等域名解析出的 CF IP 强行指向本域名测 | ⚠️ TLS 快约 0.1 s，但首字节 1.46–1.63 s，比现状 1.1 s 更慢 |
| SaaS + 自定义主机名 + 分区域 DNS（[参考](https://jqtmviyu.github.io/post/cloudflare-cn-perf/)） | 按文章测算 | ➖ 只能优化「客户端 → 边缘」，回源那 1 s 不变，收益 < 0.2 s，且要开通 SaaS + 支付方式 + 第二域名 + 分线 DNS |

## 4. 为什么不能用直连（13 ms）

同城 RTT 实测 13 ms，但域名 443 直连会立刻被重置：

```
curl --resolve music.nyaneko.org:443:43.248.116.149 https://music.nyaneko.org/
  → Recv failure: Connection was reset          （RST）

curl --resolve example.com:443:43.248.116.149 https://example.com/
  → 302                                          （任意其他 SNI 正常）

curl  http://43.248.116.149/  -H 'Host: music.nyaneko.org'
  → 404                                          （80 端口不带 SNI，可达）
```

即 **SNI 层面的域名封锁**（未备案域名的典型表现），与服务器配置无关。

## 5. 三条可选路径

| 路径 | 预期延迟 | 代价 |
|---|---|---|
| **接受现状**（当前选择） | 走代理 0.6 s / 不开代理的国内直连会超时 | 0 |
| **ICP 备案 + 域名直连** | 13 ms | 备案流程、需要有国内主体 |
| **源站搬到境外**（香港/日本） | 200–300 ms | 一台境外机器；Tunnel 可复用，只需重装 cloudflared |

选「接受现状」时，给玩家/自己的说明：

- WebUI、后台管理走代理访问没问题（0.6 s）；
- 游戏内一起听歌的同步请求也是同一条链路，延迟 0.6–1.5 s，SSE 长连接不受首字节影响，实际体验可接受；
- 若要给不挂代理的玩家用，需先解决第 4 节的封锁（备案）。

## 6. 复现命令

```bash
# 从服务器侧测公网入口
for i in 1 2 3; do
  curl -4 -sS -m 15 -o /dev/null \
    -w "$i: %{http_code} connect=%{time_connect} tls=%{time_appconnect} first=%{time_starttransfer}\n" \
    https://music.nyaneko.org/healthz
done

# 隧道连接落在哪个机房
journalctl -u cloudflared --no-pager | grep 'Registered tunnel connection' | tail -4

# 边缘 RT
for ip in 198.41.192.107 198.41.200.113 104.18.32.115; do
  curl -4 -sS -m 6 -o /dev/null -w "$ip %{time_connect}\n" --resolve "x.example:443:$ip" https://x.example/
done

# SNI 封锁验证
curl -4 -k -sS -m 8 -o /dev/null -w '%{http_code}\n' \
  --resolve "music.nyaneko.org:443:43.248.116.149" https://music.nyaneko.org/healthz
```

> 数据采集时间：2026-11-12，源站 Debian 12 / 43.248.116.149，cloudflared 2026.10.7（http2 模式）。
