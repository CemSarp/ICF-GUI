use super::*;
use crate::jobs::remote::BlockStatus;
use crate::projects::ProjectStore;

fn task(id: &str, name: &str, command: &str) -> DevTask {
    DevTask { id: id.into(), name: name.into(), kind: TaskKind::Build, command: command.into(), working_dir: String::new(), description: String::new() }
}

fn run(id: &str, project: &str, ms: u64) -> RunRecord {
    RunRecord {
        profile_id: "icf".into(),
        user: "s1".into(),
        project: project.into(),
        id: id.into(),
        task_id: "build".into(),
        task_name: "Build".into(),
        kind: TaskKind::Build,
        job_id: "7".into(),
        block: format!("{ms:013}"),
        command: "make".into(),
        working_dir: project.into(),
        gpu: None,
        node: None,
        sent_at: String::new(),
        sent_ms: ms,
        status: RunStatus::Queued,
        exit_code: None,
        started_epoch: None,
        ended_epoch: None,
        message: None,
        note: None,
    }
}

fn status(rc: Option<i32>, queued: bool, log: bool, gone: bool) -> BlockStatus {
    BlockStatus {
        gone,
        queued,
        moved: false,
        rc: rc.map(|c| (c, Some(10), Some(12))),
        log: if log { LogResult::Chunk { size: 1, from: 0, next: 1, rotated: false, text: "x".into() } } else { LogResult::Error("missing".into()) },
    }
}

struct Dir(std::path::PathBuf);
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn tmp() -> Dir {
    let d = std::env::temp_dir().join(format!("icfcc-wb-{}", random_hex(6)));
    std::fs::create_dir_all(&d).unwrap();
    Dir(d)
}

#[test]
fn tasks_are_validated() {
    assert!(validate_tasks(&[task("build", "Build", "make"), task("test-1", "Test 1", "make test1\n./run.sh --cuda")]).is_ok());
    let bad = |t: DevTask| validate_tasks(&[t]).is_err();
    assert!(bad(task("", "Build", "make")), "missing id");
    assert!(bad(task("Build!", "Build", "make")), "invalid id");
    assert!(bad(task("b", "  ", "make")), "missing name");
    assert!(bad(task("b", &"n".repeat(61), "make")), "long name");
    assert!(bad(task("b", "a\nb", "make")), "name on two lines");
    assert!(bad(task("b", "Build", "   ")), "missing command");
    assert!(bad(task("b", "Build", &"x".repeat(16 * 1024 + 1))), "oversized command");
    assert!(bad(task("b", "Build", "make\r\n")), "control characters");
    assert!(bad(DevTask { description: "d".repeat(201), ..task("b", "B", "make") }));
    assert!(validate_tasks(&[task("a", "A", "x"), task("a", "B", "y")]).is_err(), "duplicate id");
    assert!(validate_tasks(&(0..31).map(|i| task(&format!("t{i}"), "T", "x")).collect::<Vec<_>>()).is_err(), "too many");
    for wd in ["../x", "/abs", "a/../b", "a//b", "a b", "$(x)", "~/x"] {
        assert!(bad(DevTask { working_dir: wd.into(), ..task("b", "B", "make") }), "{wd}");
    }
    for wd in ["", ".", "./", "src", "src/", "tests/unit", "v1.2"] {
        assert!(!bad(DevTask { working_dir: wd.into(), ..task("b", "B", "make") }), "{wd}");
    }
}

#[test]
fn a_task_block_changes_into_its_folder_quoted_then_runs_the_command_verbatim() {
    let p = "/home/s1/my-cuda-project";
    let (b, wd) = task_block(p, &task("b", "B", "make test1 && echo '$(x)'\n")).unwrap();
    assert_eq!(wd, p);
    assert_eq!(b, format!("cd -- '{p}'\nmake test1 && echo '$(x)'"));
    let (b, wd) = task_block(p, &DevTask { working_dir: "src/".into(), ..task("b", "B", "make") }).unwrap();
    assert_eq!((b.lines().next().unwrap(), wd.as_str()), ("cd -- '/home/s1/my-cuda-project/src'", "/home/s1/my-cuda-project/src"));
}

