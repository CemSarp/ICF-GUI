# Rules for coding agents (derived from notes/ICF_CONTROL_CENTER_SPEC.md)

1. Read the spec and the plan for the version you implement. Versions go V1 → V2 → V3; do not pull features forward.
2. No real job submission, cancellation, credential deletion or remote installation during automated tests. Real ICF tests need the user's explicit consent and are read-only unless the user approves otherwise.
3. Never put secrets in argv, environment, logs, files, URLs, the DOM after login, or persisted JS state. Passwords live only in Rust memory (zeroized) or the macOS Keychain after explicit opt-in.
4. Never weaken host-key checking: no `StrictHostKeyChecking=no`/`accept-new`, no `/dev/null` known_hosts, no `sshpass`/`expect`.
5. The frontend never runs commands. Every backend command is fixed-template, typed, validated in Rust, listed in `backend/build.rs`, and granted explicitly in `backend/capabilities/`. Mutating (V2+) commands go in a separate capability.
6. Remote scripts are fixed strings sent on stdin to `sh -s`; user values are never interpolated into a remote shell.
7. Polling budget: overview ≥ 45 s (default 60 s), manual refresh debounced 10 s and single-flight, nothing while hidden/disconnected, auth failures stop everything. No per-node fan-out, no heartbeat pings.
8. Unknown is unknown: never render missing data as 0 or free. Count physical nodes once; keep MIG slices separate.
9. Gates before claiming a milestone: `pnpm lint typecheck test build` (in `frontend/`) and `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` (in `backend/`). Report real outcomes.
10. Record unsettled decisions in `docs/DECISIONS.md`.
