// Every frontend-callable command must be listed here; capabilities/*.json then grant them explicitly.
const COMMANDS: &[&str] = &[
    "connection_profiles_list",
    "connection_profile_save",
    "connection_inspect_ssh_config",
    "connection_status",
    "connection_test_and_login",
    "connection_cancel",
    "connection_answer_challenge",
    "connection_disconnect",
    "connection_forget_credentials",
    "connection_open_demo",
    "cluster_get_snapshot",
    "cluster_get_node_detail",
    "cluster_clear_cache",
    "settings_get",
    "settings_set_poll_interval",
    "open_external",
    // V2 jobs (read/local)
    "jobs_preview",
    "jobs_list_mine",
    "jobs_get_detail",
    "jobs_get_log_tail",
    "jobs_receipts",
    "jobs_reconcile",
    "jobs_dismiss_receipt",
    // V2 mutations — granted only via capabilities/job-mutations.json
    "jobs_submit",
    "jobs_cancel",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS))).expect("tauri build");
}
