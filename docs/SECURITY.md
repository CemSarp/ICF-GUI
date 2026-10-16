# Security design (V1)

## Threat model in one paragraph

The app runs as the student on their own Mac and talks to ICF only through macOS OpenSSH. We protect
the user's university password, their SSH trust decisions and the shared cluster. We assume the
network and the remote side may be hostile (MITM, injected prompts, malicious stderr/banners) and that
other software on the Mac may run as the same user but is not root.

## Authentication path

```text
Login form ──invoke(JSON, in-process)──▶ Rust (Zeroizing<String>)
                                            │ spawns, argv only, cleared env
                                            ▼
                     /usr/bin/ssh -F <gen cfg> -o ControlMaster=yes -o ControlPersist=no -N icf
                        │ ProxyJump child: ssh -W … edinburgh-jump  (inherits -F and env)
                        │ every prompt → $SSH_ASKPASS "<prompt>"   (SSH_ASKPASS_REQUIRE=force)
                        ▼
      askpass helper = this same executable in helper mode
                        │ UNIX socket <0700 session dir>/ap.sock
                        ▼
      Rust askpass server: uid check + peer pid must descend from our ssh master + nonce
        → strict prompt classifier → policy → answer | ask user | deny
```

- **Generated config** (`ssh/mod.rs::forced_config`): a `Host *` block placed *before*
  `Include ~/.ssh/config` (ssh_config is first-match-wins) forces `StrictHostKeyChecking ask`,
  `NumberOfPasswordPrompts 1`, `ConnectTimeout 20`, no agent/X11 forwarding, `ClearAllForwardings`,
  `PermitLocalCommand no`. It is passed with `-F`, which OpenSSH propagates to ProxyJump hops.
  Verified: a user config containing `StrictHostKeyChecking no` is overridden (real OpenSSH test).
- **No secrets in argv/env/files.** The ssh child gets a cleared environment plus `HOME`, `USER`,
  `LOGNAME`, `TMPDIR`, a fixed `PATH`, `SSH_AUTH_SOCK`, `SSH_ASKPASS*`, the socket path and a random
  nonce. The test suite records the fake ssh's full argv+env and asserts no password appears.
- **IPC.** The socket lives in a per-connection `0700` directory under the per-user temp dir. A peer
  is served only if (1) `getpeereid` uid equals ours, (2) its pid (`LOCAL_PEERPID`) descends from the
  ssh master we spawned, and (3) it presents the 256-bit nonce (constant-time compare). The socket
  and directory are removed when the attempt ends or on disconnect.
- **Prompt allowlist** (`ssh/askpass.rs::classify`): only `user@host's password:` and
  `(user@host) Password:` are passwords; only the OpenSSH "authenticity of host … fingerprint"
  question is a host-key prompt. Everything else (OTP, Duo, key passphrases, password change,
  CheckHostIP warnings, multi-line or odd text) is shown to the user verbatim and never auto-answered.
- **Hop binding.** A password prompt is auto-filled only if `user@host` matches exactly one hop
  resolved locally with `ssh -G`. Ambiguous or unknown hosts → manual prompt with a warning. The
  destination password is used for the gateway **only** if the user ticks "Use the same password".
- **One attempt per Connect.** Each hop gets at most one automatic answer; a repeated prompt for the
  same hop is denied, so a wrong password fails once instead of looping. After 3 failed sign-ins the
  app blocks Connect for 5 minutes. No background or automatic retries exist.
- **Success** means: the control socket exists *and* the fixed probe (`id -un`, `hostname`, …) ran
  over it and returned the expected user. TCP reachability is never treated as success.

## Host keys

- Unknown key → modal with host, key type and the fingerprint from OpenSSH, plus a warning that it
  must be compared with a fingerprint published through a trusted channel. Default focus is
  **Reject**. The decision (host, fingerprint, time, accepted) is stored in the profile; OpenSSH
  itself writes `~/.ssh/known_hosts`.
- Changed key → OpenSSH aborts (`ask` mode fails closed); the app shows "host key has CHANGED" with
  recovery advice. There is no in-app override.
- `ControlPersist` is not used because it makes OpenSSH discard stderr (ADR-003), which would hide
  the changed-key warning.

## Keychain

- Generic-password items, service `local.icf-control-center.ssh`, account
  `<profileId>:<user>@<host>` (one per hop). Written only after a successful connection with
  **Remember** ticked (default off), read only during a user-initiated connection when a bound
  password prompt arrives, deleted by **Forget saved password** (confirmation dialog + backend
  `confirm` flag). Profiles store only the list of `user@host` entries that have an item.
- OTP/MFA answers are never stored.

## Other controls

- Tauri: app commands must be listed in `build.rs`; `capabilities/default.json` grants exactly the
  V1 commands plus event listen/unlisten. No shell, fs, http or opener plugin. CSP:
  `default-src 'self'`, no inline/remote scripts, `connect-src ipc:`; `freezePrototype`.
- Remote commands are fixed scripts sent on stdin to `sh -s`; nothing from the UI is interpolated.
- Mux commands run with `BatchMode=yes` and without askpass/agent, so a dead session can never
  start a new login. A local `-O check` precedes each command.
- Output caps (2 MiB inventory, 64 KiB stderr), 15 s command timeout, 30 s auth budget (time spent
  on user prompts excluded), ANSI/control/bidi stripping before display, React text rendering only
  (`dangerouslySetInnerHTML` is lint-banned).
