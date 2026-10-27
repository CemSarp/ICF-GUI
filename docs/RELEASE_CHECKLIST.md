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

## v0.4.1 (housekeeping: repository layout, ui/logic split, version label, clearer Projects/Settings)

- [x] Frontend gates: lint (incl. ui/logic boundary), typecheck, 71 UI tests, production build
- [x] Rust gates on macos-14 CI: fmt, clippy `-D warnings`, tests (backend logic unchanged since 0.4.0; only paths moved)
- [x] Behaviour unchanged: 26 preview screens and 38 interaction screenshots pixel-identical to 0.4.0
      (before the Projects/Settings redesign, which changes only the Python environment, VS Code and
      CUDA toolchain sections)
- [x] Versions agree: `frontend/package.json`, `backend/Cargo.toml` (+ `Cargo.lock`), `backend/tauri.conf.json`
- [x] Merge PR #2, then tag `v0.4.1` on `main` and push the tag (re-cut on d713bc0 with the
      Projects/Settings redesign; the first draft was never published)
- [x] Release workflow green: `.app` built on macos-14, ad-hoc signed, `codesign --verify` passes,
      zip + SHA-256 attached to the draft release
- [x] Downloaded zip opens on an Apple Silicon Mac; sidebar shows **Version 0.4.1**; demo data works
      (Overview, New job, Settings incl. VS Code/toolchains, light and dark)
- [ ] A real sign-in still works with the 0.4.1 build
- [x] Publish the draft release

## v0.5.0 (Notebooks tab, interactive kernels, CUDA/C++/C cells, Run on GPU in the editor; ADR-031)

- [x] Frontend gates: lint (incl. ui/logic boundary), typecheck, 89 UI tests, production build
      (93 after the late fixes: number fields, delete, folding cards)
- [x] Rust: fmt, clippy `-D warnings` and tests run locally on Linux (macOS-only modules stubbed);
      the real driver + ipykernel relay test passes, including compiled cells with g++/gcc
- [x] Rust gates on macos-14 CI (run 27, before compiled cells): fmt, clippy, 136 unit tests incl. the real driver + ipykernel relay, auth and job flows
- [x] Rust gates on macos-14 CI for the 0.5.0 head (run 30): fmt, clippy, 136 unit tests incl. compiled cells with Apple clang as g++/gcc, 15 auth + 5 job flows
- [x] Opt-in: `cargo test --test real_openssh -- --ignored` (2/2) and `cargo test --lib keychain_roundtrip -- --ignored` (pass), 2026-10-25
- [x] Late fixes before tagging, with tests: kernels that start slowly (missed 1 s heartbeat gave
      `kernel_start_failed: RuntimeError` on ICF), empty number fields, delete files/folders (ADR-032),
      folding VS Code / Python environment cards; macOS CI green on PR #3 and on `main`
- [x] Built `.app` (demo data): Version 0.5.0, Notebooks tab, Overview/New job/My Jobs, light and dark.
      CUDA cell, cell type menu, editor run bar (Running → Done, ⌘⇧Enter), full screen and the
      "Stop the kernel?" prompt checked in the dev preview (Chromium) with synthetic kernels
- [ ] In WebKit with a live connection: notebook CSS under the CSP, full screen with ⌃⌘F
      (the owner used notebooks in the built app; not checked item by item)
- [ ] **Approved live kernel test** (needs explicit consent): open a notebook, start a kernel on
      Interactive (1 GPU, 15 min) with the project's CUDA toolchain; run
      `import torch; torch.cuda.is_available()`, a `%%cuda` saxpy, a `%%cpp` hello, Interrupt, Restart;
      Stop; `squeue -u $USER` shows no job left. Repeat with Disconnect instead of Stop, and once with
      **Run on GPU** for a `.cu` file in the editor
      *Owner's live use, 2026-10-25/27:* a notebook kernel started and ran on Interactive; editor runs of
      `.cu`/`.py` first failed with `kernel_start_failed: RuntimeError` (fixed in `9b28abd`), then the
      owner marked the version ready. Delete on ICF works. The full sequence above was not reported.
- [ ] Confirm students may `srun` on Interactive from the login node; note typical queue times
      (`srun` on Interactive worked for the owner's account; queue times not recorded)
- [ ] Confirm the ICF CUDA toolchains support `nvcc -arch=native` (CUDA 11.6+)
- [x] Versions agree: `frontend/package.json`, `backend/Cargo.toml` (+ `Cargo.lock`), `backend/tauri.conf.json`
- [x] Merge the PR (merge commit), set the CHANGELOG date to the tag date, tag `v0.5.0` on `main`, push the tag
- [x] Release workflow green (run 40503806096, tag re-cut on `f3d0bff` to include the folding cards):
      `.app` built on macos-14, ad-hoc signed, `codesign --verify` passes, zip + `.sha256` file attached
- [x] Downloaded zip: `shasum -a 256 -c` OK, `codesign --verify --deep --strict` passes, opens on an
      Apple Silicon Mac; sidebar shows **Version 0.5.0**; demo data works
- [x] Published 2026-10-27; `releases/latest` → v0.5.0.
      SHA-256 `af8e7d93c78560f161e943d32292cc1e6f5b8cb3d6e924abbe947c0196d3a6dd`

## v0.5.1 (Cluster and My Jobs tabs, Rename and Unpack; ADR-033)

- [x] Frontend gates: lint (incl. ui/logic boundary), typecheck, 97 UI tests, production build
- [x] Rust gates locally: fmt, clippy `-D warnings`, 141 unit tests (incl. rename and unpack against a
      sandbox home with `../x` and `/x` archive members), 15 auth + 5 job flows
- [x] Dev preview (demo data): Cluster → Overview/Nodes and a partition's Nodes, My Jobs → Training
      runs, Rename (Enter no longer reopens the sheet) and the Unpack sheet
- [ ] macOS CI green on the PR and on `main`
- [ ] Versions agree: `frontend/package.json`, `backend/Cargo.toml` (+ `Cargo.lock`), `backend/tauri.conf.json`
- [ ] Merge the PR (merge commit), tag `v0.5.1` on `main`, push the tag
- [ ] Release workflow green: zip + `.sha256` attached to a draft
- [ ] Downloaded zip: `shasum -a 256 -c` OK, `codesign --verify --deep --strict` passes; sidebar shows
      **Version 0.5.1**; demo data works
- [ ] Live (owner): Unpack a Transfers archive on ICF gives the original folder; Rename a file; ICF has `unzip`
- [ ] Published

