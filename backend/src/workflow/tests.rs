//! V3 workflow evidence. The generated wrapper and the archive stager are executed for real
//! (bash + python3) in a throwaway sandbox standing in for the compute node: `/disk/scratch` is
//! redirected to a temp dir and SLURM_JOB_ID is set; no scheduler or ICF is involved.

use super::script::{render, STAGER_PY};
use super::status::{classify_log, derive, parse_events, parse_status, status_script, FailureKind, ResultState, StatusTarget, WorkflowState};
use super::*;
use crate::jobs::parse::JobState;
use crate::jobs::remote::Precheck;
use crate::jobs::store::{PartitionRecord, ReceiptStatus};
use crate::slurm::demo_snapshot;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const HOME: &str = "/home/demo";

fn cfg(home: &str) -> WorkflowConfig {
    WorkflowConfig {
        kind: WorkflowKind::Train,
        job_name: "train".into(),
        project_dir: format!("{home}/proj"),
        entry: "train.py".into(),
        args: vec!["--data={data}/set1".into(), "--lr=1e-3".into()],
        interpreter: format!("{home}/env/bin/python"),
        toolchain: Toolchain::None,
        datasets: vec![Dataset { archive: format!("{home}/data/ds.tar.gz"), into: "set1".into() }],
        scratch_root: ScratchRoot::DiskScratch,
        hf_cache: HfCache::Scratch,
        results_root: format!("{home}/proj/runs"),
        checkpoint_mode: CheckpointMode::ScratchSync,
        checkpoint_sync_minutes: 30,
        resume_from: None,
        env: vec![],
        expected_output_gib: 0,
        signal_grace_seconds: 300,
        resources: Resources {
            partition: "Teaching".into(),
            gres_type: Some("nvidia_rtx_a6000".into()),
            gpu_count: 1,
            cpus: 4,
            memory_mib: 16384,
            time_limit_seconds: 4 * 3600,
        },
        mail_user: None,
    }
}

fn check(c: &WorkflowConfig) -> (crate::jobs::request::Validation, Vec<Precheck>) {
    plan(c, &Context { home: HOME, snapshot: &demo_snapshot(0), learned: PartitionRecord::Accepted })
}

fn fields(v: &crate::jobs::request::Validation) -> Vec<String> {
    v.errors.iter().filter_map(|i| i.field.clone()).collect()
}

#[test]
fn settings_of_other_kinds_are_refused() {
    let mut c = cfg(HOME); // a training config with a dataset
    c.resume_from = Some(format!("{HOME}/proj/runs/old/checkpoints"));
    assert!(!fields(&check(&c).0).contains(&"resumeFrom".to_string()), "training may resume");
    c.kind = WorkflowKind::Notebook;
    c.entry = "nb.ipynb".into();
    assert!(fields(&check(&c).0).contains(&"resumeFrom".to_string()));
    c.kind = WorkflowKind::GpuSmokeTest;
    c.resume_from = None;
    assert!(fields(&check(&c).0).contains(&"datasets".to_string()));
}

#[test]
fn valid_config_plans_prechecks_and_the_durability_warning() {
    let (v, checks) = check(&cfg(HOME));
    assert!(v.errors.is_empty(), "{:?}", v.errors);
    assert!(v.acknowledgements.is_empty(), "{:?}", v.acknowledgements);
    assert!(v.warnings.iter().any(|w| w.message.contains("node failure loses everything")));
    assert_eq!(
        checks,
        vec![
            Precheck::Dir("/home/demo/proj".into(), "project"),
            Precheck::MakeDir("/home/demo/proj/icfcc-run".into(), "logDir"),
            Precheck::File("/home/demo/proj/train.py".into(), "entry"),
            Precheck::Exec("/home/demo/env/bin/python".into(), "interpreter"),
            Precheck::File("/home/demo/data/ds.tar.gz".into(), "dataset"),
            Precheck::MakeDir("/home/demo/proj/runs".into(), "resultsRoot"),
        ]
    );
}

#[test]
fn hostile_paths_names_and_values_are_rejected_locally() {
    let bad_paths = ["/home/demo/p;rm -rf ~", "/home/demo/$(id)", "/home/demo/a b", "/home/demo/../other", "relative/p", "/home/demo/x`y`", "/home/demo/q'z"];
    for p in bad_paths {
        let mut c = cfg(HOME);
        c.project_dir = p.into();
        assert!(fields(&check(&c).0).contains(&"projectDir".to_string()), "{p}");
        let mut c = cfg(HOME);
        c.datasets[0].archive = p.into();
        assert!(fields(&check(&c).0).contains(&"datasets".to_string()), "{p}");
        let mut c = cfg(HOME);
        c.results_root = p.into();
        assert!(fields(&check(&c).0).contains(&"resultsRoot".to_string()), "{p}");
    }
    let mut c = cfg(HOME);
    c.project_dir = "/home/other/proj".into();
    assert!(fields(&check(&c).0).contains(&"projectDir".to_string()), "other user's home");
    let mut c = cfg(HOME);
    c.entry = "../../other/x.py".into();
    assert!(fields(&check(&c).0).contains(&"entry".to_string()));
    let mut c = cfg(HOME);
    c.datasets[0].into = "../escape".into();
    assert!(fields(&check(&c).0).contains(&"datasets".to_string()));
    let mut c = cfg(HOME);
    c.datasets.push(c.datasets[0].clone());
    assert!(fields(&check(&c).0).contains(&"datasets".to_string()), "duplicate target folder");
    let mut c = cfg(HOME);
    c.datasets[0].archive = "/home/demo/data/ds.txt".into();
    assert!(fields(&check(&c).0).contains(&"datasets".to_string()), "not an archive");
    for (name, value) in [("ICFCC_RUN_DIR", "x"), ("SLURM_JOB_ID", "1"), ("HF_HOME", "/x"), ("1BAD", "x"), ("A-B", "x"), ("OK", "line\nbreak")] {
        let mut c = cfg(HOME);
        c.env = vec![EnvVar { name: name.into(), value: value.into() }];
        assert!(fields(&check(&c).0).contains(&"env".to_string()), "{name}={value:?}");
    }
    let mut c = cfg(HOME);
    c.toolchain = Toolchain::Modules { names: vec!["cuda/12.8; rm -rf ~".into()] };
    assert!(fields(&check(&c).0).contains(&"toolchain".to_string()));
    let mut c = cfg(HOME);
    c.args = vec!["--x={secret}".into()];
    assert!(fields(&check(&c).0).contains(&"args".to_string()), "unknown placeholder");
    let mut c = cfg(HOME);
    c.args = vec!["--resume={resume}".into()];
    assert!(fields(&check(&c).0).contains(&"args".to_string()), "{{resume}} needs a checkpoint");
    let mut c = cfg(HOME);
    c.signal_grace_seconds = 3 * 3600;
    assert!(fields(&check(&c).0).contains(&"signalGraceSeconds".to_string()));
    let mut c = cfg(HOME);
    c.checkpoint_sync_minutes = 1;
    assert!(fields(&check(&c).0).contains(&"checkpointSyncMinutes".to_string()), "NFS-friendly minimum");
    let mut c = cfg(HOME);
    c.kind = WorkflowKind::Notebook;
    assert!(fields(&check(&c).0).contains(&"entry".to_string()), "notebook needs .ipynb");
    let mut c = cfg(HOME);
    c.resources.partition = "NoSuchPartition".into();
    assert!(fields(&check(&c).0).contains(&"partition".to_string()), "resources revalidated with V2 rules");
}

