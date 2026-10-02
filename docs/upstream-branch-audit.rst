Upstream branch audit for Raspberry Pi 4 and Pisound
===================================================

Report date: 2026-10-03.

Target: Raspberry Pi 4 with Pisound, Patchbox OS 64-bit, mod-ui/mod-host,
and the existing Grid theme. English is required for project code,
documentation, commit messages, and GitHub content.

This document records a mod-ui source-selection audit. It does not claim
that every source feature is implemented or that hardware performance has
been measured. The mod-host review and native Raspberry deployment results
are recorded separately in ``rpi4-pisound-integration.rst``.

Sources and review method
-------------------------

* MOD Audio mod-ui: https://github.com/mod-audio/mod-ui
  (the existing origin remote uses the equivalent moddevices repository URL).
  Reviewed master: eebb9c73e04aaa4d212ab0a2fce2064b2166c253.
* Blokas MODEP mod-ui: https://github.com/BlokasLabs/mod-ui
  Reviewed stable source: 65843c5cc4a1959063b9c96c3897b66ad7003427
  on modep-1.13-ps.
* Existing project theme: https://github.com/danmigdev/mod-ui/tree/grid-theme.
  The integration branch starts from the local Grid and dual-chain design
  work, rather than replacing that theme with an upstream layout.

The fetched remote inventory contains 57 MOD Audio branches and 28 MODEP
branches. The symbolic origin HEAD is excluded. The inventories below pin
the exact head commits observed during this review; later upstream changes
require a new audit.

Review used branch ancestry, unique-commit logs, merge-base diffs, and direct
inspection of selected fixes and their current equivalents. A unique commit
hash does not prove that a feature is absent: historical maintenance and
MODEP branches often contain the same change under different hashes.
The classifications distinguish whole-branch selection from adaptation
of specific behavior.

Accepted source changes
-----------------------

Latest MOD Audio master (M0/M1)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Master contains 41 commits beyond the previously used MOD master
0467c103d6dab0da18fe4d1762de164ced57f0b6. Its useful changes include:

* Plugin port groups, ordered by declared index, including controls without
  group metadata. Sources: 46d6fe8e, 9d272b11, b8c0e1e4.
* File-picker navigation through folders containing only subfolders:
  cf856bf8cdc07cbe59030cf6b5fb32472498ef30.
* Correct atom:String value-field scope: 94e532e0.
* Ignore a late patch_set after its plugin instance has been removed:
  0d226ca4dee60755a7f6bf2892eafaef2fe214eb.
* Report snapshot request failures, resolve failed installation callbacks,
  abort the actual transfer request, and avoid invalid logarithmic control
  mapping: 6f751f8e2aefa248bd966c15de0403754548666d.
* Correct USB audio port direction labels:
  7f7eb8eb238315f798d8b6a1ac89d6f0e38799b7.
* Declare the plugin render callback element:
  08c97a2d9b4ec31bb01593333bb70887cd4cb73e.
* Updated Tone3000 integration and file types, including EasySpin programs.

The Grid layout, explicit audio routing, parameter panel, preset and bank
management, file management, MIDI controls, transport, and existing
Tone3000 flow remain project requirements. Shared frontend changes require
regression checks against these behaviors.

The native port-group metadata and Python ctypes structures now contain
matching uri, symbol, name, and index fields. The Grid generic parameter
panel can use ordered headings while retaining a flat list for plugins
without metadata. Unknown group references remain visible as ungrouped
controls.

MODEP stable adaptations (A0)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Use selected behavior from modep-1.13-ps rather than merging the entire
older UI and backend:

* Configurable writable preset directory via MOD_PRESETS_DIR:
  be21725e; mod/settings.py and mod/host.py.
* Patchstorage item/revision metadata attached to installed LV2 bundles:
  79245920 and b7e39e6a; mod/webserver.py, modtools/utils.py,
  utils/patchstorage.cpp, utils/patchstorage.h, utils/utils.h,
  and utils/utils_lilv.cpp.
* Patchstorage target filtering and stable catalog integration:
  4b2d27ad, 6be643e0, and d6e4ae61; configuration, templates,
  and the existing Grid store adapter.
