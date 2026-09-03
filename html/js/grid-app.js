// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Controller for the independent "grid" theme: websocket protocol handling,
// REST calls and the linear auto-wiring chain.

// modgui.js (reused as-is for the plugin skins) has a couple of calls that are
// unconditional on a global `desktop` object belonging to the default theme
// (control-resize bookkeeping, and posting parameter changes for HMI sync).
// This is a minimal stand-in so the reused skin code doesn't crash here.
var desktop = {
    ParameterSet: function (paramchange) {
        $.ajax({
            url: '/effect/parameter/set/',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify(paramchange),
            cache: false,
            global: false,
            dataType: 'json',
        })
    },
    pedalboard: $('<div>'),
    openPresetSaveWindow: function () {},
}
$.fn.pedalboard = function () { return this }

function notify(type, message) {
    var toast = $('<div class="grid-toast">').text(message)
    if (type === 'error') toast.addClass('grid-toast-error')
    $('#grid-notifications').append(toast)
    setTimeout(function () {
        toast.fadeOut(200, function () { toast.remove() })
    }, 4000)
}

// Copied from pedalboard.js's generateInstance: ingen's algorithm for turning
// a plugin URI into a valid, unique instance symbol.
function generateInstance(uri) {
    var last_uri_delim = function (s) {
        for (var i = s.length - 1; i > 0; --i) {
            switch (s[i]) {
                case '/': case '?': case '#': case ':':
                    return i
            }
        }
        return -1
    }
    var re = /[^_a-zA-Z0-9]+/g
    var instance = uri
    var last_delim = last_uri_delim(instance)
    while (last_delim != -1 && !instance.substr(last_delim, instance.length - 1).match(/[a-zA-Z0-9]/)) {
        instance = instance.substr(0, last_delim)
        last_delim = last_uri_delim(instance)
    }
    instance = instance.substr(last_delim + 1, instance.length - 1).replace(re, "_")
    if (instance[0].match(/[0-9]/)) instance = "_" + instance
    instance = '/graph/' + instance
    if (instance === '/graph/cv') instance = instance + 'x'
    if (GridBoard.hasInstance(instance)) {
        var i = 1
        instance = instance + "_1"
        while (GridBoard.hasInstance(instance)) {
            i = i + 1
            instance = instance.slice(0, -1) + i
        }
    }
    return instance
}

var ws
var pbLoading = true
var dataReadyCounter = '', dataReadyTimeout = null
var currentConnections = {} // "from|to" -> [from, to], mirrors real backend connections
var pendingValues = {}      // instance -> {symbol: value}
var pendingParams = {}      // instance -> {uri: {valuetype, value}} — value stays a raw string
                            // (not every patch parameter is numeric, e.g. a file path)
var pendingOutputs = {}     // instance -> {symbol: value}, output-only control ports (see "output_set")
var pendingReadableParams = {} // instance -> {uri: {valuetype, value}}, non-writable patch params (see "patch_set")
var pluginLibrary = []      // from /effect/list, shelf data source
var hwPortLibrary = {}      // instance -> {type, isOutput, name}, shelf data source
var hwPortPlaced = {}       // instance -> true while its block is on the grid
var pedalboardModified = false
var currentBankName = null
var currentSnapshotName = null
// null = not yet known, true/false once refreshCurrentBankName has answered.
// A pedalboard that isn't in any bank saves to disk with nowhere on screen
// showing for it, which reads as "nothing happened" — so Save and New
// Snapshot stay disabled until it's filed into a bank (see updateEmptyState
// and the #grid-unbanked-hint banner).
var currentPbBanked = null

// Which bank/pedalboard/snapshot is current is otherwise invisible once the
// nav tree is closed, so it's spelled out under the title at all times.
function updateStatusLine() {
    var parts = []
    if (currentBankName) parts.push(currentBankName)
    else if (BUNDLE_PATH && currentPbBanked === false) parts.push('Not in a bank')
    parts.push(PEDALBOARD_TITLE || 'No pedalboard')
    if (currentSnapshotName) parts.push(currentSnapshotName)
    $('#grid-status-line').text(parts.join(' › '))
}

// True only when there's a pedalboard loaded AND it lives in a bank — the one
// state in which Save / New Snapshot actually produce something the user can
// find again.
function pedalboardIsSaveable() {
    return !!BUNDLE_PATH && currentPbBanked === true
}

// A pedalboard can't exist outside of a bank (see GridNav's model), so
// there's no such thing as a valid "current pedalboard" with an empty
// BUNDLE_PATH — and there must be no silently-loaded stand-in for one either
// (no hidden default pedalboard/snapshot). This is the single place that
// reflects "nothing is open" everywhere it matters: title, canvas overlay,
// and every action that only makes sense against a real saved pedalboard
// (adding blocks, saving, snapshotting).
function updateEmptyState() {
    var empty = !BUNDLE_PATH
    // unbanked: a pedalboard is loaded but isn't filed in any bank yet
    var unbanked = !empty && currentPbBanked === false
    var blocked = empty || unbanked
    $('#grid-canvas-empty').toggleClass('grid-hidden', !empty)
    $('#grid-unbanked-hint').toggleClass('grid-hidden', !unbanked)
    if (unbanked) $('#grid-unbanked-name').text(PEDALBOARD_TITLE || 'This pedalboard')
    $('#grid-new-snapshot').prop('disabled', blocked)
    $('#grid-save').prop('disabled', blocked)
    var saveTip = unbanked
        ? 'Add this pedalboard to a bank before saving'
        : 'Save the pedalboard'
    $('#grid-save').attr('title', empty ? 'No pedalboard loaded' : saveTip)
    $('#grid-new-snapshot').attr('title', unbanked
        ? 'Add this pedalboard to a bank before taking snapshots'
        : 'Save the current state as a new snapshot of this pedalboard')
    if (empty) $('#grid-title').text('No pedalboard loaded')
    updateStatusLine()
}

function refreshCurrentBankName() {
    $.ajax({
        url: '/banks/raw',
        cache: false,
        dataType: 'json',
        success: function (banks) {
            currentBankName = null;
            // the semicolon above is required — without it this parses as
            // "null(banks || [])..." (calling null as a function) instead of
            // two separate statements, throwing and silently killing this
            // whole callback before updateStatusLine() ever runs
            (banks || []).some(function (bank) {
                if ((bank.pedalboards || []).some(function (pb) { return pb.bundle === BUNDLE_PATH })) {
                    currentBankName = bank.title
                    return true
                }
                return false
            })
            currentPbBanked = BUNDLE_PATH ? (currentBankName !== null) : null
            updateEmptyState()
        },
        error: function () {
            currentPbBanked = null
            updateEmptyState()
        },
    })
}

