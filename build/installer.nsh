; Runs the Visual C++ redistributable during install.
;
; Every PostgreSQL binary the app ships imports VCRUNTIME140.dll, which comes
; from the Microsoft Visual C++ 2015-2022 redistributable. Most Windows
; machines already have it — almost every desktop application installs it — but
; a clean Windows install does not, and there the database simply fails to
; start with a dialog about a missing DLL that says nothing about databases.
;
; Microsoft's installer is a no-op when a newer version is already present, so
; running it every time costs a few seconds on first install and nothing after.

!macro customInstall
  DetailPrint "Checking the Microsoft Visual C++ runtime..."
  File "/oname=$PLUGINSDIR\vc_redist.x64.exe" "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
  ; /install /quiet /norestart — no UI, and never reboot the till mid-install.
  ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $0
  ; 0 = installed, 1638 = a newer version is already there, 3010 = wants a
  ; reboot but is in place. None of these is a failure worth stopping for.
  ${If} $0 != 0
  ${AndIf} $0 != 1638
  ${AndIf} $0 != 3010
    DetailPrint "Visual C++ runtime installer returned $0 — continuing."
  ${EndIf}
!macroend
