import subprocess
import json
import time
import threading

PROJECT = r"C:\Users\Administrator\Desktop\star-crawler\windows_implementation"
POLL_SECONDS = 10

with open("instances.json") as instances_file:
    instances = json.load(instances_file)

with open("batches.json") as batches_file:
    batches = json.load(batches_file)


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


def submit_batch_to_instance(instance, batch_index, domains):
    local_batch_file = f"batch_{instance['ip']}.txt"
    with open(local_batch_file, "w") as batch_file:
        batch_file.write("\n".join(domains) + "\n")

    scp(instance, local_batch_file, f"{PROJECT}\\batch.txt")
    ssh(instance, f'del "{PROJECT}\\done.flag"')
    ssh(instance, "schtasks /run /tn StarCrawlBatch")
    print(f"  [{instance['ip']}] batch {batch_index + 1} triggered")


def instance_is_done(instance):
    result = ssh(instance, f'if exist "{PROJECT}\\done.flag" (echo DONE) else (echo RUNNING)')
    return "DONE" in result.stdout


def run_batch(batch_index, domains):
    print(f"\n=== Batch {batch_index + 1}: {domains} ===")

    threads = []
    for instance in instances:
        thread = threading.Thread(target=submit_batch_to_instance, args=(instance, batch_index, domains))
        thread.start()
        threads.append(thread)
    for thread in threads:
        thread.join()

    print("  all instances triggered, waiting for the barrier (all must finish)...")

    remaining = {instance["ip"] for instance in instances}
    while remaining:
        for instance in instances:
            if instance["ip"] in remaining and instance_is_done(instance):
                print(f"  [{instance['ip']}] done")
                remaining.discard(instance["ip"])
        if remaining:
            time.sleep(POLL_SECONDS)

    print(f"=== Batch {batch_index + 1} complete on all instances ===")


for batch_index, domains in enumerate(batches):
    run_batch(batch_index, domains)
