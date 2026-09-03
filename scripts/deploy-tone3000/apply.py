#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
# SPDX-License-Identifier: AGPL-3.0-or-later
"""
Apply the TONE3000 integration to an already-installed mod-ui, in place.

Made for devices that run mod-ui from a distro package (e.g. Blokas' modep-mod-ui)
where the source tree cannot simply be replaced: this patches the installed files
with small anchored insertions instead.

- Idempotent. Re-running does nothing (each file carries a marker once patched).
- Every file it edits is copied to "<file>.pre-tone3000" the first time.
- It syntax-checks the Python files it touched and, if the service does not come
  back healthy, restores every backup and restarts again before failing.
- "--rollback" undoes everything: restores the backups, removes the added files.

Run it on the mod-ui host, as root:

    sudo python3 apply.py --key t3k_pub_xxxxxxxx --assets ./assets

The three files under --assets (tone3000.js, tone3000-callback.html,
tone3000-icon.png) come from the mod-ui source tree (html/js, html, html/img).
"""

import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

BACKUP_SUFFIX = ".pre-tone3000"

# ─────────────────────────────────────────────────────────────────────────────
# Content inserted into the installed files. Kept byte-for-byte in step with the
# mod-ui source; if the source changes, update these too.
# ─────────────────────────────────────────────────────────────────────────────

SETTINGS_BLOCK = '''

# Tone3000 integration. The client id is the OAuth publishable key (t3k_pub_...) -- a
# public value, but deployment configuration, so it is deliberately never committed.
# Provide it as MOD_TONE3000_CLIENT_ID, or write it to the file named by
# MOD_TONE3000_CLIENT_ID_FILE (default <data dir>/tone3000-client-id).
TONE3000_CLIENT_ID = os.environ.get('MOD_TONE3000_CLIENT_ID', "").strip()
if not TONE3000_CLIENT_ID:
    _t3k_key_file = os.environ.get('MOD_TONE3000_CLIENT_ID_FILE', join(DATA_DIR, 'tone3000-client-id'))
    try:
        with open(_t3k_key_file) as _fh:
            TONE3000_CLIENT_ID = _fh.read().strip()
    except OSError:
        pass
TONE3000_API = os.environ.get('MOD_TONE3000_API', "https://www.tone3000.com")
'''

FILESUPLOAD_CLASS = '''class FilesUpload(JsonRequestHandler):
    def post(self, filetype):
        datadir, extensions = FilesList._get_dir_and_extensions_for_filetype(filetype)
        if datadir is None:
            raise web.HTTPError(400)

        # Anything outside the 3 CORS "simple" content-types forces a preflight we do not answer,
        # so a cross-origin page cannot reach this handler.
        if self.request.headers.get("Content-Type") != "application/octet-stream":
            raise web.HTTPError(400)

        # basename() alone would quietly turn "../../etc" into "etc" and write it anyway.
        # Refuse anything it would rewrite, so a caller never gets a file somewhere it did
        # not ask for. Both are single path components by the time we join them.
        folder = self.get_argument("folder", "")
        name   = self.get_argument("name", "")
        if folder != os.path.basename(folder) or name != os.path.basename(name):
            raise web.HTTPError(400)
        if folder in ("", ".", "..") or name in ("", ".", ".."):
            raise web.HTTPError(400)
        if not name.lower().endswith(extensions):
            raise web.HTTPError(400)

        destdir = os.path.join(USER_FILES_DIR, datadir, folder)
        os.makedirs(destdir, exist_ok=True)
        fullname = os.path.join(destdir, name)
        with open(fullname, 'wb') as fh:
            fh.write(self.request.body)

        # Same string FilesList builds by walking, so a caller can match on it.
        self.write({'ok': True, 'fullname': fullname})

'''

# The grid nav's bank tree and every membership/guard check read the exact,
# unfiltered banks.json through this (GET /banks cross-references the scanner
# cache and silently drops -- then persists the drop of -- entries it doesn't
# currently vouch for). Stock mod-ui has no such route.
BANKLOADRAW_CLASS = '''class BankLoadRaw(JsonRequestHandler):
    def get(self):
        self.write(safe_json_load(USER_BANKS_JSON_FILE, list))

'''

