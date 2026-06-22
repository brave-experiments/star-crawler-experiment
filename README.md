# star-crawler-experiment

Crawler infrastructure that captures the HTML of a page at **6 load points**, across user **variations** (region, consent, resolution, device), visiting each domain **9 times** to model a returning user.


## Setup

- Run `node Pre_Build_Consent.js` once to build the Consent-O-Matic extension, because it ships as source only and needs a webpack build (MV2 no longer loads unless we can run our experiments on older Chrome versions). It produces `consent-accept/` and `consent-reject/`. Re-run only when updating Consent-O-Matic.
- Each variation needs a seed profile (the path is set in `config.json`). The crawler copies this seed fresh for every domain, so it stays pristine.


## Run

One run captures all 6 serialization points, 9 times, for the selected variation:

```
  node Page_Collector.js --variation <id>
```

### Arguments

```
  --variation <id>      (required) which row of config.json to use (region, consent, resolution, device)
  --worker <index>      (optional, default 0) isolates parallel workers on one machine; sets the debug port
  --url <domain>        (optional) crawl a single domain instead of the full list
  --domains <file>      (optional) domains file relative to the project root (default: crux_latest/current.csv)
  --limit <n>           (optional) only crawl the first n domains
  --profile <path>      (optional) override the variation's seed profile
  --extension <path>    (optional) load an extra unpacked extension
  --skip-region         (optional) skip the region/country check (used for local testing without the VPN up)
```

### Running multiple domains in parallel on one machine

Each worker takes its own `--worker` index (own debug port, own per-domain profiles) and its own domain. Example, 5 domains at once:

```
  node Page_Collector.js --variation 1 --worker 0 --url fool.com
  node Page_Collector.js --variation 1 --worker 1 --url macys.com
  node Page_Collector.js --variation 1 --worker 2 --url stonybrook.edu
  node Page_Collector.js --variation 1 --worker 3 --url github.com
  node Page_Collector.js --variation 1 --worker 4 --url cnn.com
```

Add `--skip-region` to any of these when testing without the VPN connected.


## Config

`config.json` holds the `variations` (region, consent, resolution, device), the `serialization_points`, and the seed `profile_path` per variation. Each `--variation <id>` selects one row. `consent` (`accept` / `reject` / `no-action` / `content-filtering`) picks which prebuilt extension loads: `accept`/`reject` load Consent-O-Matic, `content-filtering` loads uBlock Origin, `no-action` loads none.


## Inputs

- `crux_latest/current.csv` (default) or any file passed with `--domains` — one domain per line; the `origin,rank` header line is ignored.


## Output

```
output/variation_<id>/
  websites/<domain>/
    profile/                          # fresh seed copy for this domain, reused across its 9 runs
    run_<n>/                          # one folder per visit (1..9)
      initial_response/page.html
      domcontentloaded/page.html
      page_load/page.html
      five_seconds/page.html
      networkidle2/page.html
      networkidle0/page.html
      metadata.json
  errors_worker_<index>.json          # failures recorded as {worker_index, domain, run_index, error}
```

`metadata.json` records the variation params, run index, success/failure, HTTP status, TLS details, network errors by category, idle timeouts, dwell time, user agent, and HTML size per serialization point.


## Current state / notes

- Headful Brave (`/usr/bin/brave-browser` on Linux, `C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe` on Windows) via puppeteer-extra + stealth; automation banner suppressed.
- All 6 serialization points are captured in a single run: raw server response, domcontentloaded, load, 5s after load, networkidle2, networkidle0.
- `domcontentloaded` is the navigation anchor so a slow load cannot block the later captures; idle points use `waitForNetworkIdle` and capture the current DOM anyway on timeout.
- Each domain gets a **fresh copy** of the variation's seed profile, reused across all 9 visits (visit 1 is a cold first-timer, visits 2 to 9 are a returning user to that same site). Profiles are not shared across domains.
- Every visit fully tears down and relaunches Brave (no new tab, no refresh), which avoids bot detection and models a user reopening the browser.
- Regional egress is handled at the OS level, not by a browser extension: on Linux via a network namespace running OpenVPN, on Windows via the NordVPN app's split tunneling with only Brave routed through the VPN. The tunnel stays up across relaunches, so there is no VPN re-authentication and no rate limiting.
- Before each crawl the exit country is confirmed via `ipinfo.io` (NordVPN can hand back a different in-region IP on each reconnect). `--skip-region` bypasses this for local testing.
- `--worker` enables multiple crawlers in parallel on one machine, each with its own debug port and its own per-domain profiles. The debug port rotates per run so a just-killed Brave cannot block the next launch.
- Consent action loads (Consent-O-Matic or uBlock) but is not yet verified per page (no confirmation the banner was actually handled before serialization).

