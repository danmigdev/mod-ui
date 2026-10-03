// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * GridMidi -- the grid theme's "MIDI devices" dialog.
 *
 * Driven against the REAL html/js/grid-midi.js with a stubbed $.ajax. Covers
 * the request/response shape against /jack/get_midi_devices and
 * /jack/set_midi_devices, the Loopback special-casing and the apply payload.
 */

const { test, beforeEach } = require('node:test')
const assert = require('node:assert')
const { makeWindow } = require('./harness')

let ctx, $, M, posted

const BODY =
    '<button id="grid-midi-open"></button>' +
    '<div id="grid-midi-overlay" class="grid-hidden"><div class="grid-settings-inner">' +
    '  <button id="grid-midi-close"></button>' +
    '  <div id="grid-midi-list"></div>' +
    '  <label><input type="radio" name="grid-midi-mode" value="separated"></label>' +
    '  <label><input type="radio" name="grid-midi-mode" value="aggregated"></label>' +
    '  <div id="grid-midi-loopback-row" class="grid-hidden"><input type="checkbox" id="grid-midi-loopback"></div>' +
    '  <button id="grid-midi-cancel"></button><button id="grid-midi-apply"></button>' +
    '</div></div>'

const DEVICES = {
    devsInUse: ['dev-a', 'loop'],
    devList: ['dev-a', 'dev-b', 'loop'],
    names: { 'dev-a': 'Keystation', 'dev-b': 'Launchpad', 'loop': 'MIDI Loopback' },
    midiAggregatedMode: false,
}

beforeEach(() => {
    ctx = makeWindow({ url: 'http://localhost/', body: BODY })
    $ = ctx.$
    ctx.window.notify = () => {}
    posted = null
    ctx.$.ajax = (o) => {
        if ((o.url || '').indexOf('/jack/get_midi_devices') >= 0) {
            o.success(JSON.parse(JSON.stringify(DEVICES)))
        } else if ((o.url || '').indexOf('/jack/set_midi_devices') >= 0) {
            posted = JSON.parse(o.data)
            o.success(true)
        }
        return { done: () => {} }
    }
    ctx.window.eval('var GridMidi;')
    ctx.load('js/grid-midi.js')
    M = ctx.window.GridMidi
    M.init()
})

test('open() lists hardware, ticks in-use ports, hides Loopback from the list', () => {
    M.open()
    assert.ok(!$('#grid-midi-overlay').hasClass('grid-hidden'))
    const rows = $('#grid-midi-list .grid-midi-row')
    assert.equal(rows.length, 2) // dev-a, dev-b -- NOT the loopback
    assert.equal($('#grid-midi-list input[value="dev-a"]').prop('checked'), true)
    assert.equal($('#grid-midi-list input[value="dev-b"]').prop('checked'), false)
    // loopback surfaced in its own row instead
    assert.ok(!$('#grid-midi-loopback-row').hasClass('grid-hidden'))
    assert.equal($('#grid-midi-loopback').prop('checked'), true)
    assert.equal($('input[name="grid-midi-mode"][value="separated"]').prop('checked'), true)
})

test('apply posts the ticked devices plus mode and loopback flags', () => {
    M.open()
    $('#grid-midi-list input[value="dev-b"]').prop('checked', true)
    $('#grid-midi-list input[value="dev-a"]').prop('checked', false)
    $('input[name="grid-midi-mode"][value="aggregated"]').prop('checked', true)
    $('#grid-midi-loopback').prop('checked', false)

    $('#grid-midi-apply').trigger('click')

    assert.deepEqual(posted.devs, ['dev-b'])
    assert.equal(posted.midiAggregatedMode, true)
    assert.equal(posted.midiLoopback, false)
    assert.ok($('#grid-midi-overlay').hasClass('grid-hidden')) // closes on apply
})

test('cancel closes without posting', () => {
    M.open()
    $('#grid-midi-cancel').trigger('click')
    assert.ok($('#grid-midi-overlay').hasClass('grid-hidden'))
    assert.equal(posted, null)
})

test('no MIDI hardware -> a friendly empty message, no rows', () => {
    ctx.$.ajax = (o) => {
        if ((o.url || '').indexOf('get_midi_devices') >= 0) {
            o.success({ devsInUse: [], devList: [], names: {}, midiAggregatedMode: true })
        }
        return { done: () => {} }
    }
    M.open()
    assert.equal($('#grid-midi-list .grid-midi-row').length, 0)
    assert.ok($('#grid-midi-list').text().indexOf('No MIDI hardware') >= 0)
    assert.ok($('#grid-midi-loopback-row').hasClass('grid-hidden'))
})
