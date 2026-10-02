#!/usr/bin/env bash
set -euo pipefail

[[ $# = 0 || ( $# = 1 && $1 = --dry-run ) ]] || {
    echo 'Usage: rollback.sh [--dry-run]' >&2; exit 1;
}
ui_dropin=/etc/systemd/system/modep-mod-ui.service.d/80-grid-integration.conf
host_dropin=/etc/systemd/system/modep-mod-host.service.d/80-grid-integration.conf
if [[ ${1:-} = --dry-run ]]; then
    echo "Would remove only $ui_dropin and $host_dropin and restart packaged MODEP services."
    exit 0
fi
[[ $EUID = 0 ]] || { echo 'Run rollback with sudo.' >&2; exit 1; }
rm -f -- "$ui_dropin" "$host_dropin"
systemctl daemon-reload
systemctl restart modep-mod-host.service modep-mod-ui.service
echo 'Packaged MODEP service commands restored.'
