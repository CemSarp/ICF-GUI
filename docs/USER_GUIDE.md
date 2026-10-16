# User guide (V1)

## Connecting

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
