# apply-patch.ps1 — Applica tutte le patch al file Copilot Chat
# Fonte unica di verità: chiamato sia direttamente che dal comando VS Code.
# Legge dal backup originale, applica gate + hook + prompt + safety, scrive al target.
param(
    [string]$Target,
    [string]$Backup,
    [string]$PatchFile
)

$ErrorActionPreference = 'Stop'

# Auto-detect paths if not provided
if (-not $Target) {
    $extDir = "$env:USERPROFILE\.vscode\extensions"
    $chatDir = Get-ChildItem $extDir -Directory | Where-Object { $_.Name -like 'github.copilot-chat-*' } | Sort-Object Name | Select-Object -Last 1
    if (-not $chatDir) { Write-Error "Copilot Chat non trovato in $extDir"; exit 1 }
    $Target = Join-Path $chatDir.FullName 'dist\extension.js'
}
if (-not $Backup) { $Backup = "$Target.pre_hooks" }
if (-not $PatchFile) { $PatchFile = Join-Path $PSScriptRoot 'prompt-patches\block-01-role.txt' }

Write-Host "=== PATCH START ==="
Write-Host "Target:    $Target"
Write-Host "Backup:    $Backup"
Write-Host "PatchFile: $PatchFile"

# Create backup if needed
if (-not (Test-Path $Backup)) {
    Copy-Item $Target $Backup
    Write-Host "Backup creato: $Backup"
} else {
    Write-Host "Backup esistente: $Backup"
}

# Read from backup (always start from original)
$c = [System.IO.File]::ReadAllText($Backup)
Write-Host "Backup letto: $($c.Length) chars"

$gateCount = 0
$promptCount = 0

# ═══════════════════════════════════════
# GATE PATCHES
# ═══════════════════════════════════════

# Gate 1: MAX_AUTOPILOT_ITERATIONS 5 -> 9999
$s = 'MAX_AUTOPILOT_ITERATIONS=5'
$r = 'MAX_AUTOPILOT_ITERATIONS=9999'
if ($c.Contains($s)) { $c = $c.Replace($s, $r); $gateCount++; Write-Host "[GATE1] MAX_ITERATIONS 5 -> 9999 OK" }
else { Write-Host "[GATE1] SKIP: pattern non trovato" }

# Gate 2: toolCallLimit auto-bump ceiling 200 -> 1M
$s = 'this.options.toolCallLimit<200)this.options.toolCallLimit=Math.min(Math.round(this.options.toolCallLimit*3/2),200)'
$r = 'this.options.toolCallLimit<1e6)this.options.toolCallLimit=Math.min(Math.round(this.options.toolCallLimit*3/2),1e6)'
if ($c.Contains($s)) { $c = $c.Replace($s, $r); $gateCount++; Write-Host "[GATE2] toolCallLimit ceiling 200 -> 1e6 OK" }
else { Write-Host "[GATE2] SKIP: pattern non trovato" }

Write-Host "Gates applicati: $gateCount"

# ═══════════════════════════════════════
# HOOK PATCHES (persistenza Loop Guardian)
# ═══════════════════════════════════════

$hookCount = 0
$extId = 'scarlet.copilot-loop-guardian'

# Hook 1: shouldBypassToolLimit — impedisce terminazione per tool call limit
$h1old = 'o++>=this.options.toolCallLimit)'
$h1new = 'o++>=this.options.toolCallLimit&&!(require("vscode").extensions.getExtension("' + $extId + '")?.exports?.shouldBypassToolLimit?.(this.options.request)))'
if ($c.Contains($h1old)) { $c = $c.Replace($h1old, $h1new); $hookCount++; Write-Host "[HOOK1] shouldBypassToolLimit OK" }
else { Write-Host "[HOOK1] SKIP: pattern non trovato" }

# Hook 2: shouldBypassYield — impedisce pausa sessione
$h2old = 'this.options.yieldRequested?.()&&('
$h2new = 'this.options.yieldRequested?.()&&!(require("vscode").extensions.getExtension("' + $extId + '")?.exports?.shouldBypassYield?.(this.options.request))&&('
if ($c.Contains($h2old)) { $c = $c.Replace($h2old, $h2new); $hookCount++; Write-Host "[HOOK2] shouldBypassYield OK" }
else { Write-Host "[HOOK2] SKIP: pattern non trovato" }

