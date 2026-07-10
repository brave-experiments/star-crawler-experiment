import os
import sys
import json
import glob
from urllib.parse import urljoin, urlsplit, urlunsplit
from collections import defaultdict

import tldextract
from bs4 import BeautifulSoup #we could also use regexes to make the extraction faster --> we are only looking for <a> tags not need to serialize the whole DOM with BeatSoup


script_directory = os.path.dirname(os.path.abspath(__file__))
repo_root_directory = os.path.dirname(script_directory)
latest_snapshot_points = ["networkidle0", "networkidle2"]



# tldextract instance reused across calls; registrable-domain results are memoised per host.
tld_extractor = tldextract.TLDExtract()
registrable_domain_cache = {}


def resolve_data_root(requested_directory):
    if os.path.isdir(requested_directory):
        return os.path.abspath(requested_directory)

    joined_directory = os.path.join(repo_root_directory, requested_directory)
    if os.path.isdir(joined_directory):
        return joined_directory

    return None


def read_text_file(file_path):
    try:
        with open(file_path, encoding="utf-8", errors="ignore") as file_handle:
            return file_handle.read()
    except Exception:
        return ""



# extract the registered domain for a hostname e.g. www.dailymail.co.uk -> dailymail.co.uk.
def registrable_domain(hostname):

    hostname = (hostname or "").lower()
    if hostname in registrable_domain_cache:
        return registrable_domain_cache[hostname]


    registered = tld_extractor(hostname).registered_domain
    registrable_domain_cache[hostname] = registered

    return registered




# Parse the HTML and return the href of every <a> tag. BeautifulSoup treats
# <script>/<style> contents as text, so anchors inside JS/CSS are never matched
# (no manual stripping needed) and HTML entities are decoded for us.
def extract_href_values(raw_html):
    soup = BeautifulSoup(raw_html, "lxml")
    href_values = []
    for anchor_tag in soup.find_all("a", href=True):
        cleaned_value = anchor_tag["href"].strip()
        if cleaned_value:
            href_values.append(cleaned_value)
    return href_values











# extract sub-pages (absolute paths/relative paths and based on the eTLD+1)
# e.g. about.example.com ---> eTLD+1 is example.com and make the URL/reference absolute with urljoin
# relative paths are just ancor tags with hrefs to "/something"
def normalize_sub_page_link(href_value, base_url, crawled_registrable_domain):
    
    try:
        absolute_url = urljoin(base_url, href_value)
        url_parts = urlsplit(absolute_url)
    except Exception:
        return None

    scheme = url_parts.scheme.lower()
    if scheme not in ("http", "https"):
        return None

    hostname = (url_parts.hostname or "").lower()
    if not hostname:
        return None

    if registrable_domain(hostname) != crawled_registrable_domain:
        return None                       # different site -> not a child sub-page

    path = url_parts.path
    if not path:
        path = "/"
    elif len(path) > 1:
        path = path.rstrip("/")
        if not path:
            path = "/"

    netloc = hostname
    default_http_port = scheme == "http" and url_parts.port == 80
    default_https_port = scheme == "https" and url_parts.port == 443
    if url_parts.port and not default_http_port and not default_https_port:
        netloc = hostname + ":" + str(url_parts.port)

    return urlunsplit((scheme, netloc, path, url_parts.query, ""))   # keep query, drop fragment





def find_latest_snapshot(worker_directory):


    for point_name in latest_snapshot_points:
        candidate_path = os.path.join(worker_directory, point_name, "page.html")
        if os.path.exists(candidate_path):
            return candidate_path
        

    return None





# extract the domain from the directoru name e.g. example_com --> example.com
def read_page_url_and_domain(worker_directory):

    fallback_domain = os.path.basename(os.path.dirname(worker_directory))
    fallback_url = "https://" + fallback_domain
    metadata_path = os.path.join(worker_directory, "metadata.json")

    try:
        with open(metadata_path, encoding="utf-8") as file_handle:
            metadata = json.load(file_handle)
    except Exception:
        return fallback_url, fallback_domain

    page_url = metadata.get("url") or fallback_url
    domain_label = metadata.get("domain") or fallback_domain
    return page_url, domain_label



