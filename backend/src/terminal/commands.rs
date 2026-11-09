//! Tauri commands for the head node terminal (ADR-039). All four are in the terminal-mutations
//! capability. At most one terminal exists; opening again re-attaches it (window reload).

use super::{Sink, Terminal, TerminalEvent, MAX_DIM, MAX_WRITE};
use crate::commands::AppState;
use crate::errors::{AppError, AppResult, ErrorCode};
use crate::jobs::commands::{ctx, live};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpened {
    pub terminal_id: String,
    /// An already running shell was picked up again; its recent output is replayed first.
    pub reattached: bool,
}

fn size(cols: u16, rows: u16) -> AppResult<()> {
    if (1..=MAX_DIM).contains(&cols) && (1..=MAX_DIM).contains(&rows) {
        Ok(())
    } else {
        Err(AppError::invalid("Invalid terminal size."))
    }
}

fn sink(events: Channel<TerminalEvent>) -> Sink {
    Arc::new(move |e| {
        let _ = events.send(e);
    })
}

#[tauri::command]
pub async fn terminal_open(app: AppHandle, state: State<'_, AppState>, cols: u16, rows: u16, events: Channel<TerminalEvent>) -> AppResult<TerminalOpened> {
    size(cols, rows)?;
    let mut slot = state.terminal.lock().await;
    if let Some(t) = slot.as_ref() {
        t.attach(sink(events));
        let _ = t.resize(cols, rows);
        return Ok(TerminalOpened { terminal_id: t.id.clone(), reattached: true });
    }
    let c = ctx(&state).await?;
    let session = live(&c, "the terminal")?;
    let cmd = session.terminal_command().await?;
    let t = Terminal::start(cmd, cols, rows, sink(events)).map_err(|_| AppError::new(ErrorCode::SshUnavailable, "Could not start the terminal."))?;
    *slot = Some(t.clone());
    let opened = TerminalOpened { terminal_id: t.id.clone(), reattached: false };
    let mut done = t.done.clone();
    tauri::async_runtime::spawn(async move {
        let _ = done.wait_for(|d| *d).await;
        let state = app.state::<AppState>();
        let mut slot = state.terminal.lock().await;
        if slot.as_ref().is_some_and(|x| x.id == t.id) {
            slot.take();
        }
    });
    Ok(opened)
}

async fn current(state: &AppState, id: &str) -> AppResult<Arc<Terminal>> {
    match state.terminal.lock().await.clone() {
        Some(t) if t.id == id => Ok(t),
        _ => Err(AppError::new(ErrorCode::NotConnected, "The terminal is no longer running.")),
    }
}

#[tauri::command]
pub async fn terminal_write(state: State<'_, AppState>, terminal_id: String, data: String) -> AppResult<()> {
    if data.len() > MAX_WRITE {
        return Err(AppError::invalid("Too much text at once for the terminal."));
    }
    let t = current(&state, &terminal_id).await?;
    tokio::task::spawn_blocking(move || t.write(data.as_bytes()))
        .await
        .ok()
        .and_then(|r| r.ok())
        .ok_or_else(|| AppError::new(ErrorCode::NotConnected, "The terminal connection has closed."))
}

#[tauri::command]
pub async fn terminal_resize(state: State<'_, AppState>, terminal_id: String, cols: u16, rows: u16) -> AppResult<()> {
    size(cols, rows)?;
    current(&state, &terminal_id).await?.resize(cols, rows).map_err(|_| AppError::internal("Could not resize the terminal."))
}

#[tauri::command]
pub async fn terminal_close(state: State<'_, AppState>, terminal_id: String) -> AppResult<()> {
    current(&state, &terminal_id).await?.close();
    Ok(())
}

/// Disconnect and app exit: end the shell before the master goes away.
pub async fn shutdown(state: &AppState) {
    let t = state.terminal.lock().await.clone();
    if let Some(t) = t {
        t.close();
        let mut done = t.done.clone();
        let _ = tokio::time::timeout(Duration::from_secs(5), done.wait_for(|d| *d)).await;
    }
}

/// A terminal (or one being opened) keeps the connection from idling out.
pub fn active(state: &AppState) -> bool {
    state.terminal.try_lock().map(|g| g.is_some()).unwrap_or(true)
}
