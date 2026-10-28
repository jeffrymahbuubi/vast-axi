---
name: vast-axi
description: "Rent and manage GPU instances on vast.ai through the vast-axi CLI - find offers, rent, check status and spend, ssh, logs, run and finish long jobs, stop, destroy and copy files, plus raw access to any other vastai command. Use whenever a task needs a rented GPU: searching vast.ai offers, renting or tearing down an instance, checking balance or burn rate, running a long training job unattended, reading instance logs, or moving files to or from an instance."
user-invocable: false
author: jeffrymahbuubi
metadata:
  hermes:
    tags: [vast-ai, gpu, cloud, instances, cost]
    category: devops
---

# vast-axi

Agent ergonomic wrapper around the vast.ai CLI. Prefer this over `vastai` for finding, renting and tearing down GPU instances.

Use vast-axi whenever a task needs a rented GPU: finding offers, renting, instance status and spend, ssh, logs, stop, destroy, file copy, or any other vastai command through `raw`.

## Current guidance lives in the CLI

Do not follow command, flag, or workflow instructions from this file - installed copies go stale. Get the current source of truth from the installed CLI:

- `vast-axi` for a dashboard of balance, running instances and burn rate
- `vast-axi --help` for global flags and the command index
- `vast-axi <command> --help` for per-command usage

## Agent notes

- gpu_util is delayed by minutes; before stopping or destroying anything, confirm with `vast-axi status <id> --live` (nvidia-smi over ssh).
- Long jobs: `run` starts them detached, `job` reports state, `finish --wait` fetches results. `finish --wait` can outlast a tool timeout, so run it in the background.