// Zoom scales the whole page (header, shelf, canvas, panels) as one rigid
// unit via a transform on #grid-app-root, not just the grid content. A plain
// scale() shrinks the root's own rendered footprint too, so below 100% the
// full-width bars (header, shelf, nav) would stop reaching the screen edges.
// Counter-sizing the root to (100/zoom)% before scaling cancels that out —
// after the transform it always renders back to exactly 100% of the real
// viewport, while everything inside (fonts, blocks, bars) still visually
// scales together.
var uiZoom = 1
function zoomUi(newZoom) {
    uiZoom = Math.min(2, Math.max(0.6, newZoom))
    $('#grid-app-root').css({
        transform: 'scale(' + uiZoom + ')',
        width: (100 / uiZoom) + '%',
        height: (100 / uiZoom) + '%',
    })
    $('#grid-zoom-pct').text(Math.round(uiZoom * 100) + '%')
    try { localStorage.setItem('grid-ui-zoom', uiZoom) } catch (e) {}
    updateHeaderHeight()
}

// #grid-header can wrap onto extra lines once zoom shrinks its available
// layout width enough (see the width compensation above) — its own height
// is left auto (min-height, not height) to grow with it, and everything
// below reads that real height back through this custom property instead of
// assuming a fixed 64px, so nothing ends up clipped behind the shelf panel.
function updateHeaderHeight() {
    var h = $('#grid-header')[0].offsetHeight
    $('#grid-app-root')[0].style.setProperty('--grid-header-h', h + 'px')
}

// Hardware ports arrive from the backend named after their jack port (e.g.
// "Capture 1", "All MIDI In"), which means little to someone who isn't
// familiar with JACK; show them the same way Fractal-style gear labels its
// physical I/O instead ("In 1", "MIDI In").
// `isOutput` here is the GRAPH-direction flag (true for a capture/system-in
// port, which is a source you connect FROM — see outputPortsOf/inputPortsOf)
// — the opposite of the physical jack direction a user expects "In"/"Out" to
// mean, so the label intentionally inverts it: a capture port is the
// physical audio INPUT jack ("In 1"), a playback port is the physical
// OUTPUT jack ("Out 1").
function friendlyHwName(rawName, type, isOutput) {
    var m = rawName.match(/(\d+)\s*$/)
    var num = m ? (' ' + m[1]) : ''
    if (type === 'midi') return (isOutput ? 'MIDI In' : 'MIDI Out') + num
    if (type === 'cv') return (isOutput ? 'CV In' : 'CV Out') + num
    return (isOutput ? 'In' : 'Out') + num
}

function triggerDelayedReadyResponse(triggerNew) {
    if (dataReadyTimeout) {
        clearTimeout(dataReadyTimeout)
        triggerNew = true
    }
    if (triggerNew) {
        dataReadyTimeout = setTimeout(function () {
            dataReadyTimeout = null
            ws.send("data_ready " + dataReadyCounter)
        }, 50)
    }
}

function restConnect(from, to) {
    $.ajax({ url: '/effect/connect/' + from + ',' + to, cache: false, dataType: 'json' })
}

function restDisconnect(from, to) {
    $.ajax({ url: '/effect/disconnect/' + from + ',' + to, cache: false, dataType: 'json' })
}

// LV2 presets: pluginData.presets is a static, per-plugin-URI list (cached,
// same for every instance of that plugin) of {uri, label, path} — path is
// empty for a read-only factory preset, and the preset's own bundle
// directory for a user-saved one (only those get rename/delete). Which
// preset is currently active per INSTANCE isn't part of that static data at
// all — it only exists as a live "preset <instance> <uri>" websocket
// broadcast (see the "preset" case in ws.onmessage below), so pluginData
// gets a synthetic .preset field here that starts empty and is kept current
// purely by that broadcast, same as every other piece of live state in this
// file (nothing here mutates it directly after firing the REST call).
function presetLoad(instance, uri) {
    $.ajax({ url: '/effect/preset/load/' + instance, data: { uri: uri }, cache: false, dataType: 'json' })
    pedalboardModified = true
}

function presetSaveReplace(instance, preset) {
    $.ajax({
        url: '/effect/preset/save_replace/' + instance,
        data: { uri: preset.uri, bundle: preset.path, name: preset.label },
        cache: false,
        dataType: 'json',
        success: function (resp) {
            if (!resp || !resp.ok) { notify('error', "Couldn't save preset"); return }
            notify('info', 'Preset "' + preset.label + '" saved')
            refreshPluginPresets(instance, resp.uri)
        },
        error: function () { notify('error', "Couldn't save preset") },
    })
}

function presetSaveNew(instance, name) {
    $.ajax({
        url: '/effect/preset/save_new/' + instance,
        data: { name: name },
        cache: false,
        dataType: 'json',
        success: function (resp) {
            if (!resp || !resp.ok) { notify('error', "Couldn't save preset"); return }
            notify('info', 'Preset "' + name + '" saved')
            refreshPluginPresets(instance, resp.uri)
        },
        error: function () { notify('error', "Couldn't save preset") },
    })
}

function presetDelete(instance, preset) {
    $.ajax({
        url: '/effect/preset/delete/' + instance,
        data: { uri: preset.uri, bundle: preset.path },
        cache: false,
        dataType: 'json',
        success: function (ok) {
            if (!ok) { notify('error', "Couldn't delete preset"); return }
            notify('info', 'Preset "' + preset.label + '" deleted')
            refreshPluginPresets(instance, '')
        },
        error: function () { notify('error', "Couldn't delete preset") },
    })
}

// Re-fetches the plugin's preset list (uncached — save/delete just changed
// it) after a save or delete, and re-renders the panel's preset row if it's
// still the one open.
function refreshPluginPresets(instance, selectUri) {
    var b = GridBoard.getBlock(instance)
    if (!b) return
    $.ajax({
        url: '/effect/get_non_cached',
        data: { uri: b.pluginData.uri },
        cache: false,
        dataType: 'json',
        success: function (fresh) {
            b.pluginData.presets = fresh.presets || []
            if (selectUri !== undefined) b.pluginData.preset = selectUri
            if (GridParams.currentInstance() === instance) GridParams.refreshPresets(instance, b.pluginData)
        },
    })
}

// A hardware "output" port (hwOutput — a capture/system-audio-in jack,
// displayed to the user as "In N", see friendlyHwName/hwIconSvg) is a SOURCE
// from the pedalboard graph's point of view: it feeds captured audio into
// the chain, so it can only ever be connected FROM, never INTO. A hardware
// "input" port (a playback/system-audio-out jack, displayed as "Out N") is
// the reverse: only a valid connection TARGET, never a source.
function outputPortsOf(instance) {
    var b = GridBoard.getBlock(instance)
    if (!b) return []
    if (b.isHardware) return b.hwOutput ? [instance] : []
    return (b.pluginData.ports.audio.output || []).map(function (p) { return instance + '/' + p.symbol })
}

