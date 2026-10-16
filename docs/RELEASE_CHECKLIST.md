# Release checklist

## v0.1.0 (V1, local development release)

- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`
- [x] `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`
- [x] Opt-in: `cargo test --test real_openssh -- --ignored` (real OpenSSH, local sshd)
- [x] Opt-in: `cargo test --lib keychain_roundtrip -- --ignored`
- [x] `pnpm tauri build` produces `ICF Control Center.app`; bundled binary's askpass mode fails closed
- [ ] Built `.app` launched and clicked through by a person (demo + real connect)
- [ ] Manual read-only ICF acceptance (needs explicit consent): connect via gateway, verify both host
      keys out-of-band, view inventory, observe ≈1 inventory request/min for 10 min, minimise → 0,
      disconnect → no `ssh` processes left (`pgrep -fl icfcc`)
- [ ] Save scrubbed real `scontrol` output as a fixture; re-run parser tests
- [ ] Confirm policy on storing university passwords in the Keychain
- Not done: signing with a Developer ID / notarization (not needed for local use)

## v0.2.0 (V2, jobs)

- [x] Frontend gates: lint, typecheck, 31 UI tests (19 V1 regression + 12 V2), production build
- [x] Rust gates: fmt, clippy `-D warnings`, 63 unit + 13 auth-flow + 5 job-flow tests
- [x] Real-shell execution of generated submit/cancel/list/log scripts with stub scheduler binaries
- [x] Opt-in real OpenSSH test re-run (V1 regression)
- [x] `.app` builds
- [x] **One approved on-cluster smoke test** — job 3680123 on 2026-10-16, COMPLETED, log read in-app (Teaching, 1 GPU of the smallest type, 2 CPUs, 4 GB, 5 min,
      a script that prints `hostname` and `nvidia-smi -L` and exits): submit → see Pending/Running →
      read stdout → Completed. Optionally a second approved job to test Cancel.
- [x] UI polish after the smoke test: learned partition eligibility, dismissible receipts, one time
      format, compact GPU type list, relative working directory, one Refresh per screen
- [ ] Approved cancel test (second job, e.g. `sleep 240`)
- [ ] Capture scrubbed real `squeue`/`sacct`/`scontrol show job` output as fixtures
- [x] Smoke-test findings fixed (tests added; awaiting live re-check): job detail shows `Partition` as `Teaching AllocNode:Sid=…` (kv parser rejects
      `:` in keys); RAM shown as `—`; H200/MIG allocation still Unknown (`GresUsed` likely needs `scontrol -d`)

## V3 backlog (not started)

1. `projects_open_in_vscode`: discover `code` CLI, `code --remote ssh-remote+icf <validated path>`.
2. `projects_list_interpreters`: list `bin/python` under allowed project paths; optional `.vscode/settings.json` with consent.
3. Dataset staging plan: single archive → per-job `/disk/scratch/<UUN>/<jobid>` inside the job, `trap` copy-back, safe cleanup.
4. "Run selected script as batch job" reusing the V2 wizard and preview.
5. Optional local SQLite job history with bounded retention.
