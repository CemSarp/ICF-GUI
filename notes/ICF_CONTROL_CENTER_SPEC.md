# ICF Control Center — Product Requirements & Engineering Specification

> **Status:** Agent-ready implementation specification, not an implemented application
> **Target:** Local-first macOS desktop application for the University of Edinburgh Informatics Compute Facility (ICF)
> **Canonical plan:** This document + [`plans/V1_FOUNDATION.md`](plans/V1_FOUNDATION.md), [`plans/V2_JOBS.md`](plans/V2_JOBS.md), [`plans/V3_WORKFLOWS.md`](plans/V3_WORKFLOWS.md)
> **Last reviewed:** 2026-10-16

## 0. Instructions for Codex / Claude Code / engineering agents

1. Read **this entire specification** and the plan for the version being implemented before writing code.
2. Treat **MUST / MUST NOT / SHOULD / MAY** as normative. The **Definition of Done** and the tests in each plan are release gates.
3. Execute phases **V1 → V2 → V3** in order. Do not silently pull features forward; build interfaces/stubs only when they lower integration cost.
4. Prefer a **working, testable increment** over broad scaffolding. After each milestone, run formatters, linters, unit tests, and the relevant integration checks; report real outcomes, not assumptions.
5. Never invent current GPU availability, cluster policies, node inventory, passwords, host keys, command output, or SLURM permissions. Discovery must happen against ICF or a recorded test fixture.
6. **No real job submission, cancellation, credential deletion, destructive remote action, or installation on ICF during automated tests** without explicit user authorization. Default tests use mocks and fixture data.
7. Do not require root/sudo, install a persistent daemon on shared ICF systems, or conduct GPU computation on `hastings`.
8. Never log credentials, OTPs, SSH challenge answers, host keys treated as secrets, or full command lines that may contain sensitive values. Never put a password in process arguments, environment variables, settings JSON, shell history, the UI DOM after login, or remote files.
9. If an integration approach (especially non-interactive password handling through OpenSSH) cannot be implemented securely, **stop and document the precise blocker**. Do not replace it with `sshpass`, `expect`, disabled host-key checking, or plaintext storage.
10. Maintain a short `docs/DECISIONS.md` ADR for decisions not fully fixed here; update API contracts and the user-facing guide with each released feature.

### Terminology

- **Login / Connect**: Authenticate via SSH to the permitted ICF login host, normally through the Informatics student jump host.
- **GPU request / Allocate**: Ask the SLURM scheduler for resources. This is **not a purchase, rental contract, exclusive physical-device claim, or guarantee of immediate access**. Never use “rent GPU” as a billing assertion.
- **Available**: A scheduler-informed, timestamped estimate of resources the current identity *might* be able to request. Actual availability is only determined by the scheduler at submission/allocation time.
- **Occupied / Allocated**: GPUs already assigned by SLURM (not necessarily showing high GPU utilization).
- **Unknown**: Resources for which status cannot be reliably derived. Do not turn unknown into zero or free.
- **Node vs partition**: A physical node may belong to **multiple** partitions; avoid double-counting its GPUs across partitions.

---

## 1. Product goal, personas and non-goals

### 1.1 Product goal

Provide a clean, reliable **macOS `.app`** to:

1. Connect to ICF using a **Login** button with username and password, optionally remembering credentials in the **macOS Keychain**.
2. See allowed SLURM partitions, physical nodes, GPU models, status, scheduled/allocated GPU counts, queued jobs, and timestamped data freshness.
3. Submit **batch GPU jobs**, inspect their state and logs, cancel **only one's own** jobs, and retrieve results with minimal terminal use.
4. Open remote source code in **VS Code + Remote - SSH**, select the existing remote Python interpreter and use SLURM for computation.
5. Perform all operations with **conservative monitoring, no unnecessary SSH reconnects, no login-node workloads, and no disruption of other cluster users**.

### 1.2 Primary user

One student operating a personal MacBook, already authorized to use ICF. Initial environment evidence:

- User SSH identity example: `s3019665`; home example: `/home/s3019665`. **Do not hardcode these; derive from authenticated session.**
- Direct ICF login node observed: `hastings`.
- Gateway used outside Informatics: `student.ssh.inf.ed.ac.uk`.
- Example remote virtual environment: `~/projects/icf-env`.
- CUDA toolchain observed: `/home/htang2/toolchain-20251006/toolchain.rc`; **optional, verify existence**.
- Existing example partitions from actual output: `Interactive`, `Teaching`, `ICF-Free`, `ICF-Research`, `Open-Research` (inventory is not exhaustive and changes).
- Observed types: RTX 2080 Ti, RTX A6000, H200 with MIG slices; physical/MIG partitions may overlap.
- Official tutorial: <https://homepages.inf.ed.ac.uk/htang2/notes/icf/>.

### 1.3 Out of scope (unless explicitly approved later)

