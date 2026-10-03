MODEP Grid port
==============

Base and scope
--------------

The branch modep-grid-theme starts directly from BlokasLabs/mod-ui
modep-1.13-ps, commit 65843c5cc4a1959063b9c96c3897b66ad7003427.
The separate checkout leaves rpi4-pisound-integration and its uncommitted
stock-store restoration untouched. No MOD master merge is included in this
branch's ancestry.

Grid assets and selected shared fixes come from rpi4-pisound-integration
at 83ab9b2e, with the small Grid store hook adaptation from the local
restoration. The source branch's independent-chain design documents are
not an implemented feature and are not included as working audio behavior.

Preserved MODEP behavior
------------------------

* Stock index.html, PatchStorage window/templates/styles and its menu entry.
* Blokas branding, conditional menu visibility and moddevices.com AJAX filter.
* Version checking and notification through /apt/check and the Blokas service.
* Original package upgrade service integration, with the custom-build guard
  described below. The check is performed when opening the stock page.
* Profiler Amplifier Profiles (.tapf) and MIDI/snapshot addressing hints.
* Default-pedalboard loading special case in Desktop.loadPedalboard.
* Existing device/HMI handling, presets directory configuration, user data
  paths and the pedalboard/current and snapshot/current endpoints.
* Legacy using-256-frames persistence, alongside the additional buffer-size
  setting. Existing default.pedalboard and audio graph are not replaced.

Added or adapted
----------------

* Grid HTML/CSS/controller files and a stock-to-Grid navigation entry.
  The default route continues to serve the MODEP stock UI.
* Grid plugin shelf, parameter editor, explicit audio routing, banks,
  pedalboards, snapshots, file manager, PatchStorage, Tone3000, transport,
  MIDI-device selection, font size, buffer controls and classic-UI switch.
* Same-origin browsepy proxy (/filemanager/) and file statistics endpoint.
  browsepy must still run separately on 127.0.0.1:8081.
* Typed NAM uploads and Tone3000 OAuth popup pages. The Grid browser uses
  its own OAuth integration; no MOD cloud account is required. The stock
  constructor remains usable without Tone3000 globals or credentials.
* Ordered LV2 port-group metadata, matched Python/C structures, current
  plugin rendering/file-picker fixes and native USB-port labeling fixes.
  Stock generic controls also resolve groups by their declared index.
* PatchStorage process-ABI selection, environment compatibility and atomic
  item/revision metadata writes. Existing patchstorage.json sidecars are
  read from installed bundles and refreshed without a stale native cache.
* Plugin archive validation and isolated extraction before bundle loading.
  Both /effect/install and /effect/install/ retain the stock response shape.
* Snapshot persistence and rejection of saves without a persisted board.
* Power-of-two buffer periods from 8 to 1024; original 128/256 UI remains.
* External pedalboard cable reset and current Tornado 4/Python compatibility.
* Pedalboard thumbnail resizing works with both older and current Pillow.
* MODEP's console entry point remains mod.modep:run, now a callable function
  that imports the server without starting it during module inspection.

Native compatibility
--------------------

Port-group metadata changes the native structure layout relative to stock
MODEP. Build utils/libmod_utils.so from this exact checkout, and deploy it
with modtools/utils.py. Do not mix the system MODEP binary with this branch's
Python wrappers. Import now refuses a library missing the required bundle
lookup export instead of dereferencing the older layout.

The MODEP PatchStorage sidecar format and public JSON metadata remain
compatible; metadata enrichment now happens in the Python wrapper. Original
native patchstorage.cpp/h files remain as historical source, but the updated
Makefile does not compile them.

Configuration
-------------

Existing MODEP variables remain accepted: LV2_PLUGIN_DIR, MOD_PRESETS_DIR,
MOD_USER_PEDALBOARDS_DIR, MOD_USER_FILES_DIR and MOD_DATA_DIR. The plugin path
also accepts MOD_USER_PLUGINS_DIR, taking precedence when explicitly set.
Do not change existing Patchbox service/data locations when activating Grid.

PatchStorage accepts both PATCHSTORAGE_* and MOD_PATCHSTORAGE_* variables;
MOD-prefixed overrides take precedence. The current public catalog defaults
are platform 8046, ARMHF target 8278 and AArch64 target 8280. An explicitly
configured target is preserved. Other architectures require an explicit
target to enable downloads. A local API proxy can still be configured.

Tone3000 needs MOD_TONE3000_CLIENT_ID or the public client ID in
<MOD_DATA_DIR>/tone3000-client-id. MOD_TONE3000_API can override the service
address. Without a client ID the browser shows the setup message.

Build and deployment
--------------------

The source-checkout runner and the MODEP console entry point are supported.
For Raspberry Pi 4/Pisound, scripts/rpi4-pisound/build.sh, activate.sh and
rollback.sh provide the reviewed source-build workflow and service drop-ins.
The pinned host is danmigdev/mod-host:modep-grid-host, based on
BlokasLabs/mod-host:modep at 44c7b18, the MODEP package's source revision.
It merges the previously reviewed Raspberry host integration while preserving
Blokas's removal of the obsolete IRC workflow. Its runtime sources are identical
to the previously deployed host. Host repository, commit and tree are pinned
in stack.json; build.sh fetches that commit and verifies the tree. The archived
mod-host-patches directory documents the earlier integration and is no longer
applied during builds. The UI base remains Blokas modep-1.13-ps.

