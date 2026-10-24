use super::parse::*;
use super::remote::*;
use super::request::*;
use super::store::{JobReceipt, PartitionRecord, ReceiptStatus, ReceiptStore};
use crate::errors::{AppError, ErrorCode};
use crate::slurm::demo_snapshot;
use crate::ssh::Captured;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const HOME: &str = "/home/demo";

fn req() -> JobRequest {
    JobRequest {
        partition: "Teaching".into(),
        gres_type: Some("nvidia_rtx_a6000".into()),
        gpu_count: 1,
        cpus: 8,
        memory_mib: 32 * 1024,
        time_limit_seconds: 12 * 3600,
        job_name: "semeval-train".into(),
        working_dir: "/home/demo/projects/semeval".into(),
        runner: Runner::Python,
        program: "train.py".into(),
        program_args: vec!["--epochs".into(), "3".into()],
        python_env: Some("/home/demo/projects/icf-env".into()),
        setup_source: None,
        mail_user: None,
    }
}

fn check(r: &JobRequest) -> Validation {
    let snap = demo_snapshot(0);
    validate(r, &Context { home: HOME, snapshot: &snap, learned: PartitionRecord::None })
}

fn fields(v: &Validation) -> Vec<String> {
    v.errors.iter().filter_map(|i| i.field.clone()).collect()
}

// ---------- validation ----------

#[test]
fn valid_request_has_no_errors_but_needs_eligibility_ack() {
    let v = check(&req());
    assert!(v.errors.is_empty(), "{:?}", v.errors);
    assert!(v.acknowledgements.iter().any(|a| a.contains("Eligibility")));
}

#[test]
fn policy_and_limit_errors() {
    let with = |f: &dyn Fn(&mut JobRequest)| {
        let mut r = req();
        f(&mut r);
        fields(&check(&r))
    };
    assert_eq!(with(&|r| r.partition = "Nope".into()), ["partition"]);
    assert!(with(&|r| r.partition = "Open-Research".into()).contains(&"partition".to_string()), "not permitted by AllowGroups");
    assert_eq!(with(&|r| r.time_limit_seconds = 3 * 86_400), ["timeLimitSeconds"], "Teaching max is 2 days");
    assert_eq!(with(&|r| r.time_limit_seconds = 10), ["timeLimitSeconds"]);
    assert_eq!(with(&|r| r.gres_type = Some("nvidia_h100".into())), ["gresType"], "type absent from partition");
    assert_eq!(with(&|r| r.gpu_count = 9), ["gpuCount"], "largest node has 8");
    assert_eq!(with(&|r| r.gpu_count = 0), ["gpuCount"]);
    assert_eq!(with(&|r| r.cpus = 33), ["cpus"], "landonia11 has 32 CPUs");
    assert_eq!(with(&|r| r.memory_mib = 512 * 1024), ["memoryMib"]);
    assert_eq!(with(&|r| r.memory_mib = 100), ["memoryMib"]);
    let mut r = req();
    r.partition = "Interactive".into();
    r.gres_type = Some("nvidia_rtx_a6000".into());
    assert!(fields(&check(&r)).contains(&"gresType".to_string()), "Interactive only has 2080 Ti");
    r.gres_type = Some("nvidia_geforce_rtx_2080_ti".into());
    r.cpus = 4;
    r.memory_mib = 8192;
    r.time_limit_seconds = 3600;
    let v = check(&r);
    assert!(v.errors.is_empty(), "{:?}", v.errors);
    assert!(v.acknowledgements.iter().any(|a| a.contains("Interactive")));
}

#[test]
fn multi_gpu_and_foreign_setup_require_acknowledgement() {
    let mut r = req();
    r.gpu_count = 2;
    r.setup_source = Some("/home/htang2/toolchain-20251006/toolchain.rc".into());
    let v = check(&r);
    assert!(v.errors.is_empty(), "{:?}", v.errors);
    assert!(v.acknowledgements.iter().any(|a| a.contains("2 GPUs")));
    assert!(v.acknowledgements.iter().any(|a| a.contains("outside your home")));
}

