//! The reviewed kernel launch script (sent on stdin to `sh -s` on the login node). Pure text.
//!
//! Every user value was validated first and is single-quoted here. The driver and the node-side
//! step travel in quoted heredocs with random delimiters, so nothing in them is expanded by the
//! login shell. The script's last command `exec`s srun; the app writes nothing to stdin until the
//! driver prints `ready`, so the shell can never read protocol lines as commands.

use super::KernelRequest;
use crate::jobs::remote::{precheck_helpers, precheck_lines, Precheck};
use crate::jobs::request::{format_time_limit, shell_quote as q};
use crate::workflow::script::toolchain_lines;

pub const DRIVER_PY: &str = include_str!("driver.py");

pub fn driver_delimiter(tag: &str) -> String {
    format!("ICFCC_PY_{tag}")
}
pub fn step_delimiter(tag: &str) -> String {
    format!("ICFCC_STEP_{tag}")
}

/// Runs on the allocated node under bash: environment, import check, then the driver.
/// A failure prints the driver's own `bye` line so the app shows one reason word.
pub fn step(r: &KernelRequest) -> String {
    let mut s = String::from("fail() { printf '{\"t\":\"bye\",\"reason\":\"%s\"}\\n' \"$1\"; exit 3; }\nset +u\n");
    s += &toolchain_lines(&r.toolchain, "fail");
    s += &format!("PY={}\n", q(&r.interpreter));
    s += r#"[ -x "$PY" ] || fail interpreter_missing
PYBIN=$(dirname -- "$PY")
if [ -f "$PYBIN/activate" ]; then . "$PYBIN/activate" || fail venv_activate_failed; fi
"$PY" -c 'import ipykernel, jupyter_client' >/dev/null 2>&1 || fail ipykernel_missing
"#;
    s += &format!("cd {} || fail workdir_missing\n", q(r.work_dir()));
    s += "exec \"$PY\" -u -c \"$ICFCC_DRIVER\"\n";
    s
}

/// `srun` arguments, one per element, in the order they appear in the script.
pub fn srun_args(r: &KernelRequest, tag: &str) -> Vec<String> {
    let res = &r.resources;
    let gres = match &res.gres_type {
        Some(t) => format!("gpu:{t}"),
        None => "gpu".into(),
    };
    vec![
        format!("--job-name={}-{tag}", super::JOB_NAME),
        format!("--partition={}", res.partition),
        "--nodes=1".into(),
        "--ntasks=1".into(),
        format!("--gres={gres}:{}", res.gpu_count),
        format!("--cpus-per-task={}", res.cpus),
        format!("--mem={}M", res.memory_mib),
        format!("--time={}", format_time_limit(res.time_limit_seconds)),
        format!("--comment=icfcc-kernel-{tag}"),
        "--kill-on-bad-exit=1".into(),
    ]
}

/// The full launch script: prechecks, the two heredocs, then `exec srun … bash -c "$ICFCC_STEP"`.
pub fn render(r: &KernelRequest, checks: &[Precheck], tag: &str) -> String {
    let mut s = String::from("# icfcc:kernel\numask 077\n");
    s += &precheck_helpers();
    s += "command -v srun >/dev/null 2>&1 || { printf '@@err nosrun\\n'; exit 0; }\n";
    s += "[ -x /bin/bash ] || { printf '@@err nobash\\n'; exit 0; }\n";
    s += &precheck_lines(checks);
    let (d, st) = (driver_delimiter(tag), step_delimiter(tag));
    s += &format!("ICFCC_DRIVER=$(cat <<'{d}'\n{DRIVER_PY}{d}\n)\nexport ICFCC_DRIVER\n");
    s += &format!("ICFCC_STEP=$(cat <<'{st}'\n{}{st}\n)\n", step(r));
    s += "printf '@@starting\\n'\n";
    let args: Vec<String> = srun_args(r, tag).iter().map(|a| q(a)).collect();
    s += &format!("exec srun {} /bin/bash -c \"$ICFCC_STEP\"\n", args.join(" "));
    s
}

/// The `srun` line as shown in the review dialog (no heredoc bodies).
pub fn display_command(r: &KernelRequest, tag: &str) -> String {
    format!("srun {} /bin/bash -c <environment + {} driver>", srun_args(r, tag).join(" "), r.interpreter)
}

/// Each heredoc must be closed only by its own delimiter line (exactly one such line each).
pub fn delimiters_safe(script: &str, tag: &str) -> bool {
    let count = |d: &str| script.lines().filter(|l| *l == d).count();
    count(&driver_delimiter(tag)) == 1 && count(&step_delimiter(tag)) == 1
}