* Current pedalboard API: 884ac7ed; mod/webserver.py.
* Current snapshot API: cd09369c2ee33e49d08d0e6b126bab7b2cbf41e8.
  Adapt this as a normal synchronous JSON handler, rather than copying
  asynchronous decorators around a handler with no asynchronous work.
* Reset browser connection state when pedalboards change externally:
  18c14a67ad9914de59f589c5c0eecfe540240660; mod/session.py and
  the existing Grid websocket handling.

MODEP adaptation constraints
~~~~~~~~~~~~~~~~~~~~~~~~~~~

* Preserve an explicit PATCHSTORAGE_TARGET_ID. The reviewed automatic
  target-selection code overwrites an explicit target with 5037 in its
  else branch. Distinguish ARMHF and AArch64 using the running process
  architecture; a 64-bit OS does not make an ARMHF plugin loadable by a
  64-bit mod-host.
* Keep Python ctypes and the rebuilt libmod_utils.so together. Adding
  native metadata fields changes the structure layout; using the older
  installed MODEP binary with new Python definitions is incompatible.
* Preserve Patchbox data locations for plugins, pedalboards, user files,
  and presets. Do not restore the historical server.py override that
  forces a development data directory.
* Do not copy the older MODEP APT update handlers. Their blocking sleep
  and polling loops depend on modep-update.service and could overwrite
  the custom installation.
* Do not replace Grid with MODEP index.html or copy device/CV tab hiding
  into Grid's MIDI controls.
* The default-pedalboard change 4e351352 only changes the older Desktop
  UI. Verify the equivalent Grid flow before applying it.

Disposition rationale
---------------------

M0
  Selected current MOD Audio master as the shared code baseline.

M1
  Included through current MOD Audio master. Separate feature/fix branch
  merges would duplicate the accepted changes.

A0
  Selected MODEP stable source for targeted Raspberry/Patchstorage
  adaptations; its complete older layout and backend are not selected.

S0
  Already incorporated in the existing project: characterization tests,
  Tone3000 integration, and frontend tests. Preserve project fixes.

S1
  Superseded port-group UI branch. Current MOD master supplies these
  features and their fixes; remaining PKCE/file-refresh differences in
  feat/port-groups-ui are already present in the project.

S2
  Older MODEP release/UI branch superseded as an integration baseline by
  modep-1.13-ps and current MOD master. Its historical UI restrictions,
  update machinery, and older common code are not merged wholesale.

W0
  Superseded MODEP work-in-progress branch. WIP2's 14 distinct commit
  hashes correspond to metadata, target, catalog, and preset-directory
  changes represented in stable modep-1.13-ps.

J0
  Superseded JACK alias fix. Current MOD master already uses a correctly
  oriented aliases[2][320] buffer, including the older fix's intent.

T0
  Superseded tempo-sync prototype. Current host transport/Ableton Link
  and Grid transport controls provide the newer integration.

R0
  Historical MOD maintenance/release line; no whole-branch merge.
  Representative active-snapshot deletion, snapshot parameter capture,
  plugin removal guard, and JACK alias fixes were verified in current
  master. The divergent MOD hardware/store implementation is not a
  Raspberry/Pisound baseline. This does not assert that every historical
  commit is identical to master.

D0
  Excluded desktop product UI. Hardware-exclusive feature/store CTA
  changes do not improve the Patchbox/Pisound runtime.

H0
  Excluded device-specific or experimental Control Chain/HMI/CV/system
  plugin work. no-cc-map-limit removes Control Chain message limits;
  it does not expand ordinary MIDI CC switch assignments.

C0
  Excluded MOD cloud, store licensing, labs, social, or browser audio
  streaming implementation. The target uses local audio and Patchstorage;
  MOD device-cloud entitlement is a separate service.

L0
  Excluded older layout/search customization. Replacing the Grid layout
  or its search behavior would conflict with the preserved theme.

X0
  Excluded historical debug branch; debug instrumentation is not a
  stable feature source.