#[test]
fn run_state_comes_from_the_exit_code_file_first() {
    let p = "/home/s1/p";
    let cases = [
        // (start, rc, queued, log, gone, ended) -> expected
        (RunStatus::Queued, None, true, false, false, false, RunStatus::Queued),
        (RunStatus::Queued, None, false, true, false, false, RunStatus::Running),
        (RunStatus::Running, Some(0), false, true, false, false, RunStatus::Succeeded),
        (RunStatus::Running, Some(2), false, true, false, false, RunStatus::Failed),
        (RunStatus::Running, None, false, true, false, true, RunStatus::Interrupted),
        (RunStatus::Queued, None, true, false, false, true, RunStatus::Interrupted),
        (RunStatus::Unknown, None, false, false, false, false, RunStatus::Unknown),
        (RunStatus::Unknown, None, true, false, false, false, RunStatus::Queued),
        (RunStatus::Unknown, Some(0), false, true, false, true, RunStatus::Succeeded),
        (RunStatus::Unknown, None, false, false, false, true, RunStatus::Unknown),
        (RunStatus::Succeeded, None, false, false, false, true, RunStatus::Succeeded),
        (RunStatus::Interrupted, Some(1), false, true, false, true, RunStatus::Failed),
        (RunStatus::Running, None, false, false, true, false, RunStatus::Unknown),
        (RunStatus::Running, None, false, false, true, true, RunStatus::Interrupted),
    ];
    for (start, rc, queued, log, gone, ended, want) in cases {
        let mut r = RunRecord { status: start, ..run("r", p, 1) };
        apply_status(&mut r, &status(rc, queued, log, gone), ended);
        assert_eq!(r.status, want, "{start:?} rc={rc:?} queued={queued} log={log} gone={gone} ended={ended}");
        if let Some(c) = rc {
            assert_eq!((r.exit_code, r.started_epoch, r.ended_epoch), (Some(c), Some(10), Some(12)));
        }
        if matches!(want, RunStatus::Interrupted | RunStatus::Unknown) {
            assert!(r.message.is_some(), "an uncertain state says why");
        }
    }
    let mut r = RunRecord { status: RunStatus::Queued, ..run("r", p, 1) };
    apply_status(&mut r, &BlockStatus { moved: true, ..status(None, false, false, false) }, false);
    assert_eq!(r.status, RunStatus::Unknown, "an older session ran it but left no result files");
    assert!(r.message.as_deref().unwrap().contains("older version"));
    let mut r = RunRecord { status: RunStatus::Running, ..run("r", p, 1) };
    assert!(!apply_status(&mut r, &status(None, false, true, false), false), "nothing new → nothing saved");
}

#[test]
fn runs_are_scoped_capped_and_forgotten_with_their_project() {
    let d = tmp();
    let mut st = ProjectStore::load(&d.0);
    for i in 0..35 {
        st.put_run(run(&format!("a{i}"), "/home/s1/a", i)).unwrap();
    }
    st.put_run(run("b0", "/home/s1/b", 100)).unwrap();
    st.put_run(RunRecord { user: "s2".into(), ..run("other-user", "/home/s1/a", 200) }).unwrap();
    st.put_run(RunRecord { profile_id: "other".into(), ..run("other-profile", "/home/s1/a", 201) }).unwrap();
    let a = st.runs("icf", "s1", "/home/s1/a");
    assert_eq!(a.len(), KEEP_RUNS);
    assert_eq!(a[0].id, "a34", "newest first");
    assert!(a.iter().all(|r| r.project == "/home/s1/a" && r.user == "s1" && r.profile_id == "icf"));
    // Updating keeps one record per id.
    st.put_run(RunRecord { status: RunStatus::Failed, ..run("a34", "/home/s1/a", 34) }).unwrap();
    let again = ProjectStore::load(&d.0);
    assert_eq!(again.runs("icf", "s1", "/home/s1/a").iter().filter(|r| r.id == "a34").count(), 1);
    assert_eq!(again.runs("icf", "s1", "/home/s1/a")[0].status, RunStatus::Failed);
    st.forget("icf", "s1", Some("/home/s1/a")).unwrap();
    assert!(st.runs("icf", "s1", "/home/s1/a").is_empty());
    assert_eq!(st.runs("icf", "s1", "/home/s1/b").len(), 1);
    assert_eq!(st.runs("icf", "s2", "/home/s1/a").len(), 1);
}

#[test]
fn tasks_belong_to_one_project_and_old_settings_still_load() {
    let d = tmp();
    // A projects.json from before the Workbench: no tasks, no runs.
    std::fs::write(
        d.0.join("projects.json"),
        r#"{"projects":[{"profileId":"icf","user":"s1","path":"/home/s1/a","lastOpenedAt":"2026-01-01T00:00:00Z","interpreter":"/home/s1/env/bin/python"}],"toolchains":[],"presets":[],"prefs":{"transferLimitMbps":0}}"#,
    )
    .unwrap();
    let mut st = ProjectStore::load(&d.0);
    let a = st.find("icf", "s1", "/home/s1/a").unwrap();
    assert!(a.tasks.is_empty() && a.interpreter.as_deref() == Some("/home/s1/env/bin/python"));
    st.update("icf", "s1", "/home/s1/a", |p| p.tasks = vec![task("build", "Build", "make")]).unwrap();
    st.touch("icf", "s1", "/home/s1/b", "2026-01-02T00:00:00Z".into()).unwrap();
    st.touch("icf", "s2", "/home/s1/a", "2026-01-02T00:00:00Z".into()).unwrap();
    let st = ProjectStore::load(&d.0);
    assert_eq!(st.find("icf", "s1", "/home/s1/a").unwrap().tasks.len(), 1);
    assert!(st.find("icf", "s1", "/home/s1/b").unwrap().tasks.is_empty(), "a new project starts with no tasks");
    assert!(st.find("icf", "s2", "/home/s1/a").unwrap().tasks.is_empty(), "another account's record is separate");
}

#[test]
fn unreadable_settings_are_kept_aside_not_overwritten() {
    let d = tmp();
    std::fs::write(d.0.join("projects.json"), b"{ not json").unwrap();
    let mut st = ProjectStore::load(&d.0);
    st.touch("icf", "s1", "/home/s1/a", "2026-01-01T00:00:00Z".into()).unwrap();
    let kept: Vec<_> =
        std::fs::read_dir(&d.0).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with("projects.json.corrupt-")).collect();
    assert_eq!(kept.len(), 1);
    assert_eq!(std::fs::read(kept[0].path()).unwrap(), b"{ not json");
}
