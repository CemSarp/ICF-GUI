//! Head node terminal (ADR-039): the user's own login shell on the login node, shown in the UI.
//! `Terminal` owns a local PTY whose far end is `ssh -tt` over the app's existing ControlMaster, so
//! it never authenticates again. Nothing here interprets what the user types; the exception to the
//! fixed-template rule is deliberate and limited to this module (see ADR-039).

pub mod commands;
#[cfg(test)]
mod tests;

use base64::Engine;
use serde::Serialize;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::process::{Child, Command};
use tokio::sync::watch;

/// Output kept for a window reload to replay.
pub const BUFFER_BYTES: usize = 256 * 1024;
/// One keystroke burst or paste; larger writes are refused instead of blocking the PTY.
pub const MAX_WRITE: usize = 64 * 1024;
pub const MAX_DIM: u16 = 500;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "event")]
pub enum TerminalEvent {
    /// Raw terminal output, base64: a read can end in the middle of a UTF-8 sequence.
    Data { data: String },
    /// Final event: the shell (or the connection) is gone. `code` is ssh's exit status.
    Exit { code: Option<i32> },
}

pub type Sink = Arc<dyn Fn(TerminalEvent) + Send + Sync>;

struct Inner {
    buf: VecDeque<u8>,
    sink: Sink,
}

pub struct Terminal {
    pub id: String,
    writer: Arc<Mutex<File>>,
    inner: Arc<Mutex<Inner>>,
    kill: watch::Sender<bool>,
    pub done: watch::Receiver<bool>,
}

fn data_event(bytes: &[u8]) -> TerminalEvent {
    TerminalEvent::Data { data: base64::engine::general_purpose::STANDARD.encode(bytes) }
}

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 }
}

fn cloexec(fd: &OwnedFd) {
    // SAFETY: fcntl on a descriptor we own.
    unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
}

/// Start `cmd` with a fresh PTY as its controlling terminal. Takes the command by value so the
/// parent's copies of the slave side close at once; otherwise the reader never sees the end.
fn spawn_pty(mut cmd: Command, cols: u16, rows: u16) -> std::io::Result<(Child, File)> {
    let mut ws = winsize(cols, rows);
    let (mut m, mut s) = (0, 0);
    // SAFETY: out-pointers are valid; the name and termios arguments are optional.
    if unsafe { libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null_mut(), &mut ws) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: openpty returned two new descriptors that nothing else owns.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(m), OwnedFd::from_raw_fd(s)) };
    cloexec(&master);
    cloexec(&slave);
    cmd.stdin(Stdio::from(slave.try_clone()?)).stdout(Stdio::from(slave.try_clone()?)).stderr(Stdio::from(slave));
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    Ok((child, File::from(master)))
}

impl Terminal {
    /// Must run inside the tokio runtime. `sink` receives output and the final `Exit`; it can be
    /// swapped later with `attach`.
    pub fn start(cmd: Command, cols: u16, rows: u16, sink: Sink) -> std::io::Result<Arc<Self>> {
        let (mut child, master) = spawn_pty(cmd, cols, rows)?;
        let mut reader = master.try_clone()?;
        let inner = Arc::new(Mutex::new(Inner { buf: VecDeque::new(), sink }));
        let pump = {
            let inner = inner.clone();
            std::thread::spawn(move || {
                let mut b = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut b) {
                        Ok(0) => break,
                        Ok(n) => {
                            let mut g = inner.lock().unwrap();
                            g.buf.extend(&b[..n]);
                            let over = g.buf.len().saturating_sub(BUFFER_BYTES);
                            g.buf.drain(..over);
                            let sink = g.sink.clone();
                            sink(data_event(&b[..n]));
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(_) => break, // EIO once the slave side is gone
                    }
                }
            })
        };
        let (kill, mut kill_rx) = watch::channel(false);
        let (done_tx, done) = watch::channel(false);
        let t = Arc::new(Self { id: crate::util::random_hex(8), writer: Arc::new(Mutex::new(master)), inner: inner.clone(), kill, done });
        tokio::spawn(async move {
            let status = tokio::select! {
                s = child.wait() => s.ok(),
                _ = kill_rx.changed() => {
                    let _ = child.kill().await;
                    child.wait().await.ok()
                }
            };
            // Let the last output reach the UI before announcing the end.
            let _ = tokio::task::spawn_blocking(move || pump.join()).await;
            let sink = inner.lock().unwrap().sink.clone();
            sink(TerminalEvent::Exit { code: status.and_then(|s| s.code()) });
            let _ = done_tx.send(true);
        });
        Ok(t)
    }

    /// Point output at a new sink (window reload): the recent output is replayed first.
    pub fn attach(&self, sink: Sink) {
        let mut g = self.inner.lock().unwrap();
        let (a, b) = g.buf.as_slices();
        let replay: Vec<u8> = a.iter().chain(b).copied().collect();
        if !replay.is_empty() {
            sink(data_event(&replay));
        }
        g.sink = sink;
    }

    pub fn write(&self, data: &[u8]) -> std::io::Result<()> {
        self.writer.lock().unwrap().write_all(data)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
        let ws = winsize(cols, rows);
        // SAFETY: TIOCSWINSZ on the PTY master we own, with a valid winsize.
        let r = unsafe { libc::ioctl(self.writer.lock().unwrap().as_raw_fd(), libc::TIOCSWINSZ as _, &ws) };
        if r < 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// Ends the local ssh, which hangs up the remote shell.
    pub fn close(&self) {
        let _ = self.kill.send(true);
    }
}