#[test]
fn injection_attempts_in_paths_and_names_are_rejected_locally() {
    for bad in [
        "/home/demo/x; rm -rf ~",
        "/home/demo/$(id)",
        "/home/demo/`id`",
        "/home/demo/a b",
        "/home/demo/x\ny",
        "/home/demo/'q'",
        "/home/demo/\"q\"",
        "/home/demo/../other",
        "/home/demo/./x",
        "/home/demo//x",
        "~/x",
        "/home/demo/*",
        "/home/demo/x%j",
        "relative/dir",
        "/home/demo/x\u{0}",
    ] {
        let mut r = req();
        r.working_dir = bad.into();
        assert!(fields(&check(&r)).contains(&"workingDir".to_string()), "{bad:?}");
    }
    for bad in ["../escape.py", "a/../../b.py", "x;y.py", "$(id).py", "/etc/passwd", "/home/demoX/t.py"] {
        let mut r = req();
        r.program = bad.into();
        assert!(fields(&check(&r)).contains(&"program".to_string()), "{bad:?}");
    }
    for bad in ["-x", "a b", "x\ny", "a;b", "$(id)", ""] {
        let mut r = req();
        r.job_name = bad.into();
        assert!(fields(&check(&r)).contains(&"jobName".to_string()), "{bad:?}");
    }
    let mut r = req();
    r.program_args = vec!["ok".into(), "line\nbreak".into()];
    assert!(fields(&check(&r)).contains(&"programArgs".to_string()));
    let mut r = req();
    r.gres_type = Some("a6000 --wrap=evil".into());
    assert!(fields(&check(&r)).contains(&"gresType".to_string()));
    let mut r = req();
    r.python_env = Some("/opt/shared/env".into());
    assert!(fields(&check(&r)).contains(&"pythonEnv".to_string()), "venv must be under home");
    for bad in [
        "",
        "s1234567",
        "s1@ed",
        "a b@ed.ac.uk",
        "s1@ed.ac.uk\n#SBATCH --wrap=evil",
        "s1@ed.ac.uk --wrap=evil",
        "'s1'@ed.ac.uk",
        "s1@ed.ac.uk;id",
        "%u@ed.ac.uk",
        "$USER@ed.ac.uk",
        "-s1@ed.ac.uk",
        ".s1@ed.ac.uk",
        "s1..x@ed.ac.uk",
        "s1@@ed.ac.uk",
        "s1@-ed.ac.uk",
        "s1@ed..ac.uk",
        "s1@ed.ac.uk.",
        "s1,s2@ed.ac.uk",
    ] {
        let mut r = req();
        r.mail_user = Some(bad.into());
        assert_eq!(fields(&check(&r)), ["mailUser"], "{bad:?}");
    }
    for ok in ["s1234567@ed.ac.uk", "first.last+icf@sms.ed.ac.uk", "A_b-c@x-y.example.org"] {
        assert!(valid_mail(ok), "{ok}");
    }
}

#[test]
fn unknown_fields_are_rejected() {
    let mut j = serde_json::to_value(req()).unwrap();
    j["extraSbatchArgs"] = "--wrap=evil".into();
    assert!(serde_json::from_value::<JobRequest>(j).is_err());
}

// ---------- script rendering ----------

#[test]
fn renders_exact_reviewed_script() {
    let s = render_script(&req(), "abc123");
    assert_eq!(
        s,
        "#!/bin/bash\n\
#SBATCH --job-name=semeval-train\n\
#SBATCH --partition=Teaching\n\
#SBATCH --nodes=1\n\
#SBATCH --ntasks=1\n\
#SBATCH --gres=gpu:nvidia_rtx_a6000:1\n\
#SBATCH --cpus-per-task=8\n\
#SBATCH --mem=32768M\n\
#SBATCH --time=0-12:00:00\n\
#SBATCH --chdir=/home/demo/projects/semeval\n\
#SBATCH --output=/home/demo/projects/semeval/slurm-%j.out\n\
#SBATCH --error=/home/demo/projects/semeval/slurm-%j.err\n\
#SBATCH --comment=icfcc-abc123\n\
# Generated by ICF Control Center. Long-running work runs here on the compute node, not on the login node.\n\
set -e\n\
echo \"[icf-control-center] job ${SLURM_JOB_ID} on $(hostname) started $(date -u +%Y-%m-%dT%H:%M:%SZ)\"\n\
source '/home/demo/projects/icf-env/bin/activate'\n\
exec python '/home/demo/projects/semeval/train.py' '--epochs' '3'\n"
    );
    assert!(!s.to_lowercase().contains("password"));
    let mut r = req();
    r.gres_type = None;
    r.python_env = None;
    r.runner = Runner::Bash;
    r.program = "run.sh".into();
    let s = render_script(&r, "t");
    assert!(s.contains("#SBATCH --gres=gpu:1\n") && s.contains("exec bash '/home/demo/projects/semeval/run.sh'"));
    assert!(!s.contains("--mail"), "no e-mail unless asked for");
    r.mail_user = Some("s1234567@ed.ac.uk".into());
    assert!(render_script(&r, "t").contains("#SBATCH --comment=icfcc-t\n#SBATCH --mail-type=END,FAIL\n#SBATCH --mail-user=s1234567@ed.ac.uk\n# Generated"));
    assert_eq!(format_time_limit(2 * 86_400 + 3723), "2-01:02:03");
    assert_eq!(checksum("a"), checksum("a"));
    assert_ne!(checksum("a"), checksum("b"));
}

// ---------- parsers ----------

