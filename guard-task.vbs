' FocusLocker watchdog task - runs every minute via Task Scheduler.
' Hosted by wscript.exe (GUI subsystem, never shows a console window).
' If the main process is missing (killed by taskkill /f) and no graceful-exit
' flag exists, relaunch FocusLocker.exe.
Option Explicit
Dim fso, sh, exe, flag, wmi, procs
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
exe = fso.GetParentFolderName(WScript.ScriptFullName) & "\FocusLocker.exe"
flag = sh.ExpandEnvironmentStrings("%APPDATA%") & "\focus-locker\graceful-exit.flag"

' sanity: exe must exist
If Not fso.FileExists(exe) Then WScript.Quit 0
' graceful exit marker written by main.js before-quit -> do not restart
If fso.FileExists(flag) Then WScript.Quit 0
' main process still running -> nothing to do
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='FocusLocker.exe'")
If procs.Count = 0 Then
    ' wait a moment for OS to release handles / single-instance lock
    WScript.Sleep 2000
    ' mark watchdog restart so the new instance enters a 20-min emergency-exit cooldown
    Dim restartFlagDir, restartFlag
    restartFlagDir = sh.ExpandEnvironmentStrings("%APPDATA%") & "\focus-locker"
    If Not fso.FolderExists(restartFlagDir) Then fso.CreateFolder(restartFlagDir)
    restartFlag = restartFlagDir & "\watchdog-restart.flag"
    fso.CreateTextFile(restartFlag, True).Close
    sh.Run """" & exe & """", 0, False
End If
WScript.Quit 0
