//! Project browser, environment probe, VS Code settings and launch. Remote scripts run in a real
//! `sh` against a sandbox home; GNU-only tools (`find -printf`, `stat -c`) get small stand-ins
//! because the remote side is Linux and this test runs on macOS.

use super::remote::*;
use super::*;
use crate::errors::ErrorCode;
use crate::integrations::vscode::{alias_problems, detect, launch_args, merge_settings, parse_remote_ssh, AliasCheck, INTERPRETER_KEY};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

struct Sandbox {
    root: PathBuf,
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = Command::new("/bin/chmod").arg("-R").arg("u+w").arg(&self.root).status();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn whoami() -> String {
    String::from_utf8(Command::new("/usr/bin/id").arg("-un").output().unwrap().stdout).unwrap().trim().to_string()
}

/// GNU `find DIR -mindepth 1 -maxdepth 1 -printf '%y\t%Y\t%s\t%T@\t%m\t%u\t%f\0'` stand-in.
const FIND_STUB: &str = r#"import os, pwd, stat, sys
root = sys.argv[1]
def y(m):
    return "d" if stat.S_ISDIR(m) else "f" if stat.S_ISREG(m) else "l" if stat.S_ISLNK(m) else "p"
for name in os.listdir(root):
    p = os.path.join(root, name)
    st = os.lstat(p)
    try:
        t = y(os.stat(p).st_mode)
    except OSError:
        t = "N"
    rec = "\t".join([y(st.st_mode), t, str(st.st_size), "%.10f" % st.st_mtime, oct(st.st_mode & 0o7777)[2:], pwd.getpwuid(st.st_uid).pw_name, name]) + "\0"
    sys.stdout.buffer.write(rec.encode("utf-8", "surrogateescape"))
"#;

impl Sandbox {
    fn new() -> Self {
        let tmp = std::env::temp_dir().join(format!("icfcc-pj-{}", crate::util::random_hex(6)));
        std::fs::create_dir_all(tmp.join("home/projects/semeval")).unwrap();
        std::fs::create_dir_all(tmp.join("elsewhere")).unwrap();
        std::fs::create_dir_all(tmp.join("bin")).unwrap();
        let s = Sandbox { root: std::fs::canonicalize(&tmp).unwrap() };
        let py = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].into_iter().find(|p| Path::new(p).exists()).unwrap_or("python3");
        s.stub("find", &format!("exec {py} {} \"$@\"", s.root.join("find.py").display()));
        std::fs::write(s.root.join("find.py"), FIND_STUB).unwrap();
        s.stub("stat", "id -un");
        // GNU sha256sum stand-in (macOS 15+ ships one in /sbin; older ones have shasum).
        s.stub("sha256sum", "if [ -x /sbin/sha256sum ]; then exec /sbin/sha256sum \"$@\"; fi; exec shasum -a 256 \"$@\"");
        s
    }
    fn stub(&self, name: &str, body: &str) {
        let p = self.root.join("bin").join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    }
    fn home(&self) -> PathBuf {
        self.root.join("home")
    }
    fn h(&self) -> String {
        self.home().display().to_string()
    }
    fn run(&self, script: &str) -> String {
        let mut c = Command::new("/bin/sh")
            .arg("-s")
            .env_clear()
            .env("HOME", self.home())
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
fn browse_paths_allow_spaces_and_unicode_but_not_traversal_or_controls() {
    for ok in ["/home/s1", "/home/s1/My Project", "/home/s1/données/π", "/"] {
        assert!(check_browse_path(ok).is_ok(), "{ok}");
    }
    for bad in ["home/s1", "/home/s1/../s2", "/home/s1/./x", "/home//s1", "/home/s1/a\nb", "/home/s1/\u{1b}[2J", &format!("/{}", "a".repeat(1100))] {
        assert!(check_browse_path(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn listing_is_bounded_sorted_and_symlink_aware() {
    let s = Sandbox::new();
    let p = s.home().join("projects/semeval");
    std::fs::create_dir(p.join("data")).unwrap();
    std::fs::write(p.join("train.py"), "print(1)\n").unwrap();
    std::fs::write(p.join(".hidden"), "").unwrap();
    std::fs::write(p.join("with space.txt"), "x").unwrap();
    std::fs::write(p.join("evil\nname"), "x").unwrap();
    std::os::unix::fs::symlink(s.root.join("elsewhere"), p.join("out")).unwrap();
    std::os::unix::fs::symlink(p.join("nope"), p.join("dangling")).unwrap();
    let l = parse_listing(&s.run(&browse_script(Some(&p.display().to_string()))), &whoami(), "now".into()).unwrap();
    assert_eq!(l.path, p.display().to_string());
    assert_eq!(l.home, s.h());
    assert!(l.writable && !l.truncated);
    let names: Vec<_> = l.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names[..2], ["data", "out"], "folders (and links to folders) first: {names:?}");
    let get = |n: &str| l.entries.iter().find(|e| e.name == n).unwrap();
    assert_eq!(get("train.py").size, 9);
    assert!(get("train.py").mine && get("train.py").modified.is_some());
    assert_eq!((get("out").kind, get("out").target_kind), (EntryKind::Symlink, Some(EntryKind::Dir)));
    assert_eq!(get("dangling").target_kind, Some(EntryKind::Missing));
    assert!(get("with space.txt").kind == EntryKind::File && !get("with space.txt").unsupported);
    assert!(l.entries.iter().any(|e| e.unsupported && !e.name.contains('\n')), "newline names shown sanitized, not navigable");
    // Home by default; following a symlink out of home is refused on ICF.
    assert_eq!(parse_listing(&s.run(&browse_script(None)), "x", "now".into()).unwrap().path, s.h());
    let e = parse_listing(&s.run(&browse_script(Some(&p.join("out").display().to_string()))), "x", "now".into()).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidPath);
    assert!(e.message.contains("outside your home"));
    let e = parse_listing(&s.run(&browse_script(Some(&format!("{}/missing", s.h())))), "x", "now".into()).unwrap_err();
    assert!(e.message.contains("does not exist"));
    // Quoting: a hostile path is just a (missing) folder name.
    let out = s.run(&browse_script(Some(&format!("{}/x'; touch PWNED; '", s.h()))));
    assert!(out.contains("@@err missing") && !s.root.join("PWNED").exists());
}

#[test]
fn huge_folders_are_truncated_not_fully_loaded() {
    let s = Sandbox::new();
    let big = s.home().join("big");
    std::fs::create_dir(&big).unwrap();
    for i in 0..1200 {
        std::fs::write(big.join(format!("f{i:05}")), "").unwrap();
    }
    let l = parse_listing(&s.run(&browse_script(Some(&big.display().to_string()))), "x", "now".into()).unwrap();
    assert!(l.truncated);
    assert_eq!(l.entries.len(), MAX_ENTRIES);
}

#[test]
fn mkdir_creates_one_folder_and_never_overwrites() {
    let s = Sandbox::new();
    let parent = s.home().join("projects").display().to_string();
    let made = parse_ok(&s.run(&mkdir_script(&parent, "newproj"))).unwrap();
    assert!(Path::new(&made).is_dir());
    let e = parse_ok(&s.run(&mkdir_script(&parent, "newproj"))).unwrap_err();
    assert!(e.message.contains("already exists"));
    std::os::unix::fs::symlink(s.root.join("elsewhere"), s.home().join("link")).unwrap();
    let e = parse_ok(&s.run(&mkdir_script(&s.home().join("link").display().to_string(), "x"))).unwrap_err();
    assert!(e.message.contains("outside your home"));
    assert!(!s.root.join("elsewhere/x").exists());
    for bad in ["", "..", ".hidden", "-rf", "a/b", "a b", "x;y", "$(id)", &"n".repeat(129)] {
        assert!(!crate::workflow::valid_name(bad), "{bad:?}");
    }
}

#[test]
fn resolve_reports_canonical_paths_inside_home_only() {
    let s = Sandbox::new();
    std::fs::write(s.home().join("projects/semeval/a.txt"), "12345").unwrap();
    let r = parse_resolved(&s.run(&resolve_script(&format!("{}/projects/semeval/a.txt", s.h())))).unwrap();
    assert!(r.is_file && r.size == Some(5) && r.writable);
    std::os::unix::fs::symlink(s.home().join("projects/semeval"), s.home().join("sem")).unwrap();
    let r = parse_resolved(&s.run(&resolve_script(&format!("{}/sem", s.h())))).unwrap();
    assert_eq!(r.path, format!("{}/projects/semeval", s.h()), "canonical");
    std::os::unix::fs::symlink("/etc", s.home().join("etc")).unwrap();
    assert!(parse_resolved(&s.run(&resolve_script(&format!("{}/etc", s.h())))).is_err());
}

#[test]
fn interpreter_probe_is_light_and_classifies_candidates() {
    let s = Sandbox::new();
    let h = s.h();
    let venv = s.home().join("projects/semeval/.venv/bin");
    std::fs::create_dir_all(&venv).unwrap();
    std::fs::write(s.home().join("projects/semeval/.venv/pyvenv.cfg"), "home = /usr/bin\n").unwrap();
    std::fs::write(venv.join("activate"), "").unwrap();
    // A venv python that reports a CUDA 12.8 torch wheel (the stub ignores its arguments).
    std::fs::write(
        venv.join("python"),
        "#!/bin/sh\necho '{\"version\": \"3.12.4\", \"prefix\": \"/v\", \"base\": \"/usr\", \"torch\": \"2.7.0+cu128\", \"numpy\": \"2.1.0\", \"nbconvert\": true, \"ipykernel\": false}'\n",
    )
    .unwrap();
    std::fs::set_permissions(venv.join("python"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    std::fs::write(s.home().join("notexec"), "").unwrap();
    std::fs::write(s.home().join("toolchain.rc"), "export X=1\n").unwrap();
    let real = ["/opt/homebrew/bin/python3", "/usr/bin/python3"].into_iter().find(|p| Path::new(p).exists()).unwrap().to_string();
    let cands = vec![
        format!("{h}/projects/semeval/.venv/bin/python"),
        format!("{h}/projects/semeval/venv/bin/python"),
        format!("{h}/notexec"),
        real.clone(),
        "system".into(),
    ];
    let out = s.run(&env_probe_script(&cands, &[format!("{h}/toolchain.rc"), "/home/htang2/toolchain-20251006/toolchain.rc".into()]));
    let r = parse_env_probe(&out, &h, "now".into()).unwrap();
    let i = &r.interpreters;
    // `system` resolving to an already listed path is shown once (no duplicate rows).
    let sys = out.lines().find_map(|l| l.strip_prefix("@@resolved ")).unwrap_or_default();
    let dup = sys == real;
    assert_eq!(i.len(), if dup { 4 } else { 5 }, "{out}");
    assert_eq!(i.iter().filter(|x| x.path == real).count(), 1, "each path once: {out}");
    assert_eq!((i[0].status, i[0].env_type.as_str(), i[0].version.as_deref()), (InterpreterStatus::Ok, "venv", Some("3.12.4")));
    assert_eq!((i[0].torch.as_deref(), i[0].torch_cuda.as_deref()), (Some("2.7.0+cu128"), Some("12.8")));
    assert!(i[0].has_activate && i[0].nbconvert);
    assert_eq!(i[1].status, InterpreterStatus::Missing);
    assert_eq!(i[2].status, InterpreterStatus::NotExecutable);
    assert_eq!(i[3].status, InterpreterStatus::Ok, "real python answers the metadata-only probe: {out}");
    assert!(i[3].version.as_deref().is_some_and(|v| v.starts_with('3')));
    if !dup {
        assert_eq!(i[4].env_type, "system");
    }
    assert_eq!(r.toolchains[0].status, "ok");
    assert_eq!(r.toolchains[1].status, "missing", "the university toolchain is never assumed to exist");
    assert!(!out.contains("import torch"), "probe never imports ML libraries");
    assert_eq!(torch_cuda("2.4.1+cu118").as_deref(), Some("11.8"));
    assert_eq!(torch_cuda("2.4.1"), None);
}

#[test]
fn import_check_parser_reports_each_module_once_and_what_was_not_reached() {
    let mods: Vec<String> = ["torch", "transformers", "peft", "nbconvert"].map(String::from).to_vec();
    let out = "noise from a login banner\n@@ok torch 2.8.0a0+gitunknown\n@@failed transformers RuntimeError: operator torchvision::nms does not exist\n@@ok transformers 9.9 (a module printing a fake marker)\n@@ok peft\n@@exit 124\n";
    let r = parse_import_check(out, &mods).unwrap();
    let got: Vec<(&str, ImportStatus, &str)> = r.iter().map(|x| (x.module.as_str(), x.status, x.detail.as_str())).collect();
    assert_eq!(
        got,
        [
            ("torch", ImportStatus::Ok, "2.8.0a0+gitunknown"),
            ("transformers", ImportStatus::Failed, "RuntimeError: operator torchvision::nms does not exist"),
            ("peft", ImportStatus::Ok, ""),
            ("nbconvert", ImportStatus::NotChecked, "The check timed out before this import."),
        ]
    );
    assert!(parse_import_check("@@ok torch 1\n", &mods).is_err(), "no @@exit = incomplete");
    assert_eq!(parse_import_check("@@err missing\n", &mods).unwrap_err().code, ErrorCode::InvalidPath);
    for ok in ["torch", "sklearn.metrics", "_private", "PIL"] {
        assert!(valid_import(ok), "{ok}");
    }
    for bad in ["", "1x", "a..b", "a.", ".a", "os;id", "a b", "-c", "x'y", "torch\nx", &"a".repeat(65)] {
        assert!(!valid_import(bad), "{bad:?}");
    }
}

#[test]
fn import_check_runs_isolated_and_keeps_module_output_off_the_result() {
    let s = Sandbox::new();
    let real = ["/opt/homebrew/bin/python3", "/usr/bin/python3"].into_iter().find(|p| Path::new(p).exists()).unwrap().to_string();
    // A module in the working directory must not shadow the real one (-I).
    std::fs::write(s.root.join("json.py"), "raise SystemExit('shadowed')\n").unwrap();
    // `this` prints the Zen of Python when imported; it must not reach the parsed result.
    let mods: Vec<String> = ["json", "icfcc_no_such_module", "this"].map(String::from).to_vec();
    let script = import_check_script(&real, &mods);
    assert!(script.contains("-I -c \"$CODE\" \"$@\""), "fixed template, values as arguments");
    let out = s.run(&script);
    let r = parse_import_check(&out, &mods).unwrap();
    assert_eq!(r[0].status, ImportStatus::Ok, "{out}");
    assert_eq!((r[1].status, r[1].detail.as_str()), (ImportStatus::Failed, "ModuleNotFoundError: No module named 'icfcc_no_such_module'"));
    assert_eq!(r[2].status, ImportStatus::Ok);
    assert!(!out.contains("Beautiful is better"), "{out}");

    // An interpreter that dies after the first import leaves the rest unchecked, with the reason.
    let crash = s.home().join("crash");
    std::fs::write(&crash, "#!/bin/sh\necho '@@ok json 2.0'\nexit 139\n").unwrap();
    std::fs::set_permissions(&crash, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let r = parse_import_check(&s.run(&import_check_script(&crash.display().to_string(), &mods)), &mods).unwrap();
    assert_eq!(r.iter().map(|x| x.status).collect::<Vec<_>>(), [ImportStatus::Ok, ImportStatus::NotChecked, ImportStatus::NotChecked]);
    assert!(r[1].detail.contains("exit status 139"));

    std::fs::write(s.home().join("notexec"), "").unwrap();
    let e = parse_import_check(&s.run(&import_check_script(&format!("{}/notexec", s.h()), &mods)), &mods).unwrap_err();
    assert!(e.message.contains("not an executable"));
    let e = parse_import_check(&s.run(&import_check_script(&format!("{}/nope", s.h()), &mods)), &mods).unwrap_err();
    assert!(e.message.contains("does not exist"));
}

#[test]
fn settings_merge_preserves_keys_order_and_refuses_jsonc() {
    let before =
        "{\n  \"editor.tabSize\": 2,\n  \"files.exclude\": {\"**/.git\": true},\n  \"python.defaultInterpreterPath\": \"/old\",\n  \"zzz\": [1, 2]\n}\n";
    let after = merge_settings(Some(before), "/home/s1/env/bin/python").unwrap();
    let keys: Vec<String> = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&after).unwrap().keys().cloned().collect();
    assert_eq!(keys, ["editor.tabSize", "files.exclude", INTERPRETER_KEY, "zzz"], "order kept, value replaced in place");
    assert!(after.contains("\"/home/s1/env/bin/python\""));
    assert!(merge_settings(None, "/p").unwrap().contains(INTERPRETER_KEY));
    assert!(merge_settings(Some("\u{feff}{}"), "/p").is_ok(), "BOM tolerated");
    assert!(merge_settings(Some("{\n // comment\n \"a\": 1\n}"), "/p").unwrap_err().contains("comments"));
    assert!(merge_settings(Some("{\"a\": 1,}"), "/p").is_err(), "trailing comma");
    assert!(merge_settings(Some("[1]"), "/p").is_err(), "not an object");
}

#[test]
fn settings_write_backs_up_and_detects_concurrent_changes() {
    let s = Sandbox::new();
    let proj = s.home().join("projects/semeval");
    let p = proj.display().to_string();
    // First write: no file yet.
    let read = parse_settings_read(&s.run(&settings_read_script(&p))).unwrap();
    assert!(read.existing.is_none());
    let content = merge_settings(None, "/home/s1/env/bin/python").unwrap();
    let out = s.run(&settings_write_script(&read.project, None, &content, "20261017T100000Z", "t1"));
    assert!(out.contains("@@ok"), "{out}");
    assert_eq!(std::fs::read_to_string(proj.join(".vscode/settings.json")).unwrap(), content);
    // Second write: preview hash must still match; a backup is made first.
    std::fs::write(proj.join(".vscode/settings.json"), "{\"editor.tabSize\": 4}\n").unwrap();
    let read = parse_settings_read(&s.run(&settings_read_script(&p))).unwrap();
    let (sha, text) = read.existing.clone().unwrap();
    let new = merge_settings(Some(&text), "/home/s1/env/bin/python").unwrap();
    // Someone edits the file in VS Code between preview and apply: refused, file untouched.
    std::fs::write(proj.join(".vscode/settings.json"), "{\"editor.tabSize\": 8}\n").unwrap();
    let out = s.run(&settings_write_script(&read.project, Some(&sha), &new, "20261017T100001Z", "t2"));
    assert!(out.contains("@@err changed"), "{out}");
    assert_eq!(std::fs::read_to_string(proj.join(".vscode/settings.json")).unwrap(), "{\"editor.tabSize\": 8}\n");
    // Fresh preview + apply: backup holds the old content, new content preserves the other key.
    let read = parse_settings_read(&s.run(&settings_read_script(&p))).unwrap();
    let (sha, text) = read.existing.clone().unwrap();
    let new = merge_settings(Some(&text), "/home/s1/env/bin/python").unwrap();
    let out = s.run(&settings_write_script(&read.project, Some(&sha), &new, "20261017T100002Z", "t3"));
    assert!(out.contains("@@backup") && out.contains("@@ok"), "{out}");
    assert_eq!(std::fs::read_to_string(proj.join(".vscode/settings.json.icfcc-backup-20261017T100002Z")).unwrap(), "{\"editor.tabSize\": 8}\n");
    assert!(std::fs::read_to_string(proj.join(".vscode/settings.json")).unwrap().contains("\"editor.tabSize\": 8"));
    // A symlinked .vscode is never written through.
    let other = s.home().join("projects/other");
    std::fs::create_dir_all(&other).unwrap();
    std::os::unix::fs::symlink(s.root.join("elsewhere"), other.join(".vscode")).unwrap();
    let out = s.run(&settings_read_script(&other.display().to_string()));
    assert!(out.contains("@@err symlink"), "{out}");
    let out = s.run(&settings_write_script(&other.display().to_string(), None, "{}\n", "x", "t4"));
    assert!(out.contains("@@err symlink") && !s.root.join("elsewhere/settings.json").exists());
}

#[test]
fn project_records_never_mix_identities() {
    let dir = std::env::temp_dir().join(format!("icfcc-ps-{}", crate::util::random_hex(4)));
    let mut st = ProjectStore::load(&dir);
    assert_eq!(st.data.toolchains, default_toolchains(), "seeded university toolchain profile");
    st.touch("default", "s1", "/home/s1/a", "2026-10-17T10:00:00Z".into()).unwrap();
    st.touch("default", "s1", "/home/s1/b", "2026-10-17T11:00:00Z".into()).unwrap();
    st.touch("other", "s2", "/home/s2/c", "2026-10-17T12:00:00Z".into()).unwrap();
    let mine: Vec<_> = st.recent("default", "s1").into_iter().map(|p| p.path).collect();
    assert_eq!(mine, ["/home/s1/b", "/home/s1/a"]);
    assert!(st.update("default", "s1", "/home/s2/c", |_| {}).is_err(), "cannot edit another identity's project");
    st.update("default", "s1", "/home/s1/a", |p| p.interpreter = Some("/home/s1/env/bin/python".into())).unwrap();
    st.forget("default", "s1", None).unwrap();
    let reloaded = ProjectStore::load(&dir);
    assert!(reloaded.recent("default", "s1").is_empty());
    assert_eq!(reloaded.recent("other", "s2").len(), 1);
    let text = std::fs::read_to_string(dir.join("projects.json")).unwrap();
    assert!(!text.contains("password") && !text.contains("secret"));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(dir.join("projects.json")).unwrap().permissions().mode() & 0o777, 0o600);
    std::fs::remove_dir_all(dir).unwrap();
}

// ---------- VS Code ----------

fn fake_vscode(root: &Path, with_remote_ssh: bool) -> PathBuf {
    let app = root.join("Applications/Visual Studio Code.app");
    let bin = app.join("Contents/Resources/app/bin");
    std::fs::create_dir_all(&bin).unwrap();
    let ext = if with_remote_ssh { "ms-python.python@2026.1.0\nms-vscode-remote.remote-ssh@0.128.0\n" } else { "ms-python.python@2026.1.0\n" };
    let log = root.join("argv.log");
    std::fs::write(
        bin.join("code"),
        format!(
            "#!/bin/sh\n{{ printf 'ARGV:'; printf ' <%s>' \"$@\"; printf '\\n'; env; }} >> '{}'\ncase \"$1\" in --version) echo 1.106.0; echo abc; exit 0;; --list-extensions) printf '{}'; exit 0;; esac\nexit 0\n",
            log.display(),
            ext.replace('\n', "\\n")
        ),
    )
    .unwrap();
    std::fs::set_permissions(bin.join("code"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    app
}

#[tokio::test]
async fn vscode_detection_uses_app_bundles_not_shell_path() {
    let s = Sandbox::new();
    assert!(detect(&[s.root.join("Applications/Visual Studio Code.app")]).await.is_none(), "not installed");
    let app = fake_vscode(&s.root, false);
    let i = detect(std::slice::from_ref(&app)).await.unwrap();
    assert_eq!(i.version.as_deref(), Some("1.106.0"));
    assert_eq!(i.remote_ssh, None, "missing Remote - SSH is reported");
    fake_vscode(&s.root, true);
    assert_eq!(detect(&[app]).await.unwrap().remote_ssh.as_deref(), Some("0.128.0"));
    assert_eq!(parse_remote_ssh("MS-VSCODE-REMOTE.REMOTE-SSH@1.0.0\n").as_deref(), Some("1.0.0"));
    assert_eq!(parse_remote_ssh("ms-vscode-remote.remote-ssh-edit@0.87.0\n"), None);
}

#[tokio::test]
async fn vscode_launch_is_argv_only_with_a_clean_environment() {
    let s = Sandbox::new();
    let app = fake_vscode(&s.root, true);
    let cli = crate::integrations::vscode::bundled_cli(&app).unwrap();
    let mut c = crate::integrations::vscode::cli_command(&cli);
    c.args(launch_args("icf", "/home/s1/My Project; rm -rf ~"));
    let out = crate::ssh::run_capture(c, None, std::time::Duration::from_secs(10), 4096).await.unwrap();
    assert_eq!(out.code, Some(0));
    let log = std::fs::read_to_string(s.root.join("argv.log")).unwrap();
    assert!(log.contains("ARGV: <--remote> <ssh-remote+icf> </home/s1/My Project; rm -rf ~>"), "{log}");
    for leaked in ["ICFCC_ASKPASS", "SSH_ASKPASS", "password", "DYLD_", "NODE_OPTIONS"] {
        assert!(!log.contains(leaked), "{leaked} leaked into the VS Code environment");
    }
}

#[test]
fn alias_problems_explain_what_vscode_will_not_know() {
    let a = |host: &str, user: &str, jump: Option<&str>| AliasCheck {
        alias: "icf".into(),
        hostname: host.into(),
        user: user.into(),
        proxy_jump: jump.map(str::to_string),
        uses_proxy_command: false,
    };
    let (p, snippet) = alias_problems(&a("icf", "macuser", None), "", "s1234567");
    assert_eq!(p.len(), 2, "{p:?}");
    let snippet = snippet.unwrap();
    assert!(snippet.contains("ProxyJump edinburgh-jump") && snippet.contains("User s1234567") && snippet.contains("student.ssh.inf.ed.ac.uk"));
    assert_eq!(alias_problems(&a("icf", "s1234567", Some("edinburgh-jump")), "", "s1234567"), (vec![], None));
    let (p, _) = alias_problems(&AliasCheck { alias: "mybox".into(), ..a("10.0.0.1", "s1", None) }, "s1@gw", "s1");
    assert_eq!(p.len(), 1, "jump host override not in ssh config");
}

mod editor_files {
    use super::super::files::*;
    use super::Sandbox;
    use crate::errors::ErrorCode;
    use std::os::unix::fs::PermissionsExt;

    fn read(s: &Sandbox, path: &str) -> crate::errors::AppResult<FileContent> {
        parse_read(&s.run(&read_script(path)), path)
    }
    fn write(s: &Sandbox, path: &str, content: &str, sha: &str) -> crate::errors::AppResult<FileSaved> {
        parse_write(&s.run(&write_script(path, content, sha, "1700000000000", "abc123")), path)
    }

    #[test]
    fn reads_exact_text_and_its_hash() {
        let s = Sandbox::new();
        let f = s.home().join("projects/semeval/train.py");
        let text = "def f(x):\n    return \"π\" * x  # données"; // no trailing newline
        std::fs::write(&f, text).unwrap();
        let r = read(&s, &f.display().to_string()).unwrap();
        assert_eq!(r.content, text);
        assert_eq!(r.sha256, sha256_hex(text.as_bytes()));
        assert_eq!(r.size, text.len());
        assert!(r.writable);
        let empty = s.home().join("projects/semeval/empty.txt");
        std::fs::write(&empty, "").unwrap();
        assert_eq!(read(&s, &empty.display().to_string()).unwrap().content, "");
    }

    #[test]
    fn refuses_links_outside_paths_binary_and_large_files() {
        let s = Sandbox::new();
        let h = s.h();
        let p = s.home().join("projects/semeval");
        std::fs::write(p.join("a.py"), "x = 1\n").unwrap();
        std::fs::write(s.root.join("elsewhere/secret.txt"), "outside\n").unwrap();
        std::os::unix::fs::symlink(p.join("a.py"), p.join("link.py")).unwrap();
        std::os::unix::fs::symlink(s.root.join("elsewhere"), p.join("out")).unwrap();
        std::fs::write(p.join("bin.dat"), b"ab\0cd").unwrap();
        std::fs::write(p.join("latin1.txt"), b"caf\xe9\n").unwrap();
        std::fs::write(p.join("big.txt"), "a".repeat(MAX_TEXT_BYTES + 1)).unwrap();
        let code = |path: String| read(&s, &path).unwrap_err().message;
        assert!(code(format!("{h}/projects/semeval/link.py")).contains("symbolic link"));
        assert!(code(format!("{h}/projects/semeval/out/secret.txt")).contains("outside your home"));
        assert!(code(s.root.join("elsewhere/secret.txt").display().to_string()).contains("outside your home"));
        assert!(code(format!("{h}/projects/semeval/nope.py")).contains("does not exist"));
        assert!(code(format!("{h}/projects/semeval")).contains("not a regular file"));
        assert!(code(format!("{h}/projects/semeval/bin.dat")).contains("not text"));
        assert!(code(format!("{h}/projects/semeval/latin1.txt")).contains("not text"));
        assert!(code(format!("{h}/projects/semeval/big.txt")).contains("too large"));
    }

    #[test]
    fn saves_atomically_keeps_the_mode_and_round_trips_exact_bytes() {
        let s = Sandbox::new();
        let f = s.home().join("projects/semeval/kernel.cu");
        std::fs::write(&f, "old\n").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o750)).unwrap();
        let path = f.display().to_string();
        let sha = read(&s, &path).unwrap().sha256;
        // A line equal to a heredoc delimiter, unicode and no trailing newline must survive.
        let new = "__global__ void k() {}\nICFCC_FILE_abc123\nEOF\n// π";
        let saved = write(&s, &path, new, &sha).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), new);
        assert_eq!(saved.sha256, sha256_hex(new.as_bytes()));
        assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o750);
        let leftovers: Vec<_> =
            std::fs::read_dir(f.parent().unwrap()).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains("icfcc-")).collect();
        assert!(leftovers.is_empty(), "no temp files left: {leftovers:?}");
        // Saving the opened version again is refused: the file changed since.
        let err = write(&s, &path, "mine\n", &sha).unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), new, "a refused save leaves the file untouched");
        // Empty content is a valid save.
        write(&s, &path, "", &saved.sha256).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "");
    }

    #[test]
    fn creates_new_files_but_never_replaces_or_escapes() {
        let s = Sandbox::new();
        let p = s.home().join("projects/semeval");
        let create = |dir: &std::path::Path, name: &str, content: &str| {
            parse_create(&s.run(&create_script(&dir.display().to_string(), name, content, "1700000000001", "abc123")))
        };
        let made = create(&p, "kernel.cu", "__global__ void k() {}\n").unwrap();
        assert_eq!(made.path, p.join("kernel.cu").display().to_string());
        assert_eq!(std::fs::read_to_string(p.join("kernel.cu")).unwrap(), "__global__ void k() {}\n");
        assert_eq!(made.sha256, sha256_hex(b"__global__ void k() {}\n"));
        create(&p, "empty.py", "").unwrap();
        assert_eq!(std::fs::read_to_string(p.join("empty.py")).unwrap(), "");
        let err = create(&p, "kernel.cu", "other").unwrap_err();
        assert!(err.message.contains("already exists"), "{}", err.message);
        assert_eq!(std::fs::read_to_string(p.join("kernel.cu")).unwrap(), "__global__ void k() {}\n", "existing file untouched");
        std::os::unix::fs::symlink(s.root.join("elsewhere"), p.join("out")).unwrap();
        assert!(create(&p.join("out"), "x.py", "x").unwrap_err().message.contains("outside your home"));
        assert!(!s.root.join("elsewhere/x.py").exists());
        let leftovers = std::fs::read_dir(&p).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains("icfcc-")).count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn never_writes_through_links_or_outside_home() {
        let s = Sandbox::new();
        let p = s.home().join("projects/semeval");
        let outside = s.root.join("elsewhere/secret.txt");
        std::fs::write(&outside, "outside\n").unwrap();
        let sha = sha256_hex(b"outside\n");
        std::os::unix::fs::symlink(&outside, p.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(s.root.join("elsewhere"), p.join("out")).unwrap();
        for path in [p.join("link.txt"), p.join("out/secret.txt"), outside.clone()] {
            assert!(write(&s, &path.display().to_string(), "pwned\n", &sha).is_err(), "{}", path.display());
        }
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "outside\n");
    }
}