#[test]
fn job_states_and_ids() {
    for (raw, want) in [
        ("PENDING", JobState::Pending),
        ("PD", JobState::Pending),
        ("R", JobState::Running),
        ("COMPLETED", JobState::Completed),
        ("CANCELLED by 1234", JobState::Cancelled),
        ("CANCELLED+", JobState::Cancelled),
        ("TIMEOUT", JobState::Timeout),
        ("NODE_FAIL", JobState::NodeFail),
        ("OUT_OF_MEMORY", JobState::OutOfMemory),
        ("REQUEUED", JobState::Requeued),
        ("FAILED", JobState::Failed),
        ("WEIRD", JobState::Unknown),
    ] {
        assert_eq!(normalize_state(raw), want, "{raw}");
    }
    for ok in ["1", "2093068", "123_4"] {
        assert!(valid_job_id(ok), "{ok}");
    }
    for bad in ["", "-1", "123;rm", "12*", "123_[1-3]", "123 456", "abc", "1234567890123", "123_"] {
        assert!(!valid_job_id(bad), "{bad}");
    }
}

#[test]
fn sbatch_receipts() {
    assert_eq!(parse_receipt("3678999\n"), Some(Receipt { job_id: "3678999".into(), cluster: None }));
    assert_eq!(parse_receipt("3678999;icf\n"), Some(Receipt { job_id: "3678999".into(), cluster: Some("icf".into()) }));
    assert_eq!(parse_receipt("sbatch: warning: something\n42\n").unwrap().job_id, "42");
    assert_eq!(parse_receipt("Submitted batch job 42"), None, "--parsable output only");
    assert_eq!(parse_receipt("42;bad cluster"), None);
    assert_eq!(parse_receipt(""), None);
}

#[test]
fn squeue_sacct_scontrol_parsing() {
    let s = '\u{1f}';
    let line = format!("4242{s}s1{s}Teaching{s}RUNNING{s}1:02:03{s}10:57:57{s}12:00:00{s}8{s}32G{s}gres/gpu:nvidia_rtx_a6000:1{s}2026-10-16T09:00:00{s}2026-10-16T09:05:00{s}landonia11{s}None{s}icfcc-abc{s}name with | pipes");
    let r = parse_squeue_line(&line).unwrap();
    assert_eq!(
        (r.job_id.as_str(), r.state, r.nodes.as_deref(), r.gpus.as_deref()),
        ("4242", JobState::Running, Some("landonia11"), Some("nvidia_rtx_a6000 × 1"))
    );
    assert_eq!(r.name, "name with | pipes");
    assert_eq!(r.comment.as_deref(), Some("icfcc-abc"));
    let pending = line.replace("RUNNING", "PENDING").replace("None", "Resources");
    let p = parse_squeue_line(&pending).unwrap();
    assert_eq!((p.nodes, p.started_at, p.reason.as_deref()), (None, None, Some("Resources")), "pending jobs have no node yet (V2-AC03)");
    assert!(parse_squeue_line("garbage").is_none());
    assert!(parse_squeue_line(&format!("{s}{s}")).is_none());

    let sacct = format!(
        "JobID{s}User{s}Partition{s}State{s}Elapsed{s}Timelimit{s}AllocCPUS{s}ReqMem{s}AllocTRES{s}Submit{s}Start{s}End{s}NodeList{s}ExitCode{s}Comment{s}JobName\n\
100{s}s1{s}Teaching{s}FAILED{s}00:00:05{s}01:00:00{s}4{s}16G{s}billing=4,cpu=4,gres/gpu:nvidia_l40s=1,gres/gpu=1,mem=16G,node=1{s}2026-10-15T10:00:00{s}2026-10-15T10:00:01{s}2026-10-15T10:00:06{s}scotia01{s}1:0{s}{s}bad\n\
100.batch{s}{s}{s}FAILED{s}{s}{s}{s}{s}{s}{s}{s}{s}{s}{s}{s}batch\n\
101{s}s1{s}Teaching{s}CANCELLED by 1000{s}00:00:00{s}01:00:00{s}4{s}16G{s}{s}x{s}None{s}x{s}None assigned{s}0:0{s}{s}c\n"
    );
    let rows = parse_sacct(&sacct);
    assert_eq!(rows.len(), 2, "steps are skipped");
    assert_eq!((rows[0].state, rows[0].exit_code.as_deref(), rows[0].gpus.as_deref()), (JobState::Failed, Some("1:0"), Some("nvidia_l40s × 1")));
    assert_eq!((rows[1].state, rows[1].nodes.clone()), (JobState::Cancelled, None));
    assert!(parse_sacct("").is_empty());

    let sc = "JobId=4242 JobName=semeval-train UserId=s1(1234) GroupId=s1(1234) JobState=FAILED Reason=NonZeroExitCode ExitCode=1:0 RunTime=00:00:05 TimeLimit=12:00:00 SubmitTime=2026-10-16T09:00:00 StartTime=2026-10-16T09:05:00 EndTime=2026-10-16T09:05:05 Partition=Teaching NodeList=landonia11 NumCPUs=8 TRES=cpu=8,mem=32G,node=1,billing=8,gres/gpu=1 TresPerNode=gres/gpu:nvidia_rtx_a6000:1 WorkDir=/home/s1/p StdErr=/home/s1/p/slurm-4242.err StdOut=/home/s1/p/slurm-4242.out";
    let j = parse_scontrol_job(sc).unwrap();
    assert_eq!((j.owner.as_str(), j.row.state, j.row.memory.as_deref()), ("s1", JobState::Failed, Some("32G")));
    assert_eq!(j.stdout.as_deref(), Some("/home/s1/p/slurm-4242.out"));
    assert_eq!(j.row.reason.as_deref(), Some("NonZeroExitCode"));

    // SLURM >= 20 layout (shape of ICF's 25.05 smoke-test job 3680123): keys with ':' and '/',
    // ReqTRES/AllocTRES instead of TRES.
    let modern = "JobId=3680123 JobName=icfcc-smoke UserId=s1(1234) GroupId=s1(1234) JobState=COMPLETED Reason=None ExitCode=0:0 RunTime=00:00:01 TimeLimit=00:05:00 Partition=Teaching AllocNode:Sid=hastings:3308784 ReqNodeList=(null) NodeList=opencast NumNodes=1 NumCPUs=2 NumTasks=1 CPUs/Task=2 ReqB:S:C:T=0:0:*:* ReqTRES=cpu=2,mem=4G,node=1,billing=2,gres/gpu=1 AllocTRES=cpu=2,mem=4G,node=1,billing=2,gres/gpu=1 Socks/Node=* NtasksPerN:B:S:C=1:0:*:* CoreSpec=* MinCPUsNode=2 MinTmpDiskNode=0 WorkDir=/home/s1/icfcc-smoke TresPerNode=gres/gpu:nvidia_geforce_rtx_2080_ti:1";
    let m = parse_scontrol_job(modern).unwrap();
    assert_eq!((m.row.partition.as_str(), m.row.memory.as_deref(), m.row.cpus), ("Teaching", Some("4G"), Some(2)));
    let per_cpu = parse_scontrol_job("JobId=1 UserId=s1(1) JobState=PENDING Partition=Teaching NumCPUs=2 MinMemoryCPU=2G").unwrap();
    assert_eq!(per_cpu.row.memory.as_deref(), Some("2G per CPU"));
}

