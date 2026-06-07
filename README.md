# star-crawler-experiment

- Run `node Pre_Build_Consent.js` once to build the Consent-O-Matic extension, because it ships as source only and needs a webpack build (MV2 no longer loads). It produces `consent-accept/` and `consent-reject/`. Re-run only when updating Consent-O-Matic.

- Run the crawler per variation and serialization point:
```
  node Page_Collector.js --variation <id> --page-load    # at domcontentloaded
  node Page_Collector.js --variation <id> --net-idle     # at networkidle0
  node Page_Collector.js --variation <id> --30-secs      # at networkidle0 + 30s
```