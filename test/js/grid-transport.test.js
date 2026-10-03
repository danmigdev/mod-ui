// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * GridTransport -- the grid theme's toolbar transport controls.
 *
 * Driven against the REAL html/js/grid-transport.js with a fake websocket and
 * a stubbed $.ajax. Covers the wire protocol (transport-rolling / -bpm / -bpb),
 * the server->UI direction, clamping, tap tempo and the sync-mode lock.
 */

const { test, beforeEach } = require('node:test')
const assert = require('node:assert')
const { makeWindow } = require('./harness')

let ctx, $, T, sent

const BODY =
    '<span id="grid-transport-group">' +
    '  <button id="grid-transport-play"></button>' +
    '  <button id="grid-bpm-dec"></button>' +
    '  <span id="grid-bpm-value">--</span>' +
    '  <button id="grid-bpm-inc"></button>' +
    '  <button id="grid-bpm-tap"></button>' +
    '</span>' +
    '<select id="grid-sync-select">' +
    '  <option value="none">Internal</option>' +
    '  <option value="midi_clock_slave">MIDI clock slave</option>' +
    '  <option value="link">Ableton Link</option>' +
    '</select>' +
    '<button id="grid-bpb-dec"></button><span id="grid-bpb-value">4</span><button id="grid-bpb-inc"></button>'

beforeEach(() => {
    ctx = makeWindow({ url: 'http://localhost/', body: BODY })
    $ = ctx.$
    ctx.window.notify = () => {}
    sent = []
    ctx.window.ws = { readyState: 1, send: (m) => sent.push(m) }
    ctx.window.eval('var GridTransport;')
    ctx.load('js/grid-transport.js')
    T = ctx.window.GridTransport
    T.init()
})

test('fromServer renders state and sends nothing back', () => {
    T.fromServer(true, 3, 128, 'none')
    assert.equal($('#grid-bpm-value').text(), '128')
    assert.equal($('#grid-bpb-value').text(), '3')
    assert.ok($('#grid-transport-play').hasClass('grid-transport-playing'))
    assert.deepEqual(sent, [])
})

test('play button toggles rolling over the websocket', () => {
    T.fromServer(false, 4, 120, 'none')
    $('#grid-transport-play').trigger('click')
    assert.deepEqual(sent, ['transport-rolling 1'])
    $('#grid-transport-play').trigger('click')
    assert.deepEqual(sent, ['transport-rolling 1', 'transport-rolling 0'])
})

test('BPM steppers send transport-bpm and clamp to 20..280', () => {
    T.fromServer(false, 4, 21, 'none')
    $('#grid-bpm-dec').trigger('click')
    $('#grid-bpm-dec').trigger('click')
    assert.equal(sent[sent.length - 1], 'transport-bpm 20')
    assert.equal($('#grid-bpm-value').text(), '20')

    T.fromServer(false, 4, 279, 'none')
    sent = []
    $('#grid-bpm-inc').trigger('click')
    $('#grid-bpm-inc').trigger('click')
    assert.equal(sent[sent.length - 1], 'transport-bpm 280')
})

test('BPB steppers send transport-bpb and clamp to 1..16', () => {
    T.fromServer(false, 1, 120, 'none')
    $('#grid-bpb-dec').trigger('click')
    assert.equal($('#grid-bpb-value').text(), '1')
    assert.ok(!sent.includes('transport-bpb 0'))

    $('#grid-bpb-inc').trigger('click')
    assert.equal(sent[sent.length - 1], 'transport-bpb 2')
    assert.equal($('#grid-bpb-value').text(), '2')
})

test('tap tempo averages intervals into a BPM', () => {
    T.fromServer(false, 4, 120, 'none')
    T._internals.tapReset()
    let now = 1_000_000
    const realNow = ctx.window.Date.now
    ctx.window.Date.now = () => now
    try {
        $('#grid-bpm-tap').trigger('click')          // 1st tap: nothing yet
        now += 400; $('#grid-bpm-tap').trigger('click') // 400ms -> 150 BPM
        now += 400; $('#grid-bpm-tap').trigger('click')
        now += 400; $('#grid-bpm-tap').trigger('click')
    } finally {
        ctx.window.Date.now = realNow
    }
    const last = sent[sent.length - 1]
    assert.ok(/^transport-bpm /.test(last), last)
    assert.ok(Math.abs(parseFloat(last.split(' ')[1]) - 150) < 0.5, last)
})

test('MIDI-clock-slave / Link lock the BPM controls', () => {
    let posted = null
    ctx.$.ajax = (o) => { posted = o.url; o.success(true); return { done: () => {} } }

    $('#grid-sync-select').val('midi_clock_slave').trigger('change')
    assert.equal(posted, '/pedalboard/transport/set_sync_mode/midi_clock_slave')
    assert.ok($('#grid-bpm-inc').prop('disabled'))
    assert.ok($('#grid-bpm-tap').prop('disabled'))

    $('#grid-sync-select').val('none').trigger('change')
    assert.ok(!$('#grid-bpm-inc').prop('disabled'))
})

test('a failed sync-mode change reverts the select', () => {
    ctx.$.ajax = (o) => { o.success(false); return { done: () => {} } }
    $('#grid-sync-select').val('link').trigger('change')
    assert.equal($('#grid-sync-select').val(), 'none')
})

test('nothing is sent while the websocket is closed', () => {
    ctx.window.ws.readyState = 3
    T.fromServer(false, 4, 120, 'none')
    $('#grid-transport-play').trigger('click')
    assert.deepEqual(sent, [])
})