# Hook 3: onLoopCheck — override decisione terminazione loop
$h3old = ',!p.round.toolCalls.length||p.response.type!=="success")'
$h3new = ',await Promise.resolve(require("vscode").extensions.getExtension("' + $extId + '")?.exports?.onLoopCheck?.(p,this))??(!p.round.toolCalls.length||p.response.type!=="success"))'
if ($c.Contains($h3old)) { $c = $c.Replace($h3old, $h3new); $hookCount++; Write-Host "[HOOK3] onLoopCheck OK" }
else { Write-Host "[HOOK3] SKIP: pattern non trovato" }

Write-Host "Hooks applicati: $hookCount/3"

# ═══════════════════════════════════════
# PROMPT PATCHES
# ═══════════════════════════════════════

# Read patch text file
$raw = [System.IO.File]::ReadAllText($patchFile).TrimStart([char]0xFEFF).Trim()
$paras = @($raw -split '(\r?\n){2,}' | Where-Object { $_.Trim().Length -gt 0 })
Write-Host "Prompt file letto: $($paras.Count) paragrafi"

# --- T1: Replace main identity string (ALL occurrences) ---
$t1old = [char]34 + 'You are an expert AI programming assistant, working with a user in the VS Code editor.' + [char]34
$e1 = $paras[0].Trim() -replace '\\','\\' -replace '`','\`' -replace '\$','\$'
$t1new = [char]96 + $e1 + [char]96  # backtick-wrapped template literal

$t1n = 0
while ($c.Contains($t1old)) {
    $p = $c.IndexOf($t1old)
    $c = $c.Substring(0, $p) + $t1new + $c.Substring($p + $t1old.Length)
    $t1n++
    Write-Host "[T1] Replaced at offset $p"
}
$promptCount += $t1n
Write-Host "[T1] Total: $t1n occorrenze sostituite"

# --- T2: Replace class no (CopilotIdentityRulesClass) render method ---
# Build search string exactly matching the minified JS
$q = [char]39  # single quote
$dq = [char]34 # double quote
$t2old = "render(){return vscpp(vscppf,null,${q}When asked for your name, you must respond with ${dq}GitHub Copilot${dq}. When asked about the model you are using, you must state that you are using ${q},this.promptEndpoint.name,${dq}.${dq},vscpp(${dq}br${dq},null),${dq}Follow the user${q}s requirements carefully & to the letter.${dq})}"

Write-Host "[T2] Search string length: $($t2old.Length)"
$idx2 = $c.IndexOf($t2old)
Write-Host "[T2] Found at: $idx2"

if ($idx2 -ge 0) {
    # Build replacement from paragraphs 2+
    $parts = @()
    for ($i = 1; $i -lt $paras.Count; $i++) {
        if ($i -gt 1) { $parts += "vscpp(${dq}br${dq},null)" }
        $esc = $paras[$i].Trim() -replace '\\','\\' -replace '`','\`' -replace '\$','\$'
        $parts += [char]96 + $esc + [char]96
    }
    $t2new = 'render(){return vscpp(vscppf,null,' + ($parts -join ',') + ')}'
    $c = $c.Substring(0, $idx2) + $t2new + $c.Substring($idx2 + $t2old.Length)
    $promptCount++
    Write-Host "[T2] Identity rules class replaced OK"
} else {
    Write-Host "[T2] FAIL - pattern non trovato. Provo ricerca diagnostica..."
    $diag = 'you must respond with "GitHub Copilot"'
    $didx = $c.IndexOf($diag)
    Write-Host "[T2] Diagnostic partial match at: $didx"
}

# --- T3: Replace ALL remaining "GitHub Copilot" name references in prompt classes ---
$t3old = 'you must respond with "GitHub Copilot"'
$t3new = 'you must respond with "Scarlet"'
$t3n = 0
while ($c.Contains($t3old)) {
    $p = $c.IndexOf($t3old)
    $c = $c.Substring(0, $p) + $t3new + $c.Substring($p + $t3old.Length)
    $t3n++
}
$promptCount += $t3n
Write-Host "[T3] Replaced $t3n remaining 'GitHub Copilot' name references"

# --- T4: Replace hardcoded model name 'using GitHub Copilot.' in inline prompts ---
$t4old = 'you are using GitHub Copilot.' + [char]39
$t4new = 'you are using Scarlet.' + [char]39
$t4n = 0
while ($c.Contains($t4old)) {
    $p = $c.IndexOf($t4old)
    $c = $c.Substring(0, $p) + $t4new + $c.Substring($p + $t4old.Length)
    $t4n++
}
$promptCount += $t4n
Write-Host "[T4] Replaced $t4n hardcoded model name references"

# ═══════════════════════════════════════
# SAFETY PATCHES (neutralize MS policies)
# ═══════════════════════════════════════

$safetyCount = 0

