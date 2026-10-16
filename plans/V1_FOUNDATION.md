# V1 Implementation Plan — Secure Login, SSH and GPU Observability

> **Depends on:** [`../ICF_CONTROL_CENTER_SPEC.md`](../ICF_CONTROL_CENTER_SPEC.md)
> **Scope:** local macOS desktop app, safe connection, Keychain, partition/node/GPU dashboard; **strictly read-only** after authentication.
> **Explicitly excluded:** `sbatch`, `scancel`, GPU reservation, remote software installation, code execution on compute nodes, data transfer and VS Code integration beyond a placeholder link.

## 1. Outcome / demo script

At the end of V1 the user can open `ICF Control Center.app`, enter their UUN and password, optionally enable **Remember password (macOS Keychain)**, click **Connect**, verify both SSH hops, and view live-but-timestamped `Teaching`, `ICF-Free`, `Interactive`, and all other visible partitions. They can inspect per-node GPU types and potential availability without the app overloading ICF. Disconnect stops monitoring. A second login may reuse saved credentials only when appropriate and securely authorized.

**Hard release blocker:** Password-based OpenSSH jump-host auth must be proven secure. Do not ship an unsafe substitute if it fails; report the unsupported case and provide documented agent/interactive fallback.

## 2. Sequence of work (implement in order)

### M0 — Repository bootstrap & verification harness

**Tasks**

- [ ] Initialize Tauri 2, Vite, React, TypeScript strict mode, Rust workspace. Choose one package manager (`pnpm`) and lock all dependencies.
- [ ] Support Apple Silicon macOS initially. Add `dev`, `build`, `lint`, `typecheck`, `test`, `tauri dev`, `tauri build` scripts.
- [ ] Implement design tokens, theme switch, keyboard accessibility and sidebar shell with `Login`, `Overview`, `Partitions`, `Nodes`, `Settings`.
- [ ] Define typed Tauri command contracts and a `MockClusterAdapter` with representative synthetic fixture data (separate from real-data UI).
- [ ] Add README quickstart; document required Rust, Xcode Command Line Tools, Node/pnpm, OpenSSH and optional VS Code. Keep mock mode obvious and **never indistinguishable from live ICF**.
- [ ] Set restrictive Tauri capabilities and strict CSP; avoid exposing general shell execution to frontend.
- [ ] Add Rust/TypeScript formatters, linters and CI (unit tests run offline by default).

**Acceptance:** `pnpm tauri dev` displays a responsive mock dashboard offline; `cargo test`, TS unit tests and builds pass; no remote commands executed at startup.

### M1 — Connection profiles and SSH configuration

**Tasks**

- [ ] `ConnectionProfile` model: id, label, SSH alias, username, gateway settings, auth mode (agent / password / mixed), saved credential availability flags, last success (non-sensitive).
- [ ] Default SSH alias `icf`; allow entry/update of `UUN`, destination and gateway host. Preserve existing `~/.ssh/config`; **do not overwrite it**.
- [ ] Local-only config inspection via `ssh -G <alias>` (safe args and redacted diagnostics). Check executable path `/usr/bin/ssh` and OpenSSH features.
- [ ] Profiles stored under macOS app config, mode restricted, **passwords absent**.
- [ ] Validate SSH hostname and user fields before process launch; reject shell metacharacters, newline, empty ID, questionable host-key paths, or host aliases beginning with `-`.
- [ ] UI allows manual `Connect`, `Cancel`, `Disconnect`, `Forget password`; load saved credential presence without revealing value.
- [ ] Include example gateway `student.ssh.inf.ed.ac.uk`, destination `icf`, `ProxyJump` configuration in help panel, but don't assume all users have the same account naming scheme.

**Acceptance:** Existing SSH-agent setup continues working; profile changes don't corrupt `~/.ssh/config`; invalid input causes local validation error before SSH invocation.

### M2 — Critical auth / Keychain spike (gate to all subsequent work)

**Tasks**

