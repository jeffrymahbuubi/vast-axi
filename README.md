# vast-axi

Agent-ergonomic wrapper around the official [vast.ai CLI](https://github.com/vast-ai/vast-cli) (`vastai`), following the [AXI](https://github.com/kunchenguid/axi) principles: TOON output, minimal schemas, structured errors, no prompts, next-step hints.

## What vast-axi adds over `vastai`

- **Fewer tokens.** For 10 GPU offers, `vastai search offers --raw` returns 95 fields per offer and costs about 12,000 tokens. `vast-axi search --limit 10` costs about 400 (o200k tokenizer, measured live). `--full` brings back every field.
- **Errors an agent can act on.** Upstream reports auth failures with exit code 0. vast-axi maps them to structured errors with exit 1 and a fix hint, and an empty result says so instead of printing `[]`.
- **A spend guard.** `rent` refuses offers above your price cap. `--hours N` shows the estimated total and its share of your balance, and `rent` refuses (exit 2) when N hours of your current burn plus the new offer would cost more than your balance, unless you pass `--confirm`. Rentals are always on-demand, never interruptible.
- **A destroy timer that outlives your session.** `rent --max-hours N` schedules the destroy on vast.ai's servers, so the instance goes away even if your machine or agent session dies. Your API key never goes on the instance.
- **A job lifecycle.** `run` starts a detached job, `job` reports its state and log tail, and `finish --wait --fetch ... --destroy` destroys the instance only after every fetched file has arrived and is non-empty.
- **An upload secret guard.** `copy` refuses to upload files that look like keys or credentials unless you pass `--allow-secrets`.
- **Works on Windows.** Tested on Windows 11 and Linux, including Git Bash path handling.

## Requirements

- Node.js 20 or newer
- `vastai` 1.8.3, the tested version. Install it with `uv tool install vastai`, or point `VAST_AXI_BIN` at a project venv (`.venv/Scripts/vastai.exe`).
- A vast.ai API key, set with `vastai set api-key <key>` or `VAST_API_KEY`. vast-axi never reads or prints it.
- `ssh` and `scp` on PATH for `ssh --exec` and `copy`. rsync is not needed.

## Install

Each release has a prebuilt tarball attached. Install it straight from the release; no build runs on install:

```bash
npm i -g https://github.com/jeffrymahbuubi/vast-axi/releases/download/v0.2.0/vast-axi-0.2.0.tgz
```

`vast-axi update` installs the newest release (it uses the `gh` CLI, logged in). Add `--pre` to include pre-releases.

`npm i -g github:jeffrymahbuubi/vast-axi#<tag>` does not work. npm's global git install never installs the build tools in its clone.

Development, from this folder:

```bash
pnpm install
pnpm dev -- search --limit 5
```

## Commands

| Command | What it does |
|---|---|
| `vast-axi` | Dashboard: balance, instances, burn per hour, 24h projection, runway in hours, idle flags |
| `search [--hours N] [--sort value\|flops] [--precision fp32\|tf32\|fp16]` | Cheapest offers, 7 fields, sorted by price; `--full` for every field. `--hours N` adds `max_h`, `est_cost` and `pct_balance`, and hides offers whose contract ends within N hours. `--sort value` ranks by vast.ai's DLPerf per $/hr, and `--sort flops` by TFLOPS per $/hr. `--precision` ranks by a static table of vendor datasheet peak TFLOPS (dense) per $/hr |
| `rent <offer> --image <img> [--hours N] [--max-hours N] [--pip "pkgs"] [--onstart file]` | Rent an on-demand instance behind the spend guard. `--max-hours N` (2 to 23) has vast.ai destroy it on a server-side timer. `--pip` and `--onstart` install and set up at boot as the job `onstart`, and `status --wait` waits for it |
| `status <id> [--wait]` | Instance state; `--wait` stops on terminal states |
| `ssh <id> [--exec -- <cmd>]` | Print the ssh command, or run one remote command |
| `logs <id>` | Container logs, truncated with size hints (for a program started with `run`, use `job`) |
| `stop <id>` / `destroy <id>` | Idempotent; destroying an already destroyed id is a no-op |
| `copy <src> <dst> [--allow-secrets]` | scp for local and instance transfers, `vastai copy` between remotes. Uploads that contain secrets are refused |
| `run <id> [--cwd] [--log] [--name] -- <cmd>` | Start a detached job (nohup, setsid); the log ends with a `__VAST_AXI_EXIT__` line |
| `job <id> [--name] [--tail] [--list]` | Job state (`running`, `finished`, `failed`, `lost`), exit code, elapsed time, log tail |
| `finish <id> --wait --fetch <remote>:<local> [--destroy]` | Wait for the exit line, fetch and verify results, destroy only if every fetch verified and the job exited 0 |
| `raw <vastai args>` | Any other vastai command, rendered as TOON |
| `setup hooks` / `setup key <key>` | Opt-in Claude Code SessionStart hook; store the API key |
| `update [--check]` | Update from the latest GitHub release |

Run `vast-axi <command> --help` for the flags of each command.

## Spend guard

`rent` refuses with exit 2 when the offer exceeds `maxDph` (default 1.00 USD/hr) or when current burn plus the offer exceeds `maxBurn` (default 2x `maxDph`). `--confirm` overrides both. If current burn cannot be read, `rent` refuses and `--confirm` does not override it.

With `--hours N`, `rent` also refuses (`OVER_BALANCE`) when N x (current burn + offer price) is more than the account balance. `--confirm` overrides that. If the balance cannot be read, it refuses and `--confirm` does not override it.

`rent` always creates an on-demand instance and prints `type: on-demand`. It never passes a bid price, so it never creates an interruptible instance.

## Destroy timer (`--max-hours`)

`rent --max-hours N` (N from 2 to 23) creates a vast.ai scheduled job that destroys the instance on vast.ai's servers. It runs even when this machine is off or the agent session has ended. The API key never goes onto the instance.

- The job is a DAILY job set to the destroy hour (UTC). The destroy time is rounded down to the hour, so the rental never lasts longer than N hours; it can be up to 59 minutes shorter. The output prints `destroy_at` and `runs_for_h`. If the delete fails, vast.ai runs the job again 24 hours later.
- `rent` reads the job back after creating it. If the job is missing or doesn't match, or it cannot be created, the new instance is destroyed straight away and `rent` exits 1.
- N is capped at 23 because a daily job cannot be set further ahead. For longer runs, end with `vast-axi finish <id> --wait --fetch <remote>:<local> --destroy`.
- If the offer's rental contract ends before `destroy_at`, `rent` refuses with exit 2 (`--confirm` overrides). vast.ai stops an instance at contract end, and a stopped instance still bills storage.
- `destroy` and `finish --destroy` also delete the timer. `status <id>` and the dashboard show `destroy_at`.
- `--max-hours N` implies `--hours N` for the balance check.
- **Legacy timers:** v0.1.4 to v0.1.6 created HOURLY jobs. vast.ai fires those at the next top of the hour, ignoring the planned time. `status` and the dashboard flag them as `LEGACY` and print the command to delete them.

Set the limits in `~/.config/vast-axi/config.json` (`maxDph`, `maxBurn`, `idleMinutes`) or with `VAST_AXI_MAX_DPH` and `VAST_AXI_MAX_BURN`.

## Setup at boot (`--pip`, `--onstart`)

- `--pip "pkg pkg==1.2"` runs `python3 -m pip install` at boot. `--onstart setup.sh` then runs the script. Both run as one detached job named `onstart`, using the same exit-line mechanism as `run`. `vast-axi job <id> --name onstart` shows its log.
- `status <id> --wait` keeps waiting until the onstart job finishes. A failed onstart exits 1 with the log tail and keeps the instance.
- vast.ai stores the onstart text on the instance record, where the host can read it. Scripts containing key-shaped strings (`hf_…`, `sk-…`, `ghp_…`, `AKIA…`, private-key blocks) are refused unless you pass `--allow-secrets`. The text is limited to 4,048 characters, which leaves about 1.7 KB of script (1.5 KB with `--pip`). For longer setup, `copy` a script and start it with `run`.
- vast.ai re-runs onstart on every container start, so `status` reports the latest boot.

## Upload guard

`copy local:<path> C.<id>:<path>` checks the upload before scp starts. Files or folders named `.env`/`.env.*` (examples, samples and templates are allowed), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`/`id_ed25519`-style private keys, `.git-credentials`, `.netrc`, `.pypirc`, `.npmrc`, `credentials.json`, `kaggle.json`, `.aws/credentials`, anything under `.ssh/`, or a vast.ai key file are refused with exit 2. So are text files containing key-shaped strings. `--allow-secrets` uploads them anyway and lists them. Downloads are not checked.

## Notes for agents

- `gpu_util` comes from vast.ai and lags real GPU usage by several minutes; about 10 minutes has been observed. The API gives no timestamp for it.
- The dashboard's `idle` flag is therefore `no`, `unknown` or `likely`, never a definite yes.
- Before stopping or destroying anything, run `vast-axi status <id> --live`, which reads `nvidia-smi` over ssh. Or run `vast-axi ssh <id> --exec -- nvidia-smi`.
- `destroy` deletes data and `stop` keeps billing for disk. Copy results out first.
- For long training jobs, use `run`, then `job`, then `finish`. A job is finished only when its log has the exit line with that run's token, never because of echoed command text.
- `finish --wait` can run for hours, longer than most agent tool timeouts. Run it in the background, or call `finish` without `--wait` in a loop. It prints one progress line per poll to stderr; stdout holds only the result.
- `job` shows the tail of the job's log, so the program has to write to stdout while it runs. Run Python unbuffered (`python -u`). Notebook runners print nothing until they finish unless told to stream, e.g. `papermill in.ipynb out.ipynb --log-output`.
- `status` shows `ssh_direct`, the endpoint `ssh` and `copy` connect to, next to vast.ai's proxy endpoint. Use the direct one for a manual `ssh -L` tunnel.
- `rent` prices the offer for the `--disk` you asked for and prints `priced_for_disk_gb`. `search` lists prices for vast.ai's default disk, so the two can differ by a little.
- `finish --destroy` keeps the instance when the job failed or was lost, or when any fetched file is missing or its size differs from the remote copy. The output says why.

## Testing

- `pnpm test` replays recorded vastai output through `tests/helpers/fake-vastai.cjs`. It needs no network and no API key.
- `VAST_AXI_LIVE=1 pnpm test:live` runs the full lifecycle against the real service: it rents the cheapest reliable offer under 0.30 USD/hr, then destroys it. A run costs a few cents.
