//! Transfer control scripts run in a real `sh` against a sandbox home; the sftp data path itself is
//! exercised against a local sshd in `tests/real_openssh.rs` (opt-in).

use super::*;
use std::process::{Command, Stdio};

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
        let tmp = std::env::temp_dir().join(format!("icfcc-tx-{}", random_hex(6)));
        for d in ["home/data", "elsewhere", "bin"] {
            std::fs::create_dir_all(tmp.join(d)).unwrap();
        }
        let s = Sandbox { root: std::fs::canonicalize(&tmp).unwrap() };
        let p = s.root.join("bin/sha256sum");
        std::fs::write(&p, "#!/bin/sh\nif [ -x /sbin/sha256sum ]; then exec /sbin/sha256sum \"$@\"; fi; exec shasum -a 256 \"$@\"\n").unwrap();
        std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        s
    }
    fn data(&self) -> String {
        self.root.join("home/data").display().to_string()
    }
    fn run(&self, script: &str) -> String {
        let mut c = Command::new("/bin/sh")
            .arg("-s")
            .env_clear()
            .env("HOME", self.root.join("home"))
            .env("PATH", format!("{}:/usr/bin:/bin", self.root.join("bin").display()))
            .current_dir(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(c.stdin.as_mut().unwrap(), script.as_bytes()).unwrap();
        String::from_utf8_lossy(&c.wait_with_output().unwrap().stdout).into_owned()
    }
}

#[test]
fn sftp_batches_only_carry_paths_that_need_no_quoting() {
    assert_eq!(
        batch(Direction::Upload, false, "/tmp/icfcc-xab/f", "/home/s1/d/.x.tgz.icfcc-part").unwrap(),
        "put \"/tmp/icfcc-xab/f\" \"/home/s1/d/.x.tgz.icfcc-part\"\n"
    );
    assert!(batch(Direction::Upload, true, "/a", "/b").unwrap().starts_with("reput "));
    assert!(batch(Direction::Download, true, "/a", "/b").unwrap().starts_with("reget "));
    for bad in
        ["/home/s1/a b", "/home/s1/*", "/home/s1/x\"; !rm", "/home/s1/a\nput /etc/passwd /x", "/home/s1/[ab]", "/home/s1/x?", "relative", "/home/s1/../s2"]
    {
        assert!(batch(Direction::Download, false, bad, "/tmp/x").is_err(), "{bad:?}");
        assert!(batch(Direction::Upload, false, "/tmp/x", bad).is_err(), "{bad:?}");
    }
}

#[test]
fn partial_files_and_destinations() {
    let t = Transfer {
        id: "1".into(),
        profile_id: "default".into(),
        user: "s1".into(),
        direction: Direction::Upload,
        local_path: "/Users/me/My Data/set.tar.gz".into(),
        remote_path: "/home/s1/data/set.tar.gz".into(),
        name: "set.tar.gz".into(),
        size: 0,
        done_bytes: 0,
        phase: Phase::Queued,
        message: None,
        sha256: None,
        created_at: String::new(),
        updated_at: String::new(),
        delete_local_after: false,
    };
    assert_eq!(t.remote_part(), "/home/s1/data/.set.tar.gz.icfcc-part");
    assert_eq!(t.local_part(), PathBuf::from("/Users/me/My Data/.set.tar.gz.icfcc-part"));
}

#[test]
fn upload_check_reports_conflicts_partials_and_space() {
    let s = Sandbox::new();
    let d = s.data();
    let out = s.run(&upload_check_script(&d, "set.tar.gz"));
    assert!(out.contains(&format!("@@dir {d}\n")) && !out.contains("@@exists") && !out.contains("@@part") && out.contains("@@free_kb "), "{out}");
    std::fs::write(s.root.join("home/data/.set.tar.gz.icfcc-part"), "12345").unwrap();
    assert!(s.run(&upload_check_script(&d, "set.tar.gz")).contains("@@part 5"));
    std::fs::write(s.root.join("home/data/set.tar.gz"), "x").unwrap();
    assert!(s.run(&upload_check_script(&d, "set.tar.gz")).contains("@@exists"), "never overwrite silently");
    std::fs::remove_file(s.root.join("home/data/.set.tar.gz.icfcc-part")).unwrap();
    std::os::unix::fs::symlink(s.root.join("elsewhere/target"), s.root.join("home/data/.evil.icfcc-part")).unwrap();
    assert!(s.run(&upload_check_script(&d, "evil")).contains("@@err symlink"));
    std::os::unix::fs::symlink(s.root.join("elsewhere"), s.root.join("home/out")).unwrap();
    assert!(s.run(&upload_check_script(&format!("{}/home/out", s.root.display()), "x")).contains("@@err outside"));
}

