'use strict';

// Applied in memory to the pinned electron-builder 26.15 template. Never edits
// node_modules. The stock template recursively removes the shared extraction
// directory before Electron can enforce its per-profile single-instance lock.
// Kernel handles coordinate extraction and are released automatically on crash.
function patchPortableTemplate(source) {
  const before = '  RMDir /r $INSTDIR\n  SetOutPath $INSTDIR';
  const after = '\tRMDir /r $INSTDIR';
  source = source.replaceAll('\r\n', '\n');
  if (!source.includes(before) || !source.includes(after) || !source.includes('\tExecWait ')) {
    throw new Error('Portable template changed. Review launcher safety before building.');
  }
  const guard = `  ; Separate per-session/per-user readiness from the persistent cache marker.
  ; A second launcher never removes files belonging to a running first instance.
  ReadEnvStr $R6 USERNAME
  System::Call 'kernel32::CreateEventW(p 0, i 1, i 0, w "Local\\FixedSitesPortableReady-1.0.1-$R6") p.r4'
  StrCpy $FixedSitesReadyHandle $4
  IntCmp $FixedSitesReadyHandle 0 fixedsites_failed 0 0
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\\FixedSitesPortable-1.0.1-$R6") p.r5 ?e'
  Pop $R7
  StrCpy $FixedSitesMutexHandle $5
  IntCmp $FixedSitesMutexHandle 0 fixedsites_failed 0 0
  IntCmp $R7 183 fixedsites_reuse fixedsites_primary fixedsites_primary

fixedsites_reuse:
  System::Call 'kernel32::WaitForSingleObject(p $FixedSitesReadyHandle, i 30000) i.r7'
  IntCmp $7 0 0 fixedsites_failed fixedsites_failed
  IfFileExists "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" fixedsites_run 0
  ; An explicitly isolated TEMP/profile may coexist with another test profile.
  StrCpy $INSTDIR "$PLUGINSDIR\\app"
  Goto fixedsites_extract

fixedsites_primary:
  System::Call 'kernel32::ResetEvent(p $FixedSitesReadyHandle)'
  ; A prior launcher may have exited unexpectedly while its Electron process
  ; survived. A running Windows executable cannot be opened for writing.
  IfFileExists "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" 0 fixedsites_extract
  ClearErrors
  FileOpen $R8 "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" a
  IfErrors fixedsites_ready 0
  FileClose $R8

fixedsites_extract:
  RMDir /r $INSTDIR
  SetOutPath $INSTDIR`;
  source = 'Var FixedSitesReadyHandle\nVar FixedSitesMutexHandle\n' + source.replace(before, guard);
  const envMarker = "  System::Call 'Kernel32::SetEnvironmentVariable";
  const at = source.indexOf(envMarker);
  if (at < 0) throw new Error('Portable environment marker missing');
  source = source.slice(0, at) + `fixedsites_ready:
  System::Call 'kernel32::SetEvent(p $FixedSitesReadyHandle)'
fixedsites_run:
` + source.slice(at);
  source = source.replace(after, `  ; Keep the versioned runtime cache for stable firewall identity. It is
  ; rebuilt at the next cold launch only when its executable is not in use.
  System::Call 'kernel32::CloseHandle(p $FixedSitesReadyHandle)'
  System::Call 'kernel32::CloseHandle(p $FixedSitesMutexHandle)'
  Goto fixedsites_done
fixedsites_failed:
  System::Call 'kernel32::CloseHandle(p $FixedSitesReadyHandle)'
  System::Call 'kernel32::CloseHandle(p $FixedSitesMutexHandle)'
  SetErrorLevel 1
  MessageBox MB_OK|MB_ICONEXCLAMATION "Fixed Sites is still preparing its runtime. Please try again."
fixedsites_done:`);
  return source;
}

module.exports = { patchPortableTemplate };
