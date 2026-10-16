#!/bin/bash
# Scripted stand-in for /usr/bin/ssh used by tests/auth_flows.rs. It behaves like OpenSSH where it
# matters to the app: `-G` resolution, ControlMaster/`-O check|exit`, and calling $SSH_ASKPASS for
# each prompt listed in ./scenario. It records argv+env (to prove no secret leaks there).
set -f # scenario prompts contain glob characters
here="$(cd "$(dirname "$0")" && pwd)"
{ printf 'ARGV:'; printf ' %q' "$@"; printf '\n'; env; } >>"$here/seen"

ctl="" master=no op="" gmode=no alias=""
while [ $# -gt 0 ]; do
  case "$1" in
    -G) gmode=yes ;;
    -V) echo "OpenSSH_fake" >&2; exit 0 ;;
    -O) op="$2"; shift ;;
    -o) case "$2" in ControlPath=*) ctl="${2#ControlPath=}" ;; ControlMaster=yes) master=yes ;; esac; shift ;;
    -F|-l|-J) shift ;;
    --) alias="$2"; break ;;
  esac
  shift
done

if [ "$gmode" = yes ]; then
  case "$alias" in
    edinburgh-jump) printf 'user s1\nhostname student.ssh.inf.ed.ac.uk\nport 22\n' ;;
    *) printf 'user s1\nhostname icf\nport 22\nproxyjump edinburgh-jump\n' ;;
  esac
  exit 0
fi
case "$op" in
  check) [ -e "$ctl" ] && exit 0; echo "Control socket connect($ctl): No such file or directory" >&2; exit 255 ;;
  exit) rm -f "$ctl"; exit 0 ;;
esac

if [ "$master" = yes ]; then
  echo $$ >"$here/pid"
  while IFS= read -r line; do
    set -- $line
    case "$1" in
      ask)
        want="$2"; shift 2; prompt="$(printf '%b' "$*")"
        if ! got="$("$SSH_ASKPASS" "$prompt")"; then
          case "$prompt" in *authenticity*) echo "Host key verification failed." >&2 ;; *) echo "s1@icf: Permission denied (publickey,password)." >&2 ;; esac
          exit 255
        fi
        if [ "$got" != "$want" ]; then
          # Like OpenSSH falling back from keyboard-interactive to password: ask once more.
          "$SSH_ASKPASS" "$prompt" >/dev/null 2>&1
          echo "s1@icf: Permission denied (publickey,password)." >&2; exit 255
        fi ;;
      changed) printf '@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n' >&2; exit 255 ;;
      sleep) sleep "$2" ;;
      user) whoami_override="$2" ;;
    esac
  done <"$here/scenario"
  echo "${whoami_override:-s1}" >"$here/user"
  touch "$ctl"
  while [ -e "$ctl" ]; do sleep 0.1; done # foreground -N master until `-O exit` or kill
  exit 0
fi

# Multiplexed command.
[ -e "$ctl" ] || { echo "Control socket connect: No such file" >&2; exit 255; }
script="$(cat)"
case "$script" in
  *@@id*) printf '@@id\n%s\n@@groups\ns1 students\n@@host\nhastings\n@@home\n/home/s1\n@@cmds\nsinfo\nsqueue\nscontrol\nsbatch\nscancel\n@@version\nslurm 23.11.4\n@@json\nyes\n@@end\n' "$(cat "$here/user")" ;;
  *scontrol*) cat "$here/inventory" ;;
  *) sh -c "$script" ;;
esac