#[test]
fn risky_choices_need_acknowledgement() {
    let mut c = cfg(HOME);
    c.checkpoint_mode = CheckpointMode::None;
    c.interpreter = "/usr/bin/python3".into();
    c.toolchain = Toolchain::Rc { path: "/home/htang2/toolchain-20251006/toolchain.rc".into() };
    let (v, checks) = check(&c);
    assert!(v.errors.is_empty(), "{:?}", v.errors);
    assert_eq!(v.acknowledgements.len(), 3, "{:?}", v.acknowledgements);
    assert!(checks.contains(&Precheck::Readable("/home/htang2/toolchain-20251006/toolchain.rc".into(), "toolchain")));
    assert!(checks.contains(&Precheck::Exec("/usr/bin/python3".into(), "interpreter")));
}

#[test]
fn placeholders_split_into_literal_and_variables() {
    assert_eq!(split_placeholders("--data={data}/train").unwrap(), vec![(false, "--data=".into()), (true, "ICFCC_DATA_DIR".into()), (false, "/train".into())]);
    assert_eq!(split_placeholders("{outputs}").unwrap(), vec![(true, "ICFCC_OUTPUT_DIR".into())]);
    assert_eq!(split_placeholders("{\"a\": 1}").unwrap(), vec![(false, "{\"a\": 1}".into())], "JSON stays literal");
    assert_eq!(split_placeholders("").unwrap(), vec![(false, String::new())]);
    assert_eq!(split_placeholders("{nope}").unwrap_err(), "nope");
}

#[test]
fn rendered_script_quotes_every_user_value() {
    let mut c = cfg(HOME);
    c.args = vec!["$(touch PWNED)".into(), "it's; rm -rf /".into(), "--out={outputs}/m".into(), "ICFCC_STAGER_t1".into()];
    c.env = vec![EnvVar { name: "WANDB_MODE".into(), value: "off`id`$HOME".into() }];
    let s = render(&c, "t1");
    assert!(s.starts_with("#!/bin/bash\n#SBATCH --job-name=train\n"));
    for l in [
        "#SBATCH --gres=gpu:nvidia_rtx_a6000:1",
        "#SBATCH --signal=B:USR1@300",
        "#SBATCH --comment=icfcc-t1",
        "#SBATCH --output=/home/demo/proj/slurm-%j.out",
        "#SBATCH --chdir=/home/demo/proj",
    ] {
        assert!(s.lines().any(|x| x == l), "{l}");
    }
    assert!(
        s.contains("\"$PY\" -u '/home/demo/proj/train.py' '$(touch PWNED)' 'it'\\''s; rm -rf /' '--out='\"$ICFCC_OUTPUT_DIR\"'/m' 'ICFCC_STAGER_t1' &"),
        "{s}"
    );
    assert!(s.contains("export WANDB_MODE='off`id`$HOME'"));
    assert_eq!(s.lines().filter(|l| *l == "ICFCC_STAGER_t1").count(), 1, "only the real closing delimiter");
    assert!(!s.contains("rm -rf \"$JOB_SCRATCH\"\n") && s.contains("rm -rf -- \"$JOB_SCRATCH\""));
    assert!(!s.contains("StrictHostKeyChecking") && !s.contains("password"));
}

#[test]
fn optional_end_or_fail_email_is_validated_and_rendered() {
    let mut c = cfg(HOME);
    assert!(!render(&c, "t1").contains("--mail"), "no e-mail unless asked for");
    let mut old = serde_json::to_value(&c).unwrap();
    old.as_object_mut().unwrap().remove("mailUser");
    assert_eq!(serde_json::from_value::<WorkflowConfig>(old).unwrap(), c, "saved presets and runs without the field still load");
    c.mail_user = Some("s1234567@ed.ac.uk".into());
    assert!(check(&c).0.errors.is_empty());
    let s = render(&c, "t1");
    assert!(s.contains("#SBATCH --comment=icfcc-t1\n#SBATCH --mail-type=END,FAIL\n#SBATCH --mail-user=s1234567@ed.ac.uk\n"), "{s}");
    c.mail_user = Some("s1@ed.ac.uk\n#SBATCH --wrap=x".into());
    assert_eq!(fields(&check(&c).0), ["mailUser"]);
}

#[test]
fn smoke_test_and_notebook_variants() {
    let mut c = cfg(HOME);
    c.kind = WorkflowKind::GpuSmokeTest;
    c.entry.clear();
    c.datasets.clear();
    let (v, checks) = check(&c);
    assert!(v.errors.is_empty(), "{:?}", v.errors);
    assert!(!checks.iter().any(|x| matches!(x, Precheck::File(_, "entry"))));
    let s = render(&c, "t2");
    assert!(s.contains("icfcc_smoke.py") && s.contains("torch.cuda.is_available()") && !s.contains("icfcc_stage.py"));
    let mut c = cfg(HOME);
    c.kind = WorkflowKind::Notebook;
    c.entry = "nb/explore.ipynb".into();
    let s = render(&c, "t3");
    assert!(s.contains("-m nbconvert --to notebook --execute '/home/demo/proj/nb/explore.ipynb'") && s.contains("'explore.executed'"));
    assert!(s.contains("nbconvert_missing"));
}

