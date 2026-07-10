import csv
import os
import json
import sys
import time
import threading
import subprocess


project = r"C:\Users\Administrator\Desktop\star-crawler-experiment\windows_implementation"
path_to_crux = '/home/pbekos/star-crawler-aggreate/Error_Analysis_Pipeline/rerun_110_flaky.csv' #still_failing_after_r1.csv' #rerun_other_domains.csv' #"../crux_latest/current.csv"
# path_to_crux = "../crux_latest/demo_run.csv"
poll_seconds = 10

# workers launched PER BOX (each an independent crawl of the url). Shipped to every box as
# worker_count.txt so run_batch.ps1 reads it instead of hardcoding 3. Set to 1 to remove
# same-box contention. Total crawls per domain = len(instances) * worker_count.
worker_count = 1


def load_domains(start_index, end_index):
    domains = []
    with open(path_to_crux, newline="", encoding="utf-8") as crux_file:
        reader = csv.reader(crux_file)
        next(reader, None)  # skip the "origin,rank" header
        for row in reader:
            if not row:
                continue
            domain = row[0].replace("https://", "").replace("http://", "").strip()
            if domain:
                domains.append(domain)
    return domains[start_index:end_index]


with open("instances.json") as instances_file:
    instances = json.load(instances_file)


def ssh(instance, command):
    return subprocess.run(
        ["sshpass", "-p", instance["password"], "ssh", "-o", "StrictHostKeyChecking=no",
         "-o", "ConnectTimeout=10",
         f"Administrator@{instance['ip']}", command],
        capture_output=True, text=True
    )


def scp(instance, local_path, remote_path):
    return subprocess.run(
        ["sshpass", "-p", instance["password"], "scp", "-o", "StrictHostKeyChecking=no",
         "-o", "ConnectTimeout=10",
         local_path, f"Administrator@{instance['ip']}:{remote_path}"],
        capture_output=True, text=True
    )


def submit_domain_to_instance(instance, domain):
    # ship the single target url, this box's variation, and the worker count, clear the old flag,
    # trigger the task. the task runs run_batch.ps1, which launches worker_count browsers in parallel.
    local_url_file = f"current_url_{instance['ip']}.txt"
    local_var_file = f"variation_{instance['ip']}.txt"
    local_wc_file = f"worker_count_{instance['ip']}.txt"
    with open(local_url_file, "w", newline="") as url_file:
        url_file.write(domain + "\r\n")
    with open(local_var_file, "w", newline="") as var_file:
        var_file.write(str(instance["variation"]) + "\r\n")
    with open(local_wc_file, "w", newline="") as wc_file:
        wc_file.write(str(worker_count) + "\r\n")

    scp(instance, local_url_file, f"{project}\\current_url.txt")
    scp(instance, local_var_file, f"{project}\\variation.txt")
    scp(instance, local_wc_file, f"{project}\\worker_count.txt")
    ssh(instance, f'del "{project}\\done.flag"')
    ssh(instance, "schtasks /run /tn StarCrawlBatch")

    for scratch_file in (local_url_file, local_var_file, local_wc_file):
        os.remove(scratch_file)

    print(f"  [{instance['ip']}] variation {instance['variation']} triggered ({worker_count} worker(s))")


def instance_is_done(instance):
    result = ssh(instance, f'if exist "{project}\\done.flag" (echo DONE) else (echo RUNNING)')
    return "DONE" in result.stdout


def run_domain(domain, domain_index, total_domains):
    print(f"\n=== [{domain_index + 1}/{total_domains}] {domain} ===")

    total_crawls = len(instances) * worker_count

    # fire all instances near-simultaneously (one thread each). each box launches its worker_count
    # workers on this url, so the fleet runs len(instances) x worker_count crawls at the same time.
    threads = []
    for instance in instances:
        thread = threading.Thread(target=submit_domain_to_instance, args=(instance, domain))
        thread.start()
        threads.append(thread)
    for thread in threads:
        thread.join()

    print(f"  all instances triggered, waiting for the barrier "
          f"({len(instances)} boxes, {worker_count} worker(s) each)...")

    # barrier: an instance's done.flag is written only after ITS workers all finish. so all flags present
    # means all crawls are complete. only then do we return and let the next domain start.
    remaining = {instance["ip"] for instance in instances}
    while remaining:
        for instance in instances:
            if instance["ip"] in remaining and instance_is_done(instance):
                print(f"  [{instance['ip']}] done ({worker_count} worker(s) complete)")
                remaining.discard(instance["ip"])
        if remaining:
            time.sleep(poll_seconds)

    print(f"=== {domain} complete ({total_crawls} synchronized crawls) ===")


def main():
    if len(sys.argv) != 3:
        print("usage: python3 orchestrate_3x3.py <start_index> <end_index>")
        print("example: python3 orchestrate_3x3.py 0 10   (runs domains[0:10])")
        sys.exit(1)

    start_index = int(sys.argv[1])
    end_index = int(sys.argv[2])

    domains = load_domains(start_index, end_index)
    print(f"Loaded {len(domains)} domains (csv slice [{start_index}:{end_index}])")
    print(f"{len(instances)} instances, {worker_count} worker(s) each = "
          f"{len(instances) * worker_count} crawls per domain\n")

    for domain_index, domain in enumerate(domains):
        run_domain(domain, domain_index, len(domains))

    print("\nAll domains complete.")


if __name__ == "__main__":
    main()