function inputPortsOf(instance) {
    var b = GridBoard.getBlock(instance)
    if (!b) return []
    if (b.isHardware) return b.hwOutput ? [] : [instance]
    return (b.pluginData.ports.audio.input || []).map(function (p) { return instance + '/' + p.symbol })
}

// A human label for whatever is on the other end of a connection, for the
// connection rows in the generic panel (see buildConnectionRows in
// grid-params.js) — a saved pedalboard can arrive already wired to a
// hardware port or a plugin block that isn't currently placed on the grid
// (yet, or ever, if it was built in the default theme, or its grid block was
// since removed while the underlying JACK connection stuck around), so this
// falls back to hwPortLibrary (populated from the server's hardware
// descriptor regardless of grid placement) before giving up on a raw path.
function labelForInstance(instance) {
    var b = GridBoard.getBlock(instance)
    if (b) {
        if (b.isHardware) return (hwPortLibrary[instance] && hwPortLibrary[instance].name) || instance
        return (b.pluginData.label) || instance
    }
    if (hwPortLibrary[instance]) return hwPortLibrary[instance].name
    return instance
}

// Per-port connection status for a plugin instance's real audio ports (not
// the block-level "is anything connected at all" question) — this is the
// only reliable way to show "which of my ins/outs are actually in use" for
// an arbitrary LV2 plugin, since most skins don't expose their own jacks as
// separately clickable/markable elements. Peers carry their real port path
// (not just a display label) so the connection rows in the generic panel
// (see buildConnectionRows in grid-params.js) can remove the exact pair via
// restDisconnect — adding new connections is left to dragging on the canvas.
function audioPortConnectionInfo(instance) {
    var b = GridBoard.getBlock(instance)
    if (!b || b.isHardware) return { inputs: [], outputs: [] }
    function peersOf(portPath, side) {
        var peers = []
        for (var k in currentConnections) {
            var pair = currentConnections[k]
            if (pair[side] === portPath) {
                var peerPath = pair[side === 0 ? 1 : 0]
                peers.push({ path: peerPath, label: labelForInstance(instanceFromPortPath(peerPath)) })
            }
        }
        return peers
    }
    var inputs = (b.pluginData.ports.audio.input || []).map(function (p) {
        var path = instance + '/' + p.symbol
        var peers = peersOf(path, 1)
        return { name: p.name, symbol: p.symbol, path: path, connected: !!peers.length, peers: peers }
    })
    var outputs = (b.pluginData.ports.audio.output || []).map(function (p) {
        var path = instance + '/' + p.symbol
        var peers = peersOf(path, 0)
        return { name: p.name, symbol: p.symbol, path: path, connected: !!peers.length, peers: peers }
    })
    return { inputs: inputs, outputs: outputs }
}

// Only an EXACT port-count match (1 out -> 1 in, 2 outs -> 2 ins, ...) gets
// paired by index automatically when the user connects two blocks — anything
// else is ambiguous and needs the user to pick explicitly (see GridConnectDialog).
function desiredLinks(prevInstance, nextInstance) {
    var outs = outputPortsOf(prevInstance)
    var ins = inputPortsOf(nextInstance)
    var links = []
    if (outs.length === 0 || ins.length === 0 || outs.length !== ins.length) return links
    for (var i = 0; i < outs.length; i++) links.push([outs[i], ins[i]])
    return links
}

// A port path is either "instance/symbol" (plugin port) or just "instance"
// itself (hardware port, see outputPortsOf/inputPortsOf) — hwPortLibrary is
// checked too, not just GridBoard, so a hardware port wired but not
// currently placed on the grid is still recognized as a bare instance
// instead of having its last path segment wrongly stripped as if it were a
// plugin's port symbol (that previously turned e.g. "/graph/playback_1"
// into just "/graph").
function instanceFromPortPath(path) {
    if (GridBoard.hasInstance(path) || hwPortLibrary.hasOwnProperty(path)) return path
    var idx = path.lastIndexOf('/')
    return idx > 0 ? path.substring(0, idx) : path
}

// Placing a block adjacent to another on the same row auto-wires them once,
// right here (see autoConnectAdjacent) — but grid position is never
// consulted again after that. Moving a block only moves it; whatever it's
// connected to stays connected regardless of where it ends up, and every
// cable looks and behaves the same either way. This just redraws the
// cables to match currentConnections and the blocks' current positions.
function rewireChain() {
    var seen = {}
    var links = []
    for (var k in currentConnections) {
        var pair = currentConnections[k]
        var fromInstance = instanceFromPortPath(pair[0])
        var toInstance = instanceFromPortPath(pair[1])
        var linkKey = fromInstance + '|' + toInstance
        if (seen[linkKey]) continue
        seen[linkKey] = true
        if (GridBoard.hasInstance(fromInstance) && GridBoard.hasInstance(toInstance)) {
            links.push({ from: fromInstance, to: toInstance })
        }
    }
    GridBoard.setManualLinks(links)

    // keep the open panel's port-status pills in sync — connections can
    // change from elsewhere on the canvas while it stays open
    var openInstance = GridParams.currentInstance()
    if (openInstance) GridParams.refreshPorts(audioPortConnectionInfo(openInstance))
}

// One-shot: called only right after a block is newly placed on the grid
// (see pluginAdd/hwPortPlace), never on a later move — wires it up to
// whatever already sits immediately left/right of it on the same row, same
// exact-match-only rule as manualConnect. Ambiguous port counts are just
// left unconnected here (no auto-popup) — same as leaving two unrelated
// blocks sitting side by side; drag the handle if you want them linked.
function autoConnectAdjacent(instance) {
    var block = GridBoard.getBlock(instance)
    if (!block) return
    var leftInstance = GridBoard.instanceAt(block.col - 1, block.row)
    var rightInstance = GridBoard.instanceAt(block.col + 1, block.row)
    if (leftInstance && leftInstance !== instance) {
        desiredLinks(leftInstance, instance).forEach(function (pair) { restConnect(pair[0], pair[1]) })
    }
    if (rightInstance && rightInstance !== instance) {
        desiredLinks(instance, rightInstance).forEach(function (pair) { restConnect(pair[0], pair[1]) })
    }
}