#[test]
fn toolchain_lines_are_rendered_exactly() {
    let mut c = cfg(HOME);
    c.toolchain = Toolchain::Rc { path: "/home/htang2/toolchain-20251006/toolchain.rc".into() };
    let s = render(&c, "t4");
    assert!(s.contains(
        "set +u\n[ -r '/home/htang2/toolchain-20251006/toolchain.rc' ] || fail ENV_SETUP toolchain_missing\nsource '/home/htang2/toolchain-20251006/toolchain.rc' || fail ENV_SETUP toolchain_failed\nPY="
    ));
    c.toolchain = Toolchain::Modules { names: vec!["cuda/12.8".into(), "cudnn".into()] };
    let s = render(&c, "t5");
    assert!(s.contains(
        "command -v module >/dev/null 2>&1 || fail ENV_SETUP module_command_missing\nmodule load 'cuda/12.8' 'cudnn' || fail ENV_SETUP module_load_failed\nPY="
    ));
}

// ---------- executed wrapper ----------

fn python3() -> Option<PathBuf> {
    // ponytail: /usr/bin/python3 is an xcrun stub that breaks when symlinked as "python"; it is the last resort.
    ["/opt/homebrew/bin/python3", "/opt/homebrew/bin/python3.14", "/opt/homebrew/bin/python3.12", "/usr/local/bin/python3", "/usr/bin/python3"]
        .iter()
        .map(PathBuf::from)
        .find(|p| Command::new(p).arg("-c").arg("import tarfile, zipfile").output().is_ok_and(|o| o.status.success()))
}

const TRAIN_PY: &str = r#"import os, sys, time
d, o, c = os.environ["ICFCC_DATA_DIR"], os.environ["ICFCC_OUTPUT_DIR"], os.environ["ICFCC_CHECKPOINT_DIR"]
f = os.path.join(d, "set1", "ds", "hello.txt")
data = open(f).read() if os.path.exists(f) else "none"
with open(os.path.join(o, "result.txt"), "w") as f:
    f.write("trained on " + data + " args " + " ".join(sys.argv[1:]))
os.makedirs(c, exist_ok=True)
if not os.environ.get("NO_CKPT"):
    open(os.path.join(c, "ckpt.pt"), "w").write("weights")
if os.environ.get("BREAK_SYNC"):
    os.mkdir(os.path.join(os.environ["ICFCC_RUN_DIR"], ".outputs.partial"))
print("hf", os.environ.get("HF_HOME"), "tmp", os.environ.get("TMPDIR"), flush=True)
if os.environ.get("MODE") == "sleep":
    time.sleep(60)
sys.exit(int(os.environ.get("EXIT", "0")))
"#;

const MAKE_ARCHIVE_PY: &str = r#"import io, sys, tarfile, zipfile
kind, out = sys.argv[1], sys.argv[2]
def add(tf, name, data=b"x", t=tarfile.REGTYPE, link=""):
    ti = tarfile.TarInfo(name); ti.type = t; ti.linkname = link
    ti.size = len(data) if t == tarfile.REGTYPE else 0
    tf.addfile(ti, io.BytesIO(data) if t == tarfile.REGTYPE else None)
if kind.startswith("zip"):
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        if kind == "zip_good": z.writestr("ds/hello.txt", "world")
        if kind == "zip_traversal": z.writestr("../evil.txt", "x")
        if kind == "zip_absolute": z.writestr("/tmp/icfcc-evil.txt", "x")
        if kind == "zip_symlink":
            zi = zipfile.ZipInfo("ln"); zi.external_attr = 0o120777 << 16; z.writestr(zi, "/etc/passwd")
        if kind == "zip_bomb": z.writestr("zeros.bin", b"\0" * (20 * 1024 * 1024))
    sys.exit(0)
with tarfile.open(out, "w:gz") as tf:
    if kind == "good":
        add(tf, "ds/hello.txt", b"world"); add(tf, "ds/link", t=tarfile.SYMTYPE, link="hello.txt"); add(tf, "ds/hard", t=tarfile.LNKTYPE, link="ds/hello.txt")
    if kind == "traversal": add(tf, "ds/../../evil.txt")
    if kind == "absolute": add(tf, "/tmp/icfcc-evil.txt")
    if kind == "symlink_out": add(tf, "ds/ln", t=tarfile.SYMTYPE, link="../../../etc")
    if kind == "symlink_abs": add(tf, "ln", t=tarfile.SYMTYPE, link="/etc/passwd")
    if kind == "hardlink_out": add(tf, "hl", t=tarfile.LNKTYPE, link="/etc/passwd")
    if kind == "device": add(tf, "dev", t=tarfile.CHRTYPE)
    if kind == "fifo": add(tf, "fifo", t=tarfile.FIFOTYPE)
    if kind == "dup": add(tf, "a.txt"); add(tf, "a.txt", b"y")
    if kind == "link_then_write": add(tf, "d", t=tarfile.SYMTYPE, link="."); add(tf, "d/x.txt")
    if kind == "bomb": add(tf, "zeros.bin", b"\0" * (20 * 1024 * 1024))
"#;

struct Node {
    root: PathBuf,
    py: PathBuf,
}

