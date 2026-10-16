# V2 Implementation Plan — GPU Requests, SLURM Jobs and Logs

> **Depends on:** [`../ICF_CONTROL_CENTER_SPEC.md`](../ICF_CONTROL_CENTER_SPEC.md) and a V1 that meets **all V1 acceptance criteria**.
> **Scope:** authenticated, explicit GPU job submission on SLURM (`sbatch`), own-job management, bounded log viewing and safe cancellation.
> **Excluded until V3:** automatic dataset staging to scratch, VS Code launch workflow, notebook GPU kernels, remote environment installers.

## 1. Outcome / demo script

User selects **Teaching → RTX A6000 → 1 GPU → 8 CPUs → 32 GB RAM → 12 hours**, chooses an existing user-owned project script, previews a correct SBATCH manifest, and clicks **Submit Job**. The app shows a **job ID**, `Pending`/`Running` state, allocated node when available, recent logs, and a separately confirmed **Cancel** action. All real actions happen only after explicit user commands. SLURM—not the UI—decides when GPU resources are actually assigned.

## 2. Prerequisites / compatibility gates

- V1 auth/Keychain, host-key checks, SSH cancellation, parser layer and poller pass tests.
- Verify remote `sbatch`, `squeue`, `scontrol`, `scancel`, optionally `sacct` are installed and usable. Site may restrict `sacct`; gracefully degrade.
- Query visible partition limits and GPU GRES names from current session; **do not hardcode** current node names or assume access to `ICF-Research`.
- Confirm the tutorial policy: use `Teaching` for normal batch training; `Interactive` only for short debugging. Avoid persistent `srun --pty` in a GUI process.
- Decide and document the exact code path for user-controlled Python training: selected **remote path** under the authenticated user's home, not a local file path magically available on ICF.
- Add an explicit **Dry preview** mode that performs no SSH mutations (used by default in tests).

---

## 3. Sequence of work

### M1 — Job schema and validation library

- [ ] Rust `JobRequest`: `profileId`, `partition`, `gresType`, `gpuCount`, `cpus`, `memoryMiB`, `timeLimitSeconds`, `jobName`, `workingDir`, `program`, `programArgs`, `environmentBootstrap`, `stdoutTemplate`, `stderrTemplate`.
- [ ] Generate JSON Schema / TypeScript types from Rust contract or keep a single checked source-of-truth. Reject unknown fields.
- [ ] Validate numeric bounds, partition limits, GPU GRES membership and permitted account/QoS values from discovery.
- [ ] Default to one GPU. Require extra confirmation for >1 GPU, requests over permitted policy time, or unknown eligibility.
- [ ] Validate job name as restricted characters and length; validate script paths (absolute, normalized, remote home allowed path, no NUL/newline/globs/path traversal). Establish policy for symlinks: by default reject remote paths resolving outside allowed user-owned workspace.
- [ ] Explicitly distinguish a **script to execute** from an **sbatch wrapper**; no double wrapping.
- [ ] Typed command builder with strict quoting / stdin transfers; refuse shell metacharacter interpretation in user-supplied metadata.
- [ ] Preflight has capability failure warning if specific GRES unavailable; actual scheduler remains authoritative.

**Output:** `jobs_preview()` returns a generated SBATCH script with validation messages and a stable hash of exactly what user reviewed.

### M2 — Job submission UX

- [ ] New Job wizard shows Partition, GPU Type/Count, CPUs, RAM, wall time, remote project, entrypoint, args, `icf-env`/custom env bootstrap, optional GPU-specific warning.
- [ ] Partition chooser sourced from live data. Card clearly states `Potential availability (snapshot timestamp)` rather than `Available now, guaranteed`.
- [ ] Advanced settings collapse CPU affinity, mail notifications (off by default), output paths, optional constraints/account only if authorized/discovered.
- [ ] A **Preview** step displays final SBATCH content and expected output directories, policy warnings and any inferred defaults.
- [ ] Button **Submit Job** requires review and separate user action. Disable while request is in flight; client ID prevents duplicate UI requests.
- [ ] Submission uses `sbatch --parsable` once and parses `job_id[;cluster]`. Do not include secrets in job script or env exports.
- [ ] If SSH connection breaks after submission was issued but before receipt, state is **Submission uncertain** and requires user reconciliation; **do not auto-submit twice**.
- [ ] Store sanitized job receipt (user, job ID, profile, timestamp, script checksum, safe output path) locally for reopening.

