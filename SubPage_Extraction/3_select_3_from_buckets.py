import os
import sys
import json
from collections import Counter


script_directory = os.path.dirname(os.path.abspath(__file__))

# buckets in strict priority order: fill from bucket 1 first, then 2, 3, 4, 5.
bucket_order = [
    ("bucket_1_og_article_and_article_url", 1),
    ("bucket_2_og_article", 2),
    ("bucket_3_article_url", 3),
    ("bucket_4_text_heavy", 4),
    ("bucket_5_other", 5),
]

sub_pages_per_domain = 3


def select_three_for_domain(a_domain_buckets):
    picks = []
    for bucket_name, bucket_number in bucket_order:
        for record in a_domain_buckets.get(bucket_name, []):
            picks.append({
                "url": record.get("url"),
                "reasons": record.get("reasons", []),
                "bucket": bucket_number,
            })
            if len(picks) >= sub_pages_per_domain:
                return picks
    return picks


def main():
    if len(sys.argv) > 1:
        input_path = sys.argv[1]
    else:
        input_path = os.path.join(script_directory, "per_bucket_URLs_w_reason.json")

    if not os.path.isfile(input_path):
        print("Input not found: " + input_path)
        sys.exit(1)

    with open(input_path, encoding="utf-8") as input_file:
        buckets_by_domain = json.load(input_file)

    selected_by_domain = {}
    short_by_domain = {}
    count_distribution = Counter()
    bucket_source_totals = Counter()

    for domain_label in sorted(buckets_by_domain):
        picks = select_three_for_domain(buckets_by_domain[domain_label])
        count_distribution[len(picks)] += 1
        if len(picks) == sub_pages_per_domain:
            selected_by_domain[domain_label] = picks
            for pick in picks:
                bucket_source_totals[pick["bucket"]] += 1
        else:
            short_by_domain[domain_label] = picks

    output_path = os.path.join(script_directory, "selected_3_subpages_from_buckets.json")
    with open(output_path, "w", encoding="utf-8") as output_file:
        json.dump(selected_by_domain, output_file, ensure_ascii=False, indent=2)

    short_path = os.path.join(script_directory, "domains_under_3_subpages.json")
    with open(short_path, "w", encoding="utf-8") as short_file:
        json.dump(short_by_domain, short_file, ensure_ascii=False, indent=2)

    total_domains = len(buckets_by_domain)
    print("==============================================================================")
    print("  domains total                 : " + str(total_domains))
    print("  domains with a full 3          : " + str(len(selected_by_domain)) +"  (" + str(round(100.0 * len(selected_by_domain) / total_domains)) + "%)")
    
    
    for count_of in [3, 2, 1, 0]:
        print("    got " + str(count_of) + " sub-pages: " + str(count_distribution[count_of]))


    print("  =================> of the picks in full-3 domains bucket distribution: ")
    for _bucket_name, bucket_number in bucket_order:
        print("    bucket " + str(bucket_number) + ": " + str(bucket_source_totals[bucket_number]))
    print("  output (full 3)   : " + output_path)
    print("  output (under 3)  : " + short_path)
    print("==============================================================================")


if __name__ == "__main__":
    main()