impl Drop for Node {
    fn drop(&mut self) {
        let _ = Command::new("/bin/chmod").arg("-R").arg("u+w").arg(&self.root).status();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl Node {
    fn new() -> Option<Self> {
        let py = python3()?;
        let tmp = std::env::temp_dir().join(format!("icfcc-wf-{}", crate::util::random_hex(6)));
        std::fs::create_dir_all(&tmp).unwrap();
        let root = std::fs::canonicalize(&tmp).unwrap();
        let n = Node { root, py };
        for d in ["home/proj/runs", "home/env/bin", "home/data", "scratch", "bin", "elsewhere"] {
            std::fs::create_dir_all(n.root.join(d)).unwrap();
        }
        std::os::unix::fs::symlink(&n.py, n.home().join("env/bin/python")).unwrap();
        std::fs::write(n.home().join("env/bin/activate"), "VIRTUAL_ENV=active\n").unwrap();
        std::fs::write(n.home().join("proj/train.py"), TRAIN_PY).unwrap();
        std::fs::write(n.root.join("mk.py"), MAKE_ARCHIVE_PY).unwrap();
        let stub = |name: &str, body: &str| {
            let p = n.root.join("bin").join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        };
        stub("git", "exit 1"); // never trigger the macOS developer-tools installer
        if !Path::new("/sbin/sha256sum").exists() && !Path::new("/usr/bin/sha256sum").exists() {
            stub("sha256sum", "exec shasum -a 256 \"$@\""); // GNU sha256sum stand-in (ICF is Linux)
        }
        n.archive("good", "data/ds.tar.gz");
        Some(n)
    }
    fn home(&self) -> PathBuf {
        self.root.join("home")
    }
    fn h(&self) -> String {
        self.home().display().to_string()
    }
    fn archive(&self, kind: &str, rel: &str) -> PathBuf {
        let out = self.home().join(rel);
        let st = Command::new(&self.py).arg(self.root.join("mk.py")).arg(kind).arg(&out).status().unwrap();
        assert!(st.success(), "making {kind}");
        out
    }
    fn config(&self) -> WorkflowConfig {
        let mut c = cfg(&self.h());
        c.signal_grace_seconds = 60;
        c
    }
    fn script(&self, c: &WorkflowConfig, tag: &str) -> PathBuf {
        let s = render(c, tag).replace("SCRATCH_BASE=/disk/scratch", &format!("SCRATCH_BASE={}", self.root.join("scratch").display()));
        let p = self.root.join(format!("job-{tag}.sh"));
        std::fs::write(&p, s).unwrap();
        p
    }
    fn command(&self, script: &Path, job_id: Option<&str>) -> Command {
        let mut cmd = Command::new("/bin/bash");
        cmd.arg(script)
            .env_clear()
            .env("HOME", self.home())
            .env("PATH", format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", self.root.join("bin").display()))
            .current_dir(self.home().join("proj"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(id) = job_id {
            cmd.env("SLURM_JOB_ID", id);
        }
        cmd
    }
    /// Run like sbatch would on the compute node; returns (exit code, stdout).
    fn run(&self, c: &WorkflowConfig, tag: &str) -> (i32, String) {
        let out = self.command(&self.script(c, tag), Some("4242")).output().unwrap();
        (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr))
    }
    fn run_dir(&self) -> PathBuf {
        self.home().join("proj/runs/train-4242")
    }
    fn status(&self) -> Vec<status::Event> {
        parse_events(&std::fs::read_to_string(self.run_dir().join("icfcc-status.log")).unwrap_or_default())
    }
    fn scratch_job(&self, tag: &str) -> PathBuf {
        self.root.join("scratch").join(whoami()).join(format!("icfcc-4242-{tag}"))
    }
}

fn whoami() -> String {
    String::from_utf8(Command::new("/usr/bin/id").arg("-un").output().unwrap().stdout).unwrap().trim().to_string()
}

fn names(ev: &[status::Event]) -> Vec<String> {
    ev.iter().map(|e| if e.name == "STAGE" { format!("STAGE {}", e.args[0]) } else { e.name.clone() }).collect()
}

macro_rules! node_or_skip {
    () => {
        match Node::new() {
            Some(n) => n,
            None => {
                eprintln!("python3 not found: skipping executed-wrapper test");
                return;
            }
        }
    };
}

#[test]
fn happy_path_stages_trains_syncs_verifies_and_cleans_up() {
    let n = node_or_skip!();
    let (code, out) = n.run(&n.config(), "aa11");
    assert_eq!(code, 0, "{out}");
    let ev = n.status();
    let seq = names(&ev);
    for want in [
        "ALLOCATED",
        "STAGE ENV",
        "ENV",
        "STAGE STAGING",
        "SCRATCH",
        "STAGE TRAINING",
        "TRAINING_EXIT",
        "STAGE COPYING_RESULTS",
        "CHECKPOINT_SYNCED",
        "RESULT_SYNC",
        "STAGE CLEANUP",
        "CLEANED",
        "DONE",
    ] {
        assert!(seq.contains(&want.to_string()), "missing {want} in {seq:?}\n{out}");
    }
    let result = std::fs::read_to_string(n.run_dir().join("outputs/result.txt")).unwrap();
    assert_eq!(result, "trained on world args --data=".to_string() + &n.scratch_job("aa11").join("data/set1").display().to_string() + " --lr=1e-3");
    assert_eq!(std::fs::read_to_string(n.run_dir().join("checkpoints/ckpt.pt")).unwrap(), "weights");
    assert!(n.run_dir().join("outputs.sha256").exists());
    assert!(!n.run_dir().join(".outputs.partial").exists());
    assert!(!n.scratch_job("aa11").exists(), "job scratch removed");
    assert!(n.root.join("scratch").join(whoami()).is_dir(), "per-user scratch dir kept");
    assert!(out.contains(&format!("hf {}/hf", n.scratch_job("aa11").display())), "HF cache on scratch: {out}");
    let o = derive(ReceiptStatus::Accepted, Some(JobState::Completed), &ev, None);
    assert_eq!((o.state, o.results, o.failure), (Some(WorkflowState::Completed), ResultState::Synced, None));
    assert!(o.last_checkpoint_at.is_some() && o.python.is_some() && o.node.is_some());
}

#[test]
fn training_failure_still_copies_results_back() {
    let n = node_or_skip!();
    let mut c = n.config();
    c.env = vec![EnvVar { name: "EXIT".into(), value: "7".into() }];
    let (code, out) = n.run(&c, "bb22");
    assert_eq!(code, 7, "{out}");
    assert!(n.run_dir().join("outputs/result.txt").exists(), "best-effort copy-back after failure");
    assert!(!n.scratch_job("bb22").exists());
    let o = derive(ReceiptStatus::Accepted, Some(JobState::Failed), &n.status(), Some("Traceback ...\nValueError: bad"));
    assert_eq!((o.state, o.failure), (Some(WorkflowState::Failed), Some(FailureKind::TrainingScript)));
    assert!(o.message.unwrap().contains("Exit code 7"));
    assert!(o.recovery_note.unwrap().contains("copied back"));
}

#[test]
fn empty_checkpoint_folder_is_not_reported_as_a_checkpoint() {
    let n = node_or_skip!();
    let mut c = n.config();
    c.env = vec![EnvVar { name: "NO_CKPT".into(), value: "1".into() }, EnvVar { name: "EXIT".into(), value: "1".into() }];
    let (code, out) = n.run(&c, "gg77");
    assert_eq!(code, 1, "{out}");
    let ev = n.status();
    assert!(!ev.iter().any(|e| e.name == "CHECKPOINT_SYNCED"), "{out}");
    let o = derive(ReceiptStatus::Accepted, Some(JobState::Failed), &ev, None);
    assert!(o.last_checkpoint_at.is_none());
    assert!(!o.recovery_note.unwrap_or_default().contains("resume"));
}

#[test]
fn result_sync_failure_is_not_reported_as_completed() {
    let n = node_or_skip!();
    let mut c = n.config();
    c.env = vec![EnvVar { name: "BREAK_SYNC".into(), value: "1".into() }];
    let (code, out) = n.run(&c, "cc33");
    assert_eq!(code, 3, "training ok + sync failed must not exit 0: {out}");
    let ev = n.status();
    assert!(ev.iter().any(|e| e.name == "RESULT_SYNC" && e.args[0] == "failed"));
    let o = derive(ReceiptStatus::Accepted, Some(JobState::Failed), &ev, None);
    assert_eq!((o.state, o.failure), (Some(WorkflowState::Failed), Some(FailureKind::ResultSync)));
}

#[test]
fn unsafe_archives_are_rejected_before_any_extraction_or_training() {
    let n = node_or_skip!();
    for (i, kind) in [
        "traversal",
        "absolute",
        "symlink_out",
        "symlink_abs",
        "hardlink_out",
        "device",
        "fifo",
        "dup",
        "bomb",
        "zip_traversal",
        "zip_symlink",
        "zip_bomb",
        "zip_absolute",
    ]
    .iter()
    .enumerate()
    {
        let ext = if kind.starts_with("zip") { "zip" } else { "tar.gz" };
        let rel = format!("data/{kind}.{ext}");
        n.archive(kind, &rel);
        let mut c = n.config();
        c.datasets[0].archive = format!("{}/{rel}", n.h());
        let tag = format!("e{i:03}");
        let _ = std::fs::remove_dir_all(n.run_dir());
        let (code, out) = n.run(&c, &tag);
        assert_ne!(code, 0, "{kind}: {out}");
        let ev = n.status();
        let reason = ev.iter().find(|e| e.name == "FAILED").and_then(|e| e.arg("reason")).unwrap_or("none").to_string();
        assert_eq!(reason, "UNSAFE_ARCHIVE", "{kind}: {out}");
        assert!(!ev.iter().any(|e| e.name == "STAGE" && e.args[0] == "TRAINING"), "{kind}: training must not start");
        assert!(!n.root.join("evil.txt").exists() && !n.home().join("evil.txt").exists() && !Path::new("/tmp/icfcc-evil.txt").exists(), "{kind}");
        assert!(!n.scratch_job(&tag).exists(), "{kind}: scratch cleaned");
        let o = derive(ReceiptStatus::Accepted, Some(JobState::Failed), &ev, None);
        assert_eq!(o.failure, Some(FailureKind::UnsafeArchive), "{kind}");
    }
}

#[test]
fn stager_extracts_valid_archives_safely_and_rejects_bad_ones_by_exit_code() {
    let Some(n) = Node::new() else { return };
    let stager = n.root.join("stage.py");
    std::fs::write(&stager, STAGER_PY).unwrap();
    let run = |archive: &Path, dest: &Path, reserve: u64| {
        Command::new(&n.py).arg("-I").arg(&stager).arg(archive).arg(dest).arg(reserve.to_string()).output().unwrap()
    };
    // Valid tar.gz with an inside symlink and hard link.
    let good = n.home().join("data/ds.tar.gz");
    let dest = n.root.join("x1");
    let o = run(&good, &dest, 0);
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stdout));
    assert_eq!(std::fs::read_to_string(dest.join("ds/hello.txt")).unwrap(), "world");
    assert_eq!(std::fs::read_link(dest.join("ds/link")).unwrap(), Path::new("hello.txt"));
    assert_eq!(std::fs::read_to_string(dest.join("ds/hard")).unwrap(), "world");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(dest.join("ds/hello.txt")).unwrap().permissions().mode() & 0o7777, 0o600, "no setuid/world bits");
    // Valid zip.
    let z = n.archive("zip_good", "data/good.zip");
    assert!(run(&z, &n.root.join("x2"), 0).status.success());
    // Link created before a write through it: refused (links are created last, writes never follow them).
    let lw = n.archive("link_then_write", "data/lw.tar.gz");
    assert_ne!(run(&lw, &n.root.join("x3"), 0).status.code(), Some(0));
    // Corrupt (truncated) archive -> 5.
    let bytes = std::fs::read(&good).unwrap();
    let cut = n.root.join("cut.tar.gz");
    std::fs::write(&cut, &bytes[..bytes.len() / 2]).unwrap();
    assert_eq!(run(&cut, &n.root.join("x4"), 0).status.code(), Some(5));
    // Not enough space for data + reserve -> 4, nothing extracted.
    let o = run(&good, &n.root.join("x5"), u64::MAX / 4);
    assert_eq!(o.status.code(), Some(4));
    assert!(!n.root.join("x5/ds").exists());
    // Existing destination is never reused.
    assert_ne!(run(&good, &dest, 0).status.code(), Some(0));
}

#[test]
fn scratch_collision_never_deletes_the_existing_directory() {
    let n = node_or_skip!();
    let other = n.root.join("scratch").join(whoami()).join("icfcc-4242-dd44");
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("precious.bin"), "keep").unwrap();
    let (code, out) = n.run(&n.config(), "dd44");
    assert_ne!(code, 0, "{out}");
    assert_eq!(n.status().iter().find(|e| e.name == "FAILED").and_then(|e| e.arg("reason")), Some("SCRATCH_UNSAFE"));
    assert_eq!(std::fs::read_to_string(other.join("precious.bin")).unwrap(), "keep", "another job's scratch untouched");
}