### M3 — Jobs list and detail

- [ ] `My Jobs` table: Job ID, name, partition, resource request, state, elapsed, queue wait when known, node (allocated only), submitted/started time, last refreshed.
- [ ] Read only **own jobs** by default; ensure active profile's authenticated username matches job owner. No unauthorized other-user views.
- [ ] `squeue` active jobs; `sacct` optional for historical terminal jobs; if `sacct` absent, show **history unavailable** rather than a fake completed list.
- [ ] Job state normalization (`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, `TIMEOUT`, `NODE_FAIL`, `REQUEUED`, `COMPLETING`) with robust unknown state.
- [ ] Partition/node metadata may change while job runs; always show authoritative job fields from SLURM and state timestamp.
- [ ] Poll **My Jobs view** at 30–45s while visible; no 1s polling. Combine refreshes/dedupe across components. Paused on app hidden.
- [ ] Detail page shows `scontrol show job` fields, scheduler reason codes, recent stderr/stdout, and safe re-open of results path; no claims about percent training complete without an explicitly instrumented source.

### M4 — Logs and cancellation

- [ ] View recent job stdout/stderr with limited tail (e.g. last 200 lines or 64 KiB; backend cap) or bounded cursor offset; never download unbounded logs on every refresh.
- [ ] Escape all output, sanitize control sequences; no HTML injection / terminal hyperlink execution. Avoid reading files outside job's verified owner/project context.
- [ ] Detect `slurm-%j.out` and custom output templates. Treat unresolved `%j`/`%x` placeholders safely; file names should be resolved from scheduler evidence and validated.
- [ ] Cancellation button only enabled for **own** pending/running jobs, with confirmation containing job ID and name.
- [ ] Remote `scancel <validated_job_id>` only after owner re-validation; backend rejects forged other-user IDs and confirmation token mismatch.
- [ ] Do not claim cancelled instantly; show **Cancellation requested**, then observe state transition on next allowed refresh.
- [ ] Never invoke `scancel -u`, wildcard/glob IDs, `scontrol update`, force delete, or blanket cancellations.

### M5 — Concurrency, resilience and policy

- [ ] Job-specific in-flight locks: prevent double submit/cancel; cache invalidation after successful mutations.
- [ ] Retry only safe idempotent read-only requests, with backoff. Never automatically retry `sbatch` / `scancel` after unknown network outcomes.
- [ ] `slurm --parsable` parsing tolerant of cluster suffix; preserve string IDs.
- [ ] Validate limits against **site** and **partition** on every preview/submit; time duration shown unambiguously (HH:MM:SS / d-hh:mm:ss).
- [ ] Cross-session job receipt management: jobs continue after logout/app close; closing app never calls `scancel` automatically.
- [ ] When partition full, disabled, user lacks permissions, requested GPU type absent, or QoS denied, display scheduler error and suggested non-destructive edit, no auto-rerouting to a different partition.
- [ ] UI occupancy bars update from resource snapshots, not job submission clicks; job accepted ≠ GPU allocated.

### M6 — Testing and controlled real-cluster acceptance

- [ ] Unit test script generator and all validation/error cases; snapshot test preview for GPU GRES and time formats.
- [ ] Mock SLURM subprocesses for accepted submission, reject invalid GRES, job queued, job starts, finishes, fails, unknown receipt and cancel errors.
- [ ] Verify injection resistance for quote/backtick/subshell/newline paths, script name, args, and log path; no arbitrary shell command path in backend RPC.
- [ ] Test two rapid clicks produce one submit; unknown outcome produces no auto-retry; two profiles cannot cancel each other's job.
- [ ] With user approval only, run **one short, minimal-resource** `Teaching` batch job and inspect output, then explicitly approve a second test of `scancel` if needed. No GPU-heavy training.
- [ ] Measure SSH/SLURM command count per minute with simulated 10-minute viewing session.
- [ ] Document changes in security and user guide; build `.app`.

---

## 4. Sample UI flow (not executable until V2)

```text
Overview → Teaching → Request GPU
  Partition: Teaching (confirmed allowed or Unknown)
  GPU resource: gpu:nvidia_rtx_a6000
  GPUs: 1
  CPUs: 8
  RAM: 32 GB
  Wall time: 12:00:00
  Project: /home/<UUN>/projects/semeval
  Entrypoint: train.py
  Environment: /home/<UUN>/projects/icf-env
       ↓ Validate
       ↓ Preview exact sbatch script
       ↓ Submit (single request)
  Receipt: 3678999      State: PENDING
       ↓
  My Jobs → 3678999 → Details / Logs / Cancel
```

Do not claim that the `nvidia_rtx_a6000` GRES is available at implementation time; the name here is an example from prior inventory.

## 5. State transitions and uncertain outcomes

```text
DRAFT → VALIDATED → PREVIEWED → SUBMITTING
                   ├─ policy error → DRAFT
SUBMITTING ── receipt received ──→ ACCEPTED / PENDING
SUBMITTING ── explicit error ─────→ REJECTED
SUBMITTING ── SSH timeout ────────→ SUBMISSION_UNCERTAIN
ACCEPTED/PENDING → RUNNING → COMPLETING → COMPLETED/FAILED/TIMEOUT
         └─ CANCEL_REQUESTED → CANCELED (only when observed)
```

The app does not manufacture transitions; normalized transitions reflect scheduler observations. `REQUEUED`, `NODE_FAIL`, and `UNKNOWN` are supported.

## 6. Version 2 acceptance criteria

- **V2-AC01:** Job wizard uses live capabilities and previews the *exact* script to be sent.
- **V2-AC02:** A single click submits at most once; receipt/job ID recorded; no double submit on timeout/reconnect.
- **V2-AC03:** An accepted/queued job is not shown as allocated/free GPU consumed until SLURM confirms allocation.
- **V2-AC04:** User can see queued/running jobs and on-demand details/logs with explicit freshness.
- **V2-AC05:** Log fetching is bounded, escapes unsafe content, and never reads another user's arbitrary files.
- **V2-AC06:** Cancellation requires confirmation and owner verification; does not cancel other users' jobs or all jobs.
- **V2-AC07:** Close/disconnect does not kill jobs; no background remote polls after window hidden.
- **V2-AC08:** SLURM rejection, unavailable GPU, exceeded partition wall time, unknown user permissions, network failure are recoverable UI states.
- **V2-AC09:** All generated scripts use appropriate environment activation where configured and never embed passwords.
- **V2-AC10:** Full test suite passes including mocked job lifecycle and one explicitly approved on-cluster smoke test.

## 7. Deliverables to the user

- Built app with GPU request wizard, My Jobs, Job Details/Logs, Cancel and Preview.
- `docs/USER_GUIDE.md` section on batch jobs, scheduler queuing and the difference between allocated vs utilized GPUs.
- Documented job manifest schema, clear error mapping and retry policy.
- V2 changelog/test report; V3 backlog for VS Code, scratch and ML workflow.

## 8. Agent stopping rules

Stop rather than ship if UI can submit two jobs on one click, if retries can duplicate jobs, if non-owner jobs can be canceled, if generic remote shell commands are exposed, if actual GPU availability is invented, or if interactive GPU shells are held open unnecessarily.

**Final agent response:** implemented features, tested scenarios, actual SLURM smoke test (if authorized), security review, open issues, next-step V3 readiness.
