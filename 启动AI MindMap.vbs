Option Explicit
Dim fso, sh, dir, exe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  sh.Run "cmd /c npm install --no-audit --no-fund", 1, True
End If
sh.Run """" & exe & """ """ & dir & """", 0, False