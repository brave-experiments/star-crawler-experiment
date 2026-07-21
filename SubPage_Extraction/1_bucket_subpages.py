import os
import re
import sys
import json
import warnings
import subprocess
from urllib.parse import urlsplit
from concurrent.futures import ThreadPoolExecutor


try:
    from bs4 import XMLParsedAsHTMLWarning
    warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)
except Exception:
    pass


script_directory = os.path.dirname(os.path.abspath(__file__))

# ---- tunables -------------------------------------------------------------
fetch_worker_count = 24
wget_timeout_seconds = 15
subprocess_timeout_seconds = 40
user_agent = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36")

# bucket 4: a page is "text heavy" when visible text is at least this fraction of the raw HTML
text_ratio_threshold = 0.20
# ---------------------------------------------------------------------------

# any og:type counts as "content" (dynamic page) EXCEPT these generic container types.
# so article, product, profile, video.*, music.*, book, ecommerce, etc. all count.
non_content_og_types = ("website", "object")

date_patterns = [
    re.compile(r"(19|20)\d{2}[-/](0[1-9]|1[0-2])([-/](0[1-9]|[12]\d|3[01]))?(/|$)"),
    re.compile(r"(19|20)\d{2}[-/](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)", re.IGNORECASE),
]


def path_has_date(a_path):

    for pattern in date_patterns:
        if pattern.search(a_path):
            return True

    return False


def path_has_numeric_id(a_path):

    if re.search(r"\d{4,}", a_path):
        return True

    for segment in a_path.split("/"):
        if segment.isdigit() and len(segment) >= 2:

            return True

    return False


def path_has_title_slug(a_path):

    for segment in a_path.split("/"):
        if segment.count("-") >= 2 or segment.count("_") >= 2:
            return True

    return False


# article-looking URL = has a date OR a numeric id OR a multi-word title slug
def url_is_article_looking(url_to_analyze):
    path = urlsplit(url_to_analyze).path
    return path_has_date(path) or path_has_numeric_id(path) or path_has_title_slug(path)


def og_type_is_content(a_og_type):
    value = (a_og_type or "").strip().lower()
    if not value:
        return False

    return value not in non_content_og_types


# ======================= CONSIDER ONLY VALID HTML DOCUMENTS 2ND STEP ===========================
# static GET via wget -----------> returns the HTML text only for a VALID web page: final HTTP status
# 2xx/3xx AND Content-Type text/html. anything else (error status, or a non-HTML body like
# a pdf/json/image served at 200) returns None so it is treated as "no page".
def fetch_html(url_to_analyze):
    try:
        completed = subprocess.run(
            ["wget", "-S", "-O", "-",
             "--timeout=" + str(wget_timeout_seconds), "--tries=2",
             "--max-redirect=5", "--no-check-certificate",
             "-U", user_agent, url_to_analyze],
            capture_output=True, timeout=subprocess_timeout_seconds)
    except Exception:
        return None

    if completed.returncode != 0 or not completed.stdout:
        return None

    # -----> wget -S writes the server response headers to stderr (one block per redirect hop).
    header_text = completed.stderr.decode("utf-8", "ignore")

    # KEEP THE FINAL HTTP status = the last status line after any redirects
    status_codes = re.findall(r"HTTP/\S+\s+(\d{3})", header_text)
    if not status_codes:
        return None
    

    final_status = int(status_codes[-1])
    if not (200 <= final_status < 400):
        return None

    # final Content-Type must be HTML
    content_types = re.findall(r"(?im)^\s*Content-Type:\s*(.+)$", header_text)
    final_content_type = content_types[-1].strip().lower() if content_types else ""
    if "text/html" not in final_content_type:
        return None

    return completed.stdout.decode("utf-8", "ignore")


# read og:type and the visible-text ratio from fetched HTML
def analyze_html(a_raw_html):
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(a_raw_html, "lxml")

    og_type = ""
    meta_tag = soup.find("meta", attrs={"property": "og:type"})
    
    if meta_tag is None:
        meta_tag = soup.find("meta", attrs={"name": "og:type"})
    
    if meta_tag is not None:
        og_type = (meta_tag.get("content") or "").strip().lower()

    for removable in soup(["script", "style", "noscript"]):
        removable.extract()
    
    # measure text against the REMAINING markup (script/style/noscript already removed),
    # not the raw HTML, so inline JS/CSS bloat does not drown out the readable content.
    markup_without_code = str(soup)
    visible_text = soup.get_text(" ", strip=True)
    text_ratio = len(visible_text) / max(1, len(markup_without_code))

    return og_type, text_ratio


# fetch + analyze one url -----> returns a small dict cached to disk
def fetch_and_analyze(url_to_analyze):
    
    raw_html = fetch_html(url_to_analyze)
    if raw_html is None:
        return {"ok": False, "og_type": "", "text_ratio": 0.0}
    
    og_type, text_ratio = analyze_html(raw_html)
    
    return {"ok": True, "og_type": og_type, "text_ratio": text_ratio}


