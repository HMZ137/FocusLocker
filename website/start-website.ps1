# FocusLocker 官网本地服务 · 计划任务启动脚本
# 由计划任务在用户登录时调用；端口已在监听时直接退出（幂等）
$ErrorActionPreference = 'Stop'
$Port = 8808

if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  exit 0
}

$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 定位 node.exe：优先 PATH，兜底常见安装路径
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) {
  $candidates = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "$env:APPDATA\nvm\node.exe"
  )
  $Node = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Node) {
  Write-Output "[$(Get-Date -Format 'HH:mm:ss')] node.exe 未找到，跳过启动" | Out-File -FilePath (Join-Path $Dir 'server-err.log') -Append -Encoding utf8
  exit 1
}

$out = Join-Path $Dir 'server.log'
$err = Join-Path $Dir 'server-err.log'
Start-Process -FilePath $Node -ArgumentList 'server.mjs', $Port -WorkingDirectory $Dir -WindowStyle Hidden `
  -RedirectStandardOutput $out -RedirectStandardError $err
