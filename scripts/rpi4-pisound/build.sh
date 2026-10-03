#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(git -C "$script_dir" rev-parse --show-toplevel)
output_dir=
host_source=
while (($#)); do
    case "$1" in
        --output) output_dir=${2:?Missing output directory}; shift 2 ;;
        --mod-host) host_source=${2:?Missing mod-host source directory}; shift 2 ;;
        --help) echo 'Usage: build.sh --output ABS_EMPTY_DIR [--mod-host SOURCE_DIR]'; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done
[[ -n "$output_dir" && "$output_dir" = /* ]] || {
    echo 'Provide an absolute, empty output directory with --output.' >&2; exit 1;
}
for command in git make pkg-config python3 tar; do
    command -v "$command" >/dev/null || { echo "Missing build tool: $command" >&2; exit 1; }
done
pkg-config --exists jack lilv-0 alsa || {
    echo 'JACK, Lilv and ALSA development files are required.' >&2; exit 1;
}
[[ $(python3 -c 'import struct; print(struct.calcsize("P") * 8)') = 64 ]] || {
    echo 'This build recipe targets 64-bit userspace.' >&2; exit 1;
}
git -C "$repo_dir" diff --quiet --ignore-cr-at-eol HEAD -- || {
    echo 'Commit tracked source changes before building the pinned checkout.' >&2; exit 1;
}
output_dir=$(realpath -m -- "$output_dir")
[[ "$output_dir" != / && "$output_dir" != "$repo_dir" && "$output_dir" != "$repo_dir"/* ]] || {
    echo 'The output directory must be outside the source checkout.' >&2; exit 1;
}
if [[ -e "$output_dir" ]]; then
    [[ -d "$output_dir" && -z $(find "$output_dir" -mindepth 1 -maxdepth 1 -print -quit) ]] || {
        echo 'The output directory must be empty.' >&2; exit 1;
    }
fi
hylia_required=0
# MODEP links Hylia statically, so its Link support is invisible to ldd.
if command -v dpkg-query >/dev/null &&
    [[ $(dpkg-query -W -f='${db:Status-Status}' modep-mod-host 2>/dev/null) = installed ]]; then
    hylia_required=1
elif command -v mod-host >/dev/null && ldd "$(command -v mod-host)" 2>/dev/null | grep -q hylia; then
    hylia_required=1
fi
if ((hylia_required)); then
    pkg-config --exists hylia || {
        echo 'The installed host supports Ableton Link; install libhylia and verify pkg-config hylia before rebuilding.' >&2
        exit 1
    }
fi
read -r host_repository host_revision host_tree < <(python3 - "$script_dir/stack.json" <<'PY'
import json, sys
with open(sys.argv[1]) as handle:
    stack = json.load(handle)
print(stack['mod_host_repository'], stack['mod_host_integration_revision'],
      stack['mod_host_integration_tree'])
PY
)
umask 022
mkdir -p "$output_dir/mod-ui" "$output_dir/mod-host"
git -C "$repo_dir" archive HEAD | tar -xf - -C "$output_dir/mod-ui"
if [[ -n "$host_source" ]]; then
    host_source=$(realpath -- "$host_source")
    [[ $(git -C "$host_source" rev-parse 'HEAD^{tree}') = "$host_tree" ]] || {
        echo 'The supplied mod-host tree does not match the reviewed integration.' >&2; exit 1;
    }
    git -C "$host_source" diff --quiet --ignore-cr-at-eol HEAD -- || {
        echo 'The supplied mod-host tree has uncommitted source changes.' >&2; exit 1;
    }
    git -C "$host_source" archive HEAD | tar -xf - -C "$output_dir/mod-host"
else
    git -C "$output_dir/mod-host" init --quiet
    git -C "$output_dir/mod-host" remote add origin "$host_repository"
    git -C "$output_dir/mod-host" fetch --quiet --depth 1 origin "$host_revision"
    git -C "$output_dir/mod-host" checkout --quiet --detach FETCH_HEAD
    [[ $(git -C "$output_dir/mod-host" rev-parse 'HEAD^{tree}') = "$host_tree" ]] || {
        echo 'Fetched mod-host revision does not match the reviewed source tree.' >&2; exit 1;
    }
fi
jobs=${MOD_BUILD_JOBS:-2}
make -C "$output_dir/mod-ui/utils" -j "$jobs"
make -C "$output_dir/mod-host" -j "$jobs"
python3 -m venv "$output_dir/venv"
"$output_dir/venv/bin/python" -m pip install -r "$output_dir/mod-ui/requirements.txt"
"$output_dir/venv/bin/python" -m pip freeze > "$output_dir/requirements-installed.txt"
PYTHONPATH="$output_dir/mod-ui" "$output_dir/venv/bin/python" - "$output_dir" \
    "$(git -C "$repo_dir" rev-parse HEAD)" <<'PY'
import json, os, platform, struct, subprocess, sys
from mod.patchstorage import get_config
root, ui_revision = sys.argv[1:]
with open(os.path.join(root, 'mod-ui/scripts/rpi4-pisound/stack.json')) as handle:
    stack = json.load(handle)
config = get_config(environ={})
if config['target_id'] is None:
    raise SystemExit('No Patchstorage target exists for this build architecture')
with open(os.path.join(root, 'integration.env'), 'w') as handle:
    handle.write('MOD_PATCHSTORAGE_ENABLED=1\nMOD_PATCHSTORAGE_PLATFORM_ID=%s\n'
                 'MOD_PATCHSTORAGE_TARGET_ID=%s\n' % (config['platform_id'], config['target_id']))
capabilities = {name: subprocess.call(['pkg-config', '--exists', name]) == 0
                for name in ('hylia', 'cc_client')}
stack.update({'mod_ui_revision': ui_revision, 'machine': platform.machine(),
              'pointer_bits': struct.calcsize('P') * 8, 'capabilities': capabilities})
with open(os.path.join(root, 'build.json'), 'w') as handle:
    json.dump(stack, handle, indent=2, sort_keys=True)
    handle.write('\n')
print('Built reviewed stack in %s' % root)
print('Optional native capabilities: %s' % capabilities)
PY
