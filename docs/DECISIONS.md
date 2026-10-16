# Decisions (ADR log)

## ADR-001 — Askpass helper is the app binary itself
*Status: accepted (V1).* OpenSSH runs `$SSH_ASKPASS`; we point it at our own executable, which
detects helper mode via `ICFCC_ASKPASS_SOCK` before any GUI code runs and only forwards the prompt
over the private socket. No second binary to sign or bundle; the helper is always the same signed
code as the app. Exit status 1 = deny, which makes ssh fail closed.

## ADR-002 — Fixed-format `scontrol show partition|node -o` instead of `sinfo --json`
*Status: accepted (V1).* `scontrol -o` exists on every supported SLURM, gives one record per line with
`Gres`, `CfgTRES`, `AllocTRES`, `Partitions` and state in a single RPC each, and its output is small.
JSON layouts vary between SLURM releases and `sinfo --json` can be several MB. The probe still records
whether `--json` is available (shown in Settings). Revisit if ICF output proves ambiguous.

## ADR-003 — Foreground `-N` ControlMaster, no ControlPersist
*Status: accepted (V1), supersedes the first prototype.* With `ControlPersist`, OpenSSH 10.3 sends
its own and the ProxyJump child's stderr to /dev/null (reproduced locally), so "host key CHANGED"
became indistinguishable from a network error. The app now owns a foreground `ssh -N` master,
detects authentication by the control socket appearing, runs the probe over the mux, closes after
30 min idle, and on startup cleans up masters orphaned by a crash (owner pid file).

## ADR-004 — Eligibility is deny-only
*Status: accepted (V1).* `AllowGroups` vs `id -Gn` can prove "not permitted"; nothing visible to a
user proves a job will be accepted (accounts, QoS, limits). The UI never shows "eligible", only
"Unknown" or "Not permitted".

## ADR-005 — Allocation accounting rules
*Status: accepted (V1).* Per GPU type: typed `gres/gpu:<type>` in `CfgTRES` → exact; else untyped
`gres/gpu` total → exact only if the node has one GPU type or the total is 0; GPUs not tracked in
`CfgTRES` → unknown. Down/drain nodes count as *unavailable*, never free. MIG profiles (`\d+g.\d+gb`)
are separate resource types and are excluded from physical GPU totals. Fleet totals iterate unique
nodes once.

## ADR-006 — Polling owned by the UI, budget enforced by the backend
*Status: accepted (V1).* TanStack Query schedules refreshes only while the document is visible.
Every request still passes `state::decide` (interval floor, 10 s manual debounce, backoff 15 s → 5
min with jitter) under a single-flight lock, so the budget holds even if the UI misbehaves.

## ADR-007 — No Playwright in V1
*Status: accepted (V1).* UI flows are tested with Vitest + Testing Library against an in-memory
mock backend that serves the Rust-generated demo snapshot JSON. A webview E2E harness can be added
in V2 if job flows need it.

## ADR-008 — One reviewed preview = at most one sbatch
*Status: accepted (V2).* Submission takes a server-side preview id, not a request: the exact script the
user reviewed is stored in Rust and consumed before sending. Duplicate client ids and concurrent
mutations are refused. Unknown outcomes are reported as *uncertain* and reconciled only on request via
the `icfcc-<tag>` job comment. There is no automatic retry path anywhere.

## ADR-009 — Program location and logs
*Status: accepted (V2).* Jobs run an existing script on ICF inside the user's home (a remote path, not a
local file). The wizard writes `#SBATCH --chdir=<workdir>` and logs to `<workdir>/slurm-%j.out|.err`.
Paths are validated locally and re-resolved on ICF (`readlink -f`, must stay under `$HOME`). Sourcing a
setup file outside home (e.g. a shared CUDA toolchain rc) is allowed only with explicit
acknowledgement.

## ADR-010 — Job polling and history
*Status: accepted (V2).* My Jobs polls `squeue` every 45 s only while visible (backend floor 30 s);
`sacct` history (7 days) at most every 5 min unless refreshed manually; if `sacct` is missing or
accounting is disabled the UI says history is unavailable instead of inventing it.

## ADR-011 — Nominal VRAM only
*Status: accepted (V2).* SLURM does not report GPU memory. The UI shows nominal per-GPU/MIG-slice memory
from the model name (a small table; MIG profiles carry their size) and labels it nominal. No free-memory
or utilisation claims.

## ADR-012 — `GresUsed` when available
*Status: accepted (V2).* If `scontrol show node` reports `GresUsed`, per-type allocation is taken from it
(exact). Otherwise the V1 TRES rules apply and multi-type nodes with only an untyped total stay Unknown
(as seen for the H200/MIG node on ICF).

## ADR-013 — Default gateway when `icf` is not configured
*Status: accepted (V2).* If the profile alias is `icf`, no jump host is entered, and `ssh -G icf` shows
no ProxyJump/ProxyCommand with hostname still `icf`, the connection adds `-J <UUN>@student.ssh.inf.ed.ac.uk`
(typed UUN, else the user `ssh -G` reports). The user's ssh config and any explicit jump host always win;
other aliases are never changed. Host keys of both hops are still verified interactively.

## Open questions (need the user or Informatics)
1. Exact prompt text of student.ssh.inf.ed.ac.uk and icf (password vs keyboard-interactive, MFA).
2. Whether storing the university password in the Keychain is permitted by policy.
3. Whether ICF publishes host-key fingerprints for out-of-band verification.
4. Any rule on `scontrol` frequency stricter than once a minute.
