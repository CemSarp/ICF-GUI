fn main() {
    // When OpenSSH invokes us as SSH_ASKPASS, act only as the tiny prompt forwarder.
    if std::env::var_os(icf_control_center_lib::ssh::askpass::ENV_SOCK).is_some() {
        std::process::exit(icf_control_center_lib::ssh::askpass::helper_main());
    }
    icf_control_center_lib::run()
}
