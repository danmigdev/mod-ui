# deploy-tone3000

Installs the TONE3000 integration onto a mod-ui that runs from a distro package
(Blokas' `modep-mod-ui`, MOD's own images) where you cannot just replace the
source tree. It patches the installed files in place with small anchored
insertions and drops in three new files.

## What it changes

New files copied into the web root:

- `js/tone3000.js`, `tone3000-callback.html`, `img/tone3000-icon.png` (default theme)
- `tone3000-connect.html`, `js/grid-tone3000.js` (grid theme)

Anchored insertions (each file backed up to `<file>.pre-tone3000` first):

| File | Change |
|---|---|
| `mod/settings.py` | `TONE3000_CLIENT_ID` / `TONE3000_API` (env var, then key file, then empty) |
| `mod/webserver.py` | import, two template vars, the `FilesUpload` handler, one route |
| `html/index.html` | two template vars, the box wiring, the script tag, the menu icon, the panel |
| `html/js/desktop.js` | `makeTone3000Box` wiring (four spots) |
| `html/css/main.css` | the Tone3000 tab styling (appended) |

Grid theme (only when `grid.html` is present; `--no-grid` to skip). These are not
part of any package and this branch owns them, so they are dropped in whole and
backed up to `.pre-tone3000`:

| File | Change |
|---|---|
| `html/grid.html` | bootstrap vars, script tag, toolbar button, overlay markup |
| `html/css/grid-dashboard.css` | the grid TONE3000 styles |

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

- Idempotent: re-running is a no-op (each file carries a marker once patched).
- After patching, `apply.py` syntax-checks the Python files and does an HTTP
  check against the restarted service. If it does not come back healthy it
  restores every backup, restarts again, and exits non-zero.
- `--rollback` is always available.
