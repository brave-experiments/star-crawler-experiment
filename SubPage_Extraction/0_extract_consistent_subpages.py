import os
import sys
import json
import glob
from urllib.parse import urljoin, urlsplit, urlunsplit
from collections import defaultdict

import tldextract
from bs4 import BeautifulSoup


script_directory = os.path.dirname(os.path.abspath(__file__))
repo_root_directory = os.path.dirname(script_directory)

# the fully-settled HTML snapshot per worker (fall back to networkidle2 when networkidle0
# was never reached) ----> we extract the sub-pages from these documents (ie the fukly settled HTML)
settled_snapshot_points = ["networkidle0", "networkidle2"]



# strip the query string so a link and the same link carrying a ?tracking tag collapse to
# one sub-page
strip_query_string = True

# EXCKYDE URLS THAT DIRECTLY POINT TO DOCUMENT FILES AND NOT HTML 
# Preprocessing step ---> then we also check the content type the request (wget ) returns
non_page_extensions = (
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".csv", ".txt", ".rtf", ".odt",
    ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico", ".bmp", ".tif", ".tiff",
    ".mp4", ".mp3", ".avi", ".mov", ".wmv", ".flv", ".mkv", ".webm", ".wav", ".ogg", ".m4a",
    ".zip", ".rar", ".gz", ".tar", ".7z", ".bz2",
    ".css", ".js", ".json", ".xml", ".rss", ".atom",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".exe", ".dmg", ".apk", ".msi", ".deb", ".rpm",
)


tld_extractor = tldextract.TLDExtract()
registrable_domain_cache = {}

# ==================================== HELPERS =====================================================
def registrable_domain(a_hostname_value):

    a_hostname_value = (a_hostname_value or "").lower()

    if a_hostname_value in registrable_domain_cache:
        return registrable_domain_cache[a_hostname_value]


    registered = tld_extractor(a_hostname_value).registered_domain
    registrable_domain_cache[a_hostname_value] = registered



    return registered




def read_text_file(a_file_path):

    try:
        with open(a_file_path, encoding="utf-8", errors="ignore") as file_handle:
    
            return file_handle.read()
    
    except Exception:
        return ""


def find_settled_snapshot(a_worker_directory):

    for point_name in settled_snapshot_points:
        candidate_path = os.path.join(a_worker_directory, point_name, "page.html")
        if os.path.exists(candidate_path):
            return candidate_path


    return None






def read_page_url_and_domain(a_worker_directory):

    fallback_domain = os.path.basename(os.path.dirname(a_worker_directory))
    fallback_url = "https://" + fallback_domain
    metadata_path = os.path.join(a_worker_directory, "metadata.json")

    try:
        with open(metadata_path, encoding="utf-8") as file_handle:
            metadata = json.load(file_handle)

    except Exception:

        return fallback_url, fallback_domain


    page_url = metadata.get("url") or fallback_url
    domain_label = metadata.get("domain") or fallback_domain

    return page_url, domain_label
# ====================================================================================================




# Parse the HTML doc for every same-site child link on the page INCLUDING:
#   1. Absolute
#   2. Same registrable domain, 
#   3. ANY depth URL (we dont care about 1-2 levels as inititally)
#
# with : homepage excluded, fragment dropped, query optionally stripped. 
# ------> raw "all consistent sub-pages" base that the final design will build on.
def all_subpage_links(a_raw_html, a_page_url, a_crawled_registrable_domain):

    soup = BeautifulSoup(a_raw_html, "lxml")
    sub_page_links = set()
    for anchor_tag in soup.find_all("a", href=True):
        href_value = anchor_tag["href"].strip()
        if not href_value:
            continue
        try:
            url_parts = urlsplit(urljoin(a_page_url, href_value))
        except Exception:
            continue

        scheme = url_parts.scheme.lower()
        if scheme not in ("http", "https"):
            continue

        hostname = (url_parts.hostname or "").lower()
        
        if not hostname:
            continue

        if registrable_domain(hostname) != a_crawled_registrable_domain:
            continue

        path = url_parts.path
        path_segments = [segment for segment in path.split("/") if segment]
        if len(path_segments) < 1:            # homepage (depth 0) excluded
            continue

        # drop links that point at a file (pdf/png/zip/...), not a web page
        if path_segments[-1].lower().endswith(non_page_extensions):
            continue

        normalized_path = "/" + "/".join(path_segments)
        query = "" if strip_query_string else url_parts.query
        sub_page_links.add(urlunsplit((scheme, hostname, normalized_path, query, "")))
    return sub_page_links


# set of same-site sub-page links from this worker's settled snapshot, or None when there
# is no readable snapshot (so the worker is excluded from the intersection).
def subpage_links_from_worker(a_worker_directory):

    snapshot_path = find_settled_snapshot(a_worker_directory)
    if not snapshot_path:
        return None

    page_url, _domain_label = read_page_url_and_domain(a_worker_directory)
    crawled_registrable_domain = registrable_domain(urlsplit(page_url).hostname)
    raw_html = read_text_file(snapshot_path)


    if not raw_html:
        return None


    return all_subpage_links(raw_html, page_url, crawled_registrable_domain)