X1
  Excluded external-ui work in progress: native window UI is unsuitable
  for the headless target, and the reviewed metadata code has inverted
  strcmp tests for idle/show interface URIs.

X2
  Deferred old utility/UI prototypes and lint-only work. json2pb is a
  standalone conversion utility; pedalboard_filter and stompbox-mode
  are historical UI experiments outside this integration's requirements.
  Existing native pedalboard/preset workflows remain the baseline.

X3
  Excluded experimental drag-over plugin replacement. Its connection
  migration only considers the first new input/output and would require
  redesign to preserve Grid's explicit multiport routing behavior.

X4
  Excluded old port-group backend prototype. Its C PluginPortGroup
  includes uri while its Python ctypes definition omits it; its group
  name read also assigns to symbol. Current master's matching ABI and
  corrected metadata supersede it.

Pinned branch inventories
-------------------------

.. csv-table:: MOD Audio mod-ui
   :header: "Branch", "Head commit", "Committer date", "Disposition"
   :widths: 30, 42, 14, 14

   "aiortc", "f1b04fbc5a0461ed639ca1a43e7fdda104c3afab", "2021-11-22", "C0"
   "channel-switch", "2d99edb61dc10479a29a962beae6fb25a5a29639", "2026-09-11", "M1"
   "characterization-tests", "37b07d5c43faf08b7503daabe048b1eb8787c5db", "2026-07-09", "S0"
   "ctrl-outputs-hmi", "cbf4feedff8e37b43563fedb1c7fa9bcdadc468c", "2017-07-03", "H0"
   "debug", "42f97f24142063a6cf18c2e53c3a80149bb88fe9", "2016-09-15", "X0"
   "desktop-app-upsell", "4469bf272c1cd73f46845dcc875ce14f73511538", "2026-08-13", "D0"
   "external-ui", "9e67eb4aab39e9d63ca8fe7c33bb52fc404987c8", "2022-06-18", "X1"
   "feat/port-groups-ui", "add83ec0748f3210427ca0eed93d84080e2f898f", "2026-08-27", "S1"
   "fix/file-picker-nested-folders", "cf856bf8cdc07cbe59030cf6b5fb32472498ef30", "2026-09-21", "M1"
   "fix/no-matomo-on-device", "f8bbcd80265e91870f92c339925679670bdc8ff1", "2026-09-16", "M1"
   "fix/patch-set-missing-instance", "0d226ca4dee60755a7f6bf2892eafaef2fe214eb", "2026-09-15", "M1"
   "fix/pedalboard-undeclared-element", "08c97a2d9b4ec31bb01593333bb70887cd4cb73e", "2026-09-21", "M1"
   "fix/reversa-findings", "6f751f8e2aefa248bd966c15de0403754548666d", "2026-09-12", "M1"
   "fix/ungrouped-knob-indicator", "22efb74df1df9491430e10843aa96b1f62e90b8b", "2026-09-16", "M1"
   "fix/usb-audio-port-labels", "7f7eb8eb238315f798d8b6a1ac89d6f0e38799b7", "2026-09-29", "M1"
   "hotfix-1.0", "cad539d96d5081e98d47bce94ec4a39867396561", "2016-08-29", "R0"
   "hotfix-1.1", "f92220df69be35fa55f22013e2a68f616f075654", "2016-11-07", "R0"
   "hotfix-1.10-filehandling", "463625a1e5cb69d13cddbdba354d47983f09fa46", "2021-09-27", "R0"
   "hotfix-1.11", "02b403cdd70da19f7247a1c41de8704156cbc5fe", "2022-07-05", "R0"
   "hotfix-1.12", "4fb2f82f236d6b56316c9c19e92adad1d88ded03", "2023-01-17", "R0"
   "hotfix-1.13", "204b3fce3c1bcee870cd919849d06b64d3e6087b", "2024-11-07", "R0"
   "hotfix-1.14", "7764e1ffd13912af93501a982f2b7767a97066ab", "2026-09-29", "R0"
   "hotfix-1.2", "514fa0af56aa3cc28f685824189859d3525391f8", "2017-01-19", "R0"
   "hotfix-1.3", "6e4810f5ab2a9984d13c98700bec04334f64637b", "2017-03-29", "R0"
   "hotfix-1.4", "1e473882a4766db4cda3c67e6700bb3a5e506cad", "2017-08-03", "R0"
   "hotfix-1.6", "de749084489aa3465169d9e627b83de0aad9c37f", "2019-07-05", "R0"
   "hotfix-1.7", "12aa0eb9276a02303a5faea02aece92f8d9152d8", "2019-09-20", "R0"
   "hotfix-1.8", "0606f7416567df81622c3e4b5c2419036e790f9e", "2020-02-06", "R0"
   "hotfix-1.9", "41240430b2936f83eee7c4332cb2422cc77137a9", "2020-09-11", "R0"
   "hygiene-py34-png", "319080a44fe13e32cec9ac367a8498df33924810", "2026-09-11", "M1"
   "json2pb", "ac21543aa5e04592c79fa6459faf10245d015612", "2022-12-07", "X2"
   "labs-dashboard", "09f881c4a8478a796e567ea01ae927bbd88eef85", "2020-07-18", "C0"
   "main-menu-at-top", "b716dfcfa4743d2aadaded470ea75edae10d5cce", "2017-12-29", "L0"
   "master", "eebb9c73e04aaa4d212ab0a2fce2064b2166c253", "2026-09-29", "M0"
   "new-control-chain", "a2732bd8ffb16b04dea25a1c53403c979c3fb3ad", "2014-07-01", "H0"
   "new-control-chain-chain", "3fb1b5672bd16a856aa0937e899bd9868bff9cc9", "2014-08-27", "H0"
   "new-social", "dc12f43b2183cde69ee4dc9f2cca7e217ca6cc8b", "2015-04-30", "C0"
   "no-cc-map-limit", "9ef046ad177d8d680af4a027368ac1922929aa7b", "2020-05-22", "H0"
   "no_hmi_controlchain", "70ebf86395291f097794d4e2f76dbe4c324214db", "2015-04-11", "H0"
   "pedalboard_filter", "c5ce0bbd67b48cf4874a51c609b70541d50f48fd", "2013-09-10", "X2"
   "plugin-replacement", "b64b479aec79295542537ee83ff56c1b8c6861f6", "2017-10-23", "X3"
   "plugin-store", "92ec3f0a85afe30d2f8e76e7ec061efea9a673d0", "2026-09-16", "C0"
   "plugin-store-labs", "bb7a07553ea9a1e976b7d81a26ea82e92d64406d", "2023-07-08", "C0"
   "plugindatabase", "5a62e17198c7e5ea02f736fafda7ff037b1852b3", "2018-05-31", "C0"
   "port-groups-1.14", "b8c0e1e4d3a22bbfab1f9a88580460dccec52946", "2026-09-11", "S1"
   "pylint", "34f76cafe9fe5c9b34eba7ae9111942034dcf30d", "2020-07-30", "X2"
   "release-0.15", "d01b9a6cef647f31e3aab479ee62202e3ba891f4", "2016-06-24", "R0"
   "report-problem", "6d76d919e5720b55e7ffa1f8f0c107469bea0a41", "2026-09-11", "M1"
   "search-optional", "f7feaa7e27deceb16fd958eb7356b706947d9901", "2017-06-14", "L0"
   "sejerpz-feature/port_groups_backend", "3b2e3a0f0a0c2c0e1cfc47ac732bfd51280fd92a", "2025-10-18", "X4"
   "social-detach", "a192ed5de9dee0d639d748c0e4d320e99b862040", "2014-05-30", "C0"
   "stompbox-mode", "dc63b49369dd813b58722c9f78b27d4bcef363c4", "2014-05-22", "X2"
   "system-plugins", "7302884979fb42f390ab0ad248d030316197ab2b", "2021-04-01", "H0"
   "t3k-onto-master", "432f7991830519da6f7444b042e8bb1cb579c610", "2026-09-15", "M1"
   "test-plugin-area", "7badc4c9ef130f9a149340686ab8914381f13ff7", "2022-12-19", "C0"
   "tone3000", "6291488d4a1f955fb84c0177a5721b6ec7669daf", "2026-07-10", "S0"
   "webrtc-plugin-player", "9795e360ce580bd4f142abfe8815a6dacb589e6d", "2021-03-03", "C0"