#[test]
fn unwritable_disk_scratch_falls_back_to_slurm_tmpdir() {
    use std::os::unix::fs::PermissionsExt;
    let n = node_or_skip!();
    let base = n.root.join("scratch");
    let tmpdir = n.root.join("slurm-tmp");
    std::fs::create_dir(&tmpdir).unwrap();
    std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o555)).unwrap(); // like landonia11
    let out = n.command(&n.script(&n.config(), "ff66"), Some("4242")).env("SLURM_TMPDIR", &tmpdir).output().unwrap();
    std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stdout));
    let ev = n.status();
    assert_eq!(ev.iter().find(|e| e.name == "SCRATCH_FALLBACK").and_then(|e| e.arg("dir")), Some(tmpdir.to_str().unwrap()));
    assert!(n.run_dir().join("outputs/result.txt").exists());
    assert!(!tmpdir.join("icfcc-4242-ff66").exists(), "job scratch cleaned up");
}

#[test]
fn insufficient_scratch_space_fails_before_staging() {
    let n = node_or_skip!();
    let mut c = n.config();
    c.expected_output_gib = 10_000;
    let (code, _) = n.run(&c, "ee55");
    assert_ne!(code, 0);
    let ev = n.status();
    assert_eq!(ev.iter().find(|e| e.name == "FAILED").and_then(|e| e.arg("reason")), Some("SCRATCH_FULL"));
    assert!(!ev.iter().any(|e| e.name == "STAGE" && e.args[0] == "TRAINING"));
    assert_eq!(derive(ReceiptStatus::Accepted, Some(JobState::Failed), &ev, None).failure, Some(FailureKind::ScratchExhausted));
}

