//! Head node terminal evidence (ADR-039). The PTY is exercised with a local `sh`; no ssh, no ICF.

use super::*;
use crate::ssh::session::terminal_args;
use base64::Engine;
use std::time::{Duration, Instant};

type Seen = Arc<Mutex<(Vec<u8>, Option<Option<i32>>)>>;

fn collector() -> (Sink, Seen) {
    let seen: Seen = Default::default();
    let s = seen.clone();
    let sink: Sink = Arc::new(move |e| match e {
        TerminalEvent::Data { data } => s.lock().unwrap().0.extend(base64::engine::general_purpose::STANDARD.decode(data).unwrap()),
        TerminalEvent::Exit { code } => s.lock().unwrap().1 = Some(code),
    });
    (sink, seen)
}

fn sh() -> Command {
    let mut c = Command::new("/bin/sh");
    c.env_clear().env("PATH", "/usr/bin:/bin").env("TERM", "xterm").kill_on_drop(true);
    c
}

async fn until(seen: &Seen, what: &str, f: impl Fn(&[u8], Option<Option<i32>>) -> bool) {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(10) {
        {
            let g = seen.lock().unwrap();
            if f(&g.0, g.1) {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}; saw {:?}", String::from_utf8_lossy(&seen.lock().unwrap().0));
}

fn has(out: &[u8], needle: &str) -> bool {
    String::from_utf8_lossy(out).contains(needle)
}

#[test]
fn terminal_args_force_a_pty_and_run_no_command() {
    let a = terminal_args(vec!["-F".into(), "cfg".into()], "icf");
    assert_eq!(a, ["-F", "cfg", "-tt", "-e", "none", "--", "icf"]);
}

#[tokio::test]
async fn shell_echo_resize_and_exit() {
    let (sink, seen) = collector();
    let t = Terminal::start(sh(), 100, 30, sink).unwrap();
    // A real tty: stty reports the size we asked for, and the controlling terminal exists.
    t.write(b"stty size; tty\n").unwrap();
    until(&seen, "stty size", |o, _| has(o, "30 100")).await;
    t.resize(120, 40).unwrap();
    t.write(b"stty size\n").unwrap();
    until(&seen, "resized stty", |o, _| has(o, "40 120")).await;
    // Multi-byte output (é = c3 a9) passes through byte-for-byte.
    t.write(b"printf 'x\\303\\251y%s\\n' $((6*7))\n").unwrap();
    until(&seen, "echo", |o, _| o.windows(5).any(|w| w == b"x\xc3\xa9y4")).await;
    t.write(b"exit 3\n").unwrap();
    until(&seen, "exit", |_, e| e == Some(Some(3))).await;
    assert!(*t.done.borrow());
}

#[tokio::test]
async fn ctrl_c_reaches_the_foreground_program_not_the_shell() {
    let (sink, seen) = collector();
    let t = Terminal::start(sh(), 80, 24, sink).unwrap();
    t.write(b"sleep 30\n").unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    t.write(&[3]).unwrap(); // ^C: the tty line discipline signals the foreground group
    t.write(b"echo still-here\n").unwrap();
    until(&seen, "shell survived ^C", |o, _| has(o, "still-here")).await;
    t.close();
    until(&seen, "exit after close", |_, e| e.is_some()).await;
}

#[tokio::test]
async fn attach_replays_recent_output_then_follows_the_new_sink() {
    let (first, seen1) = collector();
    let t = Terminal::start(sh(), 80, 24, first).unwrap();
    t.write(b"echo before-reload\n").unwrap();
    until(&seen1, "first output", |o, _| has(o, "before-reload")).await;
    let (second, seen2) = collector();
    t.attach(second);
    assert!(has(&seen2.lock().unwrap().0, "before-reload"), "replayed");
    t.write(b"echo after-reload\n").unwrap();
    until(&seen2, "new output on the new sink", |o, _| has(o, "after-reload")).await;
    assert!(!has(&seen1.lock().unwrap().0, "after-reload"), "old sink no longer fed");
    t.close();
    until(&seen2, "exit", |_, e| e.is_some()).await;
}

#[tokio::test]
async fn buffer_keeps_only_the_tail() {
    let (sink, seen) = collector();
    let t = Terminal::start(sh(), 80, 24, sink).unwrap();
    t.write(b"yes abcdefghij | head -c 600000; echo END-MARK\n").unwrap();
    until(&seen, "end", |o, _| has(o, "END-MARK")).await;
    assert!(t.inner.lock().unwrap().buf.len() <= BUFFER_BYTES);
    t.close();
}