#[test]
fn log_paths_and_chunks() {
    assert_eq!(resolve_log_path("/home/s1/p/slurm-%j.out", "4242", "n", "s1").unwrap(), "/home/s1/p/slurm-4242.out");
    assert_eq!(resolve_log_path("/home/s1/%u/%x-%A_%a.log", "10_3", "train", "s1").unwrap(), "/home/s1/s1/train-10_3.log");
    assert!(resolve_log_path("/home/s1/%N.out", "1", "n", "s1").is_err(), "unsupported pattern refused");
    assert!(resolve_log_path("/home/s1/%a.out", "1", "n", "s1").is_err());
    assert!(resolve_log_path("relative.out", "1", "n", "s1").is_err());
    assert!(resolve_log_path("/home/s1/../x", "1", "n", "s1").is_err());

    let ok = parse_log_output("@@size 10\n@@from 0\n@@next 10\n@@data\nhello\n\u{1b}[31mx\n", 1000);
    assert_eq!(ok, LogResult::Chunk { size: 10, from: 0, next: 10, rotated: false, text: "hello\nx\n".into() });
    let rot = parse_log_output("@@size 3\n@@rotated\n@@from 0\n@@next 3\n@@data\nabc", 1000);
    assert!(matches!(rot, LogResult::Chunk { rotated: true, .. }));
    assert_eq!(parse_log_output("@@err missing\n", 10), LogResult::Error("missing".into()));
    assert_eq!(parse_log_output("random", 10), LogResult::Error("malformed".into()));
    // Content that looks like markers is data, not headers.
    let tricky = parse_log_output("@@size 9\n@@from 0\n@@next 9\n@@data\n@@err x\n", 100);
    assert!(matches!(tricky, LogResult::Chunk { ref text, .. } if text == "@@err x\n"));
}

// ---------- outcome classification ----------

fn cap(stdout: &str, timed_out: bool) -> Result<Captured, AppError> {
    Ok(Captured { code: if timed_out { None } else { Some(0) }, stdout: stdout.into(), stderr: String::new(), timed_out })
}

