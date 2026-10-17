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

## v0.3.0 (V3, developer workflow)

- [x] Frontend gates: lint, typecheck, 53 UI tests (37 V1/V2 regression + 16 V3), production build
- [x] Rust gates: fmt, clippy `-D warnings`, 110 unit (67 V1/V2 + 43 V3) + 15 auth-flow + 5 job-flow tests
- [x] Generated workflow wrapper and archive stager executed for real in a sandbox (bash 3.2, python3)
- [x] Opt-in real OpenSSH tests incl. real sftp transfers through the app's master
- [x] `.app` builds (0.3.0); capabilities: default / job-mutations / file-mutations, no dialog permission for the webview
- [x] VS Code detection checked read-only against the real local install (Finder-like environment)
- [ ] **Approved ICF smoke test** (GPU smoke-test workflow with a tiny dataset; see the V3 report)
- [ ] Approved upload/download of a small file on ICF (SFTP subsystem enabled?)
- [ ] Open a real project in VS Code from the app
- [ ] Approved cancel test (still open from V2)
- [ ] Built `.app` clicked through by a person