#[test]
fn missing_interpreter_is_an_environment_failure() {
    let n = node_or_skip!();
    let mut c = n.config();
    c.interpreter = format!("{}/env/bin/python9", n.h());
    let (code, _) = n.run(&c, "ff66");
    assert_ne!(code, 0);
    let ev = n.status();
    assert_eq!(ev.iter().find(|e| e.name == "FAILED").and_then(|e| e.arg("reason")), Some("ENV_SETUP"));
    assert!(!ev.iter().any(|e| e.name == "SCRATCH"), "no scratch created for a broken environment");
    assert_eq!(derive(ReceiptStatus::Accepted, Some(JobState::Failed), &ev, None).failure, Some(FailureKind::PythonEnvironment));
}

#[test]
fn refuses_to_run_outside_a_slurm_allocation() {
    let n = node_or_skip!();
    let out = n.command(&n.script(&n.config(), "gg77"), None).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(!n.run_dir().exists() && std::fs::read_dir(n.root.join("scratch")).unwrap().next().is_none(), "nothing created on a login node");
}

#[test]
fn time_limit_signal_stops_training_and_still_copies_back() {
    let n = node_or_skip!();
    let mut c = n.config();
    c.env = vec![EnvVar { name: "MODE".into(), value: "sleep".into() }];
    let mut cmd = n.command(&n.script(&c, "hh88"), Some("4242"));
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().unwrap();
    let pid = child.id() as i32;
    let t0 = Instant::now();
    while !n.status().iter().any(|e| e.name == "STAGE" && e.args[0] == "TRAINING") {
        assert!(t0.elapsed() < Duration::from_secs(20), "training never started");
        std::thread::sleep(Duration::from_millis(100));
    }
    std::thread::sleep(Duration::from_millis(500)); // let the program write its output first
                                                    // SAFETY: signalling our own child (SLURM sends USR1 to the batch shell before the time limit).
    unsafe { libc::kill(pid, libc::SIGUSR1) };
    let t0 = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(t0.elapsed() < Duration::from_secs(30), "wrapper did not finish after the signal");
        std::thread::sleep(Duration::from_millis(100));
    };
    // SAFETY: clean up the leftover fallback timer in our own process group.
    unsafe { libc::kill(-pid, libc::SIGKILL) };
    let ev = n.status();
    assert!(ev.iter().any(|e| e.name == "SIGNAL" && e.args[0] == "time_limit"), "{:?}", names(&ev));
    assert!(ev.iter().any(|e| e.name == "RESULT_SYNC" && e.args[0] == "ok"), "{:?}", names(&ev));
    assert!(n.run_dir().join("outputs/result.txt").exists());
    assert!(!n.scratch_job("hh88").exists());
    assert_ne!(status.code(), Some(0));
    let o = derive(ReceiptStatus::Accepted, Some(JobState::Timeout), &ev, None);
    assert_eq!((o.state, o.results), (Some(WorkflowState::Timeout), ResultState::Synced));
    // The wrapper finished before the limit, so SLURM reports FAILED (exit 143) or COMPLETED (exit 0):
    // still a time-limit stop, not a script failure or a normal completion.
    for sched in [JobState::Failed, JobState::Completed] {
        let o = derive(ReceiptStatus::Accepted, Some(sched), &ev, None);
        assert_eq!((o.state, o.failure), (Some(WorkflowState::Timeout), Some(FailureKind::Timeout)), "{sched:?}");
        assert!(o.message.unwrap().contains("copied back") && o.recovery_note.is_some());
    }
}

// ---------- status derivation ----------

fn ev(lines: &str) -> Vec<status::Event> {
    parse_events(lines)
}