#[test]
fn submit_outcomes() {
    assert!(matches!(classify_submit(Err(AppError::new(ErrorCode::NotConnected, "gone"))), SubmitOutcome::Rejected { .. }), "never sent");
    assert!(matches!(classify_submit(Err(AppError::new(ErrorCode::SshTimeout, "t"))), SubmitOutcome::Uncertain { .. }));
    assert!(matches!(classify_submit(cap("@@err missing program\n", false)), SubmitOutcome::Rejected { code: ErrorCode::InvalidPath, .. }));
    assert!(matches!(classify_submit(cap("", true)), SubmitOutcome::Uncertain { .. }), "no confirmation that sbatch did not run");
    assert!(matches!(classify_submit(cap("@@submitting\n", true)), SubmitOutcome::Uncertain { .. }));
    assert_eq!(classify_submit(cap("@@submitting\n4242\n\n@@rc 0\n", false)), SubmitOutcome::Accepted { job_id: "4242".into(), cluster: None });
    let rej = classify_submit(cap("@@submitting\nsbatch: error: Invalid generic resource (gres) specification\n\n@@rc 1\n", false));
    assert!(matches!(rej, SubmitOutcome::Rejected { code: ErrorCode::NoResource, .. }), "{rej:?}");
    let perm = classify_submit(cap(
        "@@submitting\nsbatch: error: Batch job submission failed: Invalid account or account/partition combination specified\n@@rc 1\n",
        false,
    ));
    assert!(matches!(perm, SubmitOutcome::Rejected { code: ErrorCode::SlurmPermission, .. }));
    assert!(matches!(classify_submit(cap("@@submitting\n\n@@rc 0\n", false)), SubmitOutcome::Uncertain { .. }));
}

#[test]
fn cancel_outcomes() {
    assert_eq!(classify_cancel(cap("@@cancelling\n\n@@rc 0\n", false)), CancelOutcome::Requested);
    assert!(matches!(classify_cancel(cap("@@err not_owner\n", false)), CancelOutcome::Refused { code: ErrorCode::SlurmPermission, .. }));
    assert!(matches!(classify_cancel(cap("@@err not_active\n", false)), CancelOutcome::Refused { .. }));
    assert!(matches!(classify_cancel(cap("@@cancelling\n", true)), CancelOutcome::Uncertain { .. }));
    assert!(matches!(classify_cancel(Err(AppError::new(ErrorCode::NotConnected, "x"))), CancelOutcome::Refused { .. }));
}

#[test]
fn list_parsing_filters_foreign_rows_and_degrades_history() {
    let s = '\u{1f}';
    let row = |u: &str| format!("1{s}{u}{s}Teaching{s}PENDING{s}0:00{s}12:00:00{s}12:00:00{s}4{s}16G{s}gres/gpu:1{s}2026{s}N/A{s}{s}Priority{s}{s}x");
    let out = format!("@@squeue\n{}\n{}\n\n@@rc 0\n@@sacct\nsacct: error: Slurm accounting storage is disabled\n\n@@rc 1\n", row("s1"), row("mallory"));
    let l = parse_list(&out, "s1", 0).unwrap();
    assert_eq!((l.active.len(), l.foreign_rows_dropped), (1, 1));
    assert!(l.history.is_none() && l.history_note.as_deref().unwrap().contains("storage is disabled"));
    let l = parse_list("@@squeue\n\n@@rc 0\n@@sacct\n@@nosacct\n", "s1", 0).unwrap();
    assert!(l.active.is_empty() && l.history_note.is_some(), "no jobs is a valid empty state");
    assert!(parse_list("@@squeue\nslurm_load_jobs error: Unable to contact slurm controller\n@@rc 1\n", "s1", 0).is_err());
    assert!(parse_list("garbage", "s1", 0).is_err());
}

// ---------- executing the generated remote scripts in a real shell ----------

struct Sandbox {
    root: PathBuf,
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl Sandbox {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("icfcc-sh-{}", crate::util::random_hex(6)));
        std::fs::create_dir_all(root.join("home/s1/projects/semeval")).unwrap();
        std::fs::create_dir_all(root.join("home/s1/env/bin")).unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(root.join("elsewhere")).unwrap();
        std::fs::write(root.join("home/s1/projects/semeval/train.py"), "print('hi')\n").unwrap();
        std::fs::write(root.join("home/s1/env/bin/activate"), "# venv\n").unwrap();
        // Stubs record argv/stdin instead of touching any scheduler.
        let stub = |name: &str, body: &str| {
            let p = root.join("bin").join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        };
        let log = root.join("calls.log");
        let l = log.display();
        stub("sbatch", &format!("printf 'sbatch %s\\n' \"$*\" >> '{l}'; cat > '{}'; echo 4242", root.join("submitted.sh").display()));
        stub("squeue", &format!("printf 'squeue %s\\n' \"$*\" >> '{l}'; cat '{}' 2>/dev/null", root.join("squeue.out").display()));
        stub("scancel", &format!("printf 'scancel %s\\n' \"$*\" >> '{l}'"));
        stub("python3", "for a in \"$@\"; do printf '<%s>\\n' \"$a\"; done");
        stub("python", "for a in \"$@\"; do printf '<%s>\\n' \"$a\"; done");
        // GNU `stat -c %U` stand-in (macOS stat differs); remote ICF is Linux.
        stub("stat", "id -un");
        Self { root }
    }
    fn home(&self) -> PathBuf {
        // Canonical path (macOS /var -> /private/var) to match `pwd -P` on the remote side.
        std::fs::canonicalize(self.root.join("home/s1")).unwrap()
    }
    fn run(&self, script: &str) -> String {
        let mut child = Command::new("/bin/sh")
            .arg("-s")
            .env_clear()
            .env("HOME", self.home())
            .env("PATH", format!("{}:/usr/bin:/bin", self.root.join("bin").display()))
            .current_dir(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(child.stdin.as_mut().unwrap(), script.as_bytes()).unwrap();
        String::from_utf8_lossy(&child.wait_with_output().unwrap().stdout).into_owned()
    }
    fn calls(&self) -> String {
        std::fs::read_to_string(self.root.join("calls.log")).unwrap_or_default()
    }
    fn req(&self) -> JobRequest {
        let h = self.home().display().to_string();
        JobRequest {
            working_dir: format!("{h}/projects/semeval"),
            python_env: Some(format!("{h}/env")),
            program_args: vec!["$(touch PWNED)".into(), "`touch PWNED2`".into(), "it's; rm -rf /".into(), "--lr=1e-3 x".into()],
            ..req()
        }
    }
}