TONE3000_PANEL = '''
    <!-- TONE3000 -->
    <div id="tone3000-library" class="mod-hidden mod-init-hidden"><div class="box">
        <header>
            <h1 class="bottom top">Tone3000</h1>
        </header>
        <!-- The catalog opens in a real OS window floated over this panel. It cannot be
             an iframe: TONE3000's sign-in cookie is SameSite=Lax and is dropped in a
             cross-site frame. So there is nothing to draw here but the way in. -->
        <div id="tone3000-wrapper">
            <img id="tone3000-logo" src="img/tone3000-icon.png" alt="Tone3000">
            <h2>Tone3000</h2>
            <p class="tone3000-hint">
                Browse the TONE3000 catalog and download the tones you like. Each tone is
                saved to its own folder under <b>NAM Models</b>, where you will find it in
                the File Manager.
            </p>
            <p class="tone3000-hint">
                A tone you just downloaded goes to the top of the model list of every NAM
                plugin on the board, so you can load it without hunting for it.
            </p>
            <button id="tone3000-browse">Open TONE3000</button>
            <label class="tone3000-autoopen">
                <input type="checkbox" id="tone3000-autoopen">
                Open TONE3000 automatically when this tab is selected
            </label>
        </div>
    </div></div>
    <!-- END TONE3000 -->
'''

MAKE_TONE3000_BOX = '''
Desktop.prototype.makeTone3000Box = function (el, trigger) {
    var self = this
    el.tone3000Box({
        trigger: trigger,
        windowManager: this.windowManager,
    })
}
'''

MAIN_CSS_BLOCK = '''
/* TONE3000 */
#main-menu #mod-tone3000{background-image:url(../img/tone3000-icon.png);background-position:center center;background-size:30px 30px;background-repeat:no-repeat;transition:all .33s}
#main-menu #mod-tone3000:hover{background-color:#000}
#main-menu #mod-tone3000.selected{background-color:#000}
#tone3000-library{background:#2c2c2c url(../img/watermark.png) 100% 100% no-repeat;top:0;bottom:46px;left:0;right:0;overflow-x:hidden;overflow-y:auto;position:absolute;z-index:2}
#tone3000-library header{display:block;left:0;height:45px;line-height:45px;position:fixed;right:0;top:0;box-shadow:0 1px 10px rgba(0,0,0,0.1);z-index:5;background-color:#111;background-position:3px 50%;background-size:36px;background-repeat:no-repeat;background-image:url(../img/icons/36/mod.png);padding-left:45px}
#tone3000-library header h1{font-weight:2em;text-transform:uppercase;font-weight:normal;color:#999;display:inline-block;font-size:24px;line-height:49px;height:45px;padding:0}
#tone3000-wrapper{position:absolute;top:45px;bottom:46px;left:0;right:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#ccc}
#tone3000-logo{width:96px;height:96px}
#tone3000-wrapper h2{color:#fff;font-size:24px;font-weight:normal;text-transform:uppercase;margin:.8em 0 .2em}
#tone3000-wrapper .tone3000-hint{font-size:13px;line-height:1.5;color:#999;max-width:34em;margin:0 0 1em}
#tone3000-wrapper .tone3000-hint b{color:#ccc;font-weight:normal}
#tone3000-wrapper .tone3000-hint:last-of-type{margin-bottom:1.5em}
#tone3000-browse{background:#883996;border:none;border-radius:3px;color:#fff;cursor:pointer;font-size:14px;padding:.7em 1.4em}
#tone3000-browse:hover{background:#9d47ad}
#tone3000-wrapper .tone3000-autoopen{font-size:12px;color:#999;cursor:pointer;margin-top:1.5em}
#tone3000-wrapper .tone3000-autoopen input{margin-right:.5em;vertical-align:middle;cursor:pointer}
#tone3000-wrapper .tone3000-autoopen:hover{color:#ccc}
'''

