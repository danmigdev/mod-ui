Raspberry Pi 4 and Pisound integration
=====================================

Target: Raspberry Pi 4, Pisound, and Patchbox OS with a 64-bit userspace.
The Grid theme remains the UI, MOD Audio provides the current shared
mod-ui baseline, and selected MODEP changes provide Raspberry deployment
and Patchstorage compatibility. The source decisions are recorded in
``upstream-branch-audit.rst``.

This deployment runs one mod-ui and one mod-host on the existing JACK
server. Independent guitar/microphone chain libraries, coordinated master
presets, and topology-changing spillover remain the separate design in
``dual-chain-presets.rst``; they are not implemented by these scripts.

What the integration preserves
-----------------------------

The Grid canvas, explicit audio routing, plugin skin and generic parameter
panel, plugin presets, pedalboard snapshots, banks, MIDI management,
transport, file management, and Tone3000 workflow remain available.
Plugins with port-group metadata receive ordered headings in the generic
panel; plugins without it retain a flat control list.

Deployment keeps the installed MODEP service relationships and runtime
identity. JACK, its Pisound configuration, the MIDI merger/broadcaster,
the browsepy file service, and Pisound button scripts remain managed by
Patchbox/MODEP. The scripts change only named mod-ui/mod-host systemd
drop-ins and retain the apt-installed programs for rollback.

Plugin downloads use Patchstorage. An official MOD device identity,
cloud token, or commercial MOD store entitlement is not configured by
this integration. Availability on Patchstorage does not establish
commercial license rights; each plugin retains its own license. Existing
compatible local LV2 bundles remain usable.

Check the installed baseline
----------------------------

Enable and verify the MODEP module through the installed Patchbox
configuration before replacing its UI/host executables. Inspect the
machine and actual service definitions::

    uname -m
    getconf LONG_BIT
    dpkg --print-architecture
    python3 -c 'import struct; print(struct.calcsize("P") * 8)'
    systemctl cat modep-mod-ui.service modep-mod-host.service
    systemctl status jack.service modep-mod-ui.service modep-mod-host.service

A 64-bit Raspberry userspace normally reports ``aarch64``, ``64``, and
``arm64`` respectively. Kernel architecture alone is insufficient: the
plugin binary must match the running host's userspace ABI.

The reviewed official MODEP package source uses these defaults:

.. list-table:: Existing MODEP runtime
   :header-rows: 1
   :widths: 35 65

   * - Setting
     - Packaged value
   * - UI unit
     - ``modep-mod-ui.service``
   * - Host unit
     - ``modep-mod-host.service``
   * - UI and host user/group
     - ``modep:modep``
   * - UI startup
     - ``/usr/bin/authbind /usr/bin/mod-ui`` on port 80
   * - Host startup
     - ``/usr/bin/mod-host -p 5555 -f 5556``; ``Type=forking``
   * - JACK dependency
     - Host uses ``After=jack.service`` and ``BindsTo=jack.service``
   * - LV2 search path
     - ``/var/modep/lv2:/var/modep/lv2-presets``
   * - Installed plugin directory
     - ``/var/modep/lv2``
   * - Writable preset directory
     - ``/var/modep/lv2-presets``
   * - Pedalboards
     - ``/var/modep/pedalboards``
   * - User files and models
     - ``/var/modep/user-files``
   * - Data directory
     - ``/var/modep``
   * - Shared JACK access
     - ``JACK_PROMISCUOUS_SERVER=jack``
   * - Real-time limits
     - ``LimitRTPRIO=95`` and ``LimitMEMLOCK=infinity``

The UI requires the host and ``modep-browsepy.service`` and wants
``modep-mod-midi-merger.service``,
``modep-mod-midi-broadcaster.service``, and ``pisound-btn.service``.
The reviewed units define environment variables inline; locally installed
drop-ins may add or change them, so inspect ``systemctl cat`` first.

Pisound's controller scripts use ``http://localhost:80/`` and expect
``GET /pedalboard/current`` to return the raw current pedalboard path.
Keeping port 80, authbind, and this endpoint preserves that workflow.
The current snapshot endpoint similarly returns its name as text.

Back up data before activation
------------------------------

