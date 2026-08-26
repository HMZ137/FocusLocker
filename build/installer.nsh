; FocusLocker 自定义安装脚本：开始菜单文件夹内创建三模式快捷方式，桌面仅正常模式
; 所有快捷方式均设置"以管理员身份运行"（RunAs 标志，由 set-runas.ps1 修改）

; customInit 在安装程序初始化时执行（早于 extraFiles 文件复制）
; 作用：覆盖安装时，extraFiles 会用新版 config.js 覆盖 $INSTDIR\config.js，用户若直接编辑过旧版 config.js，改动会丢失。
; 此处在覆盖前把旧 config.js 备份到 userData（$APPDATA\FocusLocker），应用启动时 migrateUserData 会合并到 config.json
!macro customInit
  IfFileExists "$INSTDIR\config.js" 0 skipLegacyCfgBackup
    CreateDirectory "$APPDATA\FocusLocker"
    CopyFiles /SILENT "$INSTDIR\config.js" "$APPDATA\FocusLocker\config.legacy.js"
  skipLegacyCfgBackup:
!macroend

!macro customInstall
  ; 开始菜单文件夹：FocusLocker
  CreateDirectory "$SMPROGRAMS\FocusLocker"
  ; 三个模式快捷方式（无参数=正常模式，--quick-start=快速模式，--test=测试模式）
  CreateShortCut "$SMPROGRAMS\FocusLocker\正常模式.lnk" "$INSTDIR\FocusLocker.exe"
  CreateShortCut "$SMPROGRAMS\FocusLocker\快速模式.lnk" "$INSTDIR\FocusLocker.exe" "--quick-start"
  CreateShortCut "$SMPROGRAMS\FocusLocker\测试模式.lnk" "$INSTDIR\FocusLocker.exe" "--test"
  ; 桌面快捷方式：仅正常模式
  CreateShortCut "$DESKTOP\FocusLocker.lnk" "$INSTDIR\FocusLocker.exe"
  ; 为以上全部快捷方式启用"以管理员身份运行"
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\set-runas.ps1" -StartMenuDir "$SMPROGRAMS\FocusLocker" -DesktopLnk "$DESKTOP\FocusLocker.lnk"'
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\FocusLocker\正常模式.lnk"
  Delete "$SMPROGRAMS\FocusLocker\快速模式.lnk"
  Delete "$SMPROGRAMS\FocusLocker\测试模式.lnk"
  RMDir "$SMPROGRAMS\FocusLocker"
  Delete "$DESKTOP\FocusLocker.lnk"
  ; 清理计划任务：卸载后若残留，任务计划程序会每分钟 / 每次登录去跑已删除的 exe/vbs 而不断报错
  ; 三个任务名与 main.js 中保持一致：自启动 FocusLocker、看门狗 FocusLockerGuard / FocusLockerGuardProc
  ; 任务不存在时 /F 仍返回非零，这里忽略退出码（nsExec 不因此中断卸载）
  nsExec::ExecToLog 'schtasks /Delete /TN FocusLocker /F'
  nsExec::ExecToLog 'schtasks /Delete /TN FocusLockerGuard /F'
  nsExec::ExecToLog 'schtasks /Delete /TN FocusLockerGuardProc /F'
  ; 清理注册表自启动项（HKCU Run + StartupApproved），避免登录时找不到 exe 仍尝试启动
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FocusLocker"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "FocusLocker"
!macroend
