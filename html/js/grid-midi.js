// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// MIDI devices dialog for the grid theme -- same backend as the classic UI's
// "MIDI Ports" window (see mididevices.js):
//   GET  /jack/get_midi_devices  -> { devsInUse, devList, names, midiAggregatedMode }
//   POST /jack/set_midi_devices  <- { devs, midiAggregatedMode, midiLoopback }
// Opened from the Settings overlay ("MIDI devices…").

var GridMidi = (function () {
    var inited = false
    var overlay, listEl, loopbackRow, loopbackCb
    // the JACK id ("system:midi_capture_1" style token) of the MIDI Loopback
    // device, kept aside so it isn't shown as a normal checkbox row
    var loopbackDev = null

    function fetchList(cb) {
        $.ajax({
            url: '/jack/get_midi_devices',
            type: 'GET', cache: false, dataType: 'json',
            success: function (resp) { cb(resp || {}) },
            error: function () {
                if (typeof notify === 'function') notify('error', "Couldn't read the MIDI device list")
            },
        })
    }

    function render(resp) {
        var devsInUse = resp.devsInUse || []
        var devList = resp.devList || []
        var names = resp.names || {}

        listEl.empty()
        loopbackDev = null
        var hasLoopback = false

        devList.forEach(function (dev) {
            var name = names[dev] || dev
            if (name === 'MIDI Loopback') {
                hasLoopback = true
                loopbackDev = dev
                loopbackCb.prop('checked', devsInUse.indexOf(dev) >= 0)
                return
            }
            var row = $('<label class="grid-midi-row">')
            var cb = $('<input type="checkbox" autocomplete="off">')
                .attr('value', dev)
                .prop('checked', devsInUse.indexOf(dev) >= 0)
            row.append(cb, $('<span>').text(name))
            listEl.append(row)
        })

        if (!listEl.children().length) {
            listEl.append($('<div class="grid-settings-hint">').text('No MIDI hardware detected.'))
        }

        loopbackRow.toggleClass('grid-hidden', !hasLoopback)

        var mode = resp.midiAggregatedMode ? 'aggregated' : 'separated'
        overlay.find('input[name="grid-midi-mode"][value="' + mode + '"]').prop('checked', true)
    }

    function apply() {
        var devs = []
        listEl.find('input:checked').each(function () { devs.push($(this).val()) })
        var aggregated = overlay.find('input[name="grid-midi-mode"]:checked').val() === 'aggregated'
        var loopback = !!loopbackCb.prop('checked')

        $.ajax({
            url: '/jack/set_midi_devices',
            type: 'POST', cache: false, dataType: 'json',
            data: JSON.stringify({
                devs: devs,
                midiAggregatedMode: aggregated,
                midiLoopback: loopback,
            }),
            success: function () {
                if (typeof notify === 'function') notify('info', 'MIDI devices updated')
            },
            error: function () {
                if (typeof notify === 'function') notify('error', "Couldn't apply the MIDI device changes")
            },
        })
        close()
    }

    function open() {
        fetchList(function (resp) {
            render(resp)
            overlay.removeClass('grid-hidden')
        })
    }

    function close() { overlay.addClass('grid-hidden') }

    return {
        init: function () {
            if (inited) return
            inited = true
            overlay = $('#grid-midi-overlay')
            listEl = $('#grid-midi-list')
            loopbackRow = $('#grid-midi-loopback-row')
            loopbackCb = $('#grid-midi-loopback')

            $('#grid-midi-open').click(open)
            $('#grid-midi-close, #grid-midi-cancel').click(close)
            $('#grid-midi-apply').click(apply)
            overlay.click(function (ev) { if (ev.target === overlay[0]) close() })
        },
        open: open,
    }
})()

$(document).ready(function () { GridMidi.init() })
