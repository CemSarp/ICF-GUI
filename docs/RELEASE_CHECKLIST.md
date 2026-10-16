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

## V2 backlog (prioritised; types exist in `src/types`, no commands or permissions yet)

1. `jobs_list_mine` (read): `squeue -u <verified remote user>` fixed format, own jobs only, ≤ 1/30–45 s while visible.
2. `jobs_get_detail` (read): `scontrol show job <validated id>`; `sacct` if permitted.
3. `jobs_preview` (local): typed form → exact sbatch script + warnings; script hash.
4. `jobs_submit` (mutation, separate capability): single `sbatch --parsable` with script on stdin; uncertain network result → search own recent jobs + explicit user choice, never auto-retry.
5. `jobs_get_log_tail` (read): bounded, sanitized tail of user-owned paths, ≤ 1/5–10 s.
6. `jobs_cancel` (mutation): own jobs only, confirmation token.
7. Local job reference store (no secrets), job states incl. `requeued`/`unknown`.
