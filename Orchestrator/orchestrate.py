import csv
import os
import json
import sys
import time
import threading
import subprocess


project = r"C:\Users\Administrator\Desktop\star-crawler-experiment\windows_implementation"
path_to_crux = "../crux_latest/current.csv"
# path_to_crux = "../crux_latest/demo_run.csv"
poll_seconds = 10


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
    # ship the single target url and this box's variation, clear the old flag, trigger the task.
    # the task runs run_batch.ps1, which launches 3 workers (3 browsers) on this url in parallel.
    local_url_file = f"current_url_{instance['ip']}.txt"
    local_var_file = f"variation_{instance['ip']}.txt"
    with open(local_url_file, "w", newline="") as url_file:
        url_file.write(domain + "\r\n")
    with open(local_var_file, "w", newline="") as var_file:
        var_file.write(str(instance["variation"]) + "\r\n")

    scp(instance, local_url_file, f"{project}\\current_url.txt")
    scp(instance, local_var_file, f"{project}\\variation.txt")
    ssh(instance, f'del "{project}\\done.flag"')
    ssh(instance, "schtasks /run /tn StarCrawlBatch")

    for scratch_file in (local_url_file, local_var_file):
        os.remove(scratch_file)

    print(f"  [{instance['ip']}] variation {instance['variation']} triggered (3 workers)")


def instance_is_done(instance):
    result = ssh(instance, f'if exist "{project}\\done.flag" (echo DONE) else (echo RUNNING)')
    return "DONE" in result.stdout


def run_domain(domain, domain_index, total_domains):
    print(f"\n=== [{domain_index + 1}/{total_domains}] {domain} ===")

    # fire all instances near-simultaneously (one thread each). each box launches its 3 workers on this url,
    # so the whole fleet runs 9 boxes x 3 workers = 27 crawls of this url at the same time.
    threads = []
    for instance in instances:
        thread = threading.Thread(target=submit_domain_to_instance, args=(instance, domain))
        thread.start()
        threads.append(thread)
    for thread in threads:
        thread.join()

    print("  all instances triggered, waiting for the barrier (all 9 boxes, all 3 workers each)...")

    # barrier: an instance's done.flag is written only after ITS 3 workers all finish. so all flags present
    # means all 27 crawls are complete. only then do we return and let the next domain start.
    remaining = {instance["ip"] for instance in instances}
    while remaining:
        for instance in instances:
            if instance["ip"] in remaining and instance_is_done(instance):
                print(f"  [{instance['ip']}] done (3 workers complete)")
                remaining.discard(instance["ip"])
        if remaining:
            time.sleep(poll_seconds)

    print(f"=== {domain} complete (27 synchronized crawls) ===")


def main():
    if len(sys.argv) != 3:
        print("usage: python3 orchestrate_3x3.py <start_index> <end_index>")
        print("example: python3 orchestrate_3x3.py 0 10   (runs domains[0:10])")
        sys.exit(1)

    start_index = int(sys.argv[1])
    end_index = int(sys.argv[2])

    domains = load_domains(start_index, end_index)
    print(f"Loaded {len(domains)} domains (csv slice [{start_index}:{end_index}])")
    print(f"{len(instances)} instances, 3 workers each = {len(instances) * 3} crawls per domain\n")

    for domain_index, domain in enumerate(domains):
        run_domain(domain, domain_index, len(domains))

    print("\nAll domains complete.")


if __name__ == "__main__":
    main()