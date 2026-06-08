# star-crawler-experiment

Preliminary draft of the crawler infrastructure to capture the HTML of a page at one of **3 load points**, across user **variations** (region, consent, resolution)


## Setup

- Run `node Pre_Build_Consent.js` once to build the Consent-O-Matic extension, because it ships as source only and needs a webpack build (MV2 no longer loads unless we can perform our experiemnts on previous versions of Chrome). It produces `consent-accept/` and `consent-reject/`. Re-run only when updating Consent-O-Matic

## Run

Run the crawler per variation and serialization point:
```
  node Page_Collector.js --variation <id> --page-load    # at domcontentloaded
  node Page_Collector.js --variation <id> --net-idle     # at networkidle0
  node Page_Collector.js --variation <id> --30-secs      # at networkidle0 + 30s
```

## Config

`config.json` holds the `variations` (region, consent, resolution), the allowed `serialization_points`, and paths. Each `--variation <id>` selects one row; `consent` (`accept` / `reject` / `no-action`) picks which prebuilt extension loads (`no-action` loads none)

## Inputs

- `domains.txt` — one domain per line; blank lines and `#` comments ignored.

## Output

```
output/variation_<id>/
  profile/                                  # Chromium user-data dir
  websites/<domain>/<serialization_point>/
    page.html
    metadata.json
```
The `metadata.json` records the variation params, serialization point, success/failure, `network_idle_timed_out`, and HTML size

## Current state / notes

- Headful Chromium (`/usr/bin/chromium-browser`) via puppeteer-extra + stealth; automation banner suppressed
- One serialization point per run --> To capture all three run each flag
- `domcontentloaded` is the navigation anchor, idle points use `waitForNetworkIdle` and capture anyway on timeout
- Consent action is loaded but not yet verified (no confirmation Consent-O-Matic acted before serialization)
- `region` is recorded to metadata only ---> actual vantage routing (Brave VPN) is not wired in yet
- Profile is shared across domains within a run




## Questions

- Do we also need to compare across different browsers? Also currently we are not setting a specific User Agent string but rather using the default (of stock Chromium)
- Do we use one profile per 'vantage' point (i.e. implementation option) across all browsed websites?
- Should we follow the methodology used in "Towards Realistic and Reproducible Web Crawl Measurements" i.e. execute the crawl across VMs on the same time of day?
- Should we also pin down the accept-language, timezone or other client-derived content to ensure consistency across VMs or regions?



## TODO
- Brave VPN utilization to check regional utility
- Consent-O-Matic recording capabilities **per page** (i.e. on which pages the plugin successfully handled the banner)
- Enhance recording capabilities 
- Start building orchistrator to synchronize visits across VMs