import os
import sys
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


script_directory = os.path.dirname(os.path.abspath(__file__))

bucket_keys = [
    "bucket_1_og_article_and_article_url",
    "bucket_2_og_article",
    "bucket_3_article_url",
    "bucket_4_text_heavy",
    "bucket_5_other",
]
bucket_short_labels = [
    "1: OG + URL",
    "2: OG only",
    "3: URL only",
    "4: text-heavy",
    "5: other",
]


def main():
    if len(sys.argv) > 1:
        input_path = sys.argv[1]
    else:
        input_path = os.path.join(script_directory, "subpage_buckets_consistent_captures_final.json")

    if not os.path.isfile(input_path):
        print("Input not found: " + input_path)
        sys.exit(1)

    with open(input_path, encoding="utf-8") as input_file:
        buckets_by_domain = json.load(input_file)

    total_domains = len(buckets_by_domain)
    url_counts_per_bucket = [0, 0, 0, 0, 0]
    domains_with_no_subpages = 0

    for domain_label in buckets_by_domain:
        domain_buckets = buckets_by_domain[domain_label]
        domain_total = 0
        for index, bucket_name in enumerate(bucket_keys):
            count = len(domain_buckets.get(bucket_name, []))
            url_counts_per_bucket[index] += count
            domain_total += count
        if domain_total == 0:
            domains_with_no_subpages += 1

    total_urls = sum(url_counts_per_bucket)

    print("total domains        : " + str(total_domains))
    print("total sub-page URLs  : " + str(total_urls))
    for label, count in zip(bucket_short_labels, url_counts_per_bucket):
        pct = 100.0 * count / total_urls if total_urls else 0
        print("  " + label + ": " + str(count) + "  (" + str(round(pct, 1)) + "%)")
    
    
    print("domains with NO common sub-pages: " + str(domains_with_no_subpages))

    # bar plot: 5 buckets URL count + 1 bar for domains with no common sub-pages
    bar_labels = bucket_short_labels + ["no common\nsub-pages\n(domains)"]
    bar_values = url_counts_per_bucket + [domains_with_no_subpages]
    bar_colors = ["#4C72B0", "#4C72B0", "#4C72B0", "#55A868", "#C44E52", "#8C8C8C"]

    figure, axis = plt.subplots(figsize=(10, 5.5))
    bars = axis.bar(bar_labels, bar_values, color=bar_colors)
    
    axis.set_ylabel("count")
    for bar, value in zip(bars, bar_values):
        axis.text(bar.get_x() + bar.get_width() / 2.0, value, str(value), ha="center", va="bottom", fontsize=9)
    
    
    
    axis.margins(y=0.12)
    plt.tight_layout()

    output_path = os.path.join(script_directory, "bucket_distribution.png")
    plt.savefig(output_path, dpi=140)
    plt.close()
    print("plot -> " + output_path)


if __name__ == "__main__":
    main()
