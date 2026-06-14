' ASCII only (Windows Script Host reads .vbs as Shift-JIS; UTF-8 breaks Japanese paths)
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
appDir = FindKitFolder(fso, base, "video_hotspot_placer_server.py")

If appDir = "" Then
    MsgBox "Kit folder not found." & vbCrLf & vbCrLf & _
        "Need a subfolder containing video_hotspot_placer_server.py" & vbCrLf & _
        "under: " & base, vbCritical, "VR placer"
    WScript.Quit 1
End If

sh.CurrentDirectory = appDir
sh.Environment("Process")("VR_PROJECT_ROOT") = base
pythonw = FindPythonw(sh, fso)
sh.Run """" & pythonw & """ video_hotspot_placer_server.py", 0, False
OpenPlacerQuiet sh

Function FindKitFolder(fso, root, markerFile)
    FindKitFolder = ""
    If fso.FileExists(root & "\" & markerFile) Then
        FindKitFolder = root
        Exit Function
    End If
    On Error Resume Next
    For Each subf In fso.GetFolder(root).SubFolders
        If fso.FileExists(subf.Path & "\" & markerFile) Then
            FindKitFolder = subf.Path
            Exit Function
        End If
    Next
End Function

Sub OpenPlacerQuiet(sh)
    Dim url, xhr, ready, i
    url = "http://127.0.0.1:8765/placer"
    ready = False
    ' PowerShell cleanup is done inside Python; wait silently for server bind
    WScript.Sleep 3200
    For i = 1 To 8
        On Error Resume Next
        Set xhr = CreateObject("MSXML2.ServerXMLHTTP.6.0")
        If Err.Number <> 0 Then
            Err.Clear
            Set xhr = CreateObject("MSXML2.ServerXMLHTTP")
        End If
        xhr.open "GET", url, False
        xhr.setRequestHeader "Cache-Control", "no-cache"
        xhr.send
        If Err.Number = 0 And xhr.Status = 200 Then
            ready = True
            Exit For
        End If
        Err.Clear
        WScript.Sleep 1000
    Next
    ' window style 0: no extra Run/shell flash (browser still opens)
    sh.Run "cmd /c start """" """ & url & """", 0, False
End Sub

Function FindPythonw(sh, fso)
    FindPythonw = sh.ExpandEnvironmentStrings("%LocalAppData%\Programs\Python\Python313\pythonw.exe")
    If fso.FileExists(FindPythonw) Then Exit Function
    FindPythonw = sh.ExpandEnvironmentStrings("%LocalAppData%\Programs\Python\Python312\pythonw.exe")
    If fso.FileExists(FindPythonw) Then Exit Function
    FindPythonw = "pythonw"
End Function