# map each domain to (dotted label, [worker directories across all boxes/regions])
# Our dataset is scattered in multiple sub-directories (region/worker/output/websites etc)
# so this way we group them by worker folder ---> intersection spans every crawl of that domain
def collect_domain_workers(a_data_root):


    domain_worker_directories = defaultdict(list)
    domain_dotted_label = {}
    
    
    for worker_directory in glob.glob(os.path.join(a_data_root, "**", "worker_*"), recursive=True):
        if not os.path.isdir(worker_directory):
            continue
    
    
        domain_directory_name = os.path.basename(os.path.dirname(worker_directory))
        domain_worker_directories[domain_directory_name].append(worker_directory)
    
        if domain_directory_name not in domain_dotted_label:
            _page_url, domain_label = read_page_url_and_domain(worker_directory)
            domain_dotted_label[domain_directory_name] = domain_label
    
    
    return domain_worker_directories, domain_dotted_label


# links present in EVERY worker that produced a snapshot (seen by all users of that domain)
def intersect_link_sets(a_list_of_link_sets):
    common_links = None
    for link_set in a_list_of_link_sets:
        if common_links is None:
            common_links = set(link_set)
        else:
            common_links = common_links & link_set
    return common_links or set()


def main():
    if len(sys.argv) > 1:
        requested_directory = sys.argv[1]
    else:
        requested_directory = os.path.join("Final_Dataset_Collected_Regional", "consistent_captures_final")

    if os.path.isdir(requested_directory):
        data_root = os.path.abspath(requested_directory)

    else:
        joined_directory = os.path.join(repo_root_directory, requested_directory)
        if os.path.isdir(joined_directory):
            data_root = joined_directory
        else:
            print("Directory not found: " + requested_directory)
            sys.exit(1)

    domain_worker_directories, domain_dotted_label = collect_domain_workers(data_root)


    consistent_sub_pages_by_domain = {}
    processed_count = 0
    total_domains = len(domain_worker_directories)

    for domain_directory_name in sorted(domain_worker_directories):
        worker_link_sets = []
        for worker_directory in domain_worker_directories[domain_directory_name]:
            worker_links = subpage_links_from_worker(worker_directory)
            if worker_links is not None:
                worker_link_sets.append(worker_links)

        if worker_link_sets:
            common_links = intersect_link_sets(worker_link_sets)
        else:
            common_links = set()

        domain_label = domain_dotted_label[domain_directory_name]
        consistent_sub_pages_by_domain[domain_label] = sorted(common_links)

        processed_count += 1
        print("Processing " + str(processed_count) + "/" + str(total_domains) + ": "
                + domain_label + "  -> " + str(len(common_links))
                + " consistent sub-pages (across " + str(len(worker_link_sets)) + " workers)")

    output_path = os.path.join(script_directory, "consistent_subpages_" + os.path.basename(data_root) + ".json")


    with open(output_path, "w", encoding="utf-8") as file_handle:
        json.dump(consistent_sub_pages_by_domain, file_handle, ensure_ascii=False, indent=2)



    domains_with_any = sum(1 for links in consistent_sub_pages_by_domain.values() if links)
    print("==============================================================================")
    print("  domains: " + str(total_domains))
    print("  domains with >=1 consistent sub-page: " + str(domains_with_any))
    print("  output: " + output_path)
    print("==============================================================================")


if __name__ == "__main__":
    main()









'''

For an example of 9 crawls we have instances like:

set_A  us_1/worker_0 → {/world, /sports, /2026/07/18/heatwave-hits-europe, /about, /us-deal}
set_B  us_2/worker_0 → {/world, /sports, /2026/07/18/heatwave-hits-europe, /about, /us-deal}
set_C  us_3/worker_0 → {/world, /sports, /2026/07/18/heatwave-hits-europe, /about}
set_D  uk_1/worker_0 → {/world, /sports, /2026/07/18/heatwave-hits-europe, /about, /uk-edition}
set_E  uk_2/worker_0 → {/world, /sports, /2026/07/18/heatwave-hits-europe, /about, /uk-edition}
set_F  uk_3/worker_0 → {/world, /sports, /2026/07/18/heatwave-hits-europe, /about}
set_G  jp_1/worker_0 → {/world, /sports, /2026/07/18/heatwave-hits-europe, /about, /jp-news}
set_H  jp_2/worker_0 → {/world, /sports, /2026/07/18/heatwave-hits-europe, /about, /jp-news}
set_I  jp_3/worker_0 → {/world, /sports, /2026/07/18/heatwave-hits-europe, /about}



So  the overall intersection ie that links that would be included int the final output are:
[/world, /sports, /2026/07/18/heatwave-hits-europe, /about]

THis is what ALL users browsing this website see (common links)

'''