function manualConnect(fromInstance, toInstance) {
    var outs = outputPortsOf(fromInstance)
    var ins = inputPortsOf(toInstance)
    if (!outs.length || !ins.length) {
        notify('error', 'These blocks have no compatible ports to connect')
        return
    }
    if (outs.length === ins.length) {
        desiredLinks(fromInstance, toInstance).forEach(function (pair) { restConnect(pair[0], pair[1]) })
        pedalboardModified = true
        return
    }
    // ambiguous: let the user choose exactly which port goes where
    GridConnectDialog.open(fromInstance, toInstance, outs, ins, function (pairs) {
        pairs.forEach(function (pair) { restConnect(pair[0], pair[1]) })
        if (pairs.length) pedalboardModified = true
    })
}

// Click any cable (auto same-row chain or manual/cross-row) to remove it —
// every port-pair between the two blocks goes at once, since visually it's a
// single cable even when it's really a stereo pair of connections underneath.
function disconnectManualLink(fromInstance, toInstance) {
    if (!window.confirm('Remove this connection?')) return
    var removed = false
    for (var k in currentConnections) {
        var pair = currentConnections[k]
        if (instanceFromPortPath(pair[0]) === fromInstance && instanceFromPortPath(pair[1]) === toInstance) {
            restDisconnect(pair[0], pair[1])
            removed = true
        }
    }
    if (removed) {
        pedalboardModified = true
        rewireChain()
    }
}

function pluginAdd(uri, col, row) {
    var instance = generateInstance(uri)
    var cell = GridBoard.cellSize()
    var x = col * (cell.w + cell.gap)
    var y = row * (cell.h + cell.gap)

    $.ajax({
        url: '/effect/add/' + instance + '?x=' + x + '&y=' + y + '&uri=' + escape(uri),
        success: function (pluginData) {
            if (!pluginData) {
                notify('error', 'Error adding effect')
                return
            }
            GridBoard.addPluginBlock(instance, pluginData, false, col, row)
            pedalboardModified = true
            if (!pbLoading) {
                autoConnectAdjacent(instance)
                rewireChain()
            }
        },
        error: function () {
            notify('error', 'Error adding effect. Probably a connection problem.')
        },
        cache: false,
        dataType: 'json',
    })
}

function pluginRemove(instance) {
    $.ajax({
        url: '/effect/remove/' + instance,
        success: function (resp) {
            if (!resp) {
                notify('error', "Couldn't remove effect")
                return
            }
            GridBoard.removeBlock(instance)
            delete pendingValues[instance]
            delete pendingParams[instance]
            pedalboardModified = true
            rewireChain()
        },
        cache: false,
        dataType: 'json',
    })
}

// instance has to be captured in this closure, one call per plugin instance
// — modgui.js's lv2PatchGet/lv2PatchSet call options.patchGet(uri) and
// options.patchSet(uri, valuetype, value) with NO instance argument at all
// (see modgui.js:527-594; the default theme's pedalboard.js does the exact
// same closure trick at patchSet:1406). Treating instance as this function's
// own first parameter (an earlier version of this code did) silently shifts
// every argument over by one, so the "instance" the server receives is
// actually the parameter URI — which the backend doesn't recognize as any
// real plugin, and its uncaught KeyError there kills the whole websocket,
// closing the panel on the very next reconnect-triggered reset.
function guiWsCallbacks(instance) {
    return {
        // port is "<instance>/<symbol>" (modgui.js's setPortValue builds it
        // this way, or copies it straight off a widget's mod-port attribute).
        // The server doesn't echo a client's own change back to it over the
        // websocket, so the block's LED has to be updated right here, locally
        // and synchronously — waiting on the incoming "param_set" broadcast
        // (used for genuinely external changes, e.g. HMI/other clients) would
        // never fire for the user's own click.
        change: function (port, value) {
            pedalboardModified = true
            ws.send("param_set " + port + " " + value)
            var idx = port.lastIndexOf('/')
            if (idx >= 0 && port.substring(idx + 1) === ':bypass') {
                GridBoard.setBypassed(port.substring(0, idx), value)
            }
        },
        patchGet: function (uri) {
            ws.send("patch_get " + instance + " " + uri)
        },
        patchSet: function (uri, valuetype, value) {
            pedalboardModified = true
            ws.send("patch_set " + instance + " " + uri + " " + valuetype + " " + value)
        },
    }
}

function openPanelFor(instance) {
    var block = GridBoard.getBlock(instance)
    if (!block || block.isHardware) return
    GridParams.open(instance, block, guiWsCallbacks(instance), pendingValues[instance], pendingParams[instance],
        audioPortConnectionInfo(instance), pendingOutputs[instance], pendingReadableParams[instance])
    delete pendingValues[instance]
    delete pendingParams[instance]
    delete pendingOutputs[instance]
    delete pendingReadableParams[instance]
}

var wsReconnectDelay = 1000
var wsReconnectMaxDelay = 10000
var wsReconnectTimer = null
var wsHadDisconnect = false
// Set right after the backend confirms it accepted a Power Off — the
// websocket drop that follows is then expected, not an error (see
// ws.onclose below and #grid-shutdown-overlay in grid.html). Reconnect
// attempts still run underneath in case the shutdown didn't actually
// go through; a successful reconnect clears it.
var expectingShutdown = false

function scheduleReconnect() {
    if (wsReconnectTimer) return
    wsReconnectTimer = setTimeout(function () {
        wsReconnectTimer = null
        connectWebSocket()
    }, wsReconnectDelay)
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, wsReconnectMaxDelay)
}

