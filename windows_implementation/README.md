# Windows Instance Setup

Setup steps for each Windows EC2 instance running the crawler.

## 1. Packages and Module Installation

Install Node.js (LTS):

```powershell
winget install OpenJS.NodeJS.LTS --source winget
```

To confirm the installation:

```powershell
node --version
npm --version
```

Install the crawler dependencies inside the project folder (where `Page_Collector.js` lives):

```powershell
cd C:\Users\Administrator\Desktop\star-crawler\Windows_Implementation
npm install puppeteer-extra puppeteer-extra-plugin-stealth puppeteer-core
```



Unpack the consent extensions (the crawler loads `consent-accept/` and `consent-reject/` as folders next to `Page_Collector.js`):

```powershell
Expand-Archive -Path "consent-built.zip" -DestinationPath "." -Force
```

Confirm both folders now exist:

```powershell
dir consent-accept
dir consent-reject
```

## 2. Browser Profile Setup

Install Brave from https://brave.com. Confirm it installed at the expected path:

```powershell
Test-Path "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe"
```

### Standard region profile

`config.json` points each variation at `./profiles/<region>-profile`, but the `profiles` directory ships empty, so the seed profile must be built on each instance.

Build the region's seed profile (run once, let Brave open, then close it):

```powershell
& "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe" --user-data-dir="$PWD\profiles\<region>-profile" --no-first-run
```

Replace `<region>` with the instance's region (`us`, `uk`, `jp`).

### uBlock Origin profile (content-filtering variation only)

The content-filtering variation needs a profile with uBlock Origin installed and enabled. Build it manually:

1. Launch Brave into the profile path:
   ```powershell
   & "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe" --user-data-dir="$PWD\profiles\<region>-ublock-profile" --no-first-run
   ```
2. Go to `brave://extensions`.
3. Toggle on **Developer mode** (top right).
4. Click **Load unpacked** and select the `ublock-origin` folder in the project directory.
5. Confirm uBlock Origin appears and is enabled.
6. Close Brave -> The profile now carries uBlock and can be used as the seed for that variation.


## 3. Browser and VPN Configuration

Install Brave from https://brave.com. Confirm it installed at the expected path:

```powershell
Test-Path "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe"
```

Build the region's seed profile (run once, let Brave open, then close it):

```powershell
& "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe" --user-data-dir="$PWD\profiles\<region>-profile" --no-first-run
```

VPN (NordVPN app, split tunneling so only Brave is routed):

1. Install the NordVPN desktop app.
2. Block it at the firewall before first launch so it cannot auto-connect and drop RDP:
   ```powershell
   New-NetFirewallRule -DisplayName "BlockNordApp" -Direction Outbound -Program "C:\Program Files\NordVPN\NordVPN.exe" -Action Block
   ```
3. Open the app, log in, go to Settings -> Split Tunneling -> "Use VPN for selected apps" -> add `brave.exe`.
4. Remove the firewall block, then connect:
   ```powershell
   Remove-NetFirewallRule -DisplayName "BlockNordApp"
   ```
5. Verify Brave exits in-region while the host keeps its real IP.

## 3. SSH Set-up

Install and start the OpenSSH server:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

Confirm it is running:

```powershell
Get-Service sshd
```

Status should be `Running`.

AWS security group: in the EC2 console, open the instance's security group, add an inbound rule:
- Type: SSH
- Port: 22
- Source: <YOU_IP>

## 4. Scheduling a Task

The task runs `run_batch.ps1` in the visible session so the headful browsers appear over RDP. Register it once:

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File C:\Users\Administrator\Desktop\star-crawler\Windows_Implementation\run_batch.ps1"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName "StarCrawlBatch" -Action $action -Principal $principal -Force
```

Test it (after placing 4 domains in `batch.txt`):

```powershell
schtasks /run /tn StarCrawlBatch
```

The 4 browser workers should launch in the desktop session.