#[test]
fn submit_script_runs_sbatch_once_with_exact_reviewed_script_and_args_stay_literal() {
    let sb = Sandbox::new();
    let r = sb.req();
    let job = render_script(&r, "tag1");
    let out = sb.run(&submit_script(&r, &job, "tag1"));
    assert_eq!(classify_submit(cap(&out, false)), SubmitOutcome::Accepted { job_id: "4242".into(), cluster: None }, "{out}");
    assert_eq!(sb.calls().matches("sbatch").count(), 1);
    assert!(sb.calls().contains("sbatch --parsable"));
    assert_eq!(std::fs::read_to_string(sb.root.join("submitted.sh")).unwrap(), job, "sbatch received exactly the previewed script");

    // Run the submitted job script itself (stub python prints argv): payloads arrive verbatim, nothing executes.
    let job_out = Command::new("/bin/bash")
        .arg(sb.root.join("submitted.sh"))
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", sb.root.join("bin").display()))
        .env("SLURM_JOB_ID", "4242")
        .current_dir(&sb.root)
        .output()
        .unwrap();
    let printed = String::from_utf8_lossy(&job_out.stdout);
    for a in &r.program_args {
        assert!(printed.contains(&format!("<{a}>")), "{printed}");
    }
    assert!(!sb.root.join("PWNED").exists() && !sb.root.join("PWNED2").exists(), "argument injection executed");
}

#[test]
fn submit_prechecks_block_sbatch() {
    let sb = Sandbox::new();
    // Missing program.
    let mut r = sb.req();
    r.program = "missing.py".into();
    let out = sb.run(&submit_script(&r, &render_script(&r, "t"), "t"));
    assert!(matches!(classify_submit(cap(&out, false)), SubmitOutcome::Rejected { code: ErrorCode::InvalidPath, .. }), "{out}");
    // Program is a symlink escaping home.
    std::fs::write(sb.root.join("elsewhere/evil.py"), "").unwrap();
    std::os::unix::fs::symlink(sb.root.join("elsewhere/evil.py"), sb.home().join("projects/semeval/link.py")).unwrap();
    let mut r = sb.req();
    r.program = "link.py".into();
    let out = sb.run(&submit_script(&r, &render_script(&r, "t"), "t"));
    assert!(out.contains("@@err outside program"), "{out}");
    assert!(!sb.calls().contains("sbatch"), "sbatch never ran");
}

#[test]
fn heredoc_cannot_be_terminated_early_by_content() {
    // Even if an argument contained the delimiter text, it is quoted on one line with other text.
    let sb = Sandbox::new();
    let mut r = sb.req();
    r.program_args = vec!["ICFCC_JOB_t".into()];
    let job = render_script(&r, "t");
    let out = sb.run(&submit_script(&r, &job, "t"));
    assert!(matches!(classify_submit(cap(&out, false)), SubmitOutcome::Accepted { .. }));
    assert_eq!(std::fs::read_to_string(sb.root.join("submitted.sh")).unwrap(), job);
}

#[test]
fn cancel_script_checks_owner_and_cancels_exactly_one_id() {
    let sb = Sandbox::new();
    std::fs::write(sb.root.join("squeue.out"), "mallory|RUNNING\n").unwrap();
    let out = sb.run(&cancel_script("4242", "s1"));
    assert!(matches!(classify_cancel(cap(&out, false)), CancelOutcome::Refused { code: ErrorCode::SlurmPermission, .. }), "{out}");
    assert!(!sb.calls().contains("scancel"));
    std::fs::write(sb.root.join("squeue.out"), "s1|COMPLETING\n").unwrap();
    assert!(sb.run(&cancel_script("4242", "s1")).contains("not_cancellable"));
    std::fs::write(sb.root.join("squeue.out"), "s1|RUNNING\n").unwrap();
    let out = sb.run(&cancel_script("4242", "s1"));
    assert_eq!(classify_cancel(cap(&out, false)), CancelOutcome::Requested);
    let calls = sb.calls();
    assert!(calls.lines().any(|l| l == "scancel 4242"), "{calls}");
    assert!(!calls.contains("-u") || !calls.contains("scancel -u"));
}