#[test]
fn derive_maps_scheduler_and_markers_to_workflow_states() {
    let running = ev("2026-10-17T10:00:00Z ALLOCATED node=landonia11 job=1\n2026-10-17T10:00:01Z STAGE ENV\n2026-10-17T10:00:02Z STAGE STAGING\n");
    assert_eq!(derive(ReceiptStatus::Accepted, Some(JobState::Pending), &[], None).state, Some(WorkflowState::Pending));
    assert_eq!(derive(ReceiptStatus::Accepted, Some(JobState::Running), &[], None).state, Some(WorkflowState::Allocated));
    assert_eq!(derive(ReceiptStatus::Accepted, Some(JobState::Running), &running, None).state, Some(WorkflowState::Staging));
    let mut t = running.clone();
    t.extend(ev("2026-10-17T10:01:00Z STAGE TRAINING\n2026-10-17T10:31:00Z STAGE SAVING_CHECKPOINTS\n"));
    assert_eq!(derive(ReceiptStatus::Accepted, Some(JobState::Running), &t, None).state, Some(WorkflowState::SavingCheckpoints));
    t.extend(ev("2026-10-17T10:31:30Z CHECKPOINT_SYNCED\n2026-10-17T10:31:31Z STAGE TRAINING\n"));
    let o = derive(ReceiptStatus::Accepted, Some(JobState::Running), &t, None);
    assert_eq!((o.state, o.last_checkpoint_at.as_deref()), (Some(WorkflowState::Training), Some("2026-10-17T10:31:30Z")));
    t.extend(ev("2026-10-17T11:00:00Z STAGE COPYING_RESULTS\n"));
    assert_eq!(derive(ReceiptStatus::Accepted, Some(JobState::Completing), &t, None).state, Some(WorkflowState::CopyingResults));
    // Node failure with and without a durable checkpoint.
    let nf = derive(ReceiptStatus::Accepted, Some(JobState::NodeFail), &t, None);
    assert_eq!(nf.state, Some(WorkflowState::NodeFailure));
    assert!(nf.recovery_note.unwrap().contains("resume from it"));
    assert_eq!(nf.last_checkpoint_at.as_deref(), Some("2026-10-17T10:31:30Z"));
    let nf0 = derive(ReceiptStatus::Accepted, Some(JobState::NodeFail), &running, None);
    assert!(nf0.recovery_note.unwrap().contains("No checkpoint was synced"), "never promise recovery without a checkpoint");
    assert_eq!(derive(ReceiptStatus::Accepted, Some(JobState::Cancelled), &t, None).state, Some(WorkflowState::Cancelled));
    assert_eq!(derive(ReceiptStatus::Accepted, Some(JobState::OutOfMemory), &t, None).failure, Some(FailureKind::HostOutOfMemory));
    // Unknown outcomes never look like success and never imply resubmission.
    assert_eq!(derive(ReceiptStatus::Uncertain, None, &[], None).state, Some(WorkflowState::RecoveryRequired));
    assert_eq!(derive(ReceiptStatus::Submitting, None, &[], None).state, Some(WorkflowState::RecoveryRequired));
    assert_eq!(derive(ReceiptStatus::Accepted, None, &running, None).state, Some(WorkflowState::RecoveryRequired));
    assert_eq!(derive(ReceiptStatus::Rejected, None, &[], None).failure, Some(FailureKind::SchedulerRejected));
    // Completed with markers missing (status file unreadable) still completes, labelled.
    let o = derive(ReceiptStatus::Accepted, Some(JobState::Completed), &[], None);
    assert_eq!(o.state, Some(WorkflowState::Completed));
    assert!(o.message.unwrap().contains("not available"));
}

#[test]
fn log_tails_classify_common_gpu_failures() {
    let k = |s: &str| classify_log(s).map(|x| x.0);
    assert_eq!(k("torch.OutOfMemoryError: CUDA out of memory. Tried to allocate"), Some(FailureKind::GpuOutOfMemory));
    assert_eq!(k("RuntimeError: CUDA error: no kernel image is available for execution on the device"), Some(FailureKind::CudaIncompatible));
    assert_eq!(k("OSError: [Errno 28] No space left on device"), Some(FailureKind::ScratchExhausted));
    assert_eq!(k("OSError: [Errno 116] Stale file handle"), Some(FailureKind::NfsFailure));
    assert_eq!(k("ModuleNotFoundError: No module named 'transformers'"), Some(FailureKind::PythonEnvironment));
    assert_eq!(k("ValueError: whatever"), None);
    let o = derive(ReceiptStatus::Accepted, Some(JobState::Failed), &ev("2026-10-17T10:00:00Z TRAINING_EXIT code=1\n"), Some("CUDA out of memory"));
    assert_eq!(o.failure, Some(FailureKind::GpuOutOfMemory));
}

#[test]
fn event_parser_ignores_program_output_and_forged_lines() {
    let e = parse_events("hello\n@@icfcc 2026-10-17T10:00:00Z STAGE TRAINING\nnot 2026 STAGE\n2026-10-17T10:00:01Z lower case\n2026-10-17T10:00:02Z RESULT_SYNC ok files=3\x1b[31m\n");
    assert_eq!(names(&e), vec!["STAGE TRAINING", "RESULT_SYNC"]);
    assert_eq!(e[1].arg("files"), Some("3"), "escape sequences stripped");
}

