import csv
import json

path_t0_crux = '../crux_latest/current.csv'
batches_path = 'batches.json'
num_of_doms = 1000
batch_size = 4

domains = []
with open(path_t0_crux, newline='', encoding='utf-8') as crux_file:
    reader = csv.reader(crux_file)
    next(reader, None)  # skip the "origin,rank" header
    for row in reader:
        if not row:
            continue
        domain = row[0].replace('https://', '').replace('http://', '').strip()
        if domain:
            domains.append(domain)
        if len(domains) >= num_of_doms:
            break

batches = [domains[start:start + batch_size] for start in range(0, len(domains), batch_size)]

with open(batches_path, 'w', encoding='utf-8') as output_file:
    json.dump(batches, output_file, indent=2)
    output_file.write('\n')

print(f'Read {len(domains)} domains, wrote {len(batches)} batches to {batches_path}')