- Bypassing cluster ACLs, quotas, MFA, fair-share policy or SSH security.
- Installing GPU-reservation agents, agents/services, Docker, or new software on the login node.
- Mining, crypto, automatic large-scale job bursts, multi-tenant administration or a public API.
- Substituting a custom Python interpreter for VS Code. **VS Code is an external editor; remote Python is the interpreter.**
- Per-process GPU utilization of **other** users by SSHing into every compute node.
- Continuous background surveillance when the desktop application is closed.
- Cloud backend, user analytics, ad/telemetry SDKs, or external credential sync.

---

## 2. Technology and architecture — agreed default

**Desktop stack:** Tauri **v2**, React, TypeScript (strict), Vite, Rust backend, native macOS Keychain (Security.framework via a maintained Rust crate or a small audited native bridge), Apple System OpenSSH (`/usr/bin/ssh`), and optional native file dialogs.

- Frontend: React + TypeScript, accessible component library, React Query/TanStack Query for cache/status; simple CSS tokens with dark/light/system themes.
- Backend: Rust Tauri commands handle all filesystem access, Keychain access, SSH process lifecycle, remote command whitelisting, data parsing and job operations. **Frontend never spawns shell commands directly**.
- Shell: use macOS installed OpenSSH rather than implementing unverified SSH crypto or a parallel authentication system; respect `~/.ssh/config` and `ProxyJump`.
- Credential prompt: securely integrate OpenSSH password/keyboard-interactive challenges using an audited, bundled macOS askpass helper with a **narrow, ephemeral IPC channel**. Requirements and fallback in §4. **Do not assume plain `SSH_ASKPASS` trivially solves two-hop, multiple-challenge, or MFA flows**.
- Data: in-memory typed models; non-sensitive preferences and cached snapshots only in app-local state. SQLite optional in V3 for local history, with bounded retention.
- No inbound listening server needed; no localhost web API unless an explicit design decision and threat analysis approves one.

### 2.1 Boundaries / data flow

```text
┌───────────────────────────── macOS ─────────────────────────────┐
│ ICF Control Center.app (Tauri 2)                                │
│  React UI ── typed invoke() ── Rust command/service layer        │
│        │                     ├─ Keychain adapter               │
│        │                     ├─ SSH manager + bounded parser   │
│        │                     ├─ SLURM capability adapter       │
│        │                     ├─ job orchestration + SFTP/scp  │
│        │                     └─ VS Code launcher               │
│        └── state/cache/event subscriptions                      │
└───────────────────────────┬────────────────────────────────────┘
                            │ existing SSH config / ProxyJump
              student.ssh.inf.ed.ac.uk (jump host)
                            │
                       icf → hastings
                            │  sinfo / squeue / scontrol / sbatch
                            ▼
                     SLURM scheduler
                   ┌────────┴─────────┐
             queued jobs       compute node allocation
                                      │
                         /disk/scratch (per job)
                                      │
                        copy result → /home (NFS)
```

**Important:** Never open a privileged or general-purpose SSH shell in the UI by accepting arbitrary user text. The advanced job template and VS Code are the supported user-controlled code paths.

### 2.2 Desired monorepo / initial repository structure

```text
icf-control-center/
├── README.md                       # quickstart, prerequisites, screenshots, limitations
├── AGENTS.md                       # concise mandatory coding-agent rules derived from this spec
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vite.config.ts
├── index.html
├── src/
│   ├── app/                        # application shell, routing, providers
│   ├── components/                 # accessible reusable components
│   ├── features/
│   │   ├── connection/             # login, fingerprint, connection state
│   │   ├── cluster/                # partitions, nodes, GPU views
│   │   ├── jobs/                   # submit, queue, detail, logs, cancel (V2)
│   │   ├── projects/               # VS Code, project/env selectors (V3)
│   │   └── transfers/              # scratch/results workflows (V3)
│   ├── lib/                        # typed API clients, formatters, error maps
│   ├── types/                      # TS domain types mirroring Rust models
│   └── styles/                     # design tokens
├── src-tauri/
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── capabilities/               # explicitly scoped Tauri permissions
│   ├── src/
│   │   ├── lib.rs
│   │   ├── commands/               # narrowly-scoped frontend RPC
│   │   ├── auth/                   # Keychain / askpass / prompts
│   │   ├── ssh/                    # config resolution, sessions, timeouts
│   │   ├── slurm/                  # capability detection, parsers, normalization
│   │   ├── jobs/                   # validator, template generator, supervisor
│   │   ├── filesystem/             # path validation, transfers, cleanup
│   │   ├── integrations/           # VS Code CLI
│   │   ├── state/                  # app state, bounded caches, rate limiter
│   │   └── errors.rs              # safe structured errors
│   ├── helpers/                    # signed/bundled askpass helper if selected
│   └── tests/                      # Rust integration and recorded-fixture tests
├── fixtures/
│   ├── slurm/                      # synthetic & scrubbed CLI output fixtures
│   └── ssh/                        # mock session state, never actual credentials
├── scripts/                       # local dev scripts; NO automatic remote installers
├── tests/                         # UI/e2e, mock SSH integration tests
├── docs/
│   ├── ARCHITECTURE.md
│   ├── SECURITY.md
│   ├── DECISIONS.md
│   ├── CLUSTER_COMPATIBILITY.md
│   ├── USER_GUIDE.md
│   └── RELEASE_CHECKLIST.md
└── plans/
    ├── V1_FOUNDATION.md
    ├── V2_JOBS.md
    └── V3_WORKFLOWS.md
```

