# 为 FocusLocker 快捷方式启用"以管理员身份运行"
# .lnk 文件头偏移 0x14 处的 LinkFlags 置位 SLDF_RUNAS_USER (0x20)
param(
    [string]$StartMenuDir,
    [string]$DesktopLnk
)

$links = @()
if ($StartMenuDir) {
    $links += @(
        (Join-Path $StartMenuDir '正常模式.lnk'),
        (Join-Path $StartMenuDir '快速模式.lnk'),
        (Join-Path $StartMenuDir '测试模式.lnk')
    )
}
if ($DesktopLnk) {
    $links += $DesktopLnk
}

foreach ($link in $links) {
    if (Test-Path -LiteralPath $link -PathType Leaf) {
        try {
            $bytes = [System.IO.File]::ReadAllBytes($link)
            if ($bytes.Length -gt 0x18) {
                $flags = [BitConverter]::ToUInt32($bytes, 0x14)
                $flags = $flags -bor 0x20   # SLDF_RUNAS_USER
                $bytes[0x14] = [byte]($flags -band 0xFF)
                $bytes[0x15] = [byte](($flags -shr 8) -band 0xFF)
                $bytes[0x16] = [byte](($flags -shr 16) -band 0xFF)
                $bytes[0x17] = [byte](($flags -shr 24) -band 0xFF)
                [System.IO.File]::WriteAllBytes($link, $bytes)
            }
        } catch {
            Write-Output "Failed to set runas: $link - $($_.Exception.Message)"
        }
    }
}
