# ICF Control Center

Local-first macOS app for the University of Edinburgh Informatics Compute Facility (ICF): connect over
your existing SSH setup and see partitions, nodes and GPU allocation with timestamps.

**Version 0.1.0 (V1): read-only.** It never submits, cancels or changes anything on the cluster.
Job submission (V2) and the VS Code/dataset workflows (V3) are not implemented yet.

![Overview (demo data)](docs/screenshots/overview-demo.jpg)

## Prerequisites (Apple Silicon, macOS 13+; tested on macOS 26.6)

| Tool | Why | Check |
|---|---|---|
| Xcode Command Line Tools | Rust linker, macOS SDK | `xcode-select -p` |
| Rust ≥ 1.80 (`brew install rust` or rustup) | Tauri backend | `cargo --version` |
| Node 20+ and pnpm 10 | frontend build | `node -v && pnpm -v` |
| macOS OpenSSH (`/usr/bin/ssh`) | all cluster access | `ssh -V` |
| VS Code (optional, V3) | external editor | `code --version` |

An `~/.ssh/config` entry for ICF is recommended (the app reads it and never modifies it):

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

## Run

```bash
pnpm install
```

```bash
pnpm tauri dev
```

Build the `.app` (output: `src-tauri/target/release/bundle/macos/ICF Control Center.app`):

```bash
pnpm tauri build
```

The build is ad-hoc signed for local use only (not notarized). On the login screen, **Explore demo
data** opens a synthetic dataset with a yellow *DEMO MODE* banner. Demo data is never shown as live ICF.

A browser-only UI preview with demo data (no SSH) is available for UI work: `pnpm dev`, then open
<http://localhost:1420/dev/preview.html>.

## Tests

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

```bash
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

Opt-in tests that touch local machine state (never the cluster):

```bash
cd src-tauri && cargo test --test real_openssh -- --ignored
```

```bash
cd src-tauri && cargo test --lib keychain_roundtrip -- --ignored
```

`real_openssh` starts a throwaway unprivileged `sshd` on 127.0.0.1; `keychain_roundtrip` writes and
deletes one item under a random test service name in your login Keychain.

## Limitations (V1)

- In-app password login is verified against real OpenSSH for host-key prompts and against a scripted
  ssh for password/OTP prompts. It has **not** yet been verified against the real Informatics prompts;
  see [docs/SECURITY.md](docs/SECURITY.md#verification-status).
- Allocation counts come from SLURM (`scontrol show node`), not from GPU utilisation. "Potentially
  free" is an estimate; the scheduler decides at submission time.
- Eligibility is only ever *denied* from visible group restrictions; it is never confirmed.

Docs: [User guide](docs/USER_GUIDE.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Security](docs/SECURITY.md) · [Decisions](docs/DECISIONS.md) ·
[Cluster compatibility](docs/CLUSTER_COMPATIBILITY.md) · [Release checklist](docs/RELEASE_CHECKLIST.md)
