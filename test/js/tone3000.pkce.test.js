// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

/*
 * The PKCE code challenge in html/js/tone3000.js.
 *
 * crypto.subtle only exists in a secure context. mod-ui on the device is served over
 * plain http on a LAN IP, where it is absent -- and TONE3000 accepts the S256 method
 * only, so the SHA-256 still has to be produced. tone3000.js carries a pure-JS SHA-256
 * for exactly that case.
 *
 * Driven against the REAL source. These pin:
 *   - the JS fallback matches node's crypto for inputs across every block boundary;
 *   - it produces the canonical RFC 7636 Appendix B challenge;
 *   - crypto.subtle is still used when it is available.
 */

const { test, beforeEach } = require('node:test')
const assert = require('node:assert')
const nodeCrypto = require('node:crypto')
const { makeWindow } = require('./harness')

let ctx

function base64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function refChallenge(verifier) {
    return base64url(nodeCrypto.createHash('sha256').update(verifier).digest())
}

beforeEach(() => {
    ctx = makeWindow({ url: 'http://localhost:8888/' })
    // tone3000.js registers the tone3000Box JqueryClass at load; this suite never builds
    // the box, so a no-op is enough. It also needs btoa for tone3000Base64Url.
    ctx.window.JqueryClass = () => {}
    ctx.window.btoa = s => Buffer.from(s, 'binary').toString('base64')
    ctx.load('js/tone3000.js')
})

// Force the no-SubtleCrypto path: define crypto with getRandomValues but no subtle,
// the way a non-secure context actually looks.
function withoutSubtle() {
    Object.defineProperty(ctx.window, 'crypto', {
        value: { getRandomValues: a => a },
        configurable: true,
    })
}

test('fallback produces the RFC 7636 Appendix B code challenge', async () => {
    withoutSubtle()
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const challenge = await ctx.window.tone3000Sha256Base64Url(verifier)
    assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('fallback digest matches node crypto across block boundaries', async () => {
    withoutSubtle()
    const inputs = [
        '', 'a', 'abc',
        'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(57),   // one-block padding edge
        'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65),   // block edge
        'x'.repeat(119), 'x'.repeat(120), 'x'.repeat(128),
        base64url(nodeCrypto.randomBytes(32)),            // a real 43-char verifier shape
    ]
    for (const s of inputs) {
        assert.equal(await ctx.window.tone3000Sha256Base64Url(s), refChallenge(s),
                     `digest mismatch for length ${s.length}`)
    }
})

test('crypto.subtle is preferred when present', async () => {
    let subtleCalls = 0
    Object.defineProperty(ctx.window, 'crypto', {
        value: {
            getRandomValues: a => a,
            subtle: {
                digest: (algo, bytes) => {
                    subtleCalls++
                    assert.equal(algo, 'SHA-256')
                    return Promise.resolve(nodeCrypto.createHash('sha256').update(Buffer.from(bytes)).digest())
                },
            },
        },
        configurable: true,
    })

    const challenge = await ctx.window.tone3000Sha256Base64Url('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
    assert.equal(subtleCalls, 1)
    assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})