#[test]
fn delete_removes_one_listed_entry_and_never_follows_links() {
    let s = Sandbox::new();
    let proj = s.home().join("projects/semeval");
    let dir = proj.display().to_string();
    std::fs::write(proj.join("old run.log"), "x").unwrap();
    std::fs::create_dir_all(proj.join("runs/a/b")).unwrap();
    std::fs::write(proj.join("runs/a/b/out.txt"), "x").unwrap();
    std::fs::write(s.root.join("elsewhere/keep.txt"), "x").unwrap();
    std::os::unix::fs::symlink(s.root.join("elsewhere"), proj.join("out")).unwrap();
    let del = |name: &str, kind| parse_ok(&s.run(&delete_script(&dir, name, kind)));

    // A file whose name has a space; asking for the wrong kind deletes nothing.
    assert!(del("old run.log", EntryKind::Dir).unwrap_err().message.contains("changed on ICF"));
    assert!(proj.join("old run.log").exists());
    del("old run.log", EntryKind::File).unwrap();
    assert!(!proj.join("old run.log").exists());
    assert!(del("old run.log", EntryKind::File).unwrap_err().message.contains("no longer exists"));

    // A link to a folder outside home: only the link goes, never what it points to.
    assert!(del("out", EntryKind::Dir).unwrap_err().message.contains("changed on ICF"));
    del("out", EntryKind::Symlink).unwrap();
    assert!(std::fs::symlink_metadata(proj.join("out")).is_err());
    assert!(s.root.join("elsewhere/keep.txt").exists());

    // A folder goes with everything in it.
    del("runs", EntryKind::Dir).unwrap();
    assert!(!proj.join("runs").exists());

    // The folder itself must resolve inside home.
    std::os::unix::fs::symlink(s.root.join("elsewhere"), s.home().join("link")).unwrap();
    let e = parse_ok(&s.run(&delete_script(&s.home().join("link").display().to_string(), "keep.txt", EntryKind::File))).unwrap_err();
    assert!(e.message.contains("outside your home"));
    assert!(s.root.join("elsewhere/keep.txt").exists());

    for bad in ["", ".", "..", "a/b", "x\ny", &"n".repeat(256)] {
        assert!(!valid_entry_name(bad), "{bad:?}");
    }
    for ok in ["old run.log", "résumé.txt", "-rf", "$(id)", ".hidden"] {
        assert!(valid_entry_name(ok), "{ok:?}");
    }
    // Names are quoted, so shell syntax in a name is just a name.
    std::fs::write(proj.join("$(touch pwned)"), "x").unwrap();
    del("$(touch pwned)", EntryKind::File).unwrap();
    assert!(!proj.join("pwned").exists() && !s.root.join("pwned").exists());
}

