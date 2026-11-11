# 运维：定期重启与日志清理

适用于 Debian 12 部署（`/opt/dango-party` + systemd）。Windows 部署另外有 `service-run.bat` + 计划任务。

---

## 1. 每月自动重启

**每月 1 号 04:00（本机时区，已设为 Asia/Shanghai）** 重启一次 `dango-party`。

文件：

| 文件 | 作用 |
|---|---|
| `/etc/systemd/system/dango-party-restart.service` | 先 `dango-logs clean --yes` 清日志，再 `systemctl restart dango-party.service` |
| `/etc/systemd/system/dango-party-restart.timer` | `OnCalendar=*-*-01 04:00:00`，`Persistent=true`（错过会在开机后补一次） |

常用命令：

```bash
systemctl list-timers dango-party-restart.timer      # 看下次触发时间
sudo systemctl status dango-party-restart.timer      # 看状态
sudo systemctl start dango-party-restart.service     # 立刻测试执行一次（会重启服务）
sudo systemctl disable --now dango-party-restart.timer   # 不想要了
```

确认真的重启过：

```bash
systemctl show dango-party -p NRestarts -p ActiveEnterTimestamp
curl -s http://127.0.0.1:8789/healthz       # uptimeSec 会归零
journalctl -u dango-party-restart.service -n 5 --no-pager
```

> 重启会断开当前所有房间的同步连接；`data/party.json` 每 5 分钟落盘一次，房间会在重启后恢复。

---

## 2. 日志：手动清理

日志有两份，**都不会自动轮转**：

| 日志 | 内容 |
|---|---|
| `/var/log/dango-party.log` | 应用日志（登录、建房、切歌、关房、错误） |
| `/opt/dango-party/data/heartbeat.log` | 成员心跳（5 MB 代码内滚动一份 `.1`） |

用 `dango-logs` 手动处理：

```bash
dango-logs              # 只看大小 + 已有备份
dango-logs clean        # 备份并清空（会问一次 y/N）
dango-logs clean --yes  # 不询问
dango-logs purge        # 删除所有备份（不影响当前日志）
```

行为说明：

- 清空前把文件复制到 `/var/log/dango-party-backup/`，文件名带时间戳（如 `dango-party.log.20261111-145832`）；
- 用 `truncate -s 0` **原地清空**，systemd 的追加句柄和 Node 的写入不会失效（不需要重启服务）；
- 备份只保留最近 **5 份**，更旧的自动删除。

建议节奏：看着 `dango-logs` 输出，超过 5 MB 就 `clean` 一次。

**每月 1 号的重启会自动先执行一次 `dango-logs clean --yes`**（备份 + 清空），所以正常情况下不用手动清理；手动命令用于「月中日志异常变大」时的临时处理。

---

## 3. 时区

机器已设为 `Asia/Shanghai`（原来是 `US/Eastern`，会让「凌晨 4 点」变成北京时间下午 5 点）：

```bash
timedatectl                                  # 确认 Time zone: Asia/Shanghai
sudo timedatectl set-timezone Asia/Shanghai  # 重新设置
```

`journalctl`、日志时间戳、重启计划都以这个时区为准。