The host branch compiled and passed all isolated JACK/LV2 integration checks
on WSL, including audio routing, buffer changes, MIDI, transport, presets/state
and socket/worker framing. Raspberry deployment details are recorded below.
Pull requests can target the Blokas UI and
host independently; the host PR includes stable upstream updates as well as
the selected integration fixes, rather than being a Grid-only UI change.

Build on the Raspberry from a committed checkout, using a new output folder::

    bash scripts/rpi4-pisound/build.sh --output /opt/modep-grid/builds/<build-id>
    sudo bash scripts/rpi4-pisound/activate.sh --dry-run /opt/modep-grid/builds/<build-id>
    sudo bash scripts/rpi4-pisound/activate.sh /opt/modep-grid/builds/<build-id>

Review build.sh prerequisites and the existing service environment first.
Activation retains the existing modep service user and inherited data paths.
The script requires both MODEP UI and host services and supports rollback
through the matching rollback.sh script. When replacing an existing custom
build, retain its drop-ins as well as its build directory: the generic
rollback.sh restores packaged MODEP, rather than the previous custom build.

Updates
-------

/apt/check retains the installed package version and Blokas latest-version
check, and adds custom_build and upgrade_allowed fields. Stock UI startup
still checks automatically and announces a differing official version.

Official package updates do not carry this custom Grid source. By default,
/apt/upgrade returns HTTP 409 before touching the update marker or service;
the UI explains that the fork should be rebuilt. Update Grid by updating
this branch, making a new build and activating that build. The previous
build is retained for rollback.

MOD_GRID_ALLOW_PACKAGE_UPGRADE=1 explicitly enables the original MODEP
package-update handler. Use it only when intentionally accepting that an
official package update can replace the custom installation. The notifier
compares official MODEP package versions; it does not discover newer Git
commits of this fork.

Validation
----------

Linux/WSL native utilities compiled successfully. The checked-in suite has
75 passing JavaScript tests, 101 passing default Python tests and two passing
native Lilv fixture tests run separately. A subprocess test verifies real
port-group metadata and existing PatchStorage identities with the rebuilt
library. Stock constructor/store regressions and HTTP tests cover both
layouts, local assets, OAuth popup pages, .tapf, current-board/snapshot APIs,
installer metadata, snapshot persistence and the official-upgrade guard.

The additional raw-bank regression passes with the 12-test MODEP integration
suite. It checks both URL forms and verifies that reading membership retains
unscanned entries without rewriting banks.json.

Raspberry deployment, 2026-10-03
-------------------------------

Code revision b588f468d5ad3bbeac5b9383ae3400c13a1b078a was activated on
the Raspberry Pi 4/Pisound at 192.168.1.20, using the ARM64 build directory
/opt/modep-grid-a4de41a6. The initial build was compiled on the device;
the subsequent Python-only raw-bank fix was exported from the committed
checkout into that build and its build.json revision updated. Native
utilities, mod-host and dependency installation were unchanged by that fix.
Hylia/Ableton Link remains compiled into mod-host.

Both UI and host services use the new build. JACK retained its original
process; browsepy, MIDI services and the Pisound button service remain
active. Native metadata checks found all 18 installed plugins and the same
13 Patchstorage identities. Hash checks confirmed unchanged pedalboards,
plugins and user files; API comparisons confirmed unchanged pedalboard and
snapshot lists. banks.json and the TONE3000 client configuration also match
the pre-deployment backup. Two pedalboards already marked broken retained
that status.

Real Chromium sessions opened both stock and Grid stores, fetched the ARM64
Patchstorage catalog with platform 8046 and target 8280, and reported no
JavaScript errors or failed HTTP requests. Grid displayed 361 plugin cards.
The file manager, raw-bank endpoint and official version check returned
successfully. The official updater reports custom_build=true and
upgrade_allowed=false.

The previous build remains at /opt/mod-grid-ec86b834. Its service drop-ins
and a complete /var/modep archive are retained in the root-only directory
/opt/modep-grid-backup-a4de41a6. Restore the previous custom build with::

    sudo bash /opt/modep-grid-backup-a4de41a6/rollback.sh

The data archive is a separate recovery copy; routine rollback only restores
the service selection. Physical audio listening, latency, xruns, MIDI/button
operation and plugin downloads/installations were not exercised by this
deployment smoke check.

Blokas-based host deployment, 2026-10-03
--------------------------------------

The Raspberry now runs UI revision e3224081a519c8d0ff40bcaf04ea919396e72287
and host revision 17032c376662b5889967b58846c2bffecfed7755, compiled natively
into /opt/modep-grid-e3224081. The build fetched the host from the published
fork and verified its pinned source tree; Hylia remains enabled. Both MODEP
services use this build without automatic restarts.

Post-activation checks found all seven related services active, the original
JACK process still running, unchanged pedalboard/snapshot/bank API data,
and matching hashes for pedalboards, plugins and user files. banks.json and
the TONE3000 configuration match the backup. Native scanning still finds
18 plugins and 13 Patchstorage identities. Stock and Grid store browser
checks reported no JavaScript errors or failed requests; Grid displayed
361 catalog cards. File-manager and official-version-check endpoints returned
HTTP 200, and the service journal contained no error-priority entries in the
activation check window. Physical audio and hardware interaction remain
outside these smoke checks.

The previous custom build remains at /opt/modep-grid-a4de41a6. Its service
drop-ins, a complete data archive and the validation record are retained in
/opt/modep-grid-backup-e3224081. Restore that build with::

    sudo bash /opt/modep-grid-backup-e3224081/rollback.sh
