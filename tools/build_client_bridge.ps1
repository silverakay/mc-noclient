param(
  [Parameter(Mandatory = $true)][string]$InstancePath,
  [Parameter(Mandatory = $true)][string]$JavaHome,
  [string]$OutputDirectory = 'dist-3.0.0'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'mods\client-bridge'
$modVersion = (Get-Content -Raw -LiteralPath (Join-Path $source 'src\main\resources\fabric.mod.json') | ConvertFrom-Json).version
if ($modVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid bridge version' }
$build = Join-Path $source ('build\' + $modVersion)
$classes = Join-Path $build 'classes'
$deps = Join-Path $build 'deps'
$metaFile = Join-Path $InstancePath ((Split-Path -Leaf $InstancePath) + '.json')
$meta = Get-Content -Raw -LiteralPath $metaFile | ConvertFrom-Json
if ($meta.clientVersion -ne '26.2') { throw 'This bridge targets Minecraft 26.2 only' }
$minecraft = Split-Path -Parent (Split-Path -Parent $InstancePath)
$libraries = Join-Path $minecraft 'libraries'
$classpath = [System.Collections.Generic.List[string]]::new()
$classpath.Add((Join-Path $InstancePath ((Split-Path -Leaf $InstancePath) + '.jar')))
foreach ($lib in $meta.libraries) {
  $artifactPath = $lib.downloads.artifact.path
  if (!$artifactPath -and $lib.name) {
    $parts = $lib.name.Split(':')
    if ($parts.Count -ge 3) {
      $suffix = if ($parts.Count -ge 4) { '-' + $parts[3] } else { '' }
      $artifactPath = ($parts[0].Replace('.', '/') + '/' + $parts[1] + '/' + $parts[2] + '/' + $parts[1] + '-' + $parts[2] + $suffix + '.jar')
    }
  }
  if ($artifactPath) {
    $file = Join-Path $libraries $artifactPath
    if (Test-Path -LiteralPath $file) { $classpath.Add($file) }
  }
}
New-Item -ItemType Directory -Force -Path $classes,$deps | Out-Null
$api = @(Get-ChildItem -LiteralPath (Join-Path $InstancePath 'mods') -Filter 'fabric-api-*+26.2.jar')
if ($api.Count -ne 1) { throw 'Exactly one Fabric API 26.2 jar is required for offline compilation' }
$zip = [System.IO.Compression.ZipFile]::OpenRead($api[0].FullName)
try {
  foreach ($entry in $zip.Entries) {
    if ($entry.FullName -match '^META-INF/jars/[^/]+\.jar$') {
      $target = Join-Path $deps ([System.IO.Path]::GetFileName($entry.FullName))
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
      $classpath.Add($target)
    }
  }
} finally { $zip.Dispose() }
$cp = $classpath -join ';'
$files = @(Get-ChildItem -LiteralPath (Join-Path $source 'src\main\java') -Filter '*.java' -Recurse | ForEach-Object { $_.FullName })
& (Join-Path $JavaHome 'bin\javac.exe') -encoding UTF-8 --release 25 -proc:none -classpath $cp -d $classes @files
if ($LASTEXITCODE -ne 0) { throw 'Bridge compilation failed' }
Copy-Item -LiteralPath (Join-Path $source 'src\main\resources\fabric.mod.json'),(Join-Path $source 'src\main\resources\mc-noclient-bridge.mixins.json') -Destination $classes
$tests = @(Get-ChildItem -LiteralPath (Join-Path $source 'src\test\java') -Filter '*.java' -Recurse | ForEach-Object { $_.FullName })
$testClasses = Join-Path $build 'test-classes'
New-Item -ItemType Directory -Force -Path $testClasses | Out-Null
& (Join-Path $JavaHome 'bin\javac.exe') -encoding UTF-8 --release 25 -proc:none -classpath ($classes + ';' + $cp) -d $testClasses @tests
if ($LASTEXITCODE -ne 0) { throw 'Bridge test compilation failed' }
$out = [System.IO.Path]::GetFullPath((Join-Path $root $OutputDirectory))
New-Item -ItemType Directory -Force -Path $out | Out-Null
$jar = Join-Path $out ('mc-noclient-bridge-' + $modVersion + '+26.2.jar')
& (Join-Path $JavaHome 'bin\jar.exe') --create --file $jar -C $classes .
if ($LASTEXITCODE -ne 0) { throw 'Bridge jar packaging failed' }
# Check the packaged artifact, not only the intermediate compiler output.
foreach ($test in @('ActionRegistryTest', 'MonitorSafetyTest', 'BridgeHandshakeTest', 'BridgeDiscoveryTest', 'GameOfflineStateTest', 'PurchaseMenusTest', 'PurchaseKeySequenceTest', 'DisconnectPolicyTest', 'MixinTargetTest')) {
  & (Join-Path $JavaHome 'bin\java.exe') -classpath ($testClasses + ';' + $jar + ';' + $cp) ('xyz.baixur.mcbridge.' + $test) $modVersion
  if ($LASTEXITCODE -ne 0) { throw ('Packaged bridge check failed: ' + $test) }
}
Get-FileHash -LiteralPath $jar -Algorithm SHA256
