Option Explicit

Dim shell, command, exitCode
Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Users\JakeNudell\Projects\ai-operating-system\08_outputs\serent-command-center\app\scripts\start-serent-tend.ps1"""
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
