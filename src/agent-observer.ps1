# Read-only process presence and local-service discovery. No HWND or Agent actions.
$ErrorActionPreference = 'Stop'
$presets = [Console]::In.ReadLine() | ConvertFrom-Json
$lsKey = ''
$lsServices = @()
$lsDiscoveredAt = [DateTime]::MinValue
while ($true) {
    $observations = foreach ($preset in $presets) {
        $present = $false
        $inaccessible = $false
        $instances = @()
        try {
            # Query only the four configured image names, not every process/window.
            $processes = [Diagnostics.Process]::GetProcessesByName($preset.processName)
            foreach ($candidate in $processes) {
                try {
                    if ($candidate.HasExited) { continue }
                    if ($preset.executableContains) {
                        # A normal ChatGPT process is not necessarily Codex Desktop.
                        $image = $candidate.MainModule.FileName
                        if (!$image) { $inaccessible = $true; continue }
                        if ($image.IndexOf($preset.executableContains, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
                    }
                    $present = $true
                    if ($preset.id -eq 'dsh' -or $preset.id -eq 'antigravity') {
                        $instances += @{ pid = $candidate.Id; startedAt = ([DateTimeOffset]$candidate.StartTime).ToUnixTimeMilliseconds() }
                    }
                } catch {
                    $inaccessible = $true
                } finally {
                    $candidate.Dispose()
                }
            }
            $running = if ($present) { $true } elseif ($inaccessible) { $null } else { $false }
        } catch {
            $running = $null
        }
        $observation = @{ id = $preset.id; running = $running }
        if ($preset.id -eq 'dsh') { $observation.instances = @($instances) }
        if ($preset.id -eq 'antigravity' -and $present) {
            try {
                # This fixed image-name query also finds an LS restarted by its existing parent.
                $servers = @(Get-CimInstance Win32_Process -Filter "Name='language_server.exe'" |
                    Where-Object { $_.ParentProcessId -in $instances.pid })
                $key = ($servers.ProcessId | Sort-Object) -join ','
                if ($key -ne $lsKey -or ([DateTime]::UtcNow - $lsDiscoveredAt).TotalSeconds -ge 60) {
                    $lsKey = $key
                    $lsDiscoveredAt = [DateTime]::UtcNow
                    $lsServices = @(foreach ($server in $servers) {
                        $token = [regex]::Match($server.CommandLine, '--csrf_token\s+(?:"([^"]+)"|(\S+))')
                        if (!$token.Success) { continue }
                        $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $server.ProcessId -ErrorAction SilentlyContinue |
                            Where-Object LocalAddress -eq '127.0.0.1' | Select-Object -ExpandProperty LocalPort)
                        @{ pid = $server.ProcessId; parentPid = $server.ParentProcessId; ports = $ports;
                            token = if ($token.Groups[1].Success) { $token.Groups[1].Value } else { $token.Groups[2].Value } }
                    })
                }
                # Tokens stay in FS's private process pipe; never publish them to the UI.
                $observation.services = @($lsServices)
            } catch {
                $observation.services = @()
            }
        }
        $observation
    }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject @($observations) -Depth 5 -Compress))
    [Console]::Out.Flush()
    [Threading.Thread]::Sleep(10000)
}