# The grid theme's file manager talks to /filesvc/* and /filesvc-stat/*; the
# handlers behind them were never committed upstream (see the matching commit in
# mod/webserver.py). Injected here for devices whose webserver.py predates it.
# The import is tried under tornado4 first -- on-device `tornado` is aliased to
# `tornado4`, and importing tornado.httpclient there loads a second copy whose
# HTTPError won't match what simple_httpclient raises.
FILEMANAGER_BLOCK = '''# --- grid theme file manager (proxy + stat) ---
try:
    from tornado4.httpclient import AsyncHTTPClient as _T3kHTTPClient, HTTPError as _T3kHTTPError
except ImportError:
    from tornado.httpclient import AsyncHTTPClient as _T3kHTTPClient, HTTPError as _T3kHTTPError
from urllib.parse import quote as _t3k_quote, unquote as _t3k_unquote

class FileManagerProxy(TimelessRequestHandler):
    @web.asynchronous
    @gen.coroutine
    def get(self, path):
        yield self._proxy(path)

    @web.asynchronous
    @gen.coroutine
    def post(self, path):
        yield self._proxy(path)

    @gen.coroutine
    def _proxy(self, path):
        url = "http://127.0.0.1:8081/" + _t3k_quote(path or '', safe='/')
        if self.request.query:
            url += "?" + self.request.query
        headers = {}
        ct = self.request.headers.get('Content-Type')
        if ct:
            headers['Content-Type'] = ct
        body = self.request.body if self.request.method in ('POST', 'PUT') else None
        try:
            response = yield _T3kHTTPClient().fetch(
                url, method=self.request.method, headers=headers, body=body,
                follow_redirects=False, request_timeout=30)
        except _T3kHTTPError as e:
            if e.response is None:
                self.set_status(502)
                self.finish()
                return
            response = e.response
        self.set_status(response.code)
        rct = response.headers.get('Content-Type')
        if rct:
            self.set_header('Content-Type', rct)
        self.finish(response.body or b'')

class FileManagerStat(JsonRequestHandler):
    def get(self, path):
        base = os.path.realpath(USER_FILES_DIR)
        target = os.path.realpath(os.path.join(base, _t3k_unquote(path or '')))
        if target != base and not target.startswith(base + os.sep):
            raise web.HTTPError(403)
        if not os.path.isdir(target):
            raise web.HTTPError(404)
        entries = []
        for name in os.listdir(target):
            full = os.path.join(target, name)
            try:
                fst = os.stat(full)
            except OSError:
                continue
            isdir = os.path.isdir(full)
            entries.append({
                'name': name, 'isDir': isdir,
                'extension': '' if isdir else os.path.splitext(name)[1].lstrip('.'),
                'size': fst.st_size, 'mtime': fst.st_mtime, 'ctime': fst.st_ctime,
            })
        self.write(entries)

'''

# The four blocks desktop.js already has, used as anchors so the insertion lands
# right after the matching File Manager wiring.
FM_BOX_DEFAULT = "        fileManagerBoxTrigger: $('<div>'),\n"
FM_BOX_MAKE = (
    "    this.fileManagerBox = self.makeFileManagerBox(elements.fileManagerBox,\n"
    "                                                  elements.fileManagerBoxTrigger)\n"
)
FM_BOX_TOOLTIP = "    elements.fileManagerBoxTrigger.statusTooltip()\n"
FM_BOX_PROTOTYPE = (
    "Desktop.prototype.makeFileManagerBox = function (el, trigger) {\n"
    "    var self = this\n"
    "    el.fileManagerBox({\n"
    "        trigger: trigger,\n"
    "        windowManager: this.windowManager,\n"
    "    })\n"
    "}\n"
)


WHOLE_APPEND = "\x00APPEND\x00"
WHOLE_PREPEND = "\x00PREPEND\x00"