function connectWebSocket() {
    ws = new WebSocket("ws://" + window.location.host + "/websocket")

    ws.onopen = function () {
        wsReconnectDelay = 1000
        if (expectingShutdown) {
            // it reconnected after all — the shutdown didn't happen (or was
            // a reboot), so drop back to the normal "lost/reconnected" wording
            expectingShutdown = false
            $('#grid-shutdown-overlay').addClass('grid-hidden')
        }
        if (wsHadDisconnect) {
            notify('info', 'Reconnected')
            wsHadDisconnect = false
        }
    }

    ws.onclose = function () {
        wsHadDisconnect = true
        if (expectingShutdown) {
            $('#grid-shutdown-overlay').removeClass('grid-hidden')
        } else {
            notify('error', 'Connection to the device was lost, retrying...')
        }
        // the reconnect gets a fresh pedalboard replay (loading_start..add..connect..loading_end),
        // so drop whatever local state we had rather than risk it going stale/duplicated
        GridBoard.reset()
        GridParams.close()
        currentConnections = {}
        pendingValues = {}
        pendingParams = {}
        pendingOutputs = {}
        pendingReadableParams = {}
        hwPortLibrary = {}
        hwPortPlaced = {}
        renderShelf()
        pbLoading = true
        scheduleReconnect()
    }

    ws.onmessage = function (evt) {
        var data = evt.data
        var cmd = data.split(" ", 1)
        if (!cmd.length) return
        cmd = cmd[0]

        if (cmd === "ping") { ws.send("pong"); return }
        if (cmd === "stop") return
        if (cmd === "cc-device-updated") return

        data = data.substr(cmd.length + 1)

        if (cmd === "data_ready") {
            dataReadyCounter = data
            triggerDelayedReadyResponse(true)
            return
        }

        if (cmd === "param_set") {
            var pdata = data.split(" ", 3)
            var instance = pdata[0], symbol = pdata[1], value = parseFloat(pdata[2])
            // the block's LED reflects bypass state independently of whether
            // its parameter panel happens to be open right now
            if (symbol === ':bypass') GridBoard.setBypassed(instance, value)
            if (GridParams.currentInstance() === instance) {
                GridParams.currentGui().setPortWidgetsValue(symbol, value)
            } else {
                pendingValues[instance] = pendingValues[instance] || {}
                pendingValues[instance][symbol] = value
            }
            return
        }

        // Output-only control ports (meters, playback position, detected sample
        // rate/length, ...) — read-only telemetry a plugin's own JS reads via the
        // 'change' event, same as param_set above but never user-writable, so
        // there's no local echo to send back and no ':bypass'/LED special case.
        if (cmd === "output_set") {
            var odata = data.split(" ", 3)
            var instance = odata[0], symbol = odata[1], value = parseFloat(odata[2])
            if (GridParams.currentInstance() === instance) {
                GridParams.currentGui().setOutputPortValue(symbol, value)
            } else {
                pendingOutputs[instance] = pendingOutputs[instance] || {}
                pendingOutputs[instance][symbol] = value
            }
            return
        }

        // The only source for "which preset is active on this instance" — see
        // the comment above presetLoad() for why pluginData.preset can't come
        // from anywhere else. Sent for both a real load and a delete (as
        // "preset <instance> null", since the deleted preset can no longer be
        // active); the accompanying control-value changes arrive separately
        // as their own "param_set" broadcasts, already handled above.
        if (cmd === "preset") {
            var prdata = data.split(" ", 2)
            var instance = prdata[0]
            var uri = prdata[1] === "null" ? "" : prdata[1]
            var b = GridBoard.getBlock(instance)
            if (b) b.pluginData.preset = uri
            if (GridParams.currentInstance() === instance) GridParams.refreshPresets(instance, b ? b.pluginData : { presets: [], preset: '' })
            return
        }

        triggerDelayedReadyResponse(false)

        if (cmd === "stats") {
            var stdata = data.split(" ", 2)
            var cpuLoad = parseFloat(stdata[0])
            var xruns = parseInt(stdata[1])
            $('#grid-cpu-value').text(cpuLoad.toFixed(0) + '%')
            if (xruns > 0) {
                $('#grid-xruns-value').text(xruns > 999 ? '+999' : xruns)
                $('#grid-xruns-text').removeClass('grid-hidden')
            } else {
                $('#grid-xruns-text').addClass('grid-hidden')
            }
            return
        }

        // System stats, sent on the same timer as "stats" but only when the
        // backend can read /proc/meminfo (so never in the dev environment):
        // "<memPercent> <cpuFreqHz> <cpuTempMilliC>". The RAM percentage sits
        // right next to the CPU badge; freq/temp go in its tooltip.
        if (cmd === "sys_stats") {
            var sydata = data.split(" ", 3)
            var memPct = parseFloat(sydata[0])
            var cpuFreq = parseInt(sydata[1])
            var cpuTemp = parseInt(sydata[2])
            if (!isNaN(memPct)) $('#grid-ram-value').text(memPct.toFixed(0) + '%')
            var tip = []
            if (cpuFreq > 0) tip.push((cpuFreq / 1000000).toFixed(1) + ' GHz')
            if (cpuTemp > 0) tip.push((cpuTemp / 1000).toFixed(0) + ' °C')
            $('#grid-cpu-text').attr('title', tip.join('  ·  '))
            return
        }

        // Transport: "<rolling> <beatsPerBar> <beatsPerMinute> <syncMode>".
        // Broadcast once right after connect and again on every change.
        if (cmd === "transport") {
            var trdata = data.split(" ", 4)
            if (typeof GridTransport !== 'undefined') {
                GridTransport.fromServer(
                    parseInt(trdata[0]) != 0,
                    parseFloat(trdata[1]),
                    parseFloat(trdata[2]),
                    trdata[3]
                )
            }
            return
        }

        if (cmd === "rescan") {
            var resp = JSON.parse(atob(data))
            if ((resp.installed && resp.installed.length) || (resp.removed && resp.removed.length)) {
                notify('info', 'Plugin list updated')
                loadShelf()
            }
            return
        }

        if (cmd === "patch_set") {
            var sdata = data.split(" ", 4)
            var instance = sdata[0]
            var writable = parseInt(sdata[1]) != 0
            var uri = sdata[2]
            var valuetype = sdata[3]
            var valuedata = data.substr(sdata.join(" ").length + 1)
            if (writable) {
                if (GridParams.currentInstance() === instance) {
                    GridParams.currentGui().setWritableParameterValue(uri, valuetype, valuedata)
                } else {
                    // keep the raw string and its real valuetype together —
                    // patch parameters aren't always numeric (e.g. a file
                    // path/cabinet selector), so parseFloat()'ing this
                    // unconditionally used to hand the plugin's own JS a NaN
                    // where it expected a string, crashing its GUI on replay
                    pendingParams[instance] = pendingParams[instance] || {}
                    pendingParams[instance][uri] = { valuetype: valuetype, value: valuedata }
                }
            } else {
                // non-writable patch parameters: read-only status the plugin's own
                // JS reads via the 'change' event (e.g. Audio File's waveform
                // preview data, sent once after a track loads) — same pending/live
                // split as the writable branch above, just routed to
                // setReadableParameterValue instead.
                if (GridParams.currentInstance() === instance) {
                    GridParams.currentGui().setReadableParameterValue(uri, valuetype, valuedata)
                } else {
                    pendingReadableParams[instance] = pendingReadableParams[instance] || {}
                    pendingReadableParams[instance][uri] = { valuetype: valuetype, value: valuedata }
                }
            }
            return
        }

        if (cmd === "connect") {
            var cdata = data.split(" ", 2)
            currentConnections[cdata[0] + '|' + cdata[1]] = [cdata[0], cdata[1]]
            if (!pbLoading) rewireChain()
            return
        }

        if (cmd === "disconnect") {
            var ddata = data.split(" ", 2)
            delete currentConnections[ddata[0] + '|' + ddata[1]]
            if (!pbLoading) rewireChain()
            return
        }

        if (cmd === "add") {
            var adata = data.split(" ", 7)
            var instance = adata[0], uri = adata[1]
            var x = parseFloat(adata[2]), y = parseFloat(adata[3])
            var bypassed = parseInt(adata[4]) != 0
            var pVersion = adata[5]
            if (GridBoard.hasInstance(instance)) return
            $.ajax({
                url: '/effect/get',
                data: { uri: uri, version: VERSION, plugin_version: pVersion },
                success: function (pluginData) {
                    var col = GridBoard.colFromX(x)
                    var row = GridBoard.rowFromY(y)
                    // no per-instance "currently active preset" is available from
                    // /effect/get (it's a cached, plugin-URI-keyed lookup, not
                    // instance-specific) — starts empty and is only ever set by
                    // the "preset" websocket broadcast (see below)
                    pluginData.preset = ''
                    GridBoard.addPluginBlock(instance, pluginData, bypassed, col, row)
                    if (!pbLoading) rewireChain()
                },
                cache: false,
                dataType: 'json',
            })
            return
        }

        if (cmd === "remove") {
            if (data === ":all") {
                GridBoard.reset()
                GridParams.close()
                currentConnections = {}
                pendingValues = {}
                pendingParams = {}
                pendingOutputs = {}
                pendingReadableParams = {}
                hwPortPlaced = {}
                renderShelf()
            } else {
                GridBoard.removeBlock(data)
                if (!pbLoading) rewireChain()
            }
            return
        }

        if (cmd === "add_hw_port") {
            var hdata = data.split(" ", 5)
            var instance = hdata[0], type = hdata[1]
            var isOutput = parseInt(hdata[2]) == 0 // reversed, matches host.js
            var rawName = hdata[3].replace(/_/g, " ")
            // Hardware ports are never auto-placed: they show up in the shelf and
            // the user drags them onto the grid, same as any plugin.
            hwPortLibrary[instance] = { type: type, isOutput: isOutput, name: friendlyHwName(rawName, type, isOutput) }
            renderShelfTabs()
            renderShelf(true)
            return
        }

        if (cmd === "remove_hw_port") {
            delete hwPortLibrary[data]
            delete hwPortPlaced[data]
            if (GridBoard.hasInstance(data)) {
                GridBoard.removeBlock(data)
                if (!pbLoading) rewireChain()
            }
            renderShelfTabs()
            renderShelf(true)
            return
        }

        if (cmd === "pedal_snapshot") {
            var sndata = data.split(" ", 1)
            currentSnapshotName = data.substr(sndata[0].length + 1)
            updateStatusLine()
            return
        }

        if (cmd === "loading_start") {
            pbLoading = true
            return
        }

        if (cmd === "loading_end") {
            pbLoading = false
            rewireChain()
            return
        }
    }
}

