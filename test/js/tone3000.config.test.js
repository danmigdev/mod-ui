// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * tone3000Box when the deployment has no TONE3000 key.
 *
 * The publishable key is never committed: it comes from MOD_TONE3000_CLIENT_ID or a key
 * file (see mod/settings.py), so it can legitimately be empty. "t3k_pub_REPLACE_ME" is
 * also treated as unset, in case a fork hardcodes the placeholder. Either way the flow
 * cannot start and the panel has to say so rather than opening a popup that only fails
 * at TONE3000.
 *
 * Driven against the REAL html/js/tone3000.js.
 */

const { test, beforeEach } = require('node:test')
const assert = require('node:assert')
const { makeWindow, captureWindowOptions } = require('./harness')

const AUTO_OPEN_KEY = 't3k_auto_open'
const BODY = '<div id="t3k">' +
             '<div id="tone3000-wrapper"></div>' +
             '<button id="tone3000-browse">Open TONE3000</button>' +
             '<input type="checkbox" id="tone3000-autoopen">' +
             '</div>'

let ctx, $, getOptions, opened

function loadWith(clientId) {
    ctx = makeWindow({ url: 'http://localhost:8888/', body: BODY })
    $ = ctx.$
    getOptions = captureWindowOptions(ctx)
    opened = 0
    ctx.window.open = () => { opened++; return { closed: false, focus() {}, close() {}, location: '' } }
    ctx.window.alert = () => {}
    ctx.window.TONE3000_CLIENT_ID = clientId
    ctx.window.TONE3000_API = 'https://www.tone3000.com'
    Object.defineProperty(ctx.window, 'crypto', {
        value: { getRandomValues: a => a, subtle: { digest: () => new Promise(() => {}) } },
        configurable: true,
    })
    ctx.window.btoa = s => Buffer.from(s, 'binary').toString('base64')
    ctx.load('js/tone3000.js')
}

const initBox = () => $('#t3k').tone3000Box({})

test('the shipped placeholder counts as not configured', () => {
    loadWith('t3k_pub_REPLACE_ME')
    assert.equal(ctx.window.tone3000Configured(), false)
})

test('an empty client id counts as not configured', () => {
    loadWith('')
    assert.equal(ctx.window.tone3000Configured(), false)
})

test('a real t3k_pub_ key counts as configured', () => {
    loadWith('t3k_pub_abc123')
    assert.equal(ctx.window.tone3000Configured(), true)
})

test('with the placeholder, the browse button is disabled and inert', () => {
    loadWith('t3k_pub_REPLACE_ME')
    initBox()
    const browse = $('#tone3000-browse')
    assert.equal(browse.prop('disabled'), true)
    browse.trigger('click')
    assert.equal(opened, 0, 'no popup opened')
})

test('with the placeholder, a "not set up" hint is shown in the panel', () => {
    loadWith('t3k_pub_REPLACE_ME')
    initBox()
    assert.match($('#tone3000-wrapper').text(), /no TONE3000 publishable key/i)
})

test('with the placeholder, auto-open does nothing even when the pref is on', () => {
    loadWith('t3k_pub_REPLACE_ME')
    ctx.window.localStorage.setItem(AUTO_OPEN_KEY, '1')
    initBox()
    getOptions().open()
    assert.equal(opened, 0)
})

test('with a real key, the browse button opens the popup', () => {
    loadWith('t3k_pub_abc123')
    initBox()
    assert.notEqual($('#tone3000-browse').prop('disabled'), true)
    $('#tone3000-browse').trigger('click')
    assert.equal(opened, 1)
})