# Set of same-site sub-page URLs from this worker's latest settled snapshot -----> "None" when there is no snapshot to read (so it is excluded from the intersection)
def sub_pages_from_worker(worker_directory):
  
    snapshot_path = find_latest_snapshot(worker_directory)
    if not snapshot_path:
        return None

    page_url, _domain_label = read_page_url_and_domain(worker_directory)
    crawled_registrable_domain = registrable_domain(urlsplit(page_url).hostname)



    raw_html = read_text_file(snapshot_path)
    if not raw_html:
        return None

    base_url = page_url

    sub_page_links = set()
    for href_value in extract_href_values(raw_html):

        normalized_link = normalize_sub_page_link(href_value, base_url, crawled_registrable_domain)
        if normalized_link:
            sub_page_links.add(normalized_link)
        
    return sub_page_links



# Map each domain directory to (dotted domain label, [worker directories across all vantage points])
def collect_domain_workers(data_root):
    domain_worker_directories = defaultdict(list)
    domain_dotted_label = {}

    search_pattern = os.path.join(data_root, "**", "worker_*")
    for worker_directory in glob.glob(search_pattern, recursive=True):
        if not os.path.isdir(worker_directory):
            continue

        # print(worker_directory)

        domain_directory_name = os.path.basename(os.path.dirname(worker_directory))
        domain_worker_directories[domain_directory_name].append(worker_directory)
        if domain_directory_name not in domain_dotted_label:
            _page_url, domain_label = read_page_url_and_domain(worker_directory)
            domain_dotted_label[domain_directory_name] = domain_label



    return domain_worker_directories, domain_dotted_label






# defined the intersection between crawl output ---> common sub-pages across all captures
def intersect_link_sets(list_of_link_sets):
    
    common_links = None
    
    for link_set in list_of_link_sets:
        if common_links is None:
            common_links = set(link_set)
        else:
            common_links = common_links & link_set

    if common_links is None:
        return set()
    
    
    return common_links







def main():
    
    
    if len(sys.argv) > 1:
        requested_directory = sys.argv[1]
    
    else:
        requested_directory = "consistent_captures"

    data_root = resolve_data_root(requested_directory)
    
    if data_root is None:
        print("Directory not found: " + requested_directory)
        # The directory provided fin our case is the dir that contains the "consistent" captures from the first run
        # i.e. the 601 websites that all 6 serilaization points have captured HTML across all 27 workers and 3 regions
        print("Usage: python3 extract_common_subpages.py <directory> ")
        sys.exit(1)

    domain_worker_directories, domain_dotted_label = collect_domain_workers(data_root)

    common_sub_pages_by_domain = {}
    processed_count = 0
    total_domains = len(domain_worker_directories)



    for domain_directory_name in sorted(domain_worker_directories):
        worker_link_sets = []



        for worker_directory in domain_worker_directories[domain_directory_name]:
            worker_links = sub_pages_from_worker(worker_directory)
            if worker_links is not None:
                worker_link_sets.append(worker_links)

        if worker_link_sets:
            common_links = intersect_link_sets(worker_link_sets)
        else:
            common_links = set()


        domain_label = domain_dotted_label[domain_directory_name]
        sorted_common_links = sorted(common_links)
        
        common_sub_pages_by_domain[domain_label] = {
            "common_sub_page_count": len(list(set(sorted_common_links))), # just to be sure
            "common_sub_pages": list(set(sorted_common_links)),
        }

        processed_count += 1
        print("Processing " + str(processed_count) + "/" + str(total_domains) + ": " +domain_label + "  -> " + str(len(sorted_common_links)) + " common sub-pages (across " + str(len(worker_link_sets)) + " crawls)")


    output_name = "common_sub_pages_" + os.path.basename(data_root) + ".json"
    output_path = os.path.join(script_directory, output_name)
    with open(output_path, "w", encoding="utf-8") as file_handle:
        json.dump(common_sub_pages_by_domain, file_handle, ensure_ascii=False, indent=2)



    domains_with_common = sum(1 for value in common_sub_pages_by_domain.values() if value["common_sub_page_count"] > 0)


    print('==============================================================================')
    print("  domains: " + str(total_domains))
    # for some pages we get the HTML but it might contain GEO-blocking content and not the website's content itself (e.g. y2mate.nu is blocked in UK)
    print("  domains with >=1 common sub-page: " + str(domains_with_common))
    print('==============================================================================')





# :/
if __name__ == "__main__":
    main()
