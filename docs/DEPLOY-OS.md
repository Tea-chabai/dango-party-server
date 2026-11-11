# 部署到 Linux / Windows（系统服务）

这篇只讲**把 `server.mjs` 装成系统服务**（开机自启、日志、定期重启）。
网络入口（Cloudflare Tunnel / Nginx / Tailscale Funnel）见 [DEPLOY.md](DEPLOY.md)，
从 Windows 迁到 Debian 的完整流程见 [MIGRATE.md](MIGRATE.md)。

需要的东西只有两样：

```
server.mjs      # 主程序（单文件，零依赖）
ui.html         # 控制台页面，和 server.mjs 放同一目录
```

数据都落在运行目录下的 `data/`（`party.json`、`apikey.txt`、`admintoken.txt`、`secret`、`heartbeat.log`），
**迁移时带上 `data/` 就不会丢房间和 apiKey。**

---

## 一、Linux（Debian 12 / Ubuntu 22.04+）

### 1. 装 Node（≥18）

Debian 12 自带的 18 够用：

```bash
apt update && apt install -y nodejs curl ca-certificates
node -v
```

想用最新 LTS（推荐，官方二进制）：

```bash
cd /tmp
curl -fLO https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.xz
apt-get install -y libatomic1          # 官方二进制依赖 libatomic.so.1，精简镜像没有
tar -xJf node-v26.13.0-linux-x64.tar.xz -C /usr/local --strip-components=1
chown -R root:root /usr/local
node -v && npm -v
```

> 版本号按 https://nodejs.org/dist/index.json 里的最新 LTS 改。

### 2. 放文件 + 建用户

```bash
useradd --system --home /opt/dango-party --shell /usr/sbin/nologin dango || true
mkdir -p /opt/dango-party/data
# 上传 server.mjs、ui.html 到 /opt/dango-party/，需要迁移就再把 data/ 拷进去
chown -R dango:dango /opt/dango-party
chmod 600 /opt/dango-party/data/* 2>/dev/null || true
```

### 3. systemd 服务

```bash
cat > /etc/systemd/system/dango-party.service <<'EOF'
[Unit]
Description=DangoMusic party server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dango
Group=dango
WorkingDirectory=/opt/dango-party
Environment=HOST=127.0.0.1
Environment=PORT=8789
Environment=DATA_DIR=/opt/dango-party/data
ExecStart=/usr/local/bin/node /opt/dango-party/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/dango-party/data /var/log/dango-party.log
StandardOutput=append:/var/log/dango-party.log
StandardError=append:/var/log/dango-party.log

[Install]
WantedBy=multi-user.target
EOF

touch /var/log/dango-party.log && chown dango:dango /var/log/dango-party.log
systemctl daemon-reload
systemctl enable --now dango-party
```

要点：

- `ExecStart` 必须写**绝对路径**（systemd 的 PATH 不含 `/usr/local/bin`）；
- `PORT=8789` 是习惯选择；和 nginx 的 8787 冲突时就换（见下）；
- `HOST=127.0.0.1` 只监听回环，外部一律由隧道/反代进来；
- `Restart=always`：崩了 3 秒自动拉起，不用人管。

### 4. 验证 + 看日志

```bash
systemctl is-active dango-party
curl -s http://127.0.0.1:8789/healthz; echo
tail -f /var/log/dango-party.log
```

### 5. 每月重启 + 日志清理（可选，推荐）

`/usr/local/sbin/dango-logs`（脚本内容见 [MAINTENANCE.md](MAINTENANCE.md)）：

```bash
dango-logs              # 看大小
dango-logs clean        # 备份并清空（保留最近 5 份）
```

定时器：

```ini
# /etc/systemd/system/dango-party-restart.service
[Service]
Type=oneshot
ExecStartPre=/usr/local/sbin/dango-logs clean --yes
ExecStart=/bin/systemctl restart dango-party.service
```

```ini
# /etc/systemd/system/dango-party-restart.timer
[Timer]
OnCalendar=*-*-01 04:00:00
Persistent=true
Unit=dango-party-restart.service

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload
systemctl enable --now dango-party-restart.timer
systemctl list-timers dango-party-restart.timer --no-pager
```

### 6. 防火墙（只留 SSH）

```bash
apt install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
# 用 Nginx 直接对外时才需要：
# ufw allow 80/tcp
# ufw allow 443/tcp
ufw enable && ufw status verbose
```

`8789` **不要**放行——它绑在 `127.0.0.1`，本来就不通。

### 7. 更新代码

```bash
# 覆盖 /opt/dango-party/server.mjs 之后
systemctl restart dango-party
curl -s http://127.0.0.1:8789/healthz
```

---

## 二、Windows（Server 2016+ / Win10+）

### 1. 装 Node

下载 LTS 的 `node-vXX-msi` 安装（勾选 Add to PATH），或用 winget：

