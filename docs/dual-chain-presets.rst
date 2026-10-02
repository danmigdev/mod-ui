Independent guitar and microphone rigs
======================================

Status: implementation design for the ``dual-chain-presets`` branch. The runtime
feature described here is not implemented yet.

Interactive UI mockups are available in ``mockups/dual-chain/index.html``.
See ``mockups/dual-chain/README.rst`` for the workflow and screenshots.

Requirements
------------

The target is a Raspberry Pi 5 running mod-ui and mod-host, with one audio input
for guitar, another for microphone, and a configurable twelve-switch MIDI
controller. Neither signal chain should require a separate device or audio host.

- Each chain has its own reusable presets, including plugins, connections,
  control values, bypass, model/file parameters and opaque LV2 state.
- Recalling one chain leaves the other chain's sound and selected preset intact.
- A master preset references one guitar preset and one microphone preset; it
  does not copy either definition.
- Any controller switch can target either chain or a master. There is no fixed
  two-switch microphone allocation or ten-switch guitar allocation.
- MIDI recall continues to work with the browser closed.
- Preset changes should minimize audible discontinuity and preserve retiring
  delay/reverb tails when topology changes.
- NetJACK is excluded from the live audio path.

Hardware deployment
-------------------

The baseline runtime below uses one Raspberry Pi 5 and one audio host. An
alternative under consideration uses two Raspberry Pi 5 boards in parallel
inside one appliance, with one board dedicated to Guitar and the other to
Microphone. Both deployments retain mod-ui and mod-host.

In the parallel deployment each board runs its own JACK/mod-host engine and has
its own audio interface. The audio paths are independent::

    Guitar     -> Interface A ADC -> Pi A effects -> Interface A DAC -> Guitar output
    Microphone -> Interface B ADC -> Pi B effects -> Interface B DAC -> Microphone output

There is no audio transfer between the boards and no intermediate AD/DA stage
in either path. Use separate physical outputs, or combine them in an analogue
mixer if a common output is needed. Independent audio clocks are acceptable for
these separate paths; combining their audio digitally would require clock
synchronization or drift compensation. An ordinary USB audio interface cannot
be split between two USB hosts.

One coordinator provides the UI, preset library, master references and arbitrary
twelve-switch MIDI assignments. Ethernet carries control and state messages,
not live audio. This requires a node-aware backend extension; the current Host
connects to one local mod-host and does not provide this distributed workflow.
Each node needs local copies of its preset state assets before reporting ready.

For master recall, prepare both destinations before requesting either
transition. Control-network coordination does not guarantee sample-accurate
switching. Report partial transitions or an unavailable node explicitly;
preparation failure must leave both active chains unchanged. Losing the control
connection must not stop an already running local audio graph.

Spillover remains local to each board. Each board must sustain its own active,
prepared and retiring graphs; two boards do not automatically eliminate preset
gaps or share spare CPU capacity. Measure input-to-output latency, recall
response and xruns on each board with the intended interfaces and plugins.

Library and master references
-----------------------------

Use a persistent library under ``MOD_DATA_DIR``. Each chain preset has a stable
identifier and atomically saved revisions. A revision contains a graph whose
plugin identifiers are local to the preset, parameter data and saved LV2 state.
Keep physical input/output assignments in the rig, so a preset can be reused
without embedding the current hardware port names.

Masters hold references, for example::

    Verse  -> guitar: Clean   / microphone: Vocal Dry
    Chorus -> guitar: Drive   / microphone: Vocal Dry
    Solo   -> guitar: Lead    / microphone: Vocal Delay

Editing ``Vocal Dry`` changes one definition. Both Verse and Chorus use its
latest saved revision on their next recall. Saving a preset does not silently
reload an already playing chain. Record the loaded revision separately from the
shared preset identifier so the interface can show pending changes accurately.

A rig also stores physical ports, the independent preset order for each chain,
MIDI assignments and per-chain tail settings. Saving a master records the two
selected preset references. Subsequent independent changes can produce a
combination that differs from the recalled master without modifying that master.

Assign plugins explicitly to Guitar or Microphone. Do not infer ownership from
grid rows or graph reachability. Reject plugin sharing or cross-chain connections
until a separately defined shared-effects layer exists. Sharing physical output
ports is allowed; sharing mutable effect instances prevents independent recall.

Audio runtime
-------------

Add a backend rig manager that owns plugin lifetimes, state restoration, MIDI
actions and transitions. Keep mod-host as the LV2/audio engine. Small dedicated
LV2 routing utilities can provide the gain ramps and level monitoring absent
from the current graph-editing API.

Each chain uses permanent input and output routing nodes around a pool of effect
graphs::

    Physical input
          |
    Input splitter / gates
          |             |               |
     Active graph   Prepared graph   Retiring graph
          |             |               |
          +-------------+---------------+
                        |
                   Output mixer
                        |
                 Physical output(s)

The splitter and mixer must be separate LV2 nodes. A single node sending audio
through effects back into itself introduces a JACK graph cycle.

The slot states are ``free``, ``preparing``, ``ready``, ``active`` and
``retiring``. Three slots per chain permit an active graph, a prepared replacement
and one retiring graph at the same time. Slot count is a resource setting, not a
promise that every preset can remain loaded simultaneously.

Preset recall
~~~~~~~~~~~~~

1. Resolve the saved revision and validate plugins, state assets and routing.
2. Prepare it in a free slot while the current chain continues processing live
   audio. Wait for every plugin, state and connection operation to succeed.
3. Restore opaque state, control values, bypass and file parameters. Briefly
   warm the new graph with live input while keeping its output muted, when needed.