Record the active units and make a data backup before switching builds.
For a consistent backup, stop the UI briefly while copying its data::

    backup_dir="/var/backups/mod-grid-$(date +%Y%m%d-%H%M%S)"
    sudo install -d -m 0700 "$backup_dir"
    systemctl cat modep-mod-ui.service modep-mod-host.service | sudo tee "$backup_dir/services.txt" >/dev/null
    sudo systemctl stop modep-mod-ui.service
    sudo tar --acls --xattrs -C /var -czf "$backup_dir/modep-data.tar.gz" modep
    sudo systemctl start modep-mod-ui.service

The deployment reuses the existing data directories. Removing the custom
drop-ins restores the packaged executables; it does not undo presets,
pedalboards, models, or plugin updates saved while the custom UI was active.
The data archive supports that separate recovery if needed.

Build beside the packaged installation
-------------------------------------

Run the build on the Raspberry, not on the Windows development machine.
Use a committed checkout of this integration branch. The builder exports
the committed UI ``HEAD`` into the output; uncommitted edits are not a
deployment source. Commit updates before creating another build.

Required tooling includes Git, GCC/G++, Make, pkg-config, Python 3 with
venv support, and development libraries for JACK, ALSA, Lilv, and readline.
Preserve Patchbox's Blokas JACK package when resolving build dependencies.
Keep Hylia development support available if the installed host uses it;
the builder fails rather than silently dropping Ableton Link support.
Activation also requires the existing MODEP authbind setup, ``runuser``,
``curl``, and loaded MODEP UI/host service units.

The UI venv uses this checkout's ``requirements.txt`` with Tornado 4's
callback API and its current Python compatibility shim. Do not substitute
an unpinned Tornado upgrade or use the older MODEP pycrypto dependency.
The UI's native ``libmod_utils.so`` is rebuilt with its matching Python
ctypes definitions; copying only Python files over an old native library
is not a supported deployment.

Choose an absolute, empty output directory outside the checkout, without
spaces or shell-special characters, readable by the ``modep`` user::

    git status --short
    git rev-parse HEAD
    sudo install -d -m 0755 -o "$(id -un)" -g "$(id -gn)" /opt/mod-grid-20261003
    ./scripts/rpi4-pisound/build.sh --output /opt/mod-grid-20261003

The default host build uses the pinned MOD base and the bundled host patch
series. To use a separately prepared local checkout of that same reviewed
host integration instead::

    ./scripts/rpi4-pisound/build.sh --output /opt/mod-grid-custom-host --mod-host /absolute/path/to/mod-host

The alternate output directory must also be absolute and empty. The local
host source must be committed and its Git tree must match the reviewed
integration recorded in ``scripts/rpi4-pisound/stack.json``; this option
does not accept an arbitrary upstream or experimental host. The result
contains::

    /absolute/build/
        mod-ui/
        mod-host/
        venv/
        build.json
        integration.env

``build.json`` records source pins, architecture, and checked build
capabilities. ``integration.env`` contains the generated catalog settings.
On the target Raspberry, the Patchstorage platform is ``8046`` and the
AArch64 target is ``8280``. The MOD-prefixed values take precedence over
inherited MODEP catalog variables. Do not select an ARMHF download for
the 64-bit host.

``scripts/rpi4-pisound/integration.env.example`` documents the supported
settings and inherited MODEP paths. It is a reference, not a file loaded
automatically. If local catalog overrides are required, edit the generated
build's ``integration.env`` using systemd EnvironmentFile syntax: plain
``NAME=value`` assignments, without ``export`` or shell expansion.

Activate and roll back
----------------------

Inspect the proposed service overrides before switching::

    sudo ./scripts/rpi4-pisound/activate.sh --dry-run /opt/mod-grid-20261003
    sudo ./scripts/rpi4-pisound/activate.sh /opt/mod-grid-20261003

Activation selects the built host executable with the existing command
and feedback ports, and runs the built UI through authbind and its venv.
It supplies the selected build's ``PYTHONPATH``, ``MOD_HTML_DIR``, and
``MOD_DEFAULT_PEDALBOARD`` and uses ``MOD_DEV_ENVIRONMENT=0``,
``MOD_DEV_HMI=1``, ``MOD_DEV_HOST=0``, and UI port 80. This uses the dummy
MOD HMI while retaining the real mod-host and Pisound/MIDI controllers.
The normal packaged data paths and service dependencies are inherited.

