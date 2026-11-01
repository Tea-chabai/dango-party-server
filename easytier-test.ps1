#Requires -Version 5.1
<#
  验证「EasyTier 虚拟网段 + 任意 TCP 端口」是否能用（不需要 Minecraft）
  用法（两台 Windows 机器，都以管理员身份运行）：
    Host 端： powershell -ExecutionPolicy Bypass -File .\easytier-test.ps1 -Role host
    Guest 端：powershell -ExecutionPolicy Bypass -File .\easytier-test.ps1 -Role guest -Peer 10.126.126.1

  说明：只做三件事 —— 装/起 EasyTier、在 Host 上开 8787 + 放行防火墙、互相 curl 一下。
        不会改动任何系统服务，退出时 EasyTier 仍在后台运行（可用 Stop-Process -Name easytier-core 停掉）。
#>
param(
  [ValidateSet('host', 'guest')] [string]$Role = 'host',
  [string]$NetworkName = 'dango-test',
  [string]$NetworkSecret = 'CHANGE-ME-9f3a',
  [string]$Peer = '',
  [string]$Connect = '',      # 对端要连的入口：直连用 udp://<对端公网IP>:11010；没有公网就用共享节点
  [string]$Ip = '',           # 本机虚拟 IP（可选，填写后固定，例如 10.144.144.1）
  [int]$Port = 8787
)

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Say '[!] 需要管理员权限（TUN 驱动和防火墙都要管理员）' 'Red'; exit 1 }

$core = Get-Command easytier-core -ErrorAction SilentlyContinue
if (-not $core) {
  Say '[!] 没找到 easytier-core，请先安装：' 'Yellow'
  Say '    irm "https://github.com/EasyTier/EasyTier/blob/main/script/install.ps1?raw=true" | iex'
  Say '    装完重新打开一个管理员 PowerShell 再跑本脚本（新装的命令要刷新 PATH）'
  exit 1
}

# ---- 1) 起网络
$running = Get-Process easytier-core -ErrorAction SilentlyContinue
if (-not $running) {
  Say "[*] 启动 EasyTier：network=$NetworkName" 'Cyan'
  $argv = @('-d', '--network-name', $NetworkName, '--network-secret', $NetworkSecret)
  if ($Ip) { $argv += @('-i', $Ip) }
  if ($Connect) { $argv += @('-p', $Connect) } else {
    Say '    （没给 -Connect：只能靠共享节点发现，两个节点都要加同一个 -Connect）' 'Yellow'
  }
  & easytier-core @argv | Out-Null
  Start-Sleep -Seconds 4
}

# ---- 2) 打印虚拟 IP
Say '[*] 本机虚拟网络状态：' 'Cyan'
& easytier-cli node
$myIp = (& easytier-cli node | Select-String -Pattern '10\.\d+\.\d+\.\d+' | ForEach-Object { $_.Matches[0].Value } | Select-Object -First 1)
Say "    本机虚拟 IP: $myIp" 'Green'

if ($Role -eq 'host') {
  # ---- 3) Host：放行端口 + 起服务
  $rule = Get-NetFirewallRule -DisplayName "dango-party $Port" -ErrorAction SilentlyContinue
  if (-not $rule) {
    New-NetFirewallRule -DisplayName "dango-party $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
    Say "[*] 已添加防火墙放行规则 TCP $Port" 'Cyan'
  }

  $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $listening) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
      Say "[*] 启动同步服务（HOST=0.0.0.0 PORT=$Port）…" 'Cyan'
      $env:HOST = '0.0.0.0'; $env:PORT = "$Port"
      Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory (Split-Path -Parent $PSScriptRoot) -WindowStyle Minimized | Out-Null
      Start-Sleep -Seconds 3
    } else {
      Say '[!] 没装 Node，先用裸端口测试：' 'Yellow'
      Start-Process -FilePath 'python' -ArgumentList '-m', 'http.server', "$Port", '--bind', '0.0.0.0' -WindowStyle Minimized | Out-Null
      Start-Sleep -Seconds 2
    }
  }

  Say ''
  Say '=== 在另一台机器（Guest）上执行：' 'Green'
  Say "    powershell -ExecutionPolicy Bypass -File .\easytier-test.ps1 -Role guest -Peer $myIp -NetworkName $NetworkName -NetworkSecret $NetworkSecret"
  Say ''
  Say '=== 期望结果：' 'Green'
  Say "    Test-NetConnection $myIp -Port $Port   → TcpTestSucceeded : True"
  Say "    curl.exe http://$myIp`:$Port/healthz   → 返回 JSON"
  exit 0
}

# ---- Guest：验证连通性
if (-not $Peer) { Say '[!] Guest 需要 -Peer <Host虚拟IP>' 'Red'; exit 1 }
Say ''
Say "[*] ping $Peer …" 'Cyan'
ping -n 3 $Peer
Say ''
Say "[*] TCP $Peer`:$Port …" 'Cyan'
$t = Test-NetConnection -ComputerName $Peer -Port $Port -WarningAction SilentlyContinue
Say "    TcpTestSucceeded = $($t.TcpTestSucceeded)" ($(if ($t.TcpTestSucceeded) { 'Green' } else { 'Red' }))
if ($t.TcpTestSucceeded) {
  Say ''
  Say "[*] HTTP 探测（注意用 curl.exe，PowerShell 的 curl 是别名）…" 'Cyan'
  curl.exe -s -m 5 "http://$Peer`:$Port/healthz"
  Say ''
  Say '[✓] 结论：虚拟网段上任意 TCP 端口可达 —— 内嵌服务端 + 私有网段方案成立' 'Green'
} else {
  Say ''
  Say '[x] 端口不通，按顺序排查：' 'Yellow'
  Say '    1) Host 上 Get-NetTCPConnection -LocalPort 8787 -State Listen 有没有结果（没有=服务没起）'
  Say '    2) Host 防火墙有没有放行（本脚本已自动加，重跑一次即可）'
  Say '    3) Host 上服务是否绑了 0.0.0.0（绑 127.0.0.1 只有本机能连）'
}
