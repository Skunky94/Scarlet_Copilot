# deploy-extension.ps1 — Deploy Loop Guardian dal workspace alla directory estensioni VS Code
# Uso: .\deploy-extension.ps1
# Dopo il deploy, ricaricare VS Code per attivare le modifiche.

$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
$extDir = "$env:USERPROFILE\.vscode\extensions"

# surv_008: Dynamic directory discovery — find any scarlet.copilot-loop-guardian-* directory
$candidates = Get-ChildItem $extDir -Directory -Filter "scarlet.copilot-loop-guardian-*" | Select-Object -First 1
if (-not $candidates) {
    Write-Error "Nessuna estensione scarlet.copilot-loop-guardian-* trovata in $extDir"
    exit 1
}
$dst = $candidates.FullName

# Read version from package.json for renaming
$pkg = Get-Content "$src\package.json" -Raw | ConvertFrom-Json
$targetName = "scarlet.copilot-loop-guardian-$($pkg.version)"
$targetPath = Join-Path $extDir $targetName

# Files to deploy
$files = @("extension.js", "package.json")

foreach ($f in $files) {
    $srcFile = Join-Path $src $f
    $dstFile = Join-Path $dst $f
    if (Test-Path $srcFile) {
        Copy-Item $srcFile $dstFile -Force
        Write-Host "[DEPLOY] $f -> $dst"
    } else {
        Write-Host "[SKIP] $f non trovato in $src"
    }
}

# surv_008: Rename directory to match version if needed
if ($dst -ne $targetPath -and -not (Test-Path $targetPath)) {
    Rename-Item $dst $targetPath
    $dst = $targetPath  # update reference after rename
    Write-Host "[RENAME] $(Split-Path $dst -Leaf) -> $targetName"
    Write-Host "[NOTE] VS Code reload richiesto per riconoscere la nuova versione"
} elseif ($dst -eq $targetPath) {
    Write-Host "[VERSION] Gia' allineata: $targetName"
}

# Verify version
$header = Get-Content (Join-Path $dst "extension.js") -First 1
Write-Host "`nDeploy completato. Versione attiva: $header"
Write-Host "NOTA: Ricaricare VS Code per attivare le modifiche (Ctrl+Shift+P -> Reload Window)"