4. Ramp the transition. Stop feeding new input into the old graph, make the new
   graph audible, and keep the old graph's output connected for its tails.
5. Retire the old graph after sustained output silence, or after an explicitly
   configured maximum tail duration followed by a fade. Do not reset its plugin
   state while its tail is audible.

Monitor tail output after input has faded to zero; account for delayed repeats
and require a silence hold period. Feedback delays, generators and noisy plugins
may never become silent, so the duration limit must be visible and configurable.

Preload likely destinations to reduce the time from pressing a switch to hearing
the new preset. An unprepared preset may take time to become ready while the old
sound continues. Continuous audio and immediate recall are separate targets.

If slots or resources are exhausted, keep the active sound and retain the latest
pending request for that chain. Do not silently cut a tail to reuse its slot.
Provide an explicit shorter-tail policy only if the user selects it. Discard
obsolete preparation results using per-chain generation tokens.

A master recall prepares both referenced graphs before either transition starts.
Coordinate their ramps; if preparation of either graph fails, leave both active
chains unchanged. Individual recalls must not cancel an unrelated chain's work.

MIDI assignments
----------------

The controller can send PC, CC and SysEx. PC and CC are sufficient for the
required switch assignment workflow; SysEx availability does not require using
it for preset recall. Support arbitrary allocation of the twelve switches.

Each assignment records a MIDI message identity and one action:

- Guitar or Microphone: previous preset, next preset, or a specific preset.
- Master: recall a specific master preset.
- Unassigned: leave the switch available for other controller functions.

Store channel and program for PC. For CC, store channel, controller, press value
or threshold, and press/release behavior. Avoid a fixed assumption that every
controller sends a release event. Debounce duplicate presses without preventing
repeated deliberate presses. Show MIDI numbering clearly in the interface.

Use the existing mod-host program monitoring path for PC. For CC, a permanent LV2
control bridge with ordinary control ports can use ``midi_map`` and backend
``param_set`` feedback. Do not use ``lv2:trigger`` ports for press/release
discrimination. Reject conflicting channel/controller bindings, including
existing plugin bindings, before enabling assignments.

SysEx recall, if added, needs a raw MIDI reception and message-matching path;
current PC monitoring and CC parameter feedback do not provide that interface.
Do not advertise SysEx learning as part of the PC/CC implementation.

Host integration
----------------

- Never use whole-pedalboard reset/load for a chain transition. The current
  loader disables processing and removes the whole graph.
- Current snapshots store state rather than graph topology. Keep them separate
  from the chain-preset library and masters.
- Capture live state in the backend. Frontend pending-value queues are incomplete
  and cannot represent a saved preset.
- Give utility, staged, active and retiring plugins explicit chain/slot/generation
  ownership. Filter transient runtime nodes from legacy snapshots and pedalboard
  serialization, which currently iterate over every live plugin.
- Reuse runtime instance IDs safely. The current mapper keeps increasing IDs
  after plugin removal; repeated staging must not exhaust mod-host's ID range.
- Restore only the selected chain's state. The upstream mod-host state loader
  skips instances without matching state files; build a scoped temporary state
  directory with files remapped to the staged slot's numeric instance IDs.
- Roll back failed preparation by removing only the staged graph. Publish active
  references after the transition succeeds.
- Persist active preset references and switch assignments. Reconstruct the rig
  and restore MIDI mappings after restart/reconnection; retiring tails are
  transient. Failure to reconstruct must be reported explicitly.

Verify native command/state behavior against the deployed mod-host revision
before relying on it. Relevant upstream implementation:
https://github.com/mod-audio/mod-host/blob/master/src/effects.c

Grid interface
--------------

Add a Chains view with separate Guitar and Microphone controls for physical
ports, plugin membership, preset order, save/update and independent recall.
Display each chain's active preset, loaded revision, pending destination and
``Preparing`` / ``Ready`` / ``Switching`` / ``Error`` status from the backend.
Add master selection/reference editing and a twelve-row switch assignment table.
Keep implementation details such as runtime slot IDs out of ordinary controls.

Expose per-chain spillover settings and readiness/resource feedback. The browser
reports backend state; it is not responsible for MIDI handling or tail cleanup.

Validation
----------

Automated tests must cover scoped graph/state capture, reference reuse, atomic
persistence, staging rollback, independent cancellation, obsolete callbacks,
ID reuse, conflicting MIDI mappings and compatibility with ordinary pedalboards.
Frontend tests cover membership, action payloads, presets/masters, assignment
validation, failure reporting and reconnect state.

Hardware acceptance on the Raspberry Pi 5 must include:

1. Change guitar topology while playing both inputs; microphone audio, state and
   connections remain intact. Repeat with microphone and guitar reversed.
2. Switch during audible delay/reverb tails. New notes use the new preset while
   the old tail decays without receiving new input.
3. Test slow preparation, missing plugins, failed state restoration and exhausted
   slots; the active chains remain available.
4. Press switches rapidly and on both chains. The latest requested destinations
   win, without an obsolete preparation changing the sound afterward.
5. Repeat independent and master recalls with the browser closed, then reopen it
   and check its state against the running rig.
6. Edit one shared preset and recall different masters referencing it; all use
   the updated definition without copied configurations.
7. Record transitions at the intended sample rate and buffer size. Measure recall
   response, audible gaps, discontinuities, tail behavior, peak levels, CPU/RAM
   and xruns with the heaviest actual plugins and supported overlaps.

Do not claim gapless operation or unlimited tail preservation from browser or
mock-host tests. Preloaded and retiring plugins still consume resources with
silent inputs; the supported overlap must be measured on the target system.
