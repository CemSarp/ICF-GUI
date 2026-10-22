pub mod auth;
pub mod commands;
pub mod errors;
pub mod integrations;
pub mod jobs;
pub mod profiles;
pub mod projects;
pub mod slurm;
pub mod ssh;
pub mod state;
pub mod transfers;
pub mod util;
pub mod workflow;

use commands::AppState;
use std::sync::Arc;
use tauri::Manager;

pub fn run() {
    let app = tauri::Builder::default()
        // Used from Rust only (file pickers owned by the backend); no dialog permission is granted to the UI.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            ssh::sweep_stale_sessions(std::path::Path::new(ssh::SYSTEM_SSH));
            let home = std::env::var_os("HOME").map(std::path::PathBuf::from).ok_or("HOME not set")?;
            let env = ssh::session::ConnectEnv {
                ssh_bin: ssh::SYSTEM_SSH.into(),
                askpass_exe: std::env::current_exe()?,
                home,
                connect_budget: ssh::session::CONNECT_BUDGET,
            };
            app.manage(AppState::new(&config_dir, Arc::new(auth::keychain::Keychain::default()), env));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection_profiles_list,
            commands::connection_profile_save,
            commands::connection_inspect_ssh_config,
            commands::connection_status,
            commands::connection_test_and_login,
            commands::connection_cancel,
            commands::connection_answer_challenge,
            commands::connection_disconnect,
            commands::connection_forget_credentials,
            commands::connection_open_demo,
            commands::cluster_get_snapshot,
            commands::cluster_get_node_detail,
            commands::cluster_clear_cache,
            commands::settings_get,
            commands::settings_set_poll_interval,
            commands::open_external,
            jobs::commands::jobs_preview,
            jobs::commands::jobs_submit,
            jobs::commands::jobs_list_mine,
            jobs::commands::jobs_get_detail,
            jobs::commands::jobs_get_log_tail,
            jobs::commands::jobs_cancel,
            jobs::commands::jobs_receipts,
            jobs::commands::jobs_reconcile,
            jobs::commands::jobs_dismiss_receipt,
            projects::commands::projects_recent,
            projects::commands::projects_browse,
            projects::commands::projects_mkdir,
            projects::commands::projects_open,
            projects::commands::projects_set_prefs,
            projects::commands::projects_forget,
            projects::commands::python_discover,
            projects::commands::python_check_imports,
            projects::commands::toolchains_list,
            projects::commands::toolchains_save,
            projects::commands::toolchains_delete,
            projects::commands::presets_list,
            projects::commands::presets_save,
            projects::commands::presets_delete,
            projects::commands::prefs_get,
            projects::commands::prefs_set,
            integrations::vscode::vscode_status,
            integrations::vscode::vscode_open,
            integrations::vscode::vscode_settings_preview,
            integrations::vscode::vscode_settings_apply,
            transfers::transfers_list,
            transfers::transfers_pick_file,
            transfers::transfers_pick_folder,
            transfers::transfers_pack_folder,
            transfers::transfers_upload,
            transfers::transfers_download,
            transfers::transfers_cancel,
            transfers::transfers_retry,
            transfers::transfers_discard,
            workflow::commands::workflow_preview,
            workflow::commands::workflow_runs,
            workflow::commands::workflow_refresh,
            workflow::commands::workflow_dismiss,
            workflow::commands::workflow_reconcile,
            workflow::commands::workflow_list_files,
            workflow::commands::workflow_metrics,
        ])
        .build(tauri::generate_context!())
        .expect("error while building ICF Control Center");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Tear down the app-owned ControlMaster; submitted jobs are never affected.
            let state = handle.state::<AppState>();
            tauri::async_runtime::block_on(async {
                if let Some(s) = state.session.lock().await.take() {
                    s.close().await;
                }
            });
        }
    });
}
