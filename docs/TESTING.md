# Testing

Automated tests never contact ICF, submit real jobs, or change anything outside temporary folders.
Scheduler commands run against a scripted `ssh` and stub `sbatch`/`squeue`/`scancel`; V3 remote scripts
and the job wrapper run in a real `sh`/`bash` against throwaway sandbox folders.

## Gates (all must pass before a release)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

```bash
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

```bash
pnpm tauri build
```

Opt-in tests (local machine only; never the cluster):

```bash
cd src-tauri && cargo test --test real_openssh -- --ignored --nocapture
```

```bash
cd src-tauri && cargo test --lib keychain_roundtrip -- --ignored
```

`real_openssh` starts a throwaway unprivileged `sshd` on 127.0.0.1 and drives the real
`/usr/bin/ssh`/`sftp`. The V3 part sets the remote `$HOME` to a temp folder with `SetEnv`, so no files are
written to your home directory.

## Inventory (v0.3.0, 2026-10-17)

| Suite | Tests | What |
|---|---|---|
| Rust unit, V1/V2 (`slurm`, `ssh`, `jobs`, `state`, `profiles`, `errors`, `util`) | 67 + 1 opt-in | parsers, auth policy, refresh budget, job validation/scripts/outcomes |
| Rust unit, `workflow::tests` | 23 | validation, rendering, **executed wrapper** (bash 3.2, python3), stager, status derivation, failure classification, run store |
| Rust unit, `projects::tests` | 12 | browse/mkdir/resolve scripts, interpreter probe (stubs + real python3), settings.json merge/write, identity scoping, VS Code detection/launch |
| Rust unit, `transfers::tests` + `sha256` | 8 | sftp batch safety, part/publish/discard scripts, checksums, folder scan, restart marking |
| Rust integration `auth_flows` | 15 | V1 authentication matrix with the scripted ssh |
| Rust integration `job_flows` | 5 | V2 submit/list over the real mux code |
| Rust integration `real_openssh` (opt-in) | 2 | real OpenSSH host keys/ProxyJump/mux; **real sftp transfers through the app's master** |
| Frontend (Vitest + Testing Library) | 53 | 37 V1/V2 + 16 V3 (projects, VS Code, wizard, runs, transfers, helpers) |

## Coverage of the V3 test requirements

| Requirement | Where |
|---|---|
| Path validation, traversal, Unicode, spaces, control chars | `projects::tests::browse_paths_*`, `workflow::tests::hostile_paths_*`, `transfers::tests::sftp_batches_*` |
| Shell metacharacters / malicious names | `workflow::tests::rendered_script_quotes_*` (+ executed), `projects::tests::listing_*` (`'; touch PWNED; '`), `status_reads_*` |
| Symlink escapes | `listing_*`, `mkdir_*`, `resolve_*`, `settings_write_*` (symlinked `.vscode`), `upload_check_*`, `publish_*`, `status_reads_*`, `workflow_submission_prechecks_*` |
| Interpreter discovery | `interpreter_probe_is_light_and_classifies_candidates` (stub venv, missing, non-executable, real python3, system, toolchain rc) |
| SLURM script generation | `rendered_script_quotes_every_user_value`, `smoke_test_and_notebook_variants`, `workflow_submission_prechecks_*` (sbatch receives the reviewed script byte for byte) |
| Workflow state transitions | `derive_maps_scheduler_and_markers_to_workflow_states`, every executed-wrapper test checks `derive()` on real markers |
| Archive validation (traversal, absolute, symlink/hardlink out, devices, FIFOs, duplicates, zip symlink, bombs, corrupt, no space, existing dest) | `unsafe_archives_are_rejected_before_any_extraction_or_training`, `stager_extracts_valid_archives_safely_*` |
| Checksum verification | `transfers::sha256::known_vectors`, `remote_checksums_match_local_ones`, real sftp test (corrupted partial rejected), wrapper copy-back verify |
| Scratch directory generation / collisions / exhaustion | `happy_path_*`, `scratch_collision_never_deletes_the_existing_directory`, `insufficient_scratch_space_fails_before_staging`, `refuses_to_run_outside_a_slurm_allocation` |
| Configuration persistence / application restart | `run_store_survives_restart_and_scopes_identities`, `project_records_never_mix_identities`, `interrupted_transfers_are_marked_on_restart_and_scoped`, UI `Runs dashboard` tests |
| Error classification | `log_tails_classify_common_gpu_failures`, executed failures (env, scratch, archive, sync, training) |
| Successful project opening / missing VS Code / missing extension | `vscode_detection_uses_app_bundles_not_shell_path`, UI `Projects and VS Code` tests |
| VS Code launch safety | `vscode_launch_is_argv_only_with_a_clean_environment` |
| Interrupted / resumed transfers | real sftp test (`reput` resume, dead master), `interrupted_transfers_*`, UI transfers test |
| Failed SLURM submissions / duplicate submission | V2 `job_flows`, `a_preview_can_be_submitted_at_most_once`, UI wizard double-click test |
| Job timeout / signals | `time_limit_signal_stops_training_and_still_copies_back` |
| Checkpoint sync / result sync failure | `happy_path_*` (checkpoint synced), `result_sync_failure_is_not_reported_as_completed` |
| CUDA incompatibility / missing interpreter | `log_tails_classify_*`, `missing_interpreter_is_an_environment_failure` |
| Unexpected command output / forged markers | `event_parser_ignores_program_output_and_forged_lines`, `metrics_lines_are_parsed_defensively` |
| Concurrent file replacement | `settings_write_backs_up_and_detects_concurrent_changes`, `publish_never_overwrites_*` |
| V1/V2 regression | all pre-existing suites unchanged and passing |

Notes:
- GNU-only tools are given small stand-ins on macOS where the real tool differs (`find -printf` →
  a Python shim, `stat -c %U`, `sha256sum` → `shasum` on older macOS). The real tools are exercised by
  the live smoke test.
- Not automated: the live ICF run (needs approval), clicking through the built `.app`, real VS Code
  window opening (the CLI is exercised with a fake bundle; detection was checked read-only against the
  real install).

## Live ICF smoke tests (manual, need explicit approval)

See `docs/V3_IMPLEMENTATION_REPORT.md` → *Manual cluster verification* and the test table in
`examples/workflow-smoke/README.md`. `make_dataset.py` output was checked locally against the
compute-node stager (good archive extracted, unsafe one rejected); `train_tiny.py` and the notebook
need PyTorch and run only on ICF.