Do not generate all empty folders upfront; create modules when the relevant version requires them. The four Markdown files in this bundle are **planning documents**, not an implemented repository.

---

## 3. User experience requirements

### 3.1 Application shell

- macOS native-ish window, responsive to 1280×800 and compact laptop sizes; no mandatory account with third-party services.
- Sidebar: **Overview**, **Partitions**, **GPU Nodes**, **My Jobs** (V2), **Projects** (V3), **Settings**.
- Persistent top banner: selected profile, connection state, most recent successful update, stale indicator, optional backend version.
- Differentiated states: `Disconnected`, `Connecting`, `Waiting for authentication`, `Connected`, `Refreshing`, `Degraded`, `Offline`, `Reconnecting (user initiated)`, `Authentication failed`.
- Clear, distinct empty state when *no GPUs are free* versus *data unavailable*, *not authorized*, *no nodes in partition*, and *filtered out*.
- Sorting/filtering/search over model, partition, node, VRAM, state; chart and count values derived from same normalized snapshot.
- Follow OS appearance preference, keyboard navigation, VoiceOver-compatible labels, visible focus rings, reduced-motion support, no color-only availability encoding.
- Remember last selected **non-sensitive** partition and filters; clear cache when switching SSH identity.

### 3.2 Login screen — MUST

- `Username (UUN)` input; `Password` secure input; **Connect** button; **Remember password in macOS Keychain** checkbox, initially OFF; show/hide password control; progress and cancel controls.
- Optional advanced connection profile: SSH alias (default `icf`), jump-host alias/address, SSH key/agent preference, **separate gateway and ICF credentials** when needed.
- The user can select `Use existing SSH config/agent` rather than password-based auth. This remains the recommended low-friction path.
- If both hops require passwords: prompt separately when needed; offer “Use same password for both hosts” **only with explicit user choice**. Never assume both identities/passwords are identical.
- Save passwords only after successful auth and affirmative checkbox; save separately per `{profile, username, authenticated host}` in Keychain, not one global password. Retrieve only for a connection initiated by the user.
- Allow **Forget saved password** (delete Keychain entries for selected profile); show whether a credential is stored without displaying its value.
- Respect OTP/MFA and keyboard-interactive prompts without storing or auto-replaying OTPs, recovery codes or password-change prompts.
- First-use trust of **each** SSH hop requires a fingerprint confirmation using an out-of-band verified fingerprint when possible; never auto-accept unknown host keys without warning or bypass changed-key alarms.
- If host key changed, **block connection** and show actionable recovery advice; no `StrictHostKeyChecking=no` or `/dev/null` known-hosts.
- Prevent repeated automatic auth attempts on failure. Avoid account lockouts: max **3 failed attempts** in a session, require explicit further user action and show cooldown guidance.
- `Disconnect` cancels application-owned requests and polling, clears in-memory password strings, stops askpass helpers; does **not** automatically cancel submitted SLURM jobs or close the user's independent VS Code sessions.

### 3.3 GPU overview — MUST in V1

- Show all partitions actually visible to authenticated user, not just `Teaching` and `ICF-Free`; show `Interactive` explicitly.
- Partition cards: actual name, scheduler availability, default marker, `MaxTime`, node count, known configured GPUs, known allocated GPUs, potentially free GPUs, `Unknown` where data cannot be trusted.
- Node rows: physical node ID, list of partitions, state (`idle`, `mixed`, `allocated`, `down`, `drain`, etc.), GPU GRES/MIG types and counts, allocated count where available, CPU and memory if available, freshness.
- Filter “Eligible for me” if permissions can be confirmed. If not, label “Visibility does not imply eligibility.”
- **Never count partition membership as extra physical GPUs.** De-duplicate by physical node identity in fleet-wide totals.
- MIG GPUs: present scheduler-reported GRES as separate allocatable resource types, and distinguish the underlying physical H200 from MIG slices. Do not add full GPU and its MIG slices as separate physical capacity.
- Do not claim “free GPU memory” or “GPU utilization” from SLURM occupancy. Physical runtime metrics require an authorized compute-node context and are not part of V1.
- Refresh is manual and periodic while the window is active; show `Last updated 14:32` / `Data stale` / `Refresh failed`.
- Link to official cluster status webpage as **external URL**, not as a source of individual user credentials or a scraping target.