#[test]
fn list_script_queries_only_the_authenticated_user() {
    let sb = Sandbox::new();
    let out = sb.run(&list_script("s1", false));
    assert!(out.starts_with("@@squeue\n"), "{out}");
    assert!(sb.calls().starts_with("squeue -h -u s1 -o "));
}

#[test]
fn log_script_reads_bounded_increments_and_detects_rotation() {
    let sb = Sandbox::new();
    let f = sb.home().join("projects/semeval/slurm-4242.out");
    let p = f.display().to_string();
    std::fs::write(&f, "line1\nline2\n").unwrap();
    let first = parse_log_output(&sb.run(&log_script(&p, &whoami(), None, 65536)), 10_000);
    assert_eq!(first, LogResult::Chunk { size: 12, from: 0, next: 12, rotated: false, text: "line1\nline2\n".into() });
    std::fs::write(&f, "line1\nline2\nline3\n").unwrap();
    let inc = parse_log_output(&sb.run(&log_script(&p, &whoami(), Some(12), 65536)), 10_000);
    assert_eq!(inc, LogResult::Chunk { size: 18, from: 12, next: 18, rotated: false, text: "line3\n".into() }, "only the new bytes");
    std::fs::write(&f, "new\n").unwrap();
    let rot = parse_log_output(&sb.run(&log_script(&p, &whoami(), Some(18), 65536)), 10_000);
    assert!(matches!(rot, LogResult::Chunk { rotated: true, from: 0, ref text, .. } if text == "new\n"), "{rot:?}");
    // Bounded: a big file returns only the last `max` bytes.
    std::fs::write(&f, "x".repeat(1000)).unwrap();
    let big = parse_log_output(&sb.run(&log_script(&p, &whoami(), None, 100)), 10_000);
    assert!(matches!(big, LogResult::Chunk { from: 900, next: 1000, ref text, .. } if text.len() == 100));
    assert_eq!(parse_log_output(&sb.run(&log_script(&format!("{p}.nope"), &whoami(), None, 100)), 10), LogResult::Error("missing".into()));
    std::os::unix::fs::symlink(sb.root.join("elsewhere"), sb.home().join("out")).unwrap();
    std::fs::write(sb.root.join("elsewhere/x.out"), "secret").unwrap();
    let escaped = sb.run(&log_script(&sb.home().join("out/x.out").display().to_string(), &whoami(), None, 100));
    assert_eq!(parse_log_output(&escaped, 10), LogResult::Error("outside".into()), "symlink out of home is not read");
    assert_eq!(parse_log_output(&sb.run(&log_script(&p, "someone-else", None, 100)), 10), LogResult::Error("not_owner".into()));
}

fn whoami() -> String {
    String::from_utf8(Command::new("/usr/bin/id").arg("-un").output().unwrap().stdout).unwrap().trim().to_string()
}

#[test]
fn a_preview_can_be_submitted_at_most_once() {
    use super::commands::{take_preview, StoredPreview};
    let mut map = std::collections::HashMap::new();
    let sp = |needs_ack| StoredPreview {
        request: req(),
        script: "s".into(),
        tag: "t".into(),
        checksum: "c".into(),
        needs_ack,
        created_ms: 1000,
        profile_id: "p".into(),
        user: "s1".into(),
        workflow: None,
        kernel: None,
    };
    map.insert("id".to_string(), sp(true));
    assert!(take_preview(&mut map, "id", false, "s1", "p", 2000).is_err(), "acknowledgement required");
    assert!(map.contains_key("id"), "a missing acknowledgement does not burn the preview");
    assert!(take_preview(&mut map, "id", true, "s1", "p", 2000).is_ok());
    assert!(take_preview(&mut map, "id", true, "s1", "p", 2000).is_err(), "second click / retried IPC cannot submit again");
    map.insert("other".to_string(), sp(false));
    assert!(take_preview(&mut map, "other", true, "mallory", "p", 2000).is_err(), "another identity cannot use it");
    assert!(!map.contains_key("other"));
    map.insert("old".to_string(), sp(false));
    assert!(take_preview(&mut map, "old", true, "s1", "p", 1000 + 16 * 60_000).is_err(), "expired");
}

#[test]
fn outcomes_serialize_for_the_frontend() {
    let a = serde_json::to_value(SubmitOutcome::Accepted { job_id: "1".into(), cluster: None }).unwrap();
    assert_eq!(a, serde_json::json!({"outcome": "accepted", "jobId": "1", "cluster": null}));
    let r = serde_json::to_value(SubmitOutcome::Rejected { code: ErrorCode::NoResource, message: "m".into() }).unwrap();
    assert_eq!(r, serde_json::json!({"outcome": "rejected", "code": "NO_RESOURCE", "message": "m"}));
    assert_eq!(serde_json::to_value(CancelOutcome::Requested).unwrap(), serde_json::json!({"outcome": "requested"}));
}

