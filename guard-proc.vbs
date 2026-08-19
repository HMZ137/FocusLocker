' FocusLocker proc-mode watchdog launcher.
' Runs from Task Scheduler, hosted by wscript.exe (GUI subsystem, no console window).
' Ensures guard.ps1 (long-running, 2s polling) stays alive. guard.ps1's process
' tree originates from the Task Scheduler service, NOT the Electron Job Object,
' so taskkill /f on FocusLocker.exe cannot take the guard down with it -> "second-level" restart.
Option Explicit
Dim fso, sh, exe, flag, mainPid, arguments, wmi, ps, psCmd, scriptDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = scriptDir & "\FocusLocker.exe"
flag = sh.ExpandEnvironmentStrings("%APPDATA%") & "\focus-locker\graceful-exit.flag"

' sanity: app must exist
If Not fso.FileExists(exe) Then
    WScript.Quit 0
End If
' graceful-exit marker written by main.js before-quit -> app exited on purpose, do not guard
If fso.FileExists(flag) Then
    WScript.Quit 0
End If

If WScript.Arguments.Count > 0 Then mainPid = WScript.Arguments(0)
If WScript.Arguments.Count > 1 Then arguments = WScript.Arguments(1)

' idempotent: a guard.ps1 is already running -> nothing to do.
' Match the real guard command line: ...-File "path\guard.ps1" -MainPid <pid>...
' The adjacent 'guard.ps1" -MainPid' token is unique to the watchdog, so debug /
' other powershell processes that merely mention "guard.ps1" or "-MainPid" don't
' suppress relaunch.
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set ps = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='powershell.exe' AND CommandLine LIKE '%guard.ps1"" -MainPid%'")
If ps.Count > 0 Then
    WScript.Quit 0
End If

' NOTE: PowerShell command-line parsing rejects an empty-string argument
' (e.g. -Arguments "" -> "Missing an argument"), so omit the switch when empty.
If arguments <> "" Then
    psCmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\guard.ps1"" -MainPid " & mainPid & " -ExePath """ & exe & """ -Arguments """ & arguments & """ -FlagFile """ & flag & """"
Else
    psCmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\guard.ps1"" -MainPid " & mainPid & " -ExePath """ & exe & """ -FlagFile """ & flag & """"
End If
' 0 = hidden window, False = do not wait (wscript exits, guard keeps running as orphan)
sh.Run psCmd, 0, False
WScript.Quit 0