- Disconnect / quit: `ssh -O exit`, kill the master's process group, delete the session dir.
  Startup sweeps session dirs whose owning app process no longer exists. Idle sessions close after
  30 minutes without commands. Jobs and external VS Code sessions are never touched.
- No telemetry. Diagnostics in Settings redact usernames by default.

## V2: job submission, logs, cancellation

- **Separate capability.** `jobs_submit` and `jobs_cancel` are the only commands that change cluster
  state; they are granted in `capabilities/job-mutations.json`, apart from the read-only set.
- **Identity** for all job operations comes from the authenticated probe (`id -un`, `$HOME`), never
  from the UI. `squeue -u <user>`; rows for other users are dropped (and counted).
- **Request validation** (`jobs/request.rs`, `deny_unknown_fields`): partition visible and not
  denied; GRES type present on a node in that partition; GPU/CPU/RAM within the largest such node and
  partition caps; wall time within `MaxTime`; job name `[A-Za-z0-9._-]`; paths absolute, inside
  `$HOME`, conservative charset (no whitespace, quotes, `$`, backticks, globs, `%`, `.`/`..`).
  Program arguments may contain anything printable and are single-quoted. Notices that need consent
  (unknown eligibility, multi-GPU, Interactive partition, sourcing a file outside home) must be
  acknowledged.
- **Exactly one submission per review.** `jobs_preview` stores the rendered script under a random id;
  `jobs_submit` removes it *before* sending, rejects duplicate client request ids, and runs under a
  mutation lock. The script is re-validated against the newest snapshot, then sent in a quoted
  heredoc to a single `sbatch --parsable`. On ICF the same command first resolves the working
  directory, program, venv and setup file with `readlink -f` and refuses anything outside `$HOME`
  (symlinks included) — nothing is submitted if a check fails.
- **Uncertain outcomes.** If the connection drops or times out after the submission step started, the
  receipt is marked *uncertain* and nothing is retried. Each job carries `--comment=icfcc-<tag>` so
  the user can reconcile (search own jobs) explicitly. A receipt is written *before* sending, so a
  crash mid-submit also reads as uncertain.
- **Cancellation.** Requires a token issued by `jobs_get_detail` (only for own, cancellable jobs; 10
  min TTL; constant-time compare; single use) plus a confirmation dialog. On ICF the same command
  re-checks `squeue -j <id> -o %u|%T` and runs `scancel <one validated id>` — never `-u`, ranges,
  wildcards or `scontrol update`. The UI says *Cancellation requested* until SLURM shows it.
- **Logs.** Paths come from `scontrol show job` (or this app's receipts), placeholders are expanded
  conservatively (`%j %A %a %x %u %%` only). On ICF the file must resolve inside `$HOME` and be owned by
  you. Reads are bounded (64 KiB per request, incremental by byte offset, rotation detected) and
  rate-limited per stream (5 s); text is stripped of ANSI/OSC (including terminal hyperlinks) and
  control characters and rendered as plain text.
- **Evidence.** Generated remote scripts are executed in a real `sh` with stub
  `sbatch`/`squeue`/`scancel`/`python3` (`jobs/tests.rs`): payloads such as `$(touch PWNED)`,
  backticks and `'; rm -rf /` arrive as literal argv, `sbatch` receives byte-identical script text,
  symlinks out of home are refused, and `scancel` receives exactly one id.
- Closing the app or disconnecting never cancels jobs.

## Verification status

| Matrix row (V1 plan M2) | Evidence | Status |
|---|---|---|
| Correct key/agent | real OpenSSH + local sshd (`tests/real_openssh.rs`), fake ssh | ✅ |
| Password to one hop / distinct passwords per hop | scripted ssh (`tests/auth_flows.rs`) | ✅ simulated |
| Wrong password, no loop | scripted ssh | ✅ simulated |
| Cancel mid-prompt, cleanup | scripted ssh: process killed, dir/socket removed | ✅ |
| Unknown host key gate | **real OpenSSH 10.3**: prompt on both ProxyJump hops, real fingerprint | ✅ |
| Changed host key fails closed | **real OpenSSH 10.3** | ✅ |
| OTP/MFA not stored | scripted ssh | ✅ simulated |
| Reconnect with remembered password | scripted ssh + in-memory store; real Keychain round-trip test | ✅ |
| Forget credential | UI test (confirmation) + Keychain delete test | ✅ |
| Real ICF connection, read-only inventory | performed by the user on 2026-10-16 (screenshots) | ✅ |
| Real ICF job submission | user-approved smoke test on 2026-10-16: job 3680123 (Teaching, 1× RTX 2080 Ti, 2 CPUs, 4 GB, 5 min) Accepted → COMPLETED 0:0 on `opencast`; stdout read in-app. An earlier ICF-Free attempt was cleanly rejected by sbatch (account/partition), no job created | ✅ |
| Real ICF job cancel | not run; needs a separately approved job | ⏳ pending |

A non-root `sshd` cannot produce password prompts, so the password rows rely on OpenSSH's documented
prompt formats (unit-tested strings) until the manual ICF check is done. If the real Informatics
prompts differ (e.g. no `(user@host)` prefix on keyboard-interactive), the app will fall back to
asking the user manually rather than auto-filling; that is safe but less convenient, and the
classifier would be extended after observing the real prompt text.
