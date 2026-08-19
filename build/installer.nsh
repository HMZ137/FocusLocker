; FocusLocker 自定义安装脚本：开始菜单文件夹内创建三模式快捷方式，桌面仅正常模式
; 所有快捷方式均设置"以管理员身份运行"（RunAs 标志，由 set-runas.ps1 修改）

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
!macroend