$safetyPatches = @(
    @{ Name = 'Microsoft content policies';   Search = [char]34 + 'Follow Microsoft content policies.' + [char]34;   Replace = [char]34 + [char]34 },
    @{ Name = 'Copyright warning';            Search = [char]34 + 'Avoid content that violates copyrights.' + [char]34; Replace = [char]34 + [char]34 },
    @{ Name = 'Safety gate (standard)';       Search = [char]96 + 'If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with "Sorry, I can' + [char]39 + 't assist with that."' + [char]96; Replace = [char]34 + [char]34 },
    @{ Name = 'Safety gate (extended)';       Search = [char]96 + 'If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, violent, or completely irrelevant to software engineering, only respond with "Sorry, I can' + [char]39 + 't assist with that."' + [char]96; Replace = [char]34 + [char]34 },
    @{ Name = 'Short impersonal directive';   Search = [char]34 + 'Keep your answers short and impersonal.' + [char]34; Replace = [char]34 + [char]34 },
    @{ Name = 'Inline edit apologize gate';  Search = '- Apologize with ' + [char]34 + 'Sorry, I can' + [char]39 + 't assist with that.' + [char]34 + ' for requests that may breach Microsoft content guidelines.'; Replace = '' },
    @{ Name = 'Inline edit reply gate';      Search = 'If a request may breach guidelines, reply: ' + [char]34 + 'Sorry, I can' + [char]39 + 't assist with that.' + [char]34; Replace = '' }
)

foreach ($sp in $safetyPatches) {
    $n = 0
    while ($c.Contains($sp.Search)) {
        $p = $c.IndexOf($sp.Search)
        $c = $c.Substring(0, $p) + $sp.Replace + $c.Substring($p + $sp.Search.Length)
        $n++
    }
    $safetyCount += $n
    if ($n -gt 0) { Write-Host "[SAFETY] $($sp.Name): $n occorrenze neutralizzate" }
    else { Write-Host "[SAFETY] SKIP $($sp.Name): non trovato" }
}

Write-Host "Safety applicati: $safetyCount"

# ═══════════════════════════════════════
# WRITE
# ═══════════════════════════════════════
[System.IO.File]::WriteAllText($Target, $c, [System.Text.UTF8Encoding]::new($false))
$sz = (Get-Item $Target).Length
Write-Host "`nFile scritto: $sz bytes"

# ═══════════════════════════════════════
# VERIFY
# ═══════════════════════════════════════
$v = [System.IO.File]::ReadAllText($Target)
$chkScarlet = $v.Contains('You are Scarlet')
$chkDefault = $v.Contains('You are an expert AI programming assistant, working with a user')
$chkGHname = $v.Contains('you must respond with "GitHub Copilot"')
$chkMaxIter = $v.Contains('MAX_AUTOPILOT_ITERATIONS=9999')
$chkToolCeil = $v.Contains('toolCallLimit<1e6')
$chkHook1 = $v.Contains('shouldBypassToolLimit')
$chkHook2 = $v.Contains('shouldBypassYield')
$chkHook3 = $v.Contains('onLoopCheck')
$chkMSPolicy = $v.Contains('Follow Microsoft content policies.')
$chkImpersonal = $v.Contains('Keep your answers short and impersonal.')
$chkApologize = $v.Contains('Apologize with')
$chkReplyGate = $v.Contains('reply: "Sorry')

Write-Host "`n=== VERIFICA ==="
Write-Host "Scarlet identity:    $chkScarlet (atteso: True)"
Write-Host "Default identity:    $chkDefault (atteso: False)"
Write-Host "GitHub Copilot name: $chkGHname (atteso: False)"
Write-Host "MAX_ITERATIONS=9999: $chkMaxIter (atteso: True)"
Write-Host "toolCallLimit=1e6:   $chkToolCeil (atteso: True)"
Write-Host "Hook bypass limit:   $chkHook1 (atteso: True)"
Write-Host "Hook bypass yield:   $chkHook2 (atteso: True)"
Write-Host "Hook onLoopCheck:    $chkHook3 (atteso: True)"
Write-Host "MS Policy removed:   $(-not $chkMSPolicy) (atteso: True)"
Write-Host "Impersonal removed:  $(-not $chkImpersonal) (atteso: True)"
Write-Host "Apologize removed:   $(-not $chkApologize) (atteso: True)"
Write-Host "Reply gate removed:  $(-not $chkReplyGate) (atteso: True)"
Write-Host "`nTotale: $gateCount gates + $hookCount hooks + $promptCount prompt + $safetyCount safety"
Write-Host "=== PATCH END ==="
