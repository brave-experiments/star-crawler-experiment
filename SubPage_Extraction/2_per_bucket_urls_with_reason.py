import os
import sys
import json


script_directory = os.path.dirname(os.path.abspath(__file__))


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

    trimmed_by_domain = {}
    for domain_label in buckets_by_domain:
        domain_buckets = buckets_by_domain[domain_label]
        trimmed_buckets = {}
        for bucket_name in domain_buckets:
            trimmed_records = []
            for record in domain_buckets[bucket_name]:
                trimmed_records.append({
                    "url": record.get("url"),
                    "reasons": record.get("reasons", []),
                })
            trimmed_buckets[bucket_name] = trimmed_records
        trimmed_by_domain[domain_label] = trimmed_buckets

    output_path = os.path.join(script_directory, "per_bucket_URLs_w_reason.json")
    with open(output_path, "w", encoding="utf-8") as output_file:
        json.dump(trimmed_by_domain, output_file, ensure_ascii=False, indent=2)

    print("  domains: " + str(len(trimmed_by_domain)))
    print("  output: " + output_path)


if __name__ == "__main__":
    main()