#[test]
fn rename_changes_one_name_in_place_and_never_overwrites() {
    let s = Sandbox::new();
    let proj = s.home().join("projects/semeval");
    let dir = proj.display().to_string();
    std::fs::write(proj.join("old run.log"), "x").unwrap();
    std::fs::write(proj.join("taken.txt"), "keep").unwrap();
    std::fs::create_dir_all(proj.join("runs")).unwrap();
    std::fs::write(s.root.join("elsewhere/keep.txt"), "x").unwrap();
    std::os::unix::fs::symlink(s.root.join("elsewhere"), proj.join("out")).unwrap();
    let ren = |name: &str, kind, to: &str| parse_ok(&s.run(&rename_script(&dir, name, kind, to)));

    assert!(ren("old run.log", EntryKind::Dir, "a.log").unwrap_err().message.contains("changed on ICF"));
    assert!(ren("old run.log", EntryKind::File, "taken.txt").unwrap_err().message.contains("already exists"));
    assert_eq!(std::fs::read_to_string(proj.join("taken.txt")).unwrap(), "keep");
    // An existing folder is a taken name too: nothing is moved into it.
    assert!(ren("old run.log", EntryKind::File, "runs").unwrap_err().message.contains("already exists"));
    assert!(std::fs::read_dir(proj.join("runs")).unwrap().next().is_none());

    assert_eq!(ren("old run.log", EntryKind::File, "run.log").unwrap(), proj.join("run.log").display().to_string());
    assert!(!proj.join("old run.log").exists() && proj.join("run.log").exists());
    assert!(ren("old run.log", EntryKind::File, "x.log").unwrap_err().message.contains("no longer exists"));
    ren("runs", EntryKind::Dir, "runs-v1").unwrap();
    assert!(proj.join("runs-v1").is_dir());

    // A link is renamed; what it points to stays where it is.
    ren("out", EntryKind::Symlink, "results").unwrap();
    assert!(std::fs::symlink_metadata(proj.join("results")).unwrap().file_type().is_symlink());
    assert!(s.root.join("elsewhere/keep.txt").exists() && s.root.join("elsewhere").is_dir());
}