def edits_for(mod_dir, html_dir):
    """Return {abs_path: (label, [(anchor, replacement[, guard]), ...])}.

    Each edit is skipped when its `guard` substring is already in the file, so
    the whole set is idempotent edit-by-edit. anchor == "" with a replacement
    starting WHOLE_APPEND / WHOLE_PREPEND is a whole-file append / prepend.
    """
    ws = os.path.join(mod_dir, "webserver.py")
    st = os.path.join(mod_dir, "settings.py")
    ix = os.path.join(html_dir, "index.html")
    dk = os.path.join(html_dir, "js", "desktop.js")
    cs = os.path.join(html_dir, "css", "main.css")

    return {
        st: ("settings.py", [
            ("", WHOLE_APPEND + SETTINGS_BLOCK, "TONE3000_CLIENT_ID"),
        ]),

        ws: ("webserver.py", [
            ("\nfrom mod import (\n",
             "\nfrom mod.settings import TONE3000_CLIENT_ID, TONE3000_API\n\nfrom mod import (\n",
             "from mod.settings import TONE3000_CLIENT_ID"),
            ("            'sampleRate': get_jack_sample_rate(),\n            'patchstorage_enabled':",
             "            'sampleRate': get_jack_sample_rate(),\n"
             "            'tone3000_client_id': TONE3000_CLIENT_ID,\n"
             "            'tone3000_api': TONE3000_API,\n"
             "            'patchstorage_enabled':",
             "'tone3000_client_id': TONE3000_CLIENT_ID"),
            ("\nsettings = {'log_function': lambda handler: None} if not LOG else {}\n",
             "\n" + FILESUPLOAD_CLASS + "settings = {'log_function': lambda handler: None} if not LOG else {}\n",
             "class FilesUpload("),
            ('            (r"/files/list/?", FilesList),\n',
             '            (r"/files/list/?", FilesList),\n'
             '            (r"/files/upload/([a-z]+)/?", FilesUpload),\n',
             '(r"/files/upload/([a-z]+)/?", FilesUpload)'),
            # grid theme file manager -- proxy + stat, never committed upstream
            ("\nclass EffectImage(TimelessStaticFileHandler):\n",
             "\n" + FILEMANAGER_BLOCK + "class EffectImage(TimelessStaticFileHandler):\n",
             "class FileManagerProxy("),
            ('            (r"/resources/(.*)", EffectResource),\n',
             '            (r"/resources/(.*)", EffectResource),\n'
             '            (r"/filesvc-stat/(.*)", FileManagerStat),\n'
             '            (r"/filesvc/(.*)", FileManagerProxy),\n',
             '(r"/filesvc/(.*)", FileManagerProxy)'),
            # /grid.html renders with the same bootstrap context as / (index)
            ("\n    def pedalboard(self):\n",
             "\n    def grid(self):\n"
             "        # Independent \"grid\" theme: same bootstrap data as the default theme.\n"
             "        return self.index()\n"
             "\n    def pedalboard(self):\n",
             "\n    def grid(self):\n"),
            # /banks/raw -- unfiltered banks.json, needed by the grid nav
            ("\nclass BankSave(JsonRequestHandler):\n",
             "\n" + BANKLOADRAW_CLASS + "class BankSave(JsonRequestHandler):\n",
             "class BankLoadRaw("),
            ('            (r"/banks/?", BankLoad),\n',
             '            (r"/banks/?", BankLoad),\n'
             '            (r"/banks/raw/?", BankLoadRaw),\n',
             '(r"/banks/raw/?", BankLoadRaw)'),
            # grid Settings offers the full 8..1024 buffer range; stock only
            # wires 128/256. Widen the route and guard the rest server-side.
            ("class SetBufferSize(JsonRequestHandler):\n    def post(self, size):\n        size = int(size)\n",
             "class SetBufferSize(JsonRequestHandler):\n"
             "    # JACK only takes a power-of-two period; the route lets any integer through\n"
             "    # so the UI can offer the full 8..1024 range, this rejects the rest.\n"
             "    VALID_SIZES = (8, 16, 32, 64, 128, 256, 512, 1024)\n\n"
             "    def post(self, size):\n        size = int(size)\n"
             "        if size not in self.VALID_SIZES:\n            raise web.HTTPError(400)\n",
             "VALID_SIZES ="),
            ('            (r"/set_buffersize/(128|256)", SetBufferSize),\n',
             '            (r"/set_buffersize/(\\d+)", SetBufferSize),\n',
             '/set_buffersize/(\\d+)'),
        ]),

        ix: ("index.html", [
            ("    LV2_PLUGIN_DIR   = '{{lv2_plugin_dir}}'\n",
             "    LV2_PLUGIN_DIR   = '{{lv2_plugin_dir}}'\n"
             "    TONE3000_CLIENT_ID = '{{tone3000_client_id}}'\n"
             "    TONE3000_API       = '{{tone3000_api}}'\n",
             "TONE3000_CLIENT_ID = '{{tone3000_client_id}}'"),
            ("        fileManagerBoxTrigger: $('#main-menu #mod-file-manager'),\n",
             "        fileManagerBoxTrigger: $('#main-menu #mod-file-manager'),\n"
             "        tone3000Box: $('#tone3000-library'),\n"
             "        tone3000BoxTrigger: $('#main-menu #mod-tone3000'),\n",
             "tone3000Box: $('#tone3000-library')"),
            ('<script type="text/javascript" src="js/file_manager.js?v={{version}}"></script>\n',
             '<script type="text/javascript" src="js/file_manager.js?v={{version}}"></script>\n'
             '<script type="text/javascript" src="js/tone3000.js?v={{version}}"></script>\n',
             'src="js/tone3000.js'),
            ('        <div id="mod-cloud-plugins" class="icon" data-message="Plugin Store"></div>\n',
             '        <div id="mod-cloud-plugins" class="icon" data-message="Plugin Store"></div>\n'
             '        <div id="mod-tone3000" class="icon" data-message="Tone3000"></div>\n',
             'id="mod-tone3000"'),
            ("    <!-- END FILE MANAGER -->\n",
             "    <!-- END FILE MANAGER -->\n" + TONE3000_PANEL,
             "<!-- TONE3000 -->"),
        ]),

        dk: ("desktop.js", [
            (FM_BOX_DEFAULT,
             FM_BOX_DEFAULT + "        tone3000Box: $('<div>'),\n        tone3000BoxTrigger: $('<div>'),\n",
             "tone3000Box: $('<div>')"),
            (FM_BOX_MAKE,
             FM_BOX_MAKE + "    this.tone3000Box = self.makeTone3000Box(elements.tone3000Box,\n"
             "                                            elements.tone3000BoxTrigger)\n",
             "self.makeTone3000Box(elements.tone3000Box"),
            (FM_BOX_TOOLTIP, FM_BOX_TOOLTIP + "    elements.tone3000BoxTrigger.statusTooltip()\n",
             "tone3000BoxTrigger.statusTooltip()"),
            (FM_BOX_PROTOTYPE, FM_BOX_PROTOTYPE + MAKE_TONE3000_BOX,
             "Desktop.prototype.makeTone3000Box"),
        ]),

        cs: ("main.css", [
            ("", WHOLE_APPEND + MAIN_CSS_BLOCK, "/* TONE3000 */"),
        ]),
    }


