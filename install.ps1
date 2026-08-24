$ErrorActionPreference = 'Stop'
# Keep the caller cwd: project assets go there (or --path), not this script dir.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error '未找到 node。请先安装 Node.js ≥ 22.19，然后重新运行 .\install.ps1'
}
$installScript = Join-Path $PSScriptRoot 'scripts\install-grok.mjs'
node $installScript @args
exit $LASTEXITCODE
