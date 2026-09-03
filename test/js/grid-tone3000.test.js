// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * GridTone3000 -- the grid theme's embedded TONE3000 browser.
 *
 * Driven against the REAL html/js/grid-tone3000.js. jsdom has no layout, no real
 * window.open and (here) no fetch, so this covers the PKCE, the authorize URL, the
 * filename scheme, the configured/connected gating and the disconnected render --
 * not the popup placement or live API calls.
 */

const { test, beforeEach } = require('node:test')
const assert = require('node:assert')
const nodeCrypto = require('node:crypto')
const { makeWindow } = require('./harness')

let ctx, $, T3K

function base64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

const BODY =
    '<div id="grid-tone3000-toggle"></div>' +
    '<div id="grid-t3k-overlay" class="grid-hidden"><div class="grid-t3k-inner">' +
    '  <div class="grid-t3k-header">' +
    '    <input id="grid-t3k-search"><select id="grid-t3k-sort"></select>' +
    '    <select id="grid-t3k-arch"><option value=""></option><option value="2">a2</option></select>' +
    '    <select id="grid-t3k-size"><option value=""></option><option value="lite">lite</option></select>' +
    '    <span id="grid-t3k-count"></span>' +
    '    <span id="grid-t3k-connectbar" class="grid-hidden"><button id="grid-t3k-disconnect"></button></span>' +
    '    <button id="grid-t3k-close"></button>' +
    '  </div>' +
    '  <div id="grid-t3k-status"></div><div id="grid-t3k-grid"></div><div id="grid-t3k-pager"></div>' +
    '</div></div>' +
    '<div id="grid-t3k-detail-overlay" class="grid-hidden"><div id="grid-t3k-detail-inner"></div></div>'

beforeEach(() => {
    ctx = makeWindow({ url: 'http://192.168.7.7/', body: BODY })
    $ = ctx.$
    ctx.window.notify = () => {}
    ctx.window.TONE3000_CLIENT_ID = 't3k_pub_realkey'
    ctx.window.TONE3000_API = 'https://www.tone3000.com'
    // insecure-context shape: getRandomValues but no subtle -> exercises the JS SHA-256
    Object.defineProperty(ctx.window, 'crypto', {
        value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = i & 255; return a } },
        configurable: true,
    })
    ctx.window.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
    ctx.load('js/grid-tone3000.js')
    T3K = ctx.window.GridTone3000
    T3K.init()
})

test('configured() rejects the placeholder and empty, accepts a real key', () => {
    const cfg = T3K._internals.configured
    assert.equal(cfg(), true)
    ctx.window.TONE3000_CLIENT_ID = 't3k_pub_REPLACE_ME'
    assert.equal(cfg(), false)
    ctx.window.TONE3000_CLIENT_ID = ''
    assert.equal(cfg(), false)
})

test('SHA-256 fallback matches node crypto (RFC 7636 vector)', async () => {
    const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    assert.equal(await T3K._internals.sha256B64url(v), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    for (const s of ['', 'abc', 'x'.repeat(56), 'x'.repeat(64), base64url(nodeCrypto.randomBytes(32))]) {
        const ref = base64url(nodeCrypto.createHash('sha256').update(s).digest())
        assert.equal(await T3K._internals.sha256B64url(s), ref, 'len ' + s.length)
    }
})

test('buildAuthorizeUrl: S256, our redirect_uri, state persisted', async () => {
    const url = await T3K.buildAuthorizeUrl()
    const u = new URL(url)
    assert.equal(u.origin + u.pathname, 'https://www.tone3000.com/api/v1/oauth/authorize')
    assert.equal(u.searchParams.get('client_id'), 't3k_pub_realkey')
    assert.equal(u.searchParams.get('redirect_uri'), 'http://192.168.7.7/tone3000-connect.html')
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(u.searchParams.get('response_type'), 'code')
    assert.equal(u.searchParams.get('format'), 'nam')
    const state = u.searchParams.get('state')
    assert.ok(state && state.length > 10)
    assert.equal(ctx.window.sessionStorage.getItem('t3k_state'), state)
    assert.ok(ctx.window.sessionStorage.getItem('t3k_code_verifier'))
})

test('folder is named after the tone URL slug, with a title fallback', () => {
    const { folderFor } = T3K._internals
    assert.equal(folderFor({ id: 5, title: 'x', url: 'https://www.tone3000.com/tones/1234-fender-deluxe' }),
                 '1234-fender-deluxe')
    assert.equal(folderFor({ id: 5, title: 'x', url: '/tones/9f3a' }), '9f3a')
    // no url -> "<title> (<id>)"
    assert.equal(folderFor({ id: 42, title: 'Marshall JCM800' }), 'Marshall JCM800 (42)')
})

test('filename scheme: collisions get the model id', () => {
    const { fileNamesFor } = T3K._internals
    const tone = { id: 7, title: 'Marshall JCM800' }
    const names = fileNamesFor(tone, [{ id: 1, name: 'Clean' }, { id: 2, name: 'Clean' }, { id: 3, name: 'Crunch' }])
    assert.equal(names[0], 'Marshall JCM800 - Clean.nam')
    assert.equal(names[1], 'Marshall JCM800 - Clean (2).nam')
    assert.equal(names[2], 'Marshall JCM800 - Crunch.nam')
})

test('open() when not connected shows the Connect button, no search', () => {
    let fetched = false
    ctx.window.fetch = () => { fetched = true; return Promise.reject(new Error('no')) }
    T3K.open()
    assert.equal($('#grid-t3k-overlay').hasClass('grid-hidden'), false)
    assert.match($('#grid-t3k-grid').text(), /Connect your TONE3000 account/i)
    assert.equal($('#grid-t3k-grid button').length, 1)
    assert.equal(fetched, false)
})

test('open() when the key is a placeholder shows the not-set-up message', () => {
    ctx.window.TONE3000_CLIENT_ID = 't3k_pub_REPLACE_ME'
    T3K.open()
    assert.match($('#grid-t3k-grid').text(), /not set up on this device/i)
})

test('receiveTokens stores tokens and flips isConnected', () => {
    assert.equal(T3K.isConnected(), false)
    T3K.receiveTokens({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3600000 })
    assert.equal(T3K.isConnected(), true)
})

test('architecture + size filters go into the search query', async () => {
    const seen = []
    let resolvers = []
    ctx.window.fetch = (url) => {
        seen.push(String(url))
        return new Promise((resolve) => {
            resolvers.push(() => resolve({
                ok: true, status: 200, json: () => Promise.resolve({ data: [], total_pages: 1 }),
            }))
        })
    }
    T3K.receiveTokens({ access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 3600000 })
    await tick()

    // change both filters WHILE the previous request(s) are still in flight --
    // this is what a real user does, and a naive "if (loading) return" drops it
    $('#grid-t3k-arch').val('2').trigger('change')
    await tick()
    $('#grid-t3k-size').val('lite').trigger('change')
    await tick()

    // now let every pending fetch resolve
    resolvers.forEach((fn) => fn())
    await tick()

    const last = seen[seen.length - 1]
    assert.ok(last.indexOf('/api/v1/tones/search?') >= 0, 'hit search: ' + last)
    assert.ok(last.indexOf('architecture=2') >= 0, 'architecture kept: ' + last)
    assert.ok(last.indexOf('sizes=lite') >= 0, 'size kept: ' + last)
})

function tick() { return new Promise((r) => setTimeout(r, 5)) }
