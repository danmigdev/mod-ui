# deploy-tone3000

Installs the TONE3000 integration and updates an existing Grid theme on a mod-ui that runs from a distro package
(Blokas' `modep-mod-ui`, MOD's own images) where you cannot just replace the
source tree. It patches the installed files in place with anchored insertions
and copies the branch's frontend assets.

## What it changes

Frontend assets copied into the web root:

- `js/tone3000.js`, `tone3000-callback.html`, `img/tone3000-icon.png` (default theme)
- When `grid.html` already exists on the device and `--no-grid` is not set:
  `tone3000-connect.html`, `grid.html`, all `js/grid-*.js`,
  `css/grid-dashboard.css` and `css/grid-manage.css` (the complete Grid frontend,
  including TONE3000, transport, MIDI devices and Settings)

Anchored insertions (each file backed up to `<file>.pre-tone3000` first):

| File | Change |
|---|---|
| `mod/settings.py` | `TONE3000_CLIENT_ID` / `TONE3000_API` (env var, then key file, then empty) |
| `mod/webserver.py` | TONE3000 template vars and upload route; Grid template rendering, file-manager proxy/stat routes, raw bank-list endpoint, and 8–1024-frame buffer-size route and validation |
| `html/index.html` | two template vars, the box wiring, the script tag, the menu icon, the panel |
| `html/js/desktop.js` | `makeTone3000Box` wiring (four spots) |
| `html/css/main.css` | the Tone3000 tab styling (appended) |

The script refreshes Grid assets only if the device already has `grid.html`;
use `--no-grid` to skip its assets. Existing Grid files are backed up to
`.pre-tone3000` before replacement. Open `/grid.html` after deployment.
For a fresh Grid installation, run this branch from source or build your device image
from it.

`modgui.js` is **not** touched in either theme. Without its change, a tone
downloaded while a NAM plugin is already on the board shows up after the next page
reload rather than in its dropdown immediately. Everything else works.

## The key

The `t3k_pub_...` publishable key is never stored in this repo. It is written to
`<data dir>/tone3000-client-id` on the device (the data dir comes from the
service's `MOD_DATA_DIR`, e.g. `/var/modep`). Pass it once with `--key`; later
runs without `--key` keep whatever is already there.

Get a key at tone3000.com -> Settings -> API Keys -> Create API Key, and leave
that key's allowed redirect URIs empty so any device address is accepted.

## Use

```sh
# first install
./deploy.sh --host patch@patchbox.local --key t3k_pub_xxxxxxxx

# key from a file instead of the command line
./deploy.sh --host patch@patchbox.local --key @~/.secrets/t3k.key

# see what it would do
./deploy.sh --host patch@patchbox.local --dry-run

# undo (restore every backup, remove the added files)
./deploy.sh --host patch@patchbox.local --rollback
```

`deploy.sh` copies `apply.py` + the assets to the device and runs `apply.py`
there under sudo. SSH auth is whatever your `ssh` already uses for the host.

`apply.py` can also be run directly on the device:

```sh
sudo python3 apply.py --key t3k_pub_xxxxxxxx --assets ./assets
```

Defaults: `--html-dir /usr/share/mod/html`, `--mod-dir
/usr/lib/python3/dist-packages/mod`, `--service modep-mod-ui.service`,
`--data-dir` and `--port` read from the unit's environment.

## Safety

- Re-running skips backend edits already present and refreshes the copied frontend assets.
- After patching, `apply.py` syntax-checks the Python files and does an HTTP
  check against the restarted service. If it does not come back healthy it
  restores every backup, restarts again, and exits non-zero.
- `--rollback` is always available.