# (name in --assets, dest parts under html/, replaces_an_existing_file)
# Replacements are backed up to <file>.pre-tone3000 and restored on rollback;
# new files are just removed on rollback. The grid theme's own files
# (grid.html, grid-dashboard.css) are safe to drop in whole -- they are not
# part of any distro package and this branch owns them.
ASSETS = [
    ("tone3000.js", ("js", "tone3000.js"), False),
    ("tone3000-callback.html", ("tone3000-callback.html",), False),
    ("tone3000-connect.html", ("tone3000-connect.html",), False),
    ("tone3000-icon.png", ("img", "tone3000-icon.png"), False),
]

# The whole grid theme front-end. These are branch-owned static assets -- not
# part of any distro package -- so they drop straight into the web root. The
# only backend piece the grid theme needs is the grid() template route, added
# to webserver.py above.
GRID_ASSETS = [
    ("grid.html", ("grid.html",), True),
    ("grid-app.js", ("js", "grid-app.js"), True),
    ("grid-board.js", ("js", "grid-board.js"), True),
    ("grid-connect-dialog.js", ("js", "grid-connect-dialog.js"), True),
    ("grid-file-manager.js", ("js", "grid-file-manager.js"), True),
    ("grid-manage.js", ("js", "grid-manage.js"), True),
    ("grid-midi.js", ("js", "grid-midi.js"), True),
    ("grid-nav.js", ("js", "grid-nav.js"), True),
    ("grid-params.js", ("js", "grid-params.js"), True),
    ("grid-settings.js", ("js", "grid-settings.js"), True),
    ("grid-transport.js", ("js", "grid-transport.js"), True),
    ("grid-store.js", ("js", "grid-store.js"), True),
    ("grid-tone3000.js", ("js", "grid-tone3000.js"), True),
    ("grid-dashboard.css", ("css", "grid-dashboard.css"), True),
    ("grid-manage.css", ("css", "grid-manage.css"), True),
]


def sh(*cmd, check=True):
    return subprocess.run(cmd, check=check, capture_output=True, text=True)


def detect_data_dir(service):
    try:
        out = sh("systemctl", "show", service, "-p", "Environment", check=False).stdout
        for tok in out.split():
            if tok.startswith("MOD_DATA_DIR="):
                return tok.split("=", 1)[1]
    except Exception:
        pass
    return "/var/modep"


def detect_port(service):
    try:
        out = sh("systemctl", "show", service, "-p", "Environment", check=False).stdout
        for tok in out.split():
            if tok.startswith("MOD_DEVICE_WEBSERVER_PORT="):
                return tok.split("=", 1)[1]
    except Exception:
        pass
    return "80"


