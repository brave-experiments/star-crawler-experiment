$project = "C:\Users\Administrator\Desktop\star-crawler-experiment"
Set-Location $project

Remove-Item "$project\done.flag" -ErrorAction SilentlyContinue

$url = (Get-Content "$project\current_url.txt" | Select-Object -First 1).Trim()
$variation = (Get-Content "$project\variation.txt" | Select-Object -First 1).Trim()

$worker_count = 3
$processes = @()
for ($i = 0; $i -lt $worker_count; $i++) {
    $worker_args = "Page_Collector.js --variation $variation --url $url --worker $i"
    $processes += Start-Process node -ArgumentList $worker_args -PassThru -WorkingDirectory $project
}

$processes | ForEach-Object { $_.WaitForExit() }

New-Item "$project\done.flag" -ItemType File -Force | Out-Null
