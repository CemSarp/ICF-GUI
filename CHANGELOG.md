# Changelog

## [0.2.0] — 2026-10-17 · GPU jobs

Submit, follow and cancel GPU batch jobs from the app.

### Added
- **Request GPU wizard**: partition, GPU type (with potentially-free counts), GPUs, CPUs, RAM, wall
  time, working directory, Python or bash script, optional virtualenv and arguments. It is validated
  against the current cluster snapshot and partition limits.
- **Script review**: the exact `sbatch` script, with a checksum, is shown before submission. Notices
  must be acknowledged, and you confirm once more before submitting.
- **Single submission**: one `sbatch --parsable` per reviewed preview. It is never retried. Outcomes
  are *Accepted*, *Not submitted* (with a reason and suggestion) or *Uncertain*, which can be
  reconciled through a job comment tag.
- **My Jobs**: queued and running jobs (`squeue`, every 45 s while visible) and the last 7 days of
  history (`sacct`, at most every 5 minutes).
- **Job detail**: scheduler fields, failure hints (timeout, out of memory, exit code) and logs. Logs
  are read 64 KB at a time, only new output is fetched, and rotation is detected. *Follow* mode is
  available for running jobs.
- **Cancel** your own pending or running jobs after confirmation. Ownership is re-checked on ICF
  before `scancel`.
- **Remembered partition eligibility**: a partition that accepted your last job skips the "eligibility
  unknown" notice, and one that rejected your account is flagged before you submit again.
- **Recent submissions** list with a dismiss (✕) button.
- **No SSH config needed**: if `icf` isn't in `~/.ssh/config`, the app connects through
  `student.ssh.inf.ed.ac.uk` as the UUN you type.
- Relative working directories (e.g. `projects/run1`) resolve inside your home directory.

### Changed
- One readable time format everywhere (`10:16 PM`, or `Oct 15, 4:20 PM` for other days).
- Compact one-line GPU type list in the wizard.
- One Refresh button per screen (jobs screens use their own).
- GPU allocation now comes from `scontrol -d show node` (`GresUsed`), so the H200 and MIG slices show
  exact free/used counts instead of *Unknown*.

### Fixed
- Login failed when the UUN was typed with a capital letter (`S1234567`). Usernames are now lowercased.
- Job detail showed `Teaching AllocNode:Sid=…` as the partition. SLURM field names containing `:` and
  `/` are now parsed correctly.
- Job detail showed RAM as `—`. Memory is now read from `AllocTRES`/`ReqTRES` (SLURM 20+).

### Verified on ICF (SLURM 25.05.3)
- A user-approved smoke job (Teaching, 1 × RTX 2080 Ti, 2 CPUs, 4 GB, 5 min) was accepted, completed,
  and its log was read in the app.
- A submission to a partition the account may not use was cleanly rejected, and no job was created.
- Real `scontrol -d show node` output is part of the test suite.
- Not yet verified on ICF: cancelling a job.

## [0.1.0] — 2026-10-16 · Cluster overview

- Sign in with SSH keys/agent or username and password. Passwords go only to the matching hop, with
  optional macOS Keychain storage. Host keys are verified interactively, and sign-in pauses after
  repeated failures.
- Overview, Partitions, GPU Nodes and Node detail views: GPUs by type, potentially free, allocated,
  unavailable and unknown, with MIG slices counted separately and each node counted once.
- Refresh budget: once a minute while visible, manual refresh at most every 10 s, backoff on errors,
  idle disconnect after 30 minutes.
- Demo mode with synthetic data.
- Verified read-only against ICF (5 partitions, 35 GPU nodes).