def backups_of(paths):
    return [p + BACKUP_SUFFIX for p in paths]


def do_rollback(edits, html_dir, key_file):
    restored, removed = [], []
    for path in list(edits):
        bak = path + BACKUP_SUFFIX
        if os.path.isfile(bak):
            shutil.copyfile(bak, path)
            restored.append(path)
    for name, rel, replace in ASSETS + GRID_ASSETS:
        p = os.path.join(html_dir, *rel)
        bak = p + BACKUP_SUFFIX
        if replace and os.path.isfile(bak):
            shutil.copyfile(bak, p)
            restored.append(p)
        elif not replace and os.path.isfile(p) and not os.path.isfile(bak):
            os.remove(p)
            removed.append(p)
    print("rolled back:")
    for p in restored:
        print("  restored", p)
    for p in removed:
        print("  removed ", p)
    if not restored and not removed:
        print("  (nothing to do)")


def apply_file(path, marker, edits, dry_run):
    with open(path, "r", encoding="utf-8") as fh:
        src = fh.read()

    new = src
    for edit in edits:
        anchor, repl = edit[0], edit[1]
        guard = edit[2] if len(edit) > 2 else None
        if guard is not None and guard in new:
            continue  # this edit is already applied
        if anchor == "":
            if repl.startswith(WHOLE_APPEND):
                body = repl[len(WHOLE_APPEND):]
                new = new.rstrip("\n") + "\n\n" + body.lstrip("\n")
            elif repl.startswith(WHOLE_PREPEND):
                new = repl[len(WHOLE_PREPEND):] + new
            else:
                raise SystemExit("bad whole-file op")
            continue
        count = new.count(anchor)
        if count != 1:
            raise SystemExit(
                "ABORT: anchor found %d times (want 1) in %s\n  anchor: %r"
                % (count, path, anchor[:80])
            )
        new = new.replace(anchor, repl, 1)

    if new == src:
        print("  = already patched, skipping:", path)
        return False

    if not dry_run:
        bak = path + BACKUP_SUFFIX
        if not os.path.exists(bak):
            shutil.copyfile(path, bak)
            shutil.copymode(path, bak)
        tmp = path + ".t3k-new"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(new)
        shutil.copymode(path, tmp)
        os.replace(tmp, path)
    print("  + patched:", path, "(%d bytes -> %d)" % (len(src), len(new)))
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--key", help="TONE3000 publishable key (t3k_pub_...). "
                                  "If omitted, an existing key file at the destination is kept. "
                                  "Prefix with '@' to read it from a file, e.g. --key @/root/t3k.key")
    ap.add_argument("--assets", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets"),
                    help="directory holding the asset files (tone3000*.js/html, the icon, and "
                         "grid.html / grid-dashboard.css / grid-tone3000.js for the grid theme)")
    ap.add_argument("--html-dir", default="/usr/share/mod/html")
    ap.add_argument("--mod-dir", default="/usr/lib/python3/dist-packages/mod")
    ap.add_argument("--data-dir", default=None, help="where the key file goes (default: from the unit's MOD_DATA_DIR)")
    ap.add_argument("--service", default="modep-mod-ui.service")
    ap.add_argument("--port", default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-restart", action="store_true")
    ap.add_argument("--no-grid", action="store_true", help="skip the grid theme's TONE3000 files")
    ap.add_argument("--rollback", action="store_true")
    args = ap.parse_args()

    for d in (args.html_dir, args.mod_dir):
        if not os.path.isdir(d):
            raise SystemExit("not a directory: " + d)

    data_dir = args.data_dir or detect_data_dir(args.service)
    port = args.port or detect_port(args.service)
    key_file = os.path.join(data_dir, "tone3000-client-id")
    edits = edits_for(args.mod_dir, args.html_dir)

    if args.rollback:
        do_rollback(edits, args.html_dir, key_file)
        if not args.no_restart:
            restart_and_check(args.service, port, rollback=None)
        return

    key = args.key
    if key and key.startswith("@"):
        with open(key[1:], "r", encoding="utf-8") as fh:
            key = fh.read().strip()
    if key:
        if not key.startswith("t3k_pub_"):
            raise SystemExit("--key must be a t3k_pub_... publishable key")
    else:
        existing = ""
        if os.path.isfile(key_file):
            with open(key_file, "r", encoding="utf-8") as fh:
                existing = fh.read().strip()
        if not existing.startswith("t3k_pub_"):
            raise SystemExit("no --key given and no valid key at " + key_file)
        print("keeping existing key file:", key_file)
    grid_present = os.path.isfile(os.path.join(args.html_dir, "grid.html"))
    wanted = ASSETS + (GRID_ASSETS if grid_present and not args.no_grid else [])
    for name, _, _ in wanted:
        if not os.path.isfile(os.path.join(args.assets, name)):
            raise SystemExit("missing asset: " + os.path.join(args.assets, name))

    print("mod-ui TONE3000 install")
    print("  html-dir :", args.html_dir)
    print("  mod-dir  :", args.mod_dir)
    print("  data-dir :", data_dir, "(key ->", key_file + ")")
    print("  service  :", args.service, " port", port)
    print("  dry-run  :", args.dry_run)
    print()

    changed = []
    print("patching installed files:")
    for path, (marker, file_edits) in edits.items():
        if apply_file(path, marker, file_edits, args.dry_run):
            changed.append(path)

    print("\nassets:" + ("" if grid_present and not args.no_grid else "  (grid theme not present -- skipping its files)"))
    for name, rel, replace in wanted:
        dst = os.path.join(args.html_dir, *rel)
        tag = "replace" if replace else "copy"
        print(("  (dry) " if args.dry_run else "  ") + tag, name, "->", dst)
        if not args.dry_run:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if replace and os.path.isfile(dst) and not os.path.exists(dst + BACKUP_SUFFIX):
                shutil.copyfile(dst, dst + BACKUP_SUFFIX)
            shutil.copyfile(os.path.join(args.assets, name), dst)
            os.chmod(dst, 0o644)

    print("\nkey file:")
    if not key:
        print("  keep", key_file)
    else:
        print(("  (dry) " if args.dry_run else "  ") + "write", key_file)
    if key and not args.dry_run:
        os.makedirs(data_dir, exist_ok=True)
        with open(key_file, "w", encoding="utf-8") as fh:
            fh.write(key.strip() + "\n")
        os.chmod(key_file, 0o644)
        if hasattr(os, "chown"):
            try:
                st = os.stat(data_dir)
                os.chown(key_file, st.st_uid, st.st_gid)
            except OSError:
                pass

    if args.dry_run:
        print("\ndry run: nothing written.")
        return

    # Syntax-check the Python we touched; undo everything if we broke it.
    for path in (os.path.join(args.mod_dir, "webserver.py"), os.path.join(args.mod_dir, "settings.py")):
        r = sh(sys.executable, "-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", path, check=False)
        if r.returncode != 0:
            print("\nSYNTAX ERROR in", path, "-- rolling back\n", r.stderr)
            do_rollback(edits, args.html_dir, key_file)
            restart_and_check(args.service, port, rollback=None)
            raise SystemExit(1)

    if args.no_restart:
        print("\ndone (service not restarted -- pass without --no-restart to restart).")
        return

    restart_and_check(args.service, port, rollback=lambda: do_rollback(edits, args.html_dir, key_file))
    print("\nTONE3000 installed. Open mod-ui and pick 'Tone3000' from the top menu.")


def http_status(url):
    """The HTTP status code, or None if the server did not answer.
    urlopen follows redirects and raises on >=400, so read the code off both paths."""
    try:
        with urllib.request.urlopen(url, timeout=3) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return None


def restart_and_check(service, port, rollback):
    print("\nrestarting", service, "...")
    sh("systemctl", "restart", service, check=False)
    ok = False
    for _ in range(30):
        time.sleep(1)
        active = sh("systemctl", "is-active", service, check=False).stdout.strip()
        if active != "active":
            continue
        code = http_status("http://127.0.0.1:%s/" % port)
        # anything the server answers (200, a redirect, even a 404) means tornado is
        # up and routing; only a dead socket or a 5xx is a failed start.
        if code is not None and code < 500:
            ok = True
            break
    if ok:
        print("  service is up and serving on port", port)
        return
    print("  service did NOT come back healthy")
    sh("journalctl", "-u", service, "-n", "40", "--no-pager", check=False)
    if rollback:
        rollback()
        sh("systemctl", "restart", service, check=False)
        time.sleep(3)
        print("  restored from backups and restarted")
    raise SystemExit(1)


if __name__ == "__main__":
    main()