```powershell
winget install OpenJS.NodeJS.LTS
node -v
```

### 2. 放文件

```
C:\dango-party\
├── server.mjs
├── ui.html
├── run.bat            # 双击启动（带横幅、端口自适应）
├── service-run.bat    # 计划任务用（无交互、日志写文件）
└── data\
```

`run.bat` 读取 `HOST`/`PORT` 环境变量，默认 `127.0.0.1:8787`：

```bat
set PORT=8789
run.bat
```

### 3. 计划任务（开机自启）

`service-run.bat`：

```bat
@echo off
cd /d "%~dp0"
set HOST=127.0.0.1
set PORT=8789
"C:\Program Files\nodejs\node.exe" server.mjs >> "%~dp0data\server.log" 2>&1
```

注册任务（管理员 PowerShell）：

```powershell
schtasks /create /tn "DangoParty" /tr "C:\dango-party\service-run.bat" `
         /sc onstart /ru SYSTEM /rl HIGHEST /f
schtasks /run /tn "DangoParty"
```

常用：

```powershell
schtasks /end /tn DangoParty      # 停
schtasks /run /tn DangoParty      # 起
Get-Content C:\dango-party\data\server.log -Tail 20
```

> **端口冲突的经典坑**：`run.bat` 会先检测端口占用，如果本机 8787 被 nginx 之类占了，
> 会提示「端口 8787 已经在监听」并退出。这时 `set PORT=8789` 再启动，或改 `service-run.bat`。

### 4. 每月重启 + 日志清理（可选）

`clean-and-restart.bat`：

```bat
@echo off
cd /d "%~dp0"
rem 备份并清空日志
if exist data\server.log (
  move /y data\server.log "data\server-$(date).log" >nul 2>&1
)
if exist data\heartbeat.log del /q data\heartbeat.log
rem 重启服务
schtasks /end /tn DangoParty >nul 2>&1
timeout /t 2 /nobreak >nul
schtasks /run /tn DangoParty
```

注册每月 1 号 04:00：

```powershell
schtasks /create /tn "DangoParty-Restart" /tr "C:\dango-party\clean-and-restart.bat" `
         /sc monthly /d 1 /st 04:00 /ru SYSTEM /rl HIGHEST /f
```

> 更稳妥的做法：用 PowerShell 写带时间戳的备份（`Copy-Item` + `Set-Content` 清空），
> 避免 `move`/`del` 在文件被占用时失败。Node 用追加模式打开日志，**清空要用
> `Clear-Content` 而不是删除文件**，否则句柄失效后日志会写不进去：
>
> ```powershell
> Copy-Item data\server.log "data\server-$(Get-Date -f yyyyMMdd-HHmmss).log"
> Clear-Content data\server.log
> ```

### 5. 防火墙

只需要放行 SSH/RDP（你自己的管理端口）。`8789` 不要放行：

```powershell
New-NetFirewallRule -DisplayName "DangoParty 8789 (local only)" -Direction Inbound `
  -Protocol TCP -LocalPort 8789 -RemoteAddress 127.0.0.1 -Action Allow
```

---

## 三、两种系统的共同点

| 项目 | Linux | Windows |
|---|---|---|
| 进程守护 | `systemd Restart=always` | 计划任务 + 开机启动 |
| 日志 | `/var/log/dango-party.log` | `data\server.log` |
| 心跳日志 | `data/heartbeat.log` | `data\heartbeat.log` |
| 端口 | `HOST=127.0.0.1 PORT=8789` | 同 |
| 数据目录 | `DATA_DIR=.../data` | 默认 `.\data` |
| 清日志 | `dango-logs clean` | `Clear-Content` |
| 更新代码 | 覆盖 `server.mjs` → `systemctl restart` | 覆盖 → `schtasks /end` + `/run` |

## 四、验证清单

```bash
curl -s http://127.0.0.1:8789/healthz        # 期望 {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' https://你的域名/healthz   # 期望 200
curl -s -o /dev/null -w '%{http_code}\n' https://你的域名/ui        # 期望 200
```

三条都过 = 部署完成。客户端配置：

```properties
apiKey=<data/apikey.txt 的内容>
databaseUrl=https://你的域名
relayUrl=https://你的域名
```

## 五、常见坑速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `node: error while loading shared libraries: libatomic.so.1` | 官方二进制缺依赖 | `apt install libatomic1` |
| `ExecStart` 报找不到 node | systemd PATH 不含 `/usr/local/bin` | 写绝对路径 |
| 服务起来但外网 502 | 入口指向的端口不对 | 检查隧道/反代目标端口与 `PORT` 一致 |
| `run.bat` 说端口已在监听 | 该端口被 nginx 等占用 | `set PORT=8789` |
| 日志里有 `EADDRINUSE` | 端口被占 | 同上，换端口 |
| WebUI 打开没数据 | 没填运维口令 | `/ui` 顶部填 `data/admintoken.txt` |
