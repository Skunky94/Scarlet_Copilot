# deploy-extension.ps1 — Deploy Loop Guardian dal workspace alla directory estensioni VS Code
# Uso: .\deploy-extension.ps1
# Dopo il deploy, ricaricare VS Code per attivare le modifiche.

$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
$extDir = "$env:USERPROFILE\.vscode\extensions"
$extName = "scarlet.copilot-loop-guardian-1.0.0"
$dst = Join-Path $extDir $extName

if (-not (Test-Path $dst)) {
    Write-Error "Estensione non trovata in $dst"
    exit 1
}

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

# Verify version
$header = Get-Content (Join-Path $dst "extension.js") -First 1
Write-Host "`nDeploy completato. Versione attiva: $header"
Write-Host "NOTA: Ricaricare VS Code per attivare le modifiche (Ctrl+Shift+P -> Reload Window)"