- [ ] Build a secure, **bundled** macOS SSH_ASKPASS helper or an equivalently reviewed native prompt/IPC mechanism. Document architecture in `docs/SECURITY.md` and ADR.
- [ ] Confirm system OpenSSH handling of `ProxyJump`, destination+gateway password challenges, distinct secrets, password retry, fingerprint prompt and host-key mismatch.
- [ ] Use Keychain generic-password items keyed per identity + hop. `Remember password` OFF by default, and save only after confirmed successful authentication.
- [ ] Any password field is short-lived; do not pass secrets in CLI arguments, environment, logs, IPC URL, shell input string, text files, or persistent frontend storage. Use authenticated, private IPC; clear memory best effort.
- [ ] Fingerprints: explicit first-use verification prompt for jump+ICF hosts; persist accepted keys through standard `known_hosts` handling; changed keys block. Never disable verification.
- [ ] OTP/MFA challenge: handle interactively without saving/replaying it; unknown prompts fail closed or require explicit response.
- [ ] Add a bounded SSH connection test (`hostname` and `id -un`), check correct identity and store success in connection state.
- [ ] Add `max 3` failed password attempts/session before pausing, clear error states and manual retry after cooldown; do not run background retries.
- [ ] Close helpers/sockets and kill app-owned SSH children when connection is canceled; do not cancel jobs or affect external VS Code sessions.

**Host-key requirement:** Do not display an unauthenticated fingerprint as independently trusted; encourage out-of-band fingerprint validation. **Never** silently `accept-new` without a conscious, recorded user action and appropriate policy.

**Secure fallback:** If integrated password login cannot satisfy the security test matrix, do not fabricate completion. Support `SSH agent/key + existing ssh config`, or explicit system-terminal interactive SSH with the limitation clearly labeled. Ask for user approval before relaxing the password button's functionality.

**Acceptance matrix**

| Scenario | Expected result |
|---|---|
| Correct key/agent | Connect, identity verified, no password persisted |
| Correct password to one hop | Connect, save only if opted in |
| Different jump / destination passwords | Correct host-scoped prompts; no reuse by mistake |
| Wrong password | User-visible error, no infinite retries |
| User presses Cancel mid-prompt | All app processes/IPC cleaned; no cached secret |
| Unknown host key | Explicit verification gate |
| Changed host key | Fail closed; cannot connect via bypass |
| OTP/MFA | User prompt, no OTP storage or replay |
| Reconnect with remembered password | Keychain access correct; no plaintext storage |
| Forget credential | Keychain item deleted, confirmation presented |

### M3 — Lightweight SLURM probe and adapter

**Tasks**

- [ ] After successful SSH authentication, execute **one** grouped session discovery (identity, `sinfo --version`, command availability, partition capabilities).
- [ ] Prefer JSON output if supported; build exact, small fallback formats on older versions.
- [ ] `SlurmAdapter` with functions: `getCapabilities()`, `listPartitions()`, `listNodesAndGpuAllocations()`, `getNodeDetail(nodeId)`.
- [ ] Normalize responses into `ClusterSnapshot` contract; use canonical physical-node dictionary and partition membership arrays, not duplicated physical node objects per partition.
- [ ] Parse visible GRES and allocations; preserve MIG resource naming, raw resource description in drilldown, and `unknown` where fields unavailable.
- [ ] Fixture tests: empty partitions, default marker `*`, host ranges (`landonia[05,08,11]`), `down*`, `mix-`, `idle`, mixed, drain, no GPU, A6000, RTX 2080 Ti, H200 full+MIG, multiple partition memberships, unknown allocation fields.
- [ ] Normalize numbers safely; don't parse `GPU used` from `nvidia-smi` as the default. Don't query every compute node.
- [ ] Track snapshot provenance/time, stale/partial status and parser warnings.

**Acceptance:** Same physical node is counted once globally even if in `Teaching` and `ICF-Free`; if allocated GRES unavailable, value displays “Unknown”, not 0.

### M4 — Dashboard, polling and UX

**Tasks**

- [ ] Overview: connection, last update, counts by partitions and GPU types with confidence labels.
- [ ] Partitions grid/table: partitions, nodes, GPU breakdown, status, max time, scheduler limits/eligibility when known.
- [ ] Node detail: partition memberships, GPU GRES and used/unknown resources, CPU summary and explicit data timestamp.
- [ ] “Potentially available”, “Allocated”, “Unavailable”, “Unknown” status legend; filter/sort without network requests.
- [ ] Polling: 60s overview refresh default; hard floor 45s. Manual refresh button with 10s debounce and request dedupe. At most one active refresh. Suppress when app hidden/sleeping/disconnected.
- [ ] Failed refresh retains last successful snapshot **marked stale**; timeout/backoff with jitter. Auth failures stop all attempts.
- [ ] Set per-command 10–15s timeouts and max output size; local UI never blocks.
- [ ] Add external link to official ICF status site with no automatic scraper.
- [ ] Settings show poll rate restricted to policy-compliant values, last response/error, anonymized diagnostics, clear cached snapshots.