#[test]
fn unpack_extracts_next_to_the_archive_and_never_overwrites_or_escapes() {
    let s = Sandbox::new();
    let proj = s.home().join("projects/semeval");
    let dir = proj.display().to_string();
    let tar = |args: &[&str]| assert!(Command::new("/usr/bin/tar").args(args).current_dir(&proj).status().unwrap().success());
    let unpack = |name: &str| {
        let (stem, zip) = unpack_target(name).unwrap();
        parse_unpack(&s.run(&unpack_script(&dir, name, &stem, zip)))
    };
    let leftovers =
        || std::fs::read_dir(&proj).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with(".icfcc-unpack")).count();

    // What Transfers' "pack a folder" makes: one top folder, which comes back under its own name.
    std::fs::create_dir_all(proj.join("src/data/sub")).unwrap();
    std::fs::write(proj.join("src/data/sub/a.txt"), "a").unwrap();
    std::fs::write(proj.join("src/data/.hidden"), "h").unwrap();
    tar(&["-czf", "data-20261027T160449Z.tar.gz", "-C", "src", "data"]);
    assert_eq!(unpack("data-20261027T160449Z.tar.gz").unwrap(), proj.join("data").display().to_string());
    assert_eq!(std::fs::read_to_string(proj.join("data/sub/a.txt")).unwrap(), "a");
    assert!(proj.join("data/.hidden").exists());
    assert!(proj.join("data-20261027T160449Z.tar.gz").exists(), "the archive is kept");

    // Same archive again: "data" is taken, so it lands in a folder named after the archive.
    let again = unpack("data-20261027T160449Z.tar.gz").unwrap();
    assert_eq!(again, proj.join("data-20261027T160449Z").display().to_string());
    assert!(proj.join("data-20261027T160449Z/data/sub/a.txt").exists());
    // And a third time both names are taken: nothing is overwritten and nothing is left behind.
    assert!(unpack("data-20261027T160449Z.tar.gz").unwrap_err().message.contains("already exists"));
    assert_eq!(leftovers(), 0);

    // Loose files get a folder named after the archive.
    tar(&["-cf", "loose.tar", "-C", "src/data/sub", "a.txt"]);
    unpack("loose.tar").unwrap();
    assert!(proj.join("loose/a.txt").exists());

    // A broken archive says why and leaves nothing.
    std::fs::write(proj.join("broken.tgz"), "not an archive").unwrap();
    assert!(unpack("broken.tgz").unwrap_err().message.contains("could not be unpacked"));
    assert!(!proj.join("broken").exists());
    assert_eq!(leftovers(), 0);

    // Members named "../x" or "/x" never land outside the extraction folder.
    let py = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].into_iter().find(|p| Path::new(p).exists()).unwrap();
    let evil = "import io, tarfile, sys\nt = tarfile.open(sys.argv[1], 'w:gz')\nfor n in ['../escaped.txt', '/abs.txt', 'ok.txt']:\n    i = tarfile.TarInfo(n); i.size = 1; t.addfile(i, io.BytesIO(b'x'))\nt.close()\n";
    assert!(Command::new(py).args(["-I", "-c", evil, &proj.join("evil.tar.gz").display().to_string()]).status().unwrap().success());
    let _ = unpack("evil.tar.gz");
    assert!(!s.home().join("projects/escaped.txt").exists() && !proj.join("escaped.txt").exists());
    assert!(!Path::new("/abs.txt").exists());
    assert_eq!(leftovers(), 0);

    // An archive behind a link is not unpacked.
    std::os::unix::fs::symlink(proj.join("loose.tar"), proj.join("link.tar")).unwrap();
    assert!(unpack("link.tar").unwrap_err().message.contains("changed on ICF"));

    assert_eq!(unpack_target("Data.TAR.GZ"), Some(("Data".into(), false)));
    assert_eq!(unpack_target("set.zip"), Some(("set".into(), true)));
    for no in ["notes.txt", ".tar.gz", "model.gz", "x.tar.gz.part"] {
        assert_eq!(unpack_target(no), None, "{no}");
    }
}
