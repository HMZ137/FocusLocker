# FocusLocker watchdog: restart main process when it is killed forcefully (taskkill /f)
# 与主进程互相守护：主进程被强杀时本脚本自动拉起并继续监视新进程；
# 看门狗被反杀时，主进程会定时重新拉起本脚本（见 main.js ensureWatchdog）。
param(
    [int]$MainPid,
    [string]$ExePath,
    [string]$Arguments,
    [string]$FlagFile
)

# 优雅退出标记：主进程 before-quit 时写入自身 PID；内容与本脚本监视的 PID 一致才视为"主动退出，无需重启"
$restarting = $false

while ($true) {
    Start-Sleep -Seconds 2
    $proc = Get-Process -Id $MainPid -ErrorAction SilentlyContinue
    if ($proc) {
        $restarting = $false
        continue
    }
    # 主进程已消失
    if (Test-Path -LiteralPath $FlagFile) {
        $content = ''
        try { $content = (Get-Content -LiteralPath $FlagFile -Raw -ErrorAction Stop).Trim() } catch { }
        if ($content -eq "$MainPid") {
            # 优雅退出：清理标记并结束守护
            Remove-Item -LiteralPath $FlagFile -Force -ErrorAction SilentlyContinue
            exit 0
        }
        # 标记来自其它实例/旧进程，按强杀处理
    }
    if ($restarting) { exit 0 }   # 已拉起一次：新主进程会自行派生新看门狗
    $restarting = $true
    # 等待系统释放进程句柄与单实例锁
    Start-Sleep -Seconds 3
    try {
        # 写看门狗重启标记：新实例据此进入 20 分钟紧急退出冷却，防止"杀进程重启"绕过锁屏
        try {
            $restartFlag = Join-Path $env:APPDATA 'focus-locker\watchdog-restart.flag'
            $restartFlagDir = Split-Path $restartFlag
            if (-not (Test-Path $restartFlagDir)) { New-Item -ItemType Directory -Path $restartFlagDir -Force | Out-Null }
            Set-Content -Path $restartFlag -Value '1' -Encoding ASCII
        } catch { }
        if ($Arguments) {
            Start-Process -FilePath $ExePath -ArgumentList $Arguments -WindowStyle Hidden
        } else {
            Start-Process -FilePath $ExePath -WindowStyle Hidden
        }
        exit 0
    } catch {
        $restarting = $false   # 启动失败，下轮重试
    }
}
