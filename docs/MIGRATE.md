# 迁移到 Debian 12（x86_64）

从 Windows 迁到 Debian 12.0，服务端代码不变（`server.mjs` 是纯 Node，无平台依赖），
只是把「计划任务 + bat」换成 **systemd**。

> 用 Cloudflare Tunnel 的话：**不需要申请 SSL 证书、不需要开放任何入站端口**。
> TLS 由 Cloudflare 边缘负责。

---

## 1. 装 Node（≥18）

Debian 12 自带 Node 18，够用：

```bash
sudo apt update
sudo apt install -y nodejs curl ca-certificates
node -v          # 期望 v18.x 或更高
```

想用更新的 LTS（推荐 20）：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

---

## 2. 放文件

```bash
sudo useradd --system --home /opt/dango-party --shell /usr/sbin/nologin dango || true
sudo mkdir -p /opt/dango-party/data
sudo chown -R dango:dango /opt/dango-party
```

把 Windows 上的这些文件传上去（`scp` 或 SFTP）：

```
/opt/dango-party/server.mjs
/opt/dango-party/ui.html
/opt/dango-party/data/party.json      # 可选：想保留房间就带
/opt/dango-party/data/apikey.txt      # 建议带：玩家配置里的 apiKey 就不用改
/opt/dango-party/data/admintoken.txt  # /ui 口令
/opt/dango-party/data/secret          # 签发 token 的密钥
```

```bash
sudo chown -R dango:dango /opt/dango-party
sudo chmod 600 /opt/dango-party/data/* 2>/dev/null || true
```

> 什么都不带也行，服务端会自己生成 `apikey.txt` / `admintoken.txt` / `secret`，
> 但那样玩家要改 `firebase.properties` 里的 `apiKey`。

---

## 3. systemd 服务（替代计划任务）

```bash
sudo tee /etc/systemd/system/dango-party.service >/dev/null <<'EOF'
[Unit]
Description=DangoMusic party server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dango
WorkingDirectory=/opt/dango-party
Environment=HOST=127.0.0.1
Environment=PORT=8789
Environment=DATA_DIR=/opt/dango-party/data
ExecStart=/usr/bin/node /opt/dango-party/server.mjs
Restart=always
RestartSec=3
StandardOutput=append:/var/log/dango-party.log
StandardError=append:/var/log/dango-party.log

[Install]
WantedBy=multi-user.target
EOF

sudo touch /var/log/dango-party.log
sudo chown dango:dango /var/log/dango-party.log

sudo systemctl daemon-reload
sudo systemctl enable --now dango-party
systemctl status dango-party --no-pager
curl -s http://127.0.0.1:8789/healthz
```

看日志：

```bash
tail -f /var/log/dango-party.log        # 应用日志（心跳在 data/heartbeat.log）
journalctl -u dango-party -n 50 --no-pager
```

---

## 4. Cloudflare Tunnel

```bash
# 官方 apt 源
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared
```

装成服务（token 沿用现在这个隧道即可，**DNS 不用动**）：

```bash
sudo cloudflared service install <TUNNEL_TOKEN>
systemctl status cloudflared --no-pager
```

> 换新隧道才需要改 DNS：把 `music.nyaneko.org` 的 CNAME 指向
> `<新隧道ID>.cfargotunnel.com`（橙色云）。

---

## 5. 防火墙

**不需要开放任何入站端口**（8789 只监听 127.0.0.1，隧道是出站）。

如果开了 ufw，只放 SSH 和必要的 MC 端口：

```bash
sudo ufw allow 22/tcp
sudo ufw allow 54188/udp     # 如果这台机器也跑 MC
sudo ufw enable
sudo ufw status
```

---

## 6. 验收

```bash
# 本机
curl -s http://127.0.0.1:8789/healthz; echo
# 外网
curl -s https://music.nyaneko.org/healthz; echo
# 控制台
curl -s -o /dev/null -w '%{http_code}\n' https://music.nyaneko.org/ui
```

三个都正常就迁移完成了。

---

## 7. 日常维护（Debian 版速查）

| 操作 | 命令 |
|---|---|
| 看状态 | `systemctl status dango-party` |
| 重启 | `sudo systemctl restart dango-party` |
| 停 | `sudo systemctl stop dango-party` |
| 应用日志 | `tail -f /var/log/dango-party.log` |
| 心跳日志 | `tail -f /opt/dango-party/data/heartbeat.log` |
| 隧道状态 | `systemctl status cloudflared` |
| 备份房间 | `sudo tar czf /root/party-$(date +%F).tgz -C /opt/dango-party/data party.json` |

想每天自动备份（可选）：

```bash
sudo tee /etc/cron.daily/dango-backup >/dev/null <<'EOF'
#!/bin/sh
tar czf /root/party-$(date +%F).tgz -C /opt/dango-party/data party.json
find /root -name 'party-*.tgz' -mtime +14 -delete
EOF
sudo chmod +x /etc/cron.daily/dango-backup
```

---

## 8. 想用 nginx + Let's Encrypt（不走隧道时才需要）

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
# 站点配置：proxy_pass http://127.0.0.1:8789; proxy_buffering off; proxy_read_timeout 120s;
sudo certbot --nginx -d music.nyaneko.org
```

关键仍然是 `proxy_buffering off;`（不回源 SSE 会卡住）。

> 但走隧道就不需要这一步：**证书和端口都交给 Cloudflare**。