var activeShelfCategory = 'All'

// Mirrors effects.js's renderPlugin thumbnail resolution exactly, so shelf
// tiles show the same real pedal art as the default theme's plugin browser.
function pluginThumbnailUrl(p) {
    var uri = escape(p.uri)
    var ver = [p.builder, p.microVersion, p.minorVersion, p.release].join('_')
    var url = (p.gui && p.gui.thumbnail)
        ? ("/effect/image/thumbnail.png?uri=" + uri + "&v=" + ver)
        : "/resources/pedals/default-thumbnail.png"
    if (window.devicePixelRatio && window.devicePixelRatio >= 2) {
        url = url.replace("thumbnail", "screenshot")
    }
    return url
}

// Direction is a female jack (receptacle — signal from outside plugs in
// here) for inputs vs. a male jack (plug — signal comes out of here) for
// outputs, each paired with an arrow for the same direction: a socket-shape
// (ring + center hole) reads as "female", a plug-shape (solid head + pin)
// reads as "male" — both are standard connector pictograms, not invented
// from scratch.
function hwIconSvg(type, isOutput) {
    // isOutput is the graph-direction flag (see friendlyHwName/outputPortsOf)
    // — inverted here too, so the icon matches the physical-jack label: a
    // capture port (isOutput=true, labeled "In") gets the female/socket
    // icon, a playback port (isOutput=false, labeled "Out") gets the male/plug one
    if (!isOutput) {
        // male jack (plug) on the left, arrow continuing the signal out to the right
        return '<svg class="grid-shelf-item-thumb" viewBox="0 0 24 24">' +
            '<circle cx="7" cy="12" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/>' +
            '<line x1="12.5" y1="12" x2="16" y2="12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
            '<path d="M15.5 8l4.5 4-4.5 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
            '</svg>'
    }
    // female jack (socket) on the right, arrow feeding into it from the left
    return '<svg class="grid-shelf-item-thumb" viewBox="0 0 24 24">' +
        '<path d="M1 12h4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
        '<path d="M4 8l4.5 4-4.5 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<circle cx="17" cy="12" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/>' +
        '<circle cx="17" cy="12" r="1.8" fill="currentColor"/>' +
        '</svg>'
}

// Mirrors GridBoard's internal makeBlockNameEl: single-line label that scrolls
// (rather than wraps or gets clipped) when it doesn't fit its fixed-size box.
function makeMarqueeLabel(className, label) {
    var el = $('<div class="' + className + '">').text(label)
    setTimeout(function () {
        if (el[0].scrollWidth > el[0].clientWidth + 1) {
            el.empty().addClass('grid-marquee')
            var track = $('<div class="grid-marquee-track">').css('animation-delay', marqueePhaseDelay())
            track.append($('<span>').text(label)).append($('<span>').text(label))
            el.append(track)
        }
    }, 0)
    return el
}

function buildShelfTile(label, color, dragPayload, thumbUrl, iconSvg) {
    var tile = $('<div class="grid-shelf-item">').attr('draggable', 'true')
    tile.css('border-top-color', color)
    if (iconSvg) {
        tile.append($(iconSvg).css('color', color))
    } else if (thumbUrl) {
        var img = $('<img class="grid-shelf-item-thumb">').attr('src', thumbUrl)
        img.on('error', function () { img.attr('src', '/resources/pedals/default-thumbnail.png') })
        tile.append(img)
    }
    tile.append(makeMarqueeLabel('grid-shelf-item-label', label))
    tile.on('dragstart', function (ev) {
        ev.originalEvent.dataTransfer.setData('application/x-grid-shelf-item', JSON.stringify(dragPayload))
        ev.originalEvent.dataTransfer.effectAllowed = 'copy'
    })
    return tile
}

