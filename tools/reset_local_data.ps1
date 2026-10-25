[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$appName = -join ([char[]]@(0x8292, 0x679c, 0x7aef, 0x8f85, 0x52a9))
$legacyName = 'MC' + (-join ([char[]]@(0x514d, 0x5ba2, 0x6237, 0x7aef, 0x767b, 0x5f55, 0x5668)))
$running = @(Get-Process | Where-Object { $_.ProcessName -like ($appName + '*') -or $_.ProcessName -like 'mc-noclient*' })
if ($running.Count -gt 0) {
  throw 'The application is still running. Select Exit from its tray menu, then run this script again. No data was changed.'
}
$privateExe = Join-Path $root ('dist-5.0.0-with-data-final\' + $appName + '-便携版-5.0.0.exe')
if (-not (Test-Path -LiteralPath $privateExe -PathType Leaf)) {
  throw 'The private V5.0 release must exist before resetting local data.'
}
$appData = [IO.Path]::GetFullPath([Environment]::GetFolderPath('ApplicationData'))
$targets = @((Join-Path $appData $legacyName), (Join-Path $appData '.mc-noclient'))
foreach ($target in $targets) {
  $resolved = [IO.Path]::GetFullPath($target)
  if ([IO.Path]::GetDirectoryName($resolved) -ne $appData -or $resolved -notin $targets) {
    throw 'Refusing to reset a path outside the two application directories.'
  }
  if (Test-Path -LiteralPath $resolved) {
    $items = @((Get-Item -LiteralPath $resolved -Force)) + @(Get-ChildItem -LiteralPath $resolved -Recurse -Force)
    if ($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
      throw 'Refusing to reset a directory containing a reparse point.'
    }
  }
}
if (-not $PSCmdlet.ShouldProcess(($targets -join ', '), 'Back up, verify, and remove app data; the next launch creates defaults')) { return }
$backup = Join-Path $root ('backups\v5-local-data-before-reset-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target)) { continue }
  $destination = Join-Path $backup ([IO.Path]::GetFileName($target))
  Copy-Item -LiteralPath $target -Destination $destination -Recurse -Force
  foreach ($file in Get-ChildItem -LiteralPath $target -File -Recurse -Force) {
    $relative = [IO.Path]::GetRelativePath($target, $file.FullName)
    $copy = Join-Path $destination $relative
    if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash) {
      throw 'Backup verification failed. Original data was not removed.'
    }
  }
}
$running = @(Get-Process | Where-Object { $_.ProcessName -like ($appName + '*') -or $_.ProcessName -like 'mc-noclient*' })
if ($running.Count -gt 0) { throw 'The application restarted during backup. Original data was not removed.' }
foreach ($target in $targets) {
  if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($target)) -ne $appData) { throw 'Invalid reset target.' }
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  if (Test-Path -LiteralPath $target) { throw 'The data directory could not be fully removed.' }
}
Write-Output ('RESET_COMPLETE; private backup: ' + $backup)
Write-Output 'Open the clean V5.0 executable next to create default settings without accounts or records.'