#[test]
fn publish_never_overwrites_and_discard_only_removes_our_part_file() {
    let s = Sandbox::new();
    let d = s.data();
    let part = s.root.join("home/data/.m.bin.icfcc-part");
    std::fs::write(&part, "verified").unwrap();
    let out = s.run(&publish_script(&d, "m.bin"));
    assert!(out.contains("@@ok"), "{out}");
    assert_eq!(std::fs::read_to_string(s.root.join("home/data/m.bin")).unwrap(), "verified");
    assert!(!part.exists());
    std::fs::write(&part, "second").unwrap();
    assert!(s.run(&publish_script(&d, "m.bin")).contains("@@err exists"));
    assert_eq!(std::fs::read_to_string(s.root.join("home/data/m.bin")).unwrap(), "verified", "existing file untouched");
    assert!(part.exists(), "partial kept after a refused publish");
    assert!(s.run(&discard_script(&d, "m.bin")).contains("@@ok"));
    assert!(!part.exists() && s.root.join("home/data/m.bin").exists(), "only the part file is removed");
    // A part "file" that is a symlink is never followed or deleted.
    std::fs::write(s.root.join("elsewhere/keep"), "k").unwrap();
    std::os::unix::fs::symlink(s.root.join("elsewhere/keep"), s.root.join("home/data/.k.icfcc-part")).unwrap();
    s.run(&discard_script(&d, "k"));
    assert!(s.root.join("elsewhere/keep").exists() && s.root.join("home/data/.k.icfcc-part").exists());
    assert!(s.run(&publish_script(&d, "k")).contains("@@err missing"));
}

#[test]
fn remote_checksums_match_local_ones() {
    let s = Sandbox::new();
    let f = s.root.join("home/data/blob");
    std::fs::write(&f, vec![7u8; 100_000]).unwrap();
    let out = s.run(&sha_script(&f.display().to_string()));
    let local = sha256::file(&f, |_| {}, || false).unwrap();
    assert!(out.contains("@@size 100000") && out.contains(&format!("@@sha {local}")), "{out}");
    std::fs::write(s.root.join("elsewhere/secret"), "s").unwrap();
    std::os::unix::fs::symlink(s.root.join("elsewhere/secret"), s.root.join("home/data/s")).unwrap();
    assert!(s.run(&sha_script(&format!("{}/s", s.data()))).contains("@@err outside"));
}

#[test]
fn folder_packing_refuses_links_out_and_special_files() {
    let s = Sandbox::new();
    let root = s.root.join("pack");
    std::fs::create_dir_all(root.join("a/b")).unwrap();
    std::fs::write(root.join("a/b/x.txt"), "123").unwrap();
    std::os::unix::fs::symlink("b/x.txt", root.join("a/inside")).unwrap();
    assert_eq!(scan_folder(&root).unwrap(), (1, 3));
    std::os::unix::fs::symlink("../../../etc/passwd", root.join("a/out")).unwrap();
    assert!(scan_folder(&root).unwrap_err().contains("outside the folder"));
    std::fs::remove_file(root.join("a/out")).unwrap();
    std::os::unix::fs::symlink("/etc/hosts", root.join("abs")).unwrap();
    assert!(scan_folder(&root).is_err());
    std::fs::remove_file(root.join("abs")).unwrap();
    let fifo = std::ffi::CString::new(root.join("pipe").display().to_string()).unwrap();
    // SAFETY: valid NUL-terminated path.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(scan_folder(&root).unwrap_err().contains("FIFO"));
    assert!(link_stays_inside(Path::new("/r"), Path::new("/r/a/l"), Path::new("../b")));
    assert!(!link_stays_inside(Path::new("/r"), Path::new("/r/l"), Path::new("../../x")));
}

#[test]
fn interrupted_transfers_are_marked_on_restart_and_scoped() {
    let dir = std::env::temp_dir().join(format!("icfcc-ts-{}", random_hex(4)));
    let mut st = TransferStore::load(&dir);
    let mk = |id: &str, user: &str, phase: Phase| Transfer {
        id: id.into(),
        profile_id: "default".into(),
        user: user.into(),
        direction: Direction::Download,
        local_path: "/tmp/x".into(),
        remote_path: "/home/s1/x".into(),
        name: "x".into(),
        size: 10,
        done_bytes: 4,
        phase,
        message: None,
        sha256: None,
        created_at: String::new(),
        updated_at: String::new(),
        delete_local_after: false,
    };
    st.upsert(mk("a", "s1", Phase::Transferring)).unwrap();
    st.upsert(mk("b", "s1", Phase::Done)).unwrap();
    st.upsert(mk("c", "s2", Phase::Queued)).unwrap();
    let re = TransferStore::load(&dir);
    let mine = re.for_user("default", "s1");
    assert_eq!(mine.len(), 2);
    let a = mine.iter().find(|t| t.id == "a").unwrap();
    assert_eq!(a.phase, Phase::Interrupted, "never silently resumed; the user retries");
    assert_eq!(a.done_bytes, 4);
    assert_eq!(re.for_user("default", "s2")[0].phase, Phase::Interrupted);
    std::fs::remove_dir_all(dir).unwrap();
}