function renderShelfTabs() {
    var tabs = $('#grid-shelf-tabs')
    tabs.empty()
    var counts = {}
    pluginLibrary.forEach(function (p) {
        var cat = p.category && p.category[0]
        if (cat) counts[cat] = (counts[cat] || 0) + 1
    })

    function addTab(name) {
        var tab = $('<div class="grid-shelf-tab">').text(name)
        if (name === activeShelfCategory) tab.addClass('grid-shelf-tab-active')
        tab.click(function () {
            activeShelfCategory = name
            renderShelfTabs()
            renderShelf()
        })
        tabs.append(tab)
    }

    addTab('All')
    CATEGORY_ORDER.forEach(function (cat) { if (counts[cat]) addTab(cat) })
    if (Object.keys(hwPortLibrary).length) addTab('I/O')
}

// preservePage: keep the current page (re-clamped) instead of snapping back
// to page 1 — used when the tile set changes incidentally in the background
// (e.g. a hardware port list update) rather than because the user picked a
// new category or typed a search, where jumping back to page 1 makes sense.
function renderShelf(preservePage) {
    var track = $('#grid-shelf-track')
    track.empty()
    var term = ($('#grid-shelf-search').val() || '').toLowerCase()
    var cat = activeShelfCategory

    if (cat === 'All' || cat === 'I/O') {
        Object.keys(hwPortLibrary).forEach(function (instance) {
            if (hwPortPlaced[instance]) return
            var hw = hwPortLibrary[instance]
            if (term && hw.name.toLowerCase().indexOf(term) < 0) return
            track.append(buildShelfTile(hw.name, CATEGORY_COLORS['I/O'], {
                kind: 'hw', instance: instance, type: hw.type, isOutput: hw.isOutput, name: hw.name,
            }, null, hwIconSvg(hw.type, hw.isOutput)))
        })
    }

    if (cat !== 'I/O') {
        pluginLibrary.filter(function (p) {
            if (cat !== 'All' && (!p.category || p.category[0] !== cat)) return false
            return !term || (p.label || '').toLowerCase().indexOf(term) >= 0 ||
                (p.brand || '').toLowerCase().indexOf(term) >= 0
        }).forEach(function (p) {
            track.append(buildShelfTile(p.label || p.uri, categoryColor(p), { kind: 'plugin', uri: p.uri }, pluginThumbnailUrl(p)))
        })
    }

    updateShelfListWidth()
    if (preservePage) {
        pageShelf(0) // re-clamp against the (possibly changed) item count and redraw at the same page
    } else {
        shelfPage = 0
        track.css('transform', 'translateX(0)')
    }
}

// Clips the visible viewport (#grid-shelf-list) to a whole number of tiles.
// Left to its natural flex:1 width, the viewport is rarely an exact multiple
// of the tile step, so a sliver of the next tile always peeks in at the edge
// — harmless in principle but reads as a rendering bug (a tile stuck half
// cut off).
function updateShelfListWidth() {
    var list = $('#grid-shelf-list')
    var track = $('#grid-shelf-track')
    list.css('flex', '') // back to the CSS default flex:1 so the natural width can be measured
    var items = track.children('.grid-shelf-item')
    if (!items.length) return
    var naturalWidth = list.width()
    var itemStep = items.length > 1
        ? (items.eq(1).position().left - items.eq(0).position().left)
        : items.eq(0).outerWidth()
    if (!itemStep) return
    var itemsPerPage = Math.max(1, Math.floor(naturalWidth / itemStep))
    list.css('flex', '0 0 ' + (itemsPerPage * itemStep) + 'px')
}

// The shelf never scrolls on its own (no touch/wheel/drag scrolling) — the
// arrow buttons are the only way to move, one full page of tiles at a time.
// Paging by the raw viewport width (as opposed to a whole number of items)
// only lines up on item boundaries when the width happens to be an exact
// multiple of the item step, so it otherwise leaves a tile sliced in half at
// the edge of every page after the first — paging by itemsPerPage*itemStep
// instead guarantees every page starts flush on an item boundary.
var shelfPage = 0
function pageShelf(dir) {
    var list = $('#grid-shelf-list')
    var track = $('#grid-shelf-track')
    var items = track.children('.grid-shelf-item')
    if (!items.length) return
    var pageWidth = list.width()
    var itemStep = items.length > 1
        ? (items.eq(1).position().left - items.eq(0).position().left)
        : items.eq(0).outerWidth()
    if (!itemStep) return
    var itemsPerPage = Math.max(1, Math.floor(pageWidth / itemStep))
    var stepPx = itemsPerPage * itemStep
    var maxPage = Math.max(0, Math.ceil(items.length / itemsPerPage) - 1)
    shelfPage = Math.min(maxPage, Math.max(0, shelfPage + dir))
    track.css('transform', 'translateX(-' + (shelfPage * stepPx) + 'px)')
}

function loadShelf() {
    $.ajax({
        url: '/effect/list',
        cache: false,
        dataType: 'json',
        success: function (plugins) {
            pluginLibrary = plugins || []
            renderShelfTabs()
            renderShelf()
        },
    })
    $('#grid-shelf-search').on('input', renderShelf)

    $('#grid-shelf-nav-left').click(function () { pageShelf(-1) })
    $('#grid-shelf-nav-right').click(function () { pageShelf(1) })

    $('#grid-shelf-toggle').click(function () {
        var collapsed = $('body').toggleClass('grid-shelf-collapsed').hasClass('grid-shelf-collapsed')
        $(this).html(collapsed ? '&#9660;' : '&#9650;').attr('title', collapsed ? 'Show plugin shelf' : 'Hide plugin shelf')
        try { localStorage.setItem('grid-shelf-collapsed', collapsed ? '1' : '') } catch (e) {}
    })
    try {
        if (localStorage.getItem('grid-shelf-collapsed')) $('#grid-shelf-toggle').click()
    } catch (e) {}
}

function hwPortPlace(hw, col, row) {
    var block = GridBoard.addHardwareBlock(hw.instance, hw.type, hw.isOutput, hw.name, col, row)
    if (!block) {
        notify('error', 'No free grid cell')
        return
    }
    hwPortPlaced[hw.instance] = true
    pedalboardModified = true
    renderShelf(true)
    autoConnectAdjacent(hw.instance)
    rewireChain()
}