**Acceptance:** Observe for 10 min with window foregrounded: roughly one inventory request/minute, no periodic independent password attempts, no per-node SSH fan-out, no new requests when minimized. Manual rapid clicking does not multiply calls.

### M5 — Release engineering and controlled ICF validation

**Tasks**

- [ ] Unit / integration / E2E test matrix completed, including offline mode and different SSH prompts. Static checks/lints pass.
- [ ] Verify app works as a **built `.app`**, not just in `tauri dev`. Ensure GUI-launched app can find macOS OpenSSH and resources without relying on shell startup `$PATH`.
- [ ] Manual test on ICF **read-only only**, with explicit user consent; never `sbatch` during V1 acceptance.
- [ ] Review Keychain access prompts, host-key verification, secret-redacted errors and teardown after disconnect.
- [ ] Update README, `docs/ARCHITECTURE.md`, `SECURITY.md`, `CLUSTER_COMPATIBILITY.md`, `USER_GUIDE.md`, `DECISIONS.md`.
- [ ] Capture sanitized screenshots and issue list; publish `v0.1.0` local dev release only when tests pass.

---

## 3. Version 1 functional acceptance criteria

- **V1-AC01:** Login form offers username/password, remember password OFF by default, use existing SSH agent, Connect/Cancel/Disconnect, Forget saved password.
- **V1-AC02:** Both SSH hops are verified; unexpected SSH host keys fail closed; successful connection confirms authenticated remote user.
- **V1-AC03:** Password is stored **only** in macOS Keychain after opt-in; no secrets appear in logs, local config, CLI args, process environment or screenshots.
- **V1-AC04:** `Teaching`, `ICF-Free`, `Interactive` and any other actual visible partitions appear without static assumptions; permissions not invented.
- **V1-AC05:** Node state, GPU model, configured/allocated/potential counts (or `Unknown`) correspond to fixture-backed parsing of actual SLURM outputs.
- **V1-AC06:** Overlapping node membership does not inflate total physical GPU inventory; MIG resource accounting is distinct.
- **V1-AC07:** Rapid Refresh requests are coalesced; app idle backgrounded causes **zero** scheduled polling; auth failure stops polling.
- **V1-AC08:** No `sbatch`, `scancel`, `srun`, remote file mutation or GPU workload triggered by V1 UI.
- **V1-AC09:** SSH timeout/disconnect, empty partition, missing SLURM command and stale snapshots have meaningful error states.
- **V1-AC10:** App builds and launches as a local macOS `.app`, with security and architecture documented.

## 4. Test fixtures / failure injection (minimum)

- Synthetic SLURM outputs from known scenarios: overlapping `Teaching` + `ICF-Free`, mixed RTX 2080 Ti, `landonia11` 8× A6000, `saxa` H200/GRES MIG, down nodes, no free GPUs, empty output, malformed resource suffix.
- SSH mock server: successful password, wrong password, gateway password + destination password, host-key change, prompt cancellation, unreachable target, banner on stdout/stderr, injected escape sequences.
- Rate fake-clock tests: `manual refresh ×10`, app minimize, reconnect, overnight sleep/resume, concurrent feature views and transient loss of network.
- Property tests: normalized snapshot never creates negative free resources or double counts node-level physical hardware.

## 5. Deliverables to the user

- Working local `.app` / development run instructions.
- **Screens:** Login, Overview, Partitions, Node Detail, Settings.
- Security review summary: Keychain, host key, SSH_ASKPASS implementation, known fallback/limitations.
- Repeatable mock/demo mode, test evidence and screenshot.
- A prioritized V2 backlog with backend APIs already typed (but mutations unavailable).

## 6. Agent stopping rules

Stop before release if: passwords leak into process args/env/logs; unknown host key auto accepted; institution-specific prompts are mishandled; unauthenticated `sinfo` shown as authenticated live data; user session submits SLURM jobs; refresh issues a command to each node; or system requires cluster-side daemon installation.

**Final agent response format:** implemented milestones; actual tests executed and results; security risks/limitations; how to run `.app`; next V2 steps. Never claim tests ran if they did not.
