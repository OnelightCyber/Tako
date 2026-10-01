!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$LOCALAPPDATA\Tako\bin"
  RMDir /r "$LOCALAPPDATA\Tako\inbox"
  Delete "$LOCALAPPDATA\Tako\tako.log"
!macroend