$(document).ready(function () {
    try {
        var savedZoom = parseFloat(localStorage.getItem('grid-ui-zoom'))
        if (savedZoom) zoomUi(savedZoom)
    } catch (e) {}
    updateHeaderHeight()

    var headerResizeTimer = null
    $(window).on('resize', function () {
        clearTimeout(headerResizeTimer)
        headerResizeTimer = setTimeout(updateHeaderHeight, 150)
    })

    GridParams.init()
    GridConnectDialog.init()
    loadShelf()
    refreshCurrentBankName()
    updateEmptyState()
    $('#grid-canvas-empty-open-nav').click(function () { GridNav.open() })
    $('#grid-unbanked-add').click(function () {
        if (GridNav && GridNav.addCurrentToBank) GridNav.addCurrentToBank()
        else GridNav.open()
    })

    GridNav.init({
        loadPedalboard: function (bundlepath, title) {
            if (pedalboardModified && !window.confirm('Load "' + title + '"? Unsaved changes to the current pedalboard will be lost.')) {
                return
            }
            $.ajax({
                url: '/pedalboard/load_bundle/',
                type: 'POST',
                data: { bundlepath: bundlepath, isDefault: 0 },
                success: function (resp) {
                    if (!resp || !resp.ok) {
                        notify('error', "Couldn't load pedalboard")
                        return
                    }
                    BUNDLE_PATH = bundlepath
                    PEDALBOARD_TITLE = resp.name
                    $('#grid-title').text(resp.name)
                    pedalboardModified = false
                    currentSnapshotName = null
                    refreshCurrentBankName()
                    updateEmptyState()
                    GridNav.close()
                    try {
                        var saved = JSON.parse(localStorage.getItem('grid-dimensions:' + BUNDLE_PATH) || 'null')
                        if (saved) GridBoard.setDimensions(saved.cols, saved.rows)
                    } catch (e) {}
                },
                error: function () { notify('error', "Couldn't load pedalboard") },
                cache: false,
                dataType: 'json',
            })
        },
        loadSnapshot: function (idx) {
            $.ajax({
                url: '/snapshot/load',
                data: { id: idx },
                success: function (ok) {
                    if (!ok) notify('error', "Couldn't load snapshot")
                },
                error: function () { notify('error', "Couldn't load snapshot") },
                cache: false,
                dataType: 'json',
            })
        },
    })

    GridBoard.init({
        onEmptyCellClick: function (col, row) {},
        onSelect: function (instance) { openPanelFor(instance) },
        onDeselect: function () { GridParams.close() },
        onRemoveRequested: function (instance) {
            var block = GridBoard.getBlock(instance)
            if (!block) return
            var label = block.isHardware ? block.el.find('.grid-block-name').text() : (block.pluginData.label || instance)
            if (!window.confirm('Remove "' + label + '"?')) return
            if (block.isHardware) {
                GridBoard.removeBlock(instance)
                delete hwPortPlaced[instance]
                pedalboardModified = true
                renderShelf(true)
                rewireChain()
            } else {
                pluginRemove(instance)
            }
        },
        onShelfItemDropped: function (payload, col, row) {
            if (!BUNDLE_PATH) {
                notify('error', 'Create or open a pedalboard first')
                return
            }
            if (payload.kind === 'plugin') pluginAdd(payload.uri, col, row)
            else if (payload.kind === 'hw') hwPortPlace(payload, col, row)
        },
        onManualConnect: function (fromInstance, toInstance) { manualConnect(fromInstance, toInstance) },
        onManualDisconnect: function (fromInstance, toInstance) { disconnectManualLink(fromInstance, toInstance) },
        onBlockMoved: function (instance) {
            var block = GridBoard.getBlock(instance)
            if (block && !block.isHardware) {
                var cell = GridBoard.cellSize()
                ws.send("plugin_pos " + instance + " " + (block.col * (cell.w + cell.gap)) + " " + (block.row * (cell.h + cell.gap)))
            }
            pedalboardModified = true
            rewireChain()
        },
        onDimensionsChanged: function (cols, rows) {
            try {
                localStorage.setItem('grid-dimensions:' + BUNDLE_PATH, JSON.stringify({ cols: cols, rows: rows }))
            } catch (e) {}
            updateDimensionsCount()
        },
    })

    function updateDimensionsCount() {
        var d = GridBoard.getDimensions()
        $('#grid-cols-count').text(d.cols)
        $('#grid-rows-count').text(d.rows)
    }

    try {
        var saved = JSON.parse(localStorage.getItem('grid-dimensions:' + BUNDLE_PATH) || 'null')
        if (saved) GridBoard.setDimensions(saved.cols, saved.rows)
    } catch (e) {}
    updateDimensionsCount()

    $('#grid-col-add').click(function () {
        var d = GridBoard.getDimensions()
        GridBoard.setDimensions(d.cols + 1, d.rows)
    })
    $('#grid-col-remove').click(function () {
        var d = GridBoard.getDimensions()
        if (!GridBoard.setDimensions(d.cols - 1, d.rows)) {
            notify('error', 'Remove or move the blocks in the last column first')
        }
    })
    $('#grid-row-add').click(function () {
        var d = GridBoard.getDimensions()
        GridBoard.setDimensions(d.cols, d.rows + 1)
    })
    $('#grid-row-remove').click(function () {
        var d = GridBoard.getDimensions()
        if (!GridBoard.setDimensions(d.cols, d.rows - 1)) {
            notify('error', 'Remove or move the blocks in the last row first')
        }
    })

    $('#grid-zoom-in').click(function () { zoomUi(uiZoom + 0.1) })
    $('#grid-zoom-out').click(function () { zoomUi(uiZoom - 0.1) })

    $('#grid-save').click(function () {
        // Defensive: the button is disabled unless the pedalboard is in a
        // bank (see updateEmptyState), so a plain save always lands somewhere
        // the nav tree can show.
        if (!pedalboardIsSaveable()) {
            notify('error', 'Add this pedalboard to a bank before saving')
            return
        }
        var title = PEDALBOARD_TITLE || 'Untitled'
        $.ajax({
            url: '/pedalboard/save',
            type: 'POST',
            data: { title: title, asNew: 0 },
            success: function (result) {
                if (result && result.ok) {
                    notify('info', '"' + title + '" saved')
                    pedalboardModified = false
                    // so the Banks panel shows it (with the "add to a bank"
                    // prompt if it isn't in one yet)
                    if (typeof GridNav !== 'undefined' && GridNav.refresh) GridNav.refresh()
                } else {
                    notify('error', "Couldn't save pedalboard")
                }
            },
            error: function () { notify('error', "Couldn't save pedalboard") },
            cache: false,
            dataType: 'json',
        })
    })

    $('#grid-shutdown').click(function () {
        if (!window.confirm('Power off the device? Any unsaved changes will be lost, and it will need to be turned back on manually.')) return
        $.ajax({
            url: '/system/exechange',
            type: 'POST',
            data: { type: 'command', cmd: 'poweroff' },
            success: function (resp) {
                if (resp) {
                    expectingShutdown = true
                    notify('info', 'Shutting down...')
                } else {
                    notify('error', "Couldn't power off the device")
                }
            },
            error: function () { notify('error', "Couldn't power off the device") },
            cache: false,
            dataType: 'json',
        })
    })

    connectWebSocket()
})
