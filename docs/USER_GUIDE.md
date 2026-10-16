# User guide (V1)

## Connecting

**No SSH config needed.** If `icf` is not set up in your `~/.ssh/config`, the app connects through the
Informatics gateway (`student.ssh.inf.ed.ac.uk`) automatically, as the UUN you type. Just choose
*Username and password*, enter your UUN and password, tick *Use the same password for the gateway and
ICF* if they are the same, and verify both host keys on first connect. An existing `Host icf` entry or
a jump host typed under *Advanced* always takes precedence.

1. Open **ICF Control Center**.
2. Choose a sign-in method:
   - **Use existing SSH config / agent** (recommended if `ssh icf` already works in Terminal with keys).
   - **Username and password**: enter your UUN and the password for the ICF login host. If the gateway
     (`student.ssh.inf.ed.ac.uk`) needs a password too, either type it under *Advanced → Gateway
     password*, tick *Use the same password for the gateway and ICF*, or answer the prompt when it
     appears.
3. Optional: tick **Remember password in macOS Keychain**. It is saved only after a successful login.
4. Click **Connect**. Prompts from SSH appear as dialogs:
   - **Verify host key** (first connection to each host): compare the fingerprint with one published by
     Informatics before clicking *I verified it*. If unsure, click *Reject and stop*.
   - **One-time codes / other questions**: answer manually; they are never saved.
5. **Cancel** stops the attempt immediately. After 3 failed sign-ins the app pauses sign-in for 5
   minutes to protect your account from lockout.

**Explore demo data** shows synthetic data (yellow *DEMO MODE* banner) without connecting.

## Reading the dashboard

| Symbol | Meaning |
|---|---|
| ○ green | Potentially free — the scheduler reports these GPUs unallocated. Not a reservation. |
| ● purple | Allocated by SLURM (not necessarily busy). |
| ✕ red | Unavailable: node down or draining. |
| ? hatched | Unknown: the scheduler did not report allocation; never treated as free. |

- Each physical node is counted once even if it belongs to several partitions; partition cards can
  therefore add up to more than the fleet total.
- MIG slices (e.g. *H200 3g.71gb*) are listed separately from full GPUs.
- *Visibility does not imply eligibility*: the scheduler decides which partitions accept your jobs.
- *Data stale* means the last refresh failed or the data is old; the last good data stays visible.

## Requesting a GPU (batch jobs)

1. **Request GPU** (sidebar, or the button on a partition card).
2. Choose a partition and GPU type. The numbers show *potential* availability at the last snapshot;
   they are not a reservation. Set GPUs (default 1), CPUs, RAM and wall time (within the partition limit).
3. Enter the **working directory** (relative paths start in your home, e.g. `projects/semeval`) and **script** on ICF (inside your home), an optional virtualenv
   (`source <env>/bin/activate` is added) and optional arguments (one per line, passed literally).
4. **Review script** shows the exact batch script and checksum. Acknowledge any notices, click
   **Submit job…**, then confirm. The job is submitted once.
5. Outcomes: **Accepted** (you get a job ID; it may wait in the queue), **Not submitted** (the reason
   and a suggested edit), or **Submission uncertain** (the connection dropped mid-way). For uncertain,
   use *Check my jobs for this submission* before submitting again; the app never retries by itself.

The app remembers what SLURM said about each partition you submitted to from this Mac: a partition
that accepted your last job shows *✓ accepted your last job* and needs no eligibility acknowledgement;
one that rejected your account shows *rejected you before* and warns before review. In My Jobs, **✕**
hides a finished submission from the list (it is still remembered for this purpose).

Use **Teaching** for normal training. **Interactive** is for short debugging; the app only ever uses
`sbatch` and never holds an interactive GPU shell open.

### Allocated vs utilised
A job that is *Pending* holds no GPU. When *Running*, SLURM has allocated the GPU to you, whether or
not your code is using it. The app shows scheduler allocation, not GPU utilisation or free memory.

## My Jobs

Lists your queued/running jobs (`squeue`, every 45 s while visible) and the last 7 days of finished
jobs (`sacct`, when the site provides it). Open a job for scheduler details, failure hints
(timeout, out of memory, exit code) and logs:
- **Load log** fetches the last 64 KB; **Load new output** fetches only what was added since.
  *Follow* reloads every 10 s for running jobs while the window is visible.
- **Cancel job…** appears only for your own pending/running jobs and asks for confirmation. The state
  changes to *Cancelled* once SLURM reports it.

## Refresh and load on ICF

The app refreshes once a minute (configurable 45 s – 10 min in Settings) only while its window is
visible and connected. **Refresh** works at most every 10 s. Each refresh is one SSH command with two
read-only `scontrol` queries. Minimised or hidden = no queries. After 30 minutes without activity the
connection closes.

## Disconnect and forget

**Disconnect** closes the app's SSH connection. It does not affect jobs or other SSH/VS Code sessions.
**Forget saved password** (login screen) deletes this profile's Keychain items after confirmation.

## Troubleshooting

| Message | What to do |
|---|---|
| Host key has CHANGED | Do not continue. Ask Informatics support to confirm the new key, then edit `~/.ssh/known_hosts` yourself. |
| Authentication failed | Check UUN/password; if you use a saved password, Forget it and type it again. |
| Host name could not be resolved / Network error | Check network/VPN and that `ssh icf` works in Terminal. |
| The SLURM controller did not answer | Cluster-side issue; last good data stays visible; retries back off automatically. |