### 3.4 Job creation / GPU request — MUST in V2

- Button label **Request GPU / Submit Job**. Never “Rent GPU” or “Book GPU” with implied immediate availability.
- Wizard: partition, GPU resource type, count, CPUs, host RAM, wall time, job name, script location/entry point, remote working directory, environment bootstrap and output/log paths.
- Default to **one GPU**, conservative CPU and RAM, partition-driven max wall time. Warn on multi-GPU requests because longer queues are possible.
- Display estimated eligibility, configured availability, and a preview of the exact `sbatch` script. Do not promise scheduling order, queue wait or price.
- Validate capabilities and selections again immediately before submission; actual acceptance determined by remote `sbatch` and scheduler.
- Submit through a **single `sbatch --parsable` call**. Capture numeric ID and cluster suffix if present; de-duplicate client retries via explicit manual confirmation after an uncertain network result.
- Persist local job references (profile/username/job ID/submit time) without secrets. Show pending/running/completed/failed/cancelled/timeout/requeued/unknown.
- Per-job actions: `Inspect`, `Open log` (bounded tail), `Copy job ID`, `Open working directory in VS Code` (V3 enhancement), `Cancel` with confirmation **only for your jobs**.
- `Interactive` requests must be limited to explicit debug workflows and not silently submitted as unattended long-running jobs; no `srun --pty` controlled by a webview terminal.
- No automatic resubmission, looped retries, hold/release, `sudo`, `scontrol update`, or partition-priority manipulation.
- Show submission rejected/queued/scheduled/unavailable states as distinct outcomes.

### 3.5 VS Code and Python workflow — MUST in V3

- **Open in VS Code** launches installed external VS Code, using its Remote - SSH extension and existing SSH host alias (e.g., `icf`).
- Supported CLI example: `code --remote ssh-remote+icf /home/<UUN>/projects/<project>`; discover the real CLI/install path and validate with `code --help`. If unsupported/missing, show steps to install VS Code's `code` command and Remote - SSH.
- VS Code is an **editor/debug UI**, not itself an interpreter. Offer to select an existing **remote interpreter** (e.g., `/home/<UUN>/projects/icf-env/bin/python`), and optionally create `.vscode/settings.json` **only with user permission**, preserving existing settings.
- Show prominently: ordinary **Run Python File** in Remote SSH executes on the *login node* unless configured otherwise. Long training MUST be launched using SLURM.
- Optional “Run selected script as batch job” produces/reviews a SLURM script; does not redirect `Run` buttons or override VS Code extensions without consent.
- No attempt to allocate a GPU simply by choosing a Python interpreter.

### 3.6 Data, cache, checkpoints, logs — MUST in V3

- Home `/home/<UUN>` is shared NFS; appropriate for scripts, venv, durable (but not backed-up) results, lightweight configs.
- `/disk/scratch` is local to each compute node; use **per-job private directory**, e.g. `/disk/scratch/<UUN>/<SLURM_JOB_ID>` after runtime validation, not before allocation.
- For data staging, support a **single archive** per dataset (tar/zip with validated paths) instead of copying thousands of small files. Unpack **inside allocated compute node**; never on login node.
- Use `trap` / robust exit handling and bounded signal grace to copy results back even when training fails; never falsely guarantee result recovery after power loss, time limit, or node failure.
- Safe cleanup only within verified job-specific scratch; never recursively delete `/disk/scratch`, `/home`, or paths supplied unvalidated by frontend.
- Cache Hugging Face datasets/model downloads on local scratch when feasible and avoid redundant downloads; provide offline/retry behavior.
- Stream bounded logs (`tail -n ...` or offset based), escape terminal/control sequences and rendered text; no untrusted ANSI-to-HTML injection.
- Recommend separate backup for important results: NFS is not backed up; if configured/permitted, AFS is backed up, or use user-managed Git/private storage. **Do not assume AFS prefix, permissions or quota.**

---

## 4. Security, SSH and identity contract

### 4.1 SSH config & connection profiles

Resolve the user's existing `~/.ssh/config` host aliases rather than overwrite them. Default example (for documentation, not automatic modification):

