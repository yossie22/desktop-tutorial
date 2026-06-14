' ASCII only (Windows Script Host reads .vbs as Shift-JIS; UTF-8 breaks Japanese paths)
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
appDir = FindKitFolder(fso, base, "guide_alpha_maker_ui.py")

If appDir = "" Then
    MsgBox "Kit folder not found." & vbCrLf & vbCrLf & _
        "Need a subfolder containing guide_alpha_maker_ui.py" & vbCrLf & _
        "under: " & base, vbCritical, "Alpha video tool"
    WScript.Quit 1
End If

sh.CurrentDirectory = appDir
pythonw = FindPythonw(sh, fso)
sh.Run """" & pythonw & """ guide_alpha_maker_ui.py", 0, False

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

Function FindPythonw(sh, fso)
    FindPythonw = sh.ExpandEnvironmentStrings("%LocalAppData%\Programs\Python\Python313\pythonw.exe")
    If fso.FileExists(FindPythonw) Then Exit Function
    FindPythonw = sh.ExpandEnvironmentStrings("%LocalAppData%\Programs\Python\Python312\pythonw.exe")
    If fso.FileExists(FindPythonw) Then Exit Function
    FindPythonw = "pythonw"
End Function
