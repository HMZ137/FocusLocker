# FocusLocker v1.4.0-fix

> 这是 v1.4.0 的补丁版本（fix / patch-level），**仅修复卸载残留问题**，不引入新功能、不改变任何 UI / IPC / 配置文件格式；可直接覆盖 v1.4.0 升级，无需迁移数据。
>
> Release 页面由维护者自行发布。

## 修复内容

- **卸载时彻底停用计划任务与自启动注册表项**（§1.26）

  FocusLocker 共注册了 3 条计划任务 + 2 个 HKCU 自启动键：

  | 类型 | 名称 | 触发 | 指向 |
  | --- | --- | --- | --- |
  | 计划任务 | `FocusLocker` | ONLOGON | `FocusLocker.exe` |
  | 计划任务 | `FocusLockerGuard` | 每分钟 | `guard.vbs` |
  | 计划任务 | `FocusLockerGuardProc` | 每分钟 | `guard-proc.vbs` |
  | HKCU Run | `FocusLocker` | 登录时 | `FocusLocker.exe` |

  此前 `build/installer.nsh` 的 `customUnInstall` 只删除快捷方式、`main.js` 的 `before-quit` 只删除看门狗两条任务，导致卸载后：

  1. 任务计划程序残留 3 条 FocusLocker 任务；
  2. 每分钟 / 每次登录仍触发已删除的 exe / vbs，反复报「系统找不到指定的文件」；
  3. `HKCU\…\Run\FocusLocker` 与 `StartupApproved\Run\FocusLocker` 仍被 `setLoginItemSettings` 注册，留下下次登录试启动的痕迹。

  本次修复在卸载器中：

  ```nsh
  !macro customUnInstall
    ; 1. 自启动任务：卸载这一刻才允许删，否则正常退出后自动启动也会失效
    nsExec::ExecToLog 'schtasks /Delete /TN "FocusLocker" /F'
    ; 2. 看门狗任务：before-quit 已删，这里兜底（双重保险）
    nsExec::ExecToLog 'schtasks /Delete /TN "FocusLockerGuard" /F'
    nsExec::ExecToLog 'schtasks /Delete /TN "FocusLockerGuardProc" /F'
    ; 3. 清掉 setLoginItemSettings 留下的注册表自启动项与「快速启动」批准位
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FocusLocker"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "FocusLocker"
    ; 4. 原有的快捷方式清理保持不变
    Delete "$SMPROGRAMS\FocusLocker\正常模式.lnk"
    Delete "$SMPROGRAMS\FocusLocker\快速模式.lnk"
    Delete "$SMPROGRAMS\FocusLocker\测试模式.lnk"
    RMDir "$SMPROGRAMS\FocusLocker"
    Delete "$DESKTOP\FocusLocker.lnk"
  !macroend
  ```

  自启动任务 `FocusLocker` 不在 `before-quit` 中清理——若放在那里，正常退出后用户重启 / 登录就不再自动拉起 FocusLocker，等同于把「自启动」功能拆了。卸载器是清理它的唯一正确时机。

  `schtasks /Delete /TN … /F` 即使任务不存在、即使已被人手动清过也只会返回非 0 退出码，NSIS 不会中断卸载。

## 不变项（保持 v1.4.0 已发布的内容）

为了便于你已经发行 v1.4.0 的玩家升级，本次 fix 版本**完整继承** v1.4.0 的所有新功能与修复，行为与 v1.4.0 完全一致：

- **新功能 · 数据一键导出 / 导入**：设置页「数据备份与迁移」勾选导出 / 导入数据集。
- **新功能 · 查看验证码**：一键临时关闭强制置顶 75s，每次启动 2 次。
- **新功能 · 对话输入栏命令补全**：`/` 弹出候选浮层，Tab 切下一个候选。
- **新功能 · 无 API 本地指令**：未配置 DeepSeek 时 `/add` `/list` `/timer` … `/help` 本机直接执行。
- **修复 · 卸载清理**（本次新增）。
- **修复 · 导出卡死 / 对话框遮挡 / 通知中心高度 / 会话存储库自愈 / WebRTC STUN 禁用 / 扩展加载日志点名 / 欢迎语双套 / 性能与暗色优化** 等。

v1.4.0 的详细说明请见 [v1.4.0 Release](https://github.com/HMZ137/FocusLocker/releases/tag/v1.4.0) 与 `release-v1.4.0.md`。

## 升级指引

直接覆盖 v1.4.0 安装 `FocusLocker Setup 1.4.0.exe`，无需卸载老版本；如需「干净升级」也可先卸载 1.4.0 → 安装本补丁，1.4.0 的卸载修复正好包含在本补丁中。

> 注意：如果在升级前 v1.4.0 已经残留了 3 条计划任务，重新卸载 1.4.0 **不会自动清理**——需要先安装本补丁，再走一次「卸载」才会彻底清干净。这是本补丁的唯一已知「先决步骤」。

## 安装包

`dist-build26/FocusLocker Setup 1.4.0.exe`（NSIS、约 171 MB）。

## 致谢本轮贡献者

- **CN_HiTimes01**（GitHub: [@CN_HiTimes01](https://github.com/CN_HiTimes01) · UMAsky001 · Collaborator）
  — 协助完成本轮卸载残留问题的排查与回归验证，让 uninstall 流程真正幂等、干净。

## 反馈

发现缺陷或有功能建议请提交至：[Issues](https://github.com/HMZ137/FocusLocker/issues)
