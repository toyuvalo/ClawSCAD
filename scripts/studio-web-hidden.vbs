' studio-web-hidden.vbs - launch the ClawSCAD Studio web server with no console window.
'
' Task Scheduler runs the ClawSCAD-Studio-Web task in the interactive session, so
' node.exe gets a console window that sits on the desktop for as long as the
' server runs. Node cannot hide its own console, and the task's "Hidden" setting
' only hides the task from the Task Scheduler list, not the process window.
'
' wscript.exe is a GUI-subsystem host: Run(..., 0, True) starts node with a
' hidden window and blocks until it exits, so Task Scheduler still sees the real
' exit code and its restart-on-failure policy keeps working.

Option Explicit

Dim shell, fso, here, root, nodeExe, cmd, rc

Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

' scripts\ -> repo root, so the task needs no working directory of its own.
here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)

nodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"

shell.CurrentDirectory = root

cmd = """" & nodeExe & """ web/server.js"
If WScript.Arguments.Count > 0 Then
  Dim i
  For i = 0 To WScript.Arguments.Count - 1
    cmd = cmd & " """ & WScript.Arguments(i) & """"
  Next
End If

' 0 = hidden window, True = wait, so this script's exit code is node's.
rc = shell.Run(cmd, 0, True)
WScript.Quit rc