```sshconfig
Host edinburgh-jump
    HostName student.ssh.inf.ed.ac.uk
    User <UUN>

Host icf
    HostName icf
    User <UUN>
    ProxyJump edinburgh-jump
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

Connection profile stores **alias + non-sensitive preferences**, never plaintext passwords or OTP. `ssh -G icf` can be used locally to inspect effective configuration (sanitize logs and **do not** expose private identity-file information unnecessarily). No real SSH network connection is required just to validate syntactic config.

### 4.2 Mandatory auth design spike before implementing the Login button

A password GUI with OpenSSH + `ProxyJump` is nontrivial. Implement a V1 spike verifying the end-to-end flow using fake SSH servers or test credentials **before** claiming support:

1. SSH key/agent authentication; password authentication to the destination; password authentication at both hops; distinct passwords; wrong password; 2FA/keyboard-interactive; changed/unknown host key; Cancel while prompt is active.
2. Use an **app-owned, signed/bundled, narrowly scoped `SSH_ASKPASS` helper** that can securely ask the native app for the correct secret only during an active user-initiated connection. `SSH_ASKPASS_REQUIRE=force` can be investigated; confirm actual macOS OpenSSH behavior, including hop prompts and no-tty subprocess behavior. Do not depend on an unspecified GUI display variable working magically.
3. Use unique, ephemeral challenge IDs and a private IPC channel (e.g., user-owned UNIX socket with verified peer credentials or audited platform IPC); no password in process argv, URL query, environment, stdout, logs, disk temp files, or general-purposed clipboard.
4. **Never respond to an unknown prompt by blindly submitting a saved password**. An explicit allowlist must recognize password challenges and bind them to the verified hop/host. Unrecognized prompts are surfaced for manual handling or the connection fails closed.
5. Reject ambiguous challenge-host association; do not silently replay credentials to the wrong hop. Do not auto-fill OTP/MFA/changed-password prompts.
6. Success requires authenticated completion of a harmless remote identity command (`id -un`, `hostname`), not just TCP port 22 reachability or a connected socket. Do not send credentials until host-key validation succeeds.
7. If password askpass integration cannot pass the above security tests, keep safe **SSH-agent/key support** and provide a **native interactive authentication fallback** using system OpenSSH; mark in-app password-connect unsupported rather than shipping an unsafe workaround.

**No `sshpass`, `expect`, insecure keychain scripts, shell-based secret injection, `StrictHostKeyChecking=no`, plaintext `.env` password, or default accept-all fingerprint behavior.**

### 4.3 Keychain, lifecycle, least privilege

- Use macOS Keychain generic password entries with an app-specific service identifier and per-profile/account key. OS-controlled access confirmation is acceptable.
- `Remember password` **OFF by default**. Save after successfully authenticated user request, not on every keystroke. Never backup credentials through app export/sync.
- Store credential references in Rust memory only for the lifetime of the request; best-effort zeroization on drop; never retain long-lived passwords in JS state after handoff, logs, telemetry, crash reports, or persisted caches.
- Profile removal includes an explicit separate choice to remove associated Keychain items.
- On app lock/sleep/logout (where available), suspend polling; on resume refresh only when window is active and credentials/session support it.
- Separate Tauri capabilities: read-only cluster views vs mutating job APIs. No general `shell:execute` permissions from untrusted frontend input. Use app-specific commands with strict validation.
- CSP disallows remote scripts by default; no `eval`, arbitrary remote code execution service, runtime plugin loading, or insecure navigation.
- Open external URLs and VS Code only with explicit user action and validated scheme/paths.

### 4.4 SSH lifecycle & safe “ping”

**Do not implement ICMP ping or port scanning** as a health-check. “Connection test” means a bounded SSH authentication + safe remote identity command when the user clicks Connect/Test.

- One connection operation at a time per profile; in-flight requests coalesced and cancelable.
- Prefer an existing connection/control master only where well supported and secure; inspect OpenSSH multiplexing support. Control socket path private (`0700` directory), randomized, cleaned up on disconnect. Do not keep idle masters indefinitely.
- Timeout budget: local SSH start 5s; connection/auth configurable maximum 20–30s; individual read-only SLURM commands 10–15s; no unbounded waits. Surface `timeout`, `authentication`, `host-key`, `network`, `permission`, `scheduler` separately.
- Detect disconnected/stale SSH via actual command results. **No independent heartbeat more often than once every 120 seconds**, and only if absolutely needed while actively connected and visible. Prefer results of scheduled SLURM polls over additional heartbeat SSH calls.
- Authentication retries are never automatic. For transient non-auth/network failures, exponential backoff (minimum 15s, doubling to max 5min, jitter), stopping when app hidden/offline/user disconnected.
- Cancellation kills app-owned local processes and IPC helpers; does **not** kill remote jobs unless user explicitly cancels one.
- Default to no auto-connect on app start when a password is required; if optional agent-only auto-connect is enabled, be conservative and provide an obvious opt-out.

---

## 5. Cluster query, parsing and polling contract

### 5.1 Initial capability discovery

On successful login, execute a **single grouped capability probe**, not dozens of expensive commands:

- `command -v sinfo squeue scontrol sbatch scancel` or equivalent narrow checks.
- SLURM version (`sinfo --version`) and support for desired JSON flags by exit code/help, once per session; cache capability selection.
- Current identity (`id -un`), home (`printf '%s' "$HOME"` via a strictly fixed command) and remote hostname (`hostname`).
- Partition policy if supported: `scontrol show partition` and/or suitable formatted `sinfo` outputs, with minimal data volume.
- No tools installed remotely and no dependence on parsing login banners.

### 5.2 Read-only commands

Prefer structured JSON **when supported by installed SLURM**; fallback to fixed column/line formats with fixture-backed parsers.

| Information | Preferred / fallback sources | Frequency |
|---|---|---|
| Partitions & physical nodes | `sinfo --json` or `sinfo -N -h -o ...` | On connect, then ≤1 per 45–60s |
| GPU allocations (GRES used/configured) | `sinfo -O ...` and/or `scontrol show node` | On connect, then ≤1 per 60s or on node detail |
| My jobs | `squeue --json -u <remote_username>` or fixed-format `squeue` | V2, ≤1 per 30–45s while visible |
| Job details | `scontrol show job <verified_id>`; `sacct` if permitted | User opens detail / bounded follow-up |
| Job logs | Bounded remote tail of user-owned paths | User views log, ≤1 per 5–10s |

**Rules:**

- At most one cluster-inventory refresh at a time. No fan-out of a remote command per GPU or node.
- Global periodic cluster overview **60 seconds by default**; minimum 45 seconds, explicit Refresh has a 10-second debounce and shares an in-flight refresh. Additional details on demand; no auto-refresh when window hidden/minimized/backgrounded or disconnected.
- Rate budget across client: aim ≤3 read-only SLURM commands/minute during basic idle viewing (overview only). Job monitoring has its own bounded budget and only when relevant screens are visible.
- Stop/reduce polling on SSH failures, SLURM errors, sleeping Mac, metered/offline network, SSH auth prompt, app backgrounded, or cluster busy. Backoff with jitter.
- Handle command output size limits (e.g. 1–2 MiB for compact inventory), execution timeouts, UTF-8 errors, version variants and concurrent state changes.
- Store `fetchedAt`, `source`, `age`, `partial`, `warnings`, `permission_scope`. Last-good cache can display stale, but never as fresh.
- Do not scrape `icfwebview.inf.ed.ac.uk` to bypass access or create an unapproved scraper; external link only unless documented API access is granted.

### 5.3 Normalized data model (conceptual)

```ts
type ConnectionState =
  | 'disconnected' | 'connecting' | 'auth_required' | 'connected'
  | 'degraded' | 'offline' | 'auth_failed';

