mod-ui
======

This is the UI for the MOD software. It's a webserver that delivers an HTML5 interface and communicates with mod-host.
It also communicates with the MOD hardware, but does not depend on it to run.

Install
-------

There are instructions for installing in a 64-bit Debian based Linux environment.
It will work in x86, other Linux distributions and Mac, but you might need to adjust the instructions.

The following packages will be required::

    $ sudo apt-get install virtualenv python3-pip python3-dev git build-essential libasound2-dev libjack-jackd2-dev liblilv-dev libjpeg-dev zlib1g-dev

NOTE: libjack-jackd2-dev can be replaced by libjack-dev if you are using JACK1; libjpeg-dev is needed for python-pillow, at least on my system.

Start by cloning the repository::

    $ git clone git://github.com/moddevices/mod-ui
    $ cd mod-ui

Create a python virtualenv::

    $ virtualenv modui-env
    $ source modui-env/bin/activate

Install python requirements::

    $ pip3 install -r requirements.txt

Compile libmod_utils::

    $ make -C utils

Run
---

Before running the server, you need to activate your virtualenv
(if you have just done that during installation, you can skip this step, but you'll need to do this again when you open a new shell)::

    $ source modui-env/bin/activate

mod-ui depends on mod-host and the JACK server running in order to make sound. So after you have JACK setup and running, in another terminal do::

    $ mod-host -n -p 5555 -f 5556

If you do not have mod-host, you can tell mod-ui to fake the connection to the audio backend.
You will not get any audio, but you will be able to load plugins, make connections, save pedalboards and all that. For this, run::

    $ export MOD_DEV_HOST=1

And now you are ready to start the webserver::

    $ export MOD_DEV_ENVIRONMENT=0
    $ python3 ./server.py

Setting the environment variables is needed when developing on a PC.
Open your browser and point to http://localhost:8888/.

Themes
------

mod-ui ships two independent front-end themes, both served by the same backend:

- **Default** (``/`` or ``/index.html``): the original free-canvas pedalboard editor, with each
  plugin drawn at its own custom skin size and connected with hand-dragged cables.
- **Grid** (``/grid.html``): a newer, Fractal Audio FM3-Edit-style editor, with plugins as
  uniform blocks in a configurable row/column grid, a single auto-wired signal chain, and
  parameters edited in a bottom panel (real plugin skin on one side, a generic control list on
  the other). Still missing some of the default theme's features (bank/preset cloud sharing,
  control-chain device management, tuner).

Each theme has a link to switch to the other: the grid icon in the default theme's top menu bar,
and "Classic UI" under Settings in the grid theme.

Installing this branch on a device
----------------------------------

This branch is a superset of ``master``: the grid theme, the TONE3000 integration, the grid
file-manager backend and some small backend fixes, on top of everything ``master`` has.

**From source / your own image.** Check out ``grid-theme`` and follow *Install* and *Run*
above (or build your device image from it). You get everything, nothing else to do. This is
the clean path.

**On a device that runs mod-ui as a distro package** (Blokas' ``modep-mod-ui``, sealed MOD
images) the source tree can't be swapped. ``scripts/deploy-tone3000/`` patches an installed
mod-ui in place — from a checkout of this branch, on a machine that can SSH to the device::

    $ scripts/deploy-tone3000/deploy.sh --host user@device --key t3k_pub_xxxxxxxx

That one run installs:

- the **grid theme** — ``grid.html``, every ``grid-*.js`` / ``grid-*.css`` (they are plain
  static assets this branch owns), plus the ``grid()`` template route in ``webserver.py``
  so ``/grid.html`` renders;
- the **grid file manager** backend — the ``/filesvc`` proxy and ``/filesvc-stat`` handlers
  ``html/js/grid-file-manager.js`` needs (never committed upstream);
- the **TONE3000** integration in both themes — see the section below for the key.

Every file it changes is backed up to ``<file>.pre-tone3000``; it syntax-checks the Python,
HTTP-checks the restarted service, and rolls everything back if the service does not come up.
``deploy.sh --host user@device --rollback`` undoes it. See
``scripts/deploy-tone3000/README.md`` for the details, ``--dry-run``, and running it directly
on the device.

Not covered by the script: a few independent ``webserver.py`` bug-fixes this branch also
carries (snapshot/bank save guards, ``poweroff``) and ``polkit/49-mod-ui-power.rules`` (so
Power Off / Reboot work headless — ``setup.py`` installs it on a source build). Port those
from ``git diff master...grid-theme`` if you want them, or run from source.

TONE3000
--------

The **Tone3000** entry in the top menu lets the user browse the TONE3000 catalog and download
a capture straight into the Neural Amp Modeler. The tone is signed for on TONE3000 in a popup
(OAuth PKCE), each ``.nam`` model is saved under *NAM Models* in the File Manager, and the new
files jump to the top of every NAM plugin's model list. The NAM LV2 plugin itself is not
involved and needs no change.

**Setup (once per deployment).** The publishable key is deployment configuration and is never
committed, so it has to be supplied where mod-ui runs:

1. Sign in at tone3000.com -> **Settings -> API Keys -> Create API Key** and copy the
   ``t3k_pub_...`` publishable key.
2. Leave that key's **allowed redirect URIs empty**. Per TONE3000's docs only registered
   redirect URIs are enforced, so with none registered the feature works on any device address
   with no per-device configuration; the PKCE verifier and the ``state`` check are what protect
   the flow. (Register specific URIs only to lock it down, and expect to update them whenever an
   address changes -- e.g. DHCP on the device.)
3. Give the key to mod-ui, either way:

   - environment: ``MOD_TONE3000_CLIENT_ID=t3k_pub_...`` (for a systemd service, a drop-in
     such as ``/etc/systemd/system/<unit>.d/tone3000.conf`` with ``[Service]`` +
     ``Environment=MOD_TONE3000_CLIENT_ID=...``);
   - or a file: write the key into ``<data dir>/tone3000-client-id`` (the path
     ``MOD_TONE3000_CLIENT_ID_FILE`` overrides). This survives package upgrades and needs no
     unit edit.

   ``MOD_TONE3000_API`` overrides the API base (default ``https://www.tone3000.com``).

Without a key the Tone3000 tab shows a "not set up on this deployment" note instead of the
browse button.

**For the end user** there is nothing to configure: open mod-ui, click **Tone3000**, click
**Open TONE3000**, sign in once, pick a tone.

Test
----

The test suite in ``test/`` contains HTTP-level characterization tests (pytest + tornado's testing tools).
They run against a faked audio backend, so no JACK, mod-host or MOD hardware is needed.

First complete the Install section above (virtualenv, python requirements and ``make -C utils`` — the tests
import the webserver, which requires ``utils/libmod_utils.so``).

On Python 3.10 or newer, the pinned tornado 4.3 needs a one-time patch (see the note in ``requirements.txt``)::

    $ sed -i 's/collections.MutableMapping/collections.abc.MutableMapping/' modui-env/lib/python3.*/site-packages/tornado/httputil.py

Install the test requirements and run the suite from the repository root::

    $ source modui-env/bin/activate
    $ pip3 install -r test-requirements.txt
    $ pytest

NOTE: ``test/hmi-protocol-integrationtest.py`` is not part of this suite — it is a standalone integration
test for the HMI serial protocol that requires JACK, mod-host and a serial device, and pytest does not
collect it.