.. csv-table:: Blokas MODEP mod-ui
   :header: "Branch", "Head commit", "Committer date", "Disposition"
   :widths: 30, 42, 14, 14

   "debug", "42f97f24142063a6cf18c2e53c3a80149bb88fe9", "2016-09-15", "X0"
   "get_jack_port_alias_fix", "48232d24b4b829ca711c7a64dff93a7d3a705306", "2018-08-15", "J0"
   "hotfix-1.0", "cad539d96d5081e98d47bce94ec4a39867396561", "2016-08-29", "S2"
   "hotfix-1.1", "f92220df69be35fa55f22013e2a68f616f075654", "2016-11-07", "S2"
   "hotfix-1.2", "514fa0af56aa3cc28f685824189859d3525391f8", "2017-01-19", "S2"
   "hotfix-1.3", "6e4810f5ab2a9984d13c98700bec04334f64637b", "2017-03-29", "S2"
   "master", "c1b66e69dbe881b35f5f08ede9cdbb100d1e720f", "2020-01-29", "S2"
   "midi-output", "b47050cdff9df20195ef18b547f3138a3390c423", "2014-05-07", "S2"
   "modep-1.12", "976b61c4a783df1aee8708ae675cc5f7776d7b9d", "2022-09-09", "S2"
   "modep-1.12-ps", "91aab2b5051a68a3f4a0f1f847a2f341aef1e8a7", "2023-09-15", "S2"
   "modep-1.13-ps", "65843c5cc4a1959063b9c96c3897b66ad7003427", "2025-01-25", "A0"
   "modep-1.13-ps-wip", "e2b40cc265f98609bdb73e13fec88be19894761b", "2023-05-08", "W0"
   "modep-1.13-ps-wip2", "c4727f0d9936e3cb75d263f09c014df005003d67", "2023-05-11", "W0"
   "modep-1.8", "3ce5950eb13bb7a8278a598f3dea456c814bcaee", "2020-06-15", "S2"
   "modep_2018.08", "10afb5dd6870ac7eafd4202e0414dfee60204c6d", "2018-08-15", "S2"
   "new-control-chain", "a2732bd8ffb16b04dea25a1c53403c979c3fb3ad", "2014-07-01", "H0"
   "new-control-chain-chain", "3fb1b5672bd16a856aa0937e899bd9868bff9cc9", "2014-08-27", "H0"
   "new-controller", "04847fb2ffecd4e0618ae4ab5385205e53546686", "2013-08-22", "H0"
   "new-social", "dc12f43b2183cde69ee4dc9f2cca7e217ca6cc8b", "2015-04-30", "C0"
   "no_hmi_controlchain", "70ebf86395291f097794d4e2f76dbe4c324214db", "2015-04-11", "H0"
   "pedalboard_filter", "c5ce0bbd67b48cf4874a51c609b70541d50f48fd", "2013-09-10", "X2"
   "preset_manager", "24ecea27b5216eb246d8147ba01a79ce79ec2c24", "2015-07-08", "S2"
   "release-0.15", "d01b9a6cef647f31e3aab479ee62202e3ba891f4", "2016-06-24", "S2"
   "settings.html", "4e5c68cf864fb1eb1b7bcb8e8f4af5dc7b49f114", "2017-04-05", "S2"
   "social-detach", "a192ed5de9dee0d639d748c0e4d320e99b862040", "2014-05-30", "C0"
   "stompbox-mode", "dc63b49369dd813b58722c9f78b27d4bcef363c4", "2014-05-22", "X2"
   "temposync", "a97846e68bb56f3830e294c0e46f432ab0198eaf", "2017-04-03", "T0"
   "ui-update", "0477208b808de5265022d4fe7a602aa00faba4a2", "2013-08-13", "S2"