The only integration drop-ins are::

    /etc/systemd/system/modep-mod-ui.service.d/80-grid-integration.conf
    /etc/systemd/system/modep-mod-host.service.d/80-grid-integration.conf

Check startup and open the Grid UI::

    systemctl status modep-mod-host.service modep-mod-ui.service
    journalctl -u modep-mod-host.service -u modep-mod-ui.service -n 100 --no-pager

Browse to ``http://<raspberry-address>/grid.html``. Confirm the previous
pedalboards, models, presets, MIDI devices, and bank contents before
saving changes. Verify Pisound's external pedalboard controls update the
Grid browser state.

Rollback removes only the two named integration drop-ins, reloads systemd,
and returns the services to their remaining packaged/local definitions::

    sudo ./scripts/rpi4-pisound/rollback.sh --dry-run
    sudo ./scripts/rpi4-pisound/rollback.sh

The build directory and shared user data remain available. Inspect the
resulting ``systemctl cat`` output and service status after rollback.

For an update, create the new build first, then roll back the active
integration drop-ins before activating the replacement. Activation refuses
to overwrite existing integration drop-ins. If activation fails its service
or HTTP health checks, it restores the remaining MODEP service commands.

Audio validation on the Pi
-------------------------

The scripts do not change JACK's sample rate, buffer size, period count,
or Pisound configuration. Use the Patchbox audio settings for those
choices. Start testing with 256 frames per period, then benchmark 128
frames with the actual plugin chains if the first configuration is stable.
These are test points, not latency or CPU guarantees.

Measure JACK xruns and CPU load, total input-to-output latency, and
peak load while loading/restoring plugins. Exercise model changes,
MIDI mappings, preset/snapshot recall, browser reconnection, and Pisound
buttons. Recheck the maximum plugin load at the intended sample rate
and buffer size. A successful build does not establish real-time safety
for a particular chain.

Validation boundaries
---------------------

Automated frontend regressions exercise Grid parameter groups, flat
metadata fallback, control writes and external synchronization, model
file refresh, Tone3000, MIDI, and transport. Backend tests exercise the
Grid template bootstrap, MODEP-compatible current-state APIs,
architecture selection, Patchstorage metadata, and plugin installation.
These tests use simulated host/services where described in the test suite.

Actual Raspberry Pi 4/Pisound startup, audio latency, xruns, resource
headroom, and physical MIDI/button behavior require validation on the
device. Independent-chain spillover and master recall remain unimplemented
runtime features; the existing interactive mockups simulate their behavior.

Official package sources
------------------------

The deployment defaults above were checked against
``BlokasLabs/modep-debs`` commit
``24ab2e4f67c14ebd913e799a25afc190300ede50``:

* `UI service <https://github.com/BlokasLabs/modep-debs/blob/24ab2e4f67c14ebd913e799a25afc190300ede50/modep-mod-ui/modep-mod-ui-1.13.0/debian/modep-mod-ui.service>`_
* `Host service <https://github.com/BlokasLabs/modep-debs/blob/24ab2e4f67c14ebd913e799a25afc190300ede50/modep-mod-host/modep-mod-host-1.13.0/debian/modep-mod-host.service>`_
* `Service user setup <https://github.com/BlokasLabs/modep-debs/blob/24ab2e4f67c14ebd913e799a25afc190300ede50/modep-common/modep-common-1.1.0/debian/postinst>`_
* `Data and authbind permissions <https://github.com/BlokasLabs/modep-debs/blob/24ab2e4f67c14ebd913e799a25afc190300ede50/modep-mod-ui/modep-mod-ui-1.13.0/debian/postinst>`_
* `Python package dependencies <https://github.com/BlokasLabs/modep-debs/blob/24ab2e4f67c14ebd913e799a25afc190300ede50/modep-mod-ui/modep-mod-ui-1.13.0/debian/control>`_
* `Pisound MODEP controller <https://github.com/BlokasLabs/modep-btn-scripts/blob/48d515c074b59afd0db0a36710ea7352f79f92d2/modep-ctrl.py>`_