type ResourceConfidence = 'exact' | 'estimated' | 'unknown';
type NodeState = 'idle' | 'mixed' | 'allocated' | 'down' | 'drain' | 'unknown';

type GpuResource = {
  gresName: string;             // e.g. gpu:nvidia_rtx_a6000, gpu:h200_3g.71gb
  modelLabel: string;
  granularity: 'physical' | 'mig' | 'unknown';
  configured: number | null;
  allocated: number | null;
  potentiallyFree: number | null;
  confidence: ResourceConfidence;
};

type ComputeNode = {
  id: string;
  partitions: string[];        // node may belong to multiple partitions
  state: NodeState;
  resources: GpuResource[];
  cpuTotal?: number | null;
  cpuAllocated?: number | null;
  sourceTimestamp: string;
  warnings: string[];
};

type Partition = {
  name: string;
  isDefault: boolean;
  state: 'up' | 'down' | 'unknown';
  maxTimeSeconds: number | null;
  nodeIds: string[];
  eligibility: 'confirmed' | 'not_permitted' | 'unknown';
};

type ClusterSnapshot = {
  clusterName: string;
  fetchedAt: string;
  stale: boolean;
  partial: boolean;
  partitions: Partition[];
  nodesById: Record<string, ComputeNode>;
  warnings: string[];
};

type JobState =
  | 'pending' | 'configuring' | 'running' | 'completing' | 'completed'
  | 'failed' | 'cancelled' | 'timeout' | 'node_fail' | 'unknown';