# classify one url: returns (bucket_number, record) where record keeps the url plus the
# exact heuristics that placed it (og:type, which URL signals fired, text ratio, fetch state).
def classify_subpage(url_to_analyze, a_analysis):
    path = urlsplit(url_to_analyze).path
    has_date = path_has_date(path)
    has_numeric_id = path_has_numeric_id(path)
    has_title_slug = path_has_title_slug(path)


    url_signals = []
    if has_date:
        url_signals.append("date")
    if has_numeric_id:
        url_signals.append("numeric_id")
    if has_title_slug:
        url_signals.append("title_slug")
    url_article = bool(url_signals)

    fetched = a_analysis is not None and a_analysis.get("ok")
    og_type = a_analysis.get("og_type", "") if fetched else ""
    og_article = og_type_is_content(og_type) if fetched else False
    text_ratio = round(a_analysis.get("text_ratio", 0.0), 3) if fetched else 0.0
    text_heavy = fetched and text_ratio >= text_ratio_threshold

    reasons = []
    if not fetched:
        bucket = 3 if url_article else 5
        reasons = ["url:" + s for s in url_signals]
        reasons.append("fetch_failed")
    
    elif og_article and url_article:
        bucket = 1
        reasons = ["og:type=" + og_type] + ["url:" + s for s in url_signals]
    
    elif og_article:
        bucket = 2
        reasons = ["og:type=" + og_type]
    
    elif url_article:
        bucket = 3
        reasons = ["url:" + s for s in url_signals]
    
    elif text_heavy:
        bucket = 4
        reasons = ["text_heavy"]
    
    else:
        bucket = 5
        reasons = ["no_content_signal"]
        if og_type:
            reasons.append("og:type=" + og_type)

    record = {
        "url": url_to_analyze,
        "reasons": reasons,
        "og_type": og_type,
        "url_signals": url_signals,
        "text_ratio": text_ratio,
    }
    return bucket, record


# =========================================================================
# These are mour buckets BY PREFERENCE for selecting a sub-page
bucket_key = {
    1: "bucket_1_og_article_and_article_url",
    2: "bucket_2_og_article",
    3: "bucket_3_article_url",
    4: "bucket_4_text_heavy",
    5: "bucket_5_other",
}
# =========================================================================


# in case the script is stopped 
def load_cache(a_cache_path):
    if os.path.isfile(a_cache_path):
        try:
            with open(a_cache_path, encoding="utf-8") as file_handle:
                return json.load(file_handle)
        except Exception:
            return {}
    return {}


def save_cache(a_cache_path, a_cache):
    with open(a_cache_path, "w", encoding="utf-8") as file_handle:
        json.dump(a_cache, file_handle, ensure_ascii=False)


def main():

    if len(sys.argv) > 1:
        input_path = sys.argv[1]
    else:
        input_path = os.path.join(script_directory, "consistent_subpages_consistent_captures_final.json")

    if not os.path.isfile(input_path):
        print("Input not found: " + input_path)
        print("Run extract_consistent_subpages.py first to produce it.")
        sys.exit(1)

    with open(input_path, encoding="utf-8") as file_handle:
        consistent_sub_pages_by_domain = json.load(file_handle)

    # gather every unique url to fetch once
    all_urls = set()
    for links in consistent_sub_pages_by_domain.values():
        for url in links:
            all_urls.add(url)
    print("unique sub-page urls to consider: " + str(len(all_urls)))



    cache_path = os.path.join(script_directory, "fetch_cache.json")
    cache = load_cache(cache_path)

    urls_to_fetch = [url for url in all_urls if url not in cache]
    print("already cached: " + str(len(all_urls) - len(urls_to_fetch))+ "  |  to fetch now: " + str(len(urls_to_fetch)))

    fetched_since_save = 0
    completed_count = 0


    with ThreadPoolExecutor(max_workers=fetch_worker_count) as executor:
        future_to_url = {}
        
        for url in urls_to_fetch:
            future_to_url[executor.submit(fetch_and_analyze, url)] = url
        
        for future in future_to_url:
            pass  # submitted
        
        for future in list(future_to_url):
            url = future_to_url[future]
            try:
                cache[url] = future.result()
            except Exception:
                cache[url] = {"ok": False, "og_type": "", "text_ratio": 0.0}
            completed_count += 1
            fetched_since_save += 1
            if fetched_since_save >= 500:
                save_cache(cache_path, cache)
                fetched_since_save = 0
                print("  fetched " + str(completed_count) + "/" + str(len(urls_to_fetch)))




    save_cache(cache_path, cache)



    # assign buckets per domain
    buckets_by_domain = {}
    bucket_totals = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
    for domain_label in sorted(consistent_sub_pages_by_domain):
        domain_buckets = {bucket_key[n]: [] for n in range(1, 6)}
        for url in consistent_sub_pages_by_domain[domain_label]:
            analysis = cache.get(url)
            bucket_number, record = classify_subpage(url, analysis)
            domain_buckets[bucket_key[bucket_number]].append(record)
            bucket_totals[bucket_number] += 1
        buckets_by_domain[domain_label] = domain_buckets

    input_basename = os.path.basename(input_path).replace("consistent_subpages_", "").replace(".json", "")
    output_path = os.path.join(script_directory, "subpage_buckets_" + input_basename + ".json")
    with open(output_path, "w", encoding="utf-8") as file_handle:
        json.dump(buckets_by_domain, file_handle, ensure_ascii=False, indent=2)



    print("==============================================================================")
    print("  domains: " + str(len(buckets_by_domain)))
    for n in range(1, 6):
        print("  " + bucket_key[n] + ": " + str(bucket_totals[n]) + " urls")
    print("  output: " + output_path)
    print("==============================================================================")


if __name__ == "__main__":
    main()