#[test]
fn status_reads_are_bounded_owner_checked_and_parsed() {
    let n = node_or_skip!();
    let h = n.h();
    let st = n.home().join("proj/runs/train-1/icfcc-status.log");
    std::fs::create_dir_all(st.parent().unwrap()).unwrap();
    std::fs::write(&st, "2026-10-17T10:00:00Z STAGE TRAINING\n").unwrap();
    std::fs::write(n.home().join("proj/runs/slurm-2.out"), "noise\n@@icfcc 2026-10-17T10:00:00Z FAILED reason=ENV_SETUP\n").unwrap();
    std::fs::write(n.home().join("proj/runs/slurm-2.err"), "Traceback\nCUDA out of memory\n").unwrap();
    std::fs::write(n.root.join("elsewhere/s.log"), "2026-10-17T10:00:00Z DONE exit=0\n").unwrap();
    std::os::unix::fs::symlink(n.root.join("elsewhere/s.log"), n.home().join("proj/runs/escape.log")).unwrap();
    let stub = n.root.join("bin/stat");
    std::fs::write(&stub, "#!/bin/sh\nid -un\n").unwrap(); // GNU `stat -c %U` stand-in
    std::fs::set_permissions(&stub, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let t = |tag: &str, file: &str, id: &str, want_err: bool| StatusTarget {
        tag: tag.into(),
        status_file: format!("{h}/proj/runs/{file}"),
        stdout: format!("{h}/proj/runs/slurm-{id}.out"),
        stderr: format!("{h}/proj/runs/slurm-{id}.err"),
        want_err,
    };
    let script = status_script(
        &whoami(),
        &[t("a", "train-1/icfcc-status.log", "1", false), t("b", "train-2/icfcc-status.log", "2", true), t("c'; touch PWNED; '", "escape.log", "3", false)],
    );
    let out = Command::new("/bin/sh")
        .arg("-s")
        .env_clear()
        .env("HOME", n.home())
        .env("PATH", format!("{}:/usr/bin:/bin", n.root.join("bin").display()))
        .current_dir(&n.root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .and_then(|mut c| {
            std::io::Write::write_all(c.stdin.as_mut().unwrap(), script.as_bytes())?;
            c.wait_with_output()
        })
        .unwrap();
    let reads = parse_status(&String::from_utf8_lossy(&out.stdout)).unwrap();
    assert_eq!(names(&parse_events(reads["a"].status.as_deref().unwrap())), vec!["STAGE TRAINING"]);
    assert_eq!(names(&parse_events(reads["b"].status.as_deref().unwrap())), vec!["FAILED"], "stdout markers as fallback");
    assert!(reads["b"].err_tail.as_deref().unwrap().contains("CUDA out of memory"));
    assert_eq!(reads["c'; touch PWNED; '"].status, None, "symlink out of home is not read");
    assert!(!n.root.join("PWNED").exists());
}

#[test]
fn metrics_lines_are_parsed_defensively() {
    let pts = commands::parse_metrics(
        "{\"step\": 1, \"loss\": 2.5, \"lr\": 0.001}\nnot json\n{\"epoch\": 1, \"val_loss\": 1.5, \"evil\": \"<script>\"}\n{\"loss\": \"NaN\"}\n[1,2]\n",
    );
    assert_eq!(pts.len(), 2);
    assert_eq!(pts[0].step, Some(1.0));
    assert_eq!(pts[0].values, vec![("loss".to_string(), 2.5), ("lr".to_string(), 0.001)]);
    assert_eq!(pts[1].values, vec![("val_loss".to_string(), 1.5)]);
}

#[test]
fn run_store_survives_restart_and_scopes_identities() {
    let dir = std::env::temp_dir().join(format!("icfcc-runs-{}", crate::util::random_hex(4)));
    let mut s = store::RunStore::load(&dir);
    let run = |tag: &str, profile: &str, user: &str| store::WorkflowRun {
        tag: tag.into(),
        profile_id: profile.into(),
        user: user.into(),
        job_id: Some("4242".into()),
        name: "train".into(),
        kind: WorkflowKind::Train,
        config: cfg(HOME),
        checksum: "c".into(),
        submitted_at: "2026-10-17T10:00:00Z".into(),
        submission: ReceiptStatus::Accepted,
        submission_message: None,
        scheduler_state: Some(JobState::Running),
        observed: Default::default(),
        events: vec![],
        last_checked_at: None,
        finalized: false,
        dismissed: false,
        log_dir: None,
    };
    // A run from before 0.5.1 keeps reading its logs from the results folder; a new one from icfcc-run.
    let old = run("t0", "default", "s1");
    assert_eq!(old.log_path("out").unwrap(), format!("{}/slurm-4242.out", old.config.results_root));
    let new = store::WorkflowRun { log_dir: Some(format!("{HOME}/proj/icfcc-run")), ..old };
    assert_eq!(new.log_path("err").unwrap(), format!("{HOME}/proj/icfcc-run/slurm-4242.err"));
    s.upsert(run("t1", "default", "s1")).unwrap();
    s.upsert(run("t2", "other", "s2")).unwrap();
    let reloaded = store::RunStore::load(&dir);
    assert_eq!(reloaded.for_user("default", "s1").len(), 1);
    assert_eq!(reloaded.for_user("default", "s1")[0].run_dir().as_deref(), Some("/home/demo/proj/runs/train-4242"));
    assert!(reloaded.get("default", "s1", "t2").is_err(), "another profile's run is invisible");
    assert!(reloaded.for_user("default", "s1")[0].needs_poll());
    let text = std::fs::read_to_string(dir.join("runs.json")).unwrap();
    assert!(!text.to_lowercase().contains("password"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn workflow_submission_prechecks_create_results_root_safely_then_sbatch_once() {
    let n = node_or_skip!();
    let log = n.root.join("calls.log");
    let stub = |name: &str, body: String| {
        let p = n.root.join("bin").join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    };
    stub("sbatch", format!("printf 'sbatch %s\\n' \"$*\" >> '{}'; cat > '{}'; echo 777", log.display(), n.root.join("submitted.sh").display()));
    let sh = |script: &str| {
        let mut c = Command::new("/bin/sh")
            .arg("-s")
            .env_clear()
            .env("HOME", n.home())
            .env("PATH", format!("{}:/usr/bin:/bin", n.root.join("bin").display()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(c.stdin.as_mut().unwrap(), script.as_bytes()).unwrap();
        String::from_utf8_lossy(&c.wait_with_output().unwrap().stdout).into_owned()
    };
    let mut c = n.config();
    c.results_root = format!("{}/proj/new/runs", n.h());
    let (v, checks) = plan(&c, &Context { home: &n.h(), snapshot: &demo_snapshot(0), learned: PartitionRecord::Accepted });
    assert!(v.errors.is_empty(), "{:?}", v.errors);
    let job = render(&c, "ab12");
    let out = sh(&crate::jobs::remote::submit_script_with(&checks, &job, "ab12"));
    assert_eq!(
        crate::jobs::remote::classify_submit(Ok(crate::ssh::Captured { code: Some(0), stdout: out.clone(), stderr: String::new(), timed_out: false })),
        crate::jobs::remote::SubmitOutcome::Accepted { job_id: "777".into(), cluster: None },
        "{out}"
    );
    assert!(n.home().join("proj/new/runs").is_dir(), "results root created inside home");
    assert_eq!(std::fs::read_to_string(n.root.join("submitted.sh")).unwrap(), job, "sbatch got the reviewed script byte for byte");
    assert_eq!(std::fs::read_to_string(&log).unwrap().matches("sbatch").count(), 1);
    // A results folder whose parent is a symlink out of home is never created, and nothing is submitted.
    std::os::unix::fs::symlink(n.root.join("elsewhere"), n.home().join("proj/link")).unwrap();
    c.results_root = format!("{}/proj/link/runs", n.h());
    let (_, checks) = plan(&c, &Context { home: &n.h(), snapshot: &demo_snapshot(0), learned: PartitionRecord::Accepted });
    let out = sh(&crate::jobs::remote::submit_script_with(&checks, &render(&c, "cd34"), "cd34"));
    assert!(out.contains("@@err outside resultsRoot"), "{out}");
    assert!(!n.root.join("elsewhere/runs").exists());
    assert_eq!(std::fs::read_to_string(&log).unwrap().matches("sbatch").count(), 1, "no second sbatch");
    // A missing dataset blocks submission too.
    let mut c = n.config();
    c.datasets[0].archive = format!("{}/data/missing.tar.gz", n.h());
    let (_, checks) = plan(&c, &Context { home: &n.h(), snapshot: &demo_snapshot(0), learned: PartitionRecord::Accepted });
    assert!(sh(&crate::jobs::remote::submit_script_with(&checks, &render(&c, "ef56"), "ef56")).contains("@@err missing dataset"));
}
