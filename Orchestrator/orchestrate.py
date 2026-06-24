import csv
import json
import sys
import time
import threading
import subprocess


project = r"C:\Users\Administrator\Desktop\star-crawler-experiment"
path_to_crux = "../crux_latest/current.csv"
poll_seconds = 10
visits_per_domain = 10


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
         f"Administrator@{instance['ip']}", command],
        capture_output=True, text=True
    )


def scp(instance, local_path, remote_path):
    return subprocess.run(
        ["sshpass", "-p", instance["password"], "scp", "-o", "StrictHostKeyChecking=no",
         local_path, f"Administrator@{instance['ip']}:{remote_path}"],
        capture_output=True, text=True
    )


def submit_visit_to_instance(instance, domain, run_index):
    local_url_file = f"current_url_{instance['ip']}.txt"
    local_run_file = f"run_index_{instance['ip']}.txt"
    local_var_file = f"variation_{instance['ip']}.txt"
    with open(local_url_file, "w", newline="") as url_file:
        url_file.write(domain + "\r\n")
    with open(local_run_file, "w", newline="") as run_file:
        run_file.write(str(run_index) + "\r\n")
    with open(local_var_file, "w", newline="") as var_file:
        var_file.write(str(instance["variation"]) + "\r\n")

    scp(instance, local_url_file, f"{project}\\current_url.txt")
    scp(instance, local_run_file, f"{project}\\run_index.txt")
    scp(instance, local_var_file, f"{project}\\variation.txt")
    ssh(instance, f'del "{project}\\done.flag"')
    ssh(instance, "schtasks /run /tn StarCrawlBatch")
    print(f"  [{instance['ip']}] visit {run_index} (variation {instance['variation']}) triggered")


    


def instance_is_done(instance):
    result = ssh(instance, f'if exist "{project}\\done.flag" (echo DONE) else (echo RUNNING)')
    return "DONE" in result.stdout






def run_visit(domain, run_index):


    threads = []
    for instance in instances:
        thread = threading.Thread(target=submit_visit_to_instance, args=(instance, domain, run_index))
        thread.start()
        threads.append(thread)
    for thread in threads:
        thread.join()

    print(f"  all instances triggered for visit {run_index}, waiting for the barrier...")

    remaining = {instance["ip"] for instance in instances}
    while remaining:
        for instance in instances:
            if instance["ip"] in remaining and instance_is_done(instance):
                print(f"  [{instance['ip']}] visit {run_index} done")
                remaining.discard(instance["ip"])
        if remaining:
            time.sleep(poll_seconds)


def run_domain(domain, domain_index, total_domains):
    print(f"\n=== [{domain_index + 1}/{total_domains}] {domain} ===")
    # visits 1..N happen one at a time, each synchronized across all instances by the barrier,
    # so visit N runs at the same point in time on every box before any box moves to visit N+1
    for run_index in range(1, visits_per_domain + 1):
        run_visit(domain, run_index)
    print(f"=== {domain} complete ({visits_per_domain} synchronized visits) ===")








def main():



    if len(sys.argv) != 3:
        print("usage: python3 orchestrate.py <start_index> <end_index>")
        print("example: python3 orchestrate.py 0 10   (runs domains[0:10])")
        sys.exit(1)

    start_index = int(sys.argv[1])
    end_index = int(sys.argv[2])

    domains = load_domains(start_index, end_index)
    print(f"Loaded {len(domains)} domains (csv slice [{start_index}:{end_index}])")
    print(f"{visits_per_domain} synchronized visits per domain across {len(instances)} instances\n")

    for domain_index, domain in enumerate(domains):
        run_domain(domain, domain_index, len(domains))

    print("\nAll domains complete.")






if __name__ == "__main__":
    main()