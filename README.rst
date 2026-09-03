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

TONE3000
--------

The **Tone3000** entry in the top menu lets the user browse the TONE3000 catalog and download
a capture straight into the Neural Amp Modeler. The tone is signed for on TONE3000 in a popup
(OAuth PKCE), each ``.nam`` model is saved under *NAM Models* in the File Manager, and the new
files jump to the top of every NAM plugin's model list. The NAM LV2 plugin itself is not
involved and needs no change.

**One-time setup, for whoever publishes the build** (it cannot be scripted -- it needs a human
TONE3000 login):

1. Sign in at tone3000.com -> **Settings -> API Keys -> Create API Key** and copy the
   ``t3k_pub_...`` publishable key. It is a public value, safe to embed.
2. Leave that key's **allowed redirect URIs empty**. Per TONE3000's docs only registered
   redirect URIs are enforced, so with none registered the feature works on any device address
   with no per-device configuration; the PKCE verifier and the ``state`` check are what protect
   the flow. (Register specific URIs only to lock it down, and expect to update them whenever an
   address changes -- e.g. DHCP on the device.)
3. Put the key in the build: set it as the default of ``TONE3000_CLIENT_ID`` in
   ``mod/settings.py`` (replace ``t3k_pub_REPLACE_ME``). Until you do, the Tone3000 tab shows a
   "not set up in this build" note instead of the browse button.

``MOD_TONE3000_CLIENT_ID`` overrides the built-in default at runtime (rebranded build, or local
development), and ``MOD_TONE3000_API`` overrides the API base (default
``https://www.tone3000.com``).

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
