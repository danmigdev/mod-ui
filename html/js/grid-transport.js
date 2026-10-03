// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Transport controls for the grid theme: play/stop, tempo (BPM) and
// beats-per-bar, plus the tempo-sync source. The classic UI keeps these in a
// pop-out window with knobs (see transport.js); here they're a compact
// toolbar group with dec/value/inc steppers, matching the Cols/Rows/Zoom
// groups next to them.
//
// Wire protocol (same as transport.js):
//   in : "transport <rolling> <beatsPerBar> <beatsPerMinute> <syncMode>"
//        -- broadcast once after connect and on every change
//   out: ws "transport-rolling 0|1", "transport-bpb <n>", "transport-bpm <n>"
//        sync mode: POST /pedalboard/transport/set_sync_mode/<none|midi_clock_slave|link>

var GridTransport = (function () {
    var BPM_MIN = 20, BPM_MAX = 280
    var BPB_MIN = 1, BPB_MAX = 16

    var inited = false
    var playBtn, bpmValue, bpbValue, syncSel
    // last values the server told us; null until the first "transport" message
    var rolling = false
    var bpm = null
    var bpb = null
    var syncMode = 'none'

    // tap tempo: timestamps of recent taps, averaged into a BPM
    var taps = []
    var TAP_RESET_MS = 2000

    function wsSend(msg) {
        if (typeof ws !== 'undefined' && ws && ws.readyState === 1) {
            ws.send(msg)
            return true
        }
        return false
    }

    function clampBpm(v) { return Math.min(BPM_MAX, Math.max(BPM_MIN, v)) }
    function clampBpb(v) { return Math.min(BPB_MAX, Math.max(BPB_MIN, Math.round(v))) }

    function renderPlay() {
        if (!playBtn) return
        // U+25B6 play / U+23F8 pause
        playBtn.html(rolling ? '⏸' : '▶')
        playBtn.attr('aria-label', rolling ? 'Stop' : 'Play')
        playBtn.toggleClass('grid-transport-playing', rolling)
    }

    function renderBpm() {
        // don't yank the text out from under someone mid-edit
        if (bpmValue && !bpmValue.is(':focus')) bpmValue.text(bpm == null ? '--' : formatBpm(bpm))
    }

    function renderBpb() {
        if (bpbValue) bpbValue.text(bpb == null ? '--' : String(bpb))
    }

    function formatBpm(v) {
        // whole numbers show without a trailing ".0"; tapped/typed fractions
        // keep one decimal
        return (Math.round(v * 10) / 10).toString()
    }

    function renderSync() {
        if (!syncSel) return
        syncSel.val(syncMode)
        // BPM is driven externally in these modes -- the steppers/tap would
        // fight the clock, so grey them out (matches transport.js)
        var locked = (syncMode === 'midi_clock_slave' || syncMode === 'link')
        $('#grid-bpm-dec, #grid-bpm-inc, #grid-bpm-tap').prop('disabled', locked)
        if (bpmValue) bpmValue.attr('contenteditable', String(!locked))
        if (playBtn) playBtn.prop('disabled', syncMode === 'midi_clock_slave')
    }

    function setRolling(next) {
        if (next === rolling) return
        rolling = next
        renderPlay()
        wsSend('transport-rolling ' + (rolling ? '1' : '0'))
    }

    function setBpm(next, fromServer) {
        next = clampBpm(next)
        if (bpm != null && Math.abs(next - bpm) < 0.01) { renderBpm(); return }
        bpm = next
        renderBpm()
        if (!fromServer) wsSend('transport-bpm ' + bpm)
    }

    function setBpb(next, fromServer) {
        next = clampBpb(next)
        if (next === bpb) { renderBpb(); return }
        bpb = next
        renderBpb()
        if (!fromServer) wsSend('transport-bpb ' + bpb)
    }

    function setSyncMode(next, fromServer) {
        if (next === syncMode && !fromServer) return
        var prev = syncMode
        syncMode = next
        renderSync()
        if (fromServer) return
        $.ajax({
            url: '/pedalboard/transport/set_sync_mode/' + next,
            type: 'POST', cache: false, dataType: 'json',
            success: function (ok) {
                if (!ok) {
                    syncMode = prev
                    renderSync()
                    if (typeof notify === 'function') notify('error', "Couldn't change the tempo sync source")
                } else if (typeof notify === 'function') {
                    notify('info', 'Tempo sync: ' + syncSel.find('option:selected').text())
                }
            },
            error: function () {
                syncMode = prev
                renderSync()
                if (typeof notify === 'function') notify('error', "Couldn't change the tempo sync source")
            },
        })
    }

    function tap() {
        var now = Date.now()
        if (taps.length && now - taps[taps.length - 1] > TAP_RESET_MS) taps = []
        taps.push(now)
        if (taps.length < 2) return
        // keep the last few intervals only, so a tempo change settles quickly
        if (taps.length > 5) taps = taps.slice(-5)
        var intervals = []
        for (var i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1])
        var avg = intervals.reduce(function (a, b) { return a + b }, 0) / intervals.length
        if (avg > 0) setBpm(60000 / avg, false)
    }

    // only digits and one dot while typing a tempo into the value span
    function bpmKeydown(e) {
        if (e.keyCode === 13) { e.preventDefault(); bpmValue.blur(); return }
        var ok = (e.keyCode >= 48 && e.keyCode <= 57) || (e.keyCode >= 96 && e.keyCode <= 105) ||
                 e.keyCode === 8 || e.keyCode === 46 || e.keyCode === 37 || e.keyCode === 39 ||
                 e.keyCode === 190 || e.keyCode === 110 || e.keyCode === 9
        if (!ok) e.preventDefault()
    }

    function bpmCommit() {
        var typed = parseFloat(bpmValue.text())
        if (isNaN(typed)) { renderBpm(); return }
        setBpm(typed, false)
    }

    return {
        init: function () {
            if (inited) return
            inited = true
            playBtn = $('#grid-transport-play')
            bpmValue = $('#grid-bpm-value')
            bpbValue = $('#grid-bpb-value')
            syncSel = $('#grid-sync-select')

            playBtn.click(function () { setRolling(!rolling) })
            $('#grid-bpm-dec').click(function () { if (bpm != null) setBpm(bpm - 1, false) })
            $('#grid-bpm-inc').click(function () { if (bpm != null) setBpm(bpm + 1, false) })
            $('#grid-bpm-tap').click(tap)

            bpmValue.attr('contenteditable', 'true')
                .on('keydown', bpmKeydown)
                .on('blur', bpmCommit)
                .on('focus', function () {
                    // select the current text so typing replaces it
                    var r = document.createRange()
                    r.selectNodeContents(bpmValue[0])
                    var sel = window.getSelection()
                    sel.removeAllRanges()
                    sel.addRange(r)
                })

            $('#grid-bpb-dec').click(function () { if (bpb != null) setBpb(bpb - 1, false) })
            $('#grid-bpb-inc').click(function () { if (bpb != null) setBpb(bpb + 1, false) })

            syncSel.on('change', function () { setSyncMode(syncSel.val(), false) })

            renderPlay(); renderBpm(); renderBpb(); renderSync()
        },

        // called from grid-app.js's "transport" websocket handler
        fromServer: function (isRolling, beatsPerBar, beatsPerMinute, mode) {
            rolling = !!isRolling
            renderPlay()
            if (!isNaN(beatsPerBar)) setBpb(beatsPerBar, true)
            if (!isNaN(beatsPerMinute)) setBpm(beatsPerMinute, true)
            if (mode) setSyncMode(mode, true)
        },

        // test seam
        _internals: {
            clampBpm: clampBpm,
            clampBpb: clampBpb,
            formatBpm: formatBpm,
            tapReset: function () { taps = [] },
        },
    }
})()

$(document).ready(function () { GridTransport.init() })
