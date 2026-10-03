#!/usr/bin/env bash
set -euo pipefail

dry_run=0
if [[ ${1:-} = --dry-run ]]; then dry_run=1; shift; fi
[[ $# = 1 ]] || { echo 'Usage: activate.sh [--dry-run] ABS_BUILD_DIR' >&2; exit 1; }
build_dir=$(realpath -- "$1")
[[ "$build_dir" =~ ^/[a-zA-Z0-9_./-]+$ ]] || {
    echo 'Use a build directory without spaces or shell-special characters.' >&2; exit 1;
}
for file in mod-ui/utils/libmod_utils.so mod-host/mod-host venv/bin/python build.json integration.env; do
    [[ -f "$build_dir/$file" ]] || { echo "Missing build output: $file" >&2; exit 1; }
done
python3 - "$build_dir/build.json" <<'PY'
import json, platform, struct, sys
with open(sys.argv[1]) as handle:
    build = json.load(handle)
if build['machine'] != platform.machine() or build['pointer_bits'] != struct.calcsize('P') * 8:
    raise SystemExit('Build architecture differs from this system; rebuild on the target')
PY
ui_dropin=/etc/systemd/system/modep-mod-ui.service.d/80-grid-integration.conf
host_dropin=/etc/systemd/system/modep-mod-host.service.d/80-grid-integration.conf
[[ ! -e "$ui_dropin" && ! -e "$host_dropin" ]] || {
    echo 'The Grid overrides already exist. Roll back before activating another build.' >&2; exit 1;
}
if ((dry_run)); then
    echo "Would select $build_dir/mod-ui and $build_dir/mod-host/mod-host."
    echo "Would create $ui_dropin and $host_dropin and restart the MODEP host/UI."
    exit 0
fi
[[ $EUID = 0 ]] || { echo 'Run activation with sudo.' >&2; exit 1; }
for unit in modep-mod-ui.service modep-mod-host.service; do
    [[ $(systemctl show --property=LoadState --value "$unit") = loaded ]] || {
        echo "Missing installed MODEP unit: $unit" >&2; exit 1;
    }
done
[[ -x /usr/bin/authbind ]] || { echo 'MODEP authbind is required for port 80.' >&2; exit 1; }
command -v curl >/dev/null || { echo 'curl is required for the activation health check.' >&2; exit 1; }
runuser -u modep -- test -r "$build_dir/mod-ui/html/grid.html" || {
    echo 'The modep service user cannot read the build directory.' >&2; exit 1;
}
mkdir -p "$(dirname "$ui_dropin")" "$(dirname "$host_dropin")"
rollback_failure() {
    echo 'Activation failed; restoring packaged MODEP service commands.' >&2
    rm -f -- "$ui_dropin" "$host_dropin"
    systemctl daemon-reload
    systemctl restart modep-mod-host.service modep-mod-ui.service || true
}
trap rollback_failure ERR
cat > "$host_dropin" <<EOF
[Service]
ExecStart=
ExecStart=$build_dir/mod-host/mod-host -p 5555 -f 5556
EOF
cat > "$ui_dropin" <<EOF
[Service]
EnvironmentFile=$build_dir/integration.env
Environment=PYTHONPATH=$build_dir/mod-ui
Environment=MOD_HTML_DIR=$build_dir/mod-ui/html
Environment=MOD_DEFAULT_PEDALBOARD=$build_dir/mod-ui/default.pedalboard
Environment=MOD_DEV_ENVIRONMENT=0 MOD_DEV_HOST=0 MOD_DEV_HMI=1 MOD_DEVICE_WEBSERVER_PORT=80
ExecStart=
ExecStart=/usr/bin/authbind $build_dir/venv/bin/python $build_dir/mod-ui/scripts/rpi4-pisound/run-ui.py
EOF
systemctl daemon-reload
systemctl restart modep-mod-host.service modep-mod-ui.service
for unit in modep-mod-host.service modep-mod-ui.service; do
    systemctl is-active --quiet "$unit"
done
healthy=0
for attempt in {1..10}; do
    if curl --silent --fail --max-time 3 'http://localhost/grid.html?v=integration' \
        | grep -q 'grid-app.js'; then healthy=1; break; fi
    sleep 1
done
((healthy)) || { echo 'Grid HTTP health check failed.' >&2; false; }
trap - ERR
echo 'Grid stack activated. Open http://DEVICE/grid.html.'