/// V2 M6: scheduler RPCs during a simulated 10-minute session with Overview and My Jobs both
/// visible, driven by a UI that misbehaves (asks every 5 s). Backend floors must hold.
#[test]
fn ten_minute_budget_with_overview_and_jobs_open() {
    use super::commands::{HISTORY_INTERVAL_MS, JOBS_INTERVAL_MS};
    use crate::state::{decide, Cache, Decision};
    let (mut snap, mut jobs): (Cache<()>, Cache<()>) = (Cache::default(), Cache::default());
    let (mut rpcs, mut last_history) = (0u32, None::<u64>);
    for t in (0..600_000u64).step_by(5_000) {
        if decide(&snap, t, false, 60_000) == Decision::Fetch {
            snap.last_attempt_ms = Some(t);
            rpcs += 2; // scontrol show partition + node
        }
        if decide(&jobs, t, false, JOBS_INTERVAL_MS) == Decision::Fetch {
            jobs.last_attempt_ms = Some(t);
            rpcs += 1; // squeue
            if last_history.is_none_or(|h| t - h > HISTORY_INTERVAL_MS) {
                last_history = Some(t);
                rpcs += 1; // sacct
            }
        }
    }
    // 10 inventory fetches (20 RPCs) + 20 squeue + 2 sacct = 42 in 10 min ≈ 4.2/min, even with a 5 s UI.
    assert!(rpcs <= 42, "{rpcs} scheduler RPCs in 10 minutes");
}

// ---------- learned partition eligibility + receipts ----------

#[test]
fn past_submissions_change_the_eligibility_notice() {
    let snap = demo_snapshot(0);
    let r = req();
    let acks = |learned| validate(&r, &Context { home: HOME, snapshot: &snap, learned }).acknowledgements;
    assert!(acks(PartitionRecord::None).iter().any(|a| a.contains("Eligibility")));
    assert!(!acks(PartitionRecord::Accepted).iter().any(|a| a.contains("Eligibility") || a.contains("rejected")));
    assert!(acks(PartitionRecord::Denied).iter().any(|a| a.contains("rejected your last job")));
}

#[test]
fn receipt_store_learns_partitions_and_dismisses() {
    let dir = crate::ssh::SessionDir::create().unwrap();
    let rec = |tag: &str, part: &str, status, message: Option<&str>| JobReceipt {
        tag: tag.into(),
        profile_id: "default".into(),
        user: "s1".into(),
        job_id: (status == ReceiptStatus::Accepted).then(|| "1".into()),
        cluster: None,
        status,
        name: "n".into(),
        partition: part.into(),
        gres: "gpu".into(),
        gpu_count: 1,
        submitted_at: "2026-10-16T21:15:00Z".into(),
        checksum: "c".into(),
        stdout_pattern: "/home/s1/slurm-%j.out".into(),
        stderr_pattern: "/home/s1/slurm-%j.err".into(),
        message: message.map(str::to_string),
        access_denied: false,
        dismissed: false,
    };
    // A receipt written by v0.2.0 before these fields existed (real ICF-Free rejection text).
    let legacy = serde_json::json!([{
        "tag": "a", "profileId": "default", "user": "s1", "jobId": null, "cluster": null, "status": "rejected",
        "name": "icfcc-smoke", "partition": "ICF-Free", "gres": "gpu", "gpuCount": 1, "submittedAt": "x", "checksum": "c",
        "stdoutPattern": "o", "stderrPattern": "e",
        "message": format!("sbatch: error: Batch job submission failed: Invalid account or account/partition combination specified — {}", crate::jobs::store::ACCESS_HINT)
    }]);
    std::fs::write(dir.path.join("jobs.json"), legacy.to_string()).unwrap();
    let mut st = ReceiptStore::load(&dir.path);
    assert!(st.items[0].access_denied, "old receipts are migrated");
    assert_eq!(st.partition_record("default", "s1", "ICF-Free"), PartitionRecord::Denied);
    assert_eq!(st.partition_record("default", "s1", "Teaching"), PartitionRecord::None);
    assert_eq!(st.partition_record("default", "other", "ICF-Free"), PartitionRecord::None, "per user");

    st.upsert(rec("b", "Teaching", ReceiptStatus::Accepted, None)).unwrap();
    st.upsert(rec("c", "Teaching", ReceiptStatus::Rejected, Some("time limit too long"))).unwrap();
    assert_eq!(st.partition_record("default", "s1", "Teaching"), PartitionRecord::Accepted, "non-access rejections teach nothing");

    st.upsert(rec("d", "Teaching", ReceiptStatus::Uncertain, Some("dropped"))).unwrap();
    assert!(st.dismiss("default", "s1", "d").is_err(), "unresolved submissions cannot be hidden");
    assert!(st.dismiss("default", "other", "a").is_err(), "only your own receipts");
    st.dismiss("default", "s1", "a").unwrap();
    let reloaded = ReceiptStore::load(&dir.path);
    assert!(reloaded.find("a").unwrap().dismissed, "persisted");
    assert_eq!(reloaded.partition_record("default", "s1", "ICF-Free"), PartitionRecord::Denied, "dismissing keeps what was learned");
}