```

For job models add `{cluster, profileId, owner, jobId, name, partition, resources, state, submittedAt, startedAt?, endedAt?, exitCode?, stdoutPath?, stderrPath?, lastUpdatedAt}`. Dates use explicit offsets/UTC and are formatted locally. Treat numeric IDs as validated strings to preserve possible scheduler suffixes.

### 5.4 GPU accounting and eligibility

- **Never** count a GPU as truly allocatable simply because `STATE=idle` and `GRES` lists units: limits, QoS, ACLs, pending scheduler decisions and GRES bindings matter.
- Parse `CfgTRES`/`AllocTRES`, `Gres`/`GresUsed`, node status and partition membership where available. Only subtract like-for-like resources, respecting resource type and MIG semantics.
- For `mixed` nodes, `allocated=unknown` until allocation fields are read; zero GPU memory usage in `nvidia-smi` is **not** a reliable SLURM-free test.
- Present `potentially free` and `unavailable (down/drain)` separately; false precision is prohibited.
- No automatic, invisible “probe jobs” submitted to test availability. Requesting resources itself is a scheduling action and requires user intent.
- If queue/limits require special account/QoS, show informative errors without guessing values; surface options only from observed scheduler configuration.

---

## 6. Backend API contracts (logical; implement as typed Tauri commands)

| Command | Access | Input | Output / notes |
|---|---|---|---|
| `connection_profiles_list` | V1 read | none | Public profiles only |
| `connection_test_and_login` | V1 auth | profile, username, transient password(s), save flags | Connection state + user identity; secrets not echoed |
| `connection_disconnect` | V1 auth | profileId | Stops app-owned SSH/polling, not jobs |
| `connection_forget_credentials` | V1 sensitive | profileId + confirmed action | Keychain delete, status only |
| `cluster_get_snapshot` | V1 read | forceRefresh boolean | Snapshot + freshness metadata |
| `cluster_get_node_detail` | V1 read | verified nodeId | On-demand bounded detail |
| `jobs_preview` | V2 local | typed validated form | Exact SLURM script, warnings, eligibility |
| `jobs_submit` | V2 mutation | reviewed immutable preview/hash | Job ID, scheduler receipt, explicit success/failure |
| `jobs_list_mine` | V2 read | filters, cursor | User-owned jobs only |
| `jobs_get_detail` | V2 read | verified jobId | normalized status/errors |
| `jobs_get_log_tail` | V2 read | verified jobId, stream, bounded cursor | sanitized bounded text |
| `jobs_cancel` | V2 mutation | verified own jobId, confirmation token | cancel receipt; state observed later |
| `projects_open_in_vscode` | V3 local launch | validated project path + profile | launch result; no secret in CLI |
| `projects_list_interpreters` | V3 read | allowed remote project path | visible remote Python paths only |
| `workflow_preview_staging` | V3 local | project + dataset + job | archive/transfer/cleanup plan |
| `workflow_submit_staged_job` | V3 mutation | immutable reviewed plan | Job ID & local workflow reference |
| `workflow_get_transfer_status` | V3 read | workflowId | phase, bytes, errors |

- No dynamic `execute_command(raw: string)` API exposed to the React frontend.
- Parse/validate all inputs again in Rust; use `std::process::Command` argv vectors for local processes; remote invocation must be built from fixed command templates and safely encoded strictly typed values (prefer sending generated script by stdin rather than interpolating user content into a remote shell).
- Return structured error codes (`SSH_AUTH`, `SSH_HOST_KEY`, `SSH_TIMEOUT`, `SLURM_UNAVAILABLE`, `SLURM_PERMISSION`, `NO_RESOURCE`, `JOB_SUBMIT_UNCERTAIN`, `INVALID_PATH`, etc.) and non-sensitive user messages.
- On unstable network after submission, **never automatically retry sbatch**. The scheduler might have accepted the first request; search own recent jobs and require explicit user choice.

---

## 7. Performance, reliability, privacy, testing

### 7.1 Nonfunctional acceptance targets

- App startup to usable cached/empty shell: p95 ≤2s on supported Apple Silicon Mac with warmed assets (development telemetry optional; local only).
- Initial cluster fetch: bounded by SSH authentication; subsequent warm snapshot p95 ≤5s under healthy network; *not* a scheduler SLA.
- UI remains responsive during network/SSH timeouts (no blocking main thread).
- Repeated clicks coalesce; at most one active login and inventory refresh per profile.
- Safe cancellation/cleanup: no leaked askpass sockets/helpers/SSH children.
- Authentication failures never trigger a repeated loop; status polls pause on failure.
- Accessibility: keyboard flows, labels, screen reader checks; contrast consistent with WCAG AA where feasible.
- Support Apple Silicon macOS initially; Intel macOS optional only after build/test validation. Document minimum tested OS version.
- No analytics/telemetry by default; local diagnostics opt-in and secret-redacted; bounded local log retention (e.g. 7 days / 10 MiB).

### 7.2 Automated quality gates

- Rust: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.
- Frontend: `pnpm lint`, `pnpm typecheck`, `pnpm test`, production `pnpm build`.
- UI/E2E: Playwright or equivalent against mock backend. Important authentication and destructive-action flows included.
- Fixture-based parser tests for multiple SLURM versions, malformed/missing GRES, mixed/down/drain, overlapping partitions, unknown resource counts, MIG resources, `slurm-<jobId>.out`, no jobs, and stale snapshots.
- Security tests: dangerous form input (`;`, quotes, newlines, `$(...)`, path traversal), changed SSH host key, wrong password, prompt injection in stderr, swapped credential challenge, timeouts, disconnection, duplicate submission, foreign-job cancellation, unsafe archive entries/symlinks.
- Integration tests with an **isolated local SSH mock server**/stub or provided test cluster only; no automated real ICF load or mutation.
- Manual opt-in acceptance on actual ICF: inspect inventory; run exactly one **small, permitted** test job; inspect output; cancel a separately approved test job; verify polling stays within budget.

### 7.3 Privacy

- No exposure of password/Keychain values to frontend after login completes; frontend fields cleared.
- Do not log full user home path if the diagnostics mode doesn't require it; redact UUN by default in exported diagnostics.
- Snapshot contains metadata accessible to the authenticated account; avoid collecting identities of other cluster users except information inherently needed by an authorized SLURM command. Do not expose detailed other-user job listings by default.
- Never send any data to third parties; documentation links open external browser only by deliberate user action.

---

## 8. V1–V3 release gates & roadmap

| Milestone | User-visible deliverable | Required gate |
|---|---|---|
| **V1 — Secure Connection & Observability** | Login/Keychain, SSH, dashboard, partition/node/GPU status, manual/low-rate refresh | Proven secure auth flow; accurate de-duplicated snapshots; no mutations |
| **V2 — GPU Job Manager** | SLURM form/preflight, submit, job list/details/logs/cancel | Correct scheduler outcomes; explicit confirmations; no duplicate jobs |
| **V3 — Developer Workflow** | VS Code launch, remote interpreter setup, scratch staging, batch templates, safe result transfer | No GPU computation on login; reliable cleanup/recovery; full end-to-end training smoke test |

**Version plans:**

- [V1: Foundation, SSH login, Security, GPU dashboard](plans/V1_FOUNDATION.md)
- [V2: GPU allocation/job orchestration](plans/V2_JOBS.md)
- [V3: VS Code, datasets/scratch and end-to-end ML workflows](plans/V3_WORKFLOWS.md)

### Definition of Done for **each** version

- [ ] Required features pass plan-specific acceptance criteria and security gate.
- [ ] Work is reviewed for credential handling, subprocess injection, SLURM policy and failure recovery.
- [ ] Automated tests pass and relevant edge cases have fixture tests.
- [ ] User-visible error messages and empty/loading/stale states work.
- [ ] User guide, architectural diagrams, ADRs, release notes updated.
- [ ] Signed/notarized distributable documented if distribution is needed; development `.app` demonstrably launches on macOS.
- [ ] No hidden setup or background load on ICF; all real-world cluster tests require explicit user consent.

---

## 9. Decisions, constraints, unknowns (discover; never assume)

1. Can user authentication to **both** the gateway and `icf` be performed through macOS OpenSSH + secure askpass with the actual institutional prompts? This is the **V1 critical path**.
2. Do institutional policies authorize third-party client tools and local Keychain credential storage for university accounts? **Confirm before distribution/use**; if disallowed, support agent/interactive login only.
3. Does current ICF SLURM expose `--json`? Which `sinfo -O` formats and `scontrol show node` fields are available? Detect on connect.
4. What GPUs/MIG allocations and partition/account policies are available to this identity **today**? Discover live and never hardcode screenshot data.
5. Do requested partitions permit specific GPU types, time limits, memory and quotas for this user? The scheduler is authoritative.
6. Does `/disk/scratch` exist on every eligible node, and does `SLURM_TMPDIR` have site-specific precedence? Detect from within a job.
7. Which VS Code CLI and Remote - SSH versions are installed on the Mac? Validate locally.
8. Does the user want direct `.app` distribution outside the App Store, or signed/notarized distribution? V1 local development first.
9. Is there a supported ICF scheduler API or read-only institutional dashboard endpoint? Prefer only when **documented and authorized**, never scrape blindly.
10. Are there additional university rules restricting frequency of `sinfo`/`squeue` or interactive workloads? If so, those rules override default polling budgets here.

---

## 10. Source references (for implementers to verify)

- **ICF-specific** official tutorial (SSH jump, partitions, `/disk/scratch`, custom toolchain, `Interactive` vs `Teaching`, `sbatch`): <https://homepages.inf.ed.ac.uk/htang2/notes/icf/>
- **SLURM** official GRES/MIG / allocations reference: <https://slurm.schedmd.com/gres.html>
- **SLURM** command references: <https://slurm.schedmd.com/sinfo.html>, <https://slurm.schedmd.com/squeue.html>, <https://slurm.schedmd.com/sbatch.html>, <https://slurm.schedmd.com/scontrol.html>
- **VS Code** Remote SSH: <https://code.visualstudio.com/docs/remote/ssh>
- **VS Code CLI** and `--remote`: <https://code.visualstudio.com/docs/configure/command-line>
- **Tauri 2** and capability security: <https://v2.tauri.app/start/>, <https://tauri.app/security/capabilities/>, <https://tauri.app/security/permissions/>
- **macOS Keychain** Apple Security framework documentation: <https://developer.apple.com/documentation/security/keychain_services>
- **OpenSSH** (read the installed `man ssh`, `man ssh_config`, `man ssh-add`, especially host-key checking, ProxyJump, ControlMaster, and askpass).

> **Policy precedence:** Current institutional security guidance and scheduler policy > live cluster limits > this design > example commands or screenshots. A coding agent must stop and ask before using any workaround that violates a higher-priority rule.
