// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// TONE3000 catalog, browsed inside the grid theme's own panel -- search NAM
// captures, see each model's size/architecture, download the ones you want
// straight into "NAM Models". Built fresh in grid's style, like grid-store.js
// for Patchstorage; it does not reuse the default theme's tone3000.js (that
// one opens TONE3000's website in a popup).
//
// The one thing that still needs a window is the initial account sign-in:
// OAuth always makes the user authorise on the provider, and TONE3000's
// sign-in cookie is SameSite=Lax so it cannot happen in a cross-site iframe.
// That popup lands on tone3000-connect.html (our origin), hands the tokens
// back here, and closes itself. Everything after -- search, model listing,
// downloads -- is plain API calls rendered in this panel.
//
// TONE3000_CLIENT_ID / TONE3000_API come from grid.html's bootstrap script,
// the same server context grid() shares with index() (see mod/webserver.py).

var GridTone3000 = (function () {
    'use strict'

    // ── PKCE ────────────────────────────────────────────────────────────────
    // Self-contained: TONE3000 accepts the S256 method only (no `plain`), and
    // the device serves mod-ui over plain http on a LAN IP where crypto.subtle
    // does not exist -- so the SHA-256 has a pure-JS fallback. crypto.getRandomValues
    // works in an insecure context, only SubtleCrypto is gated.

    function b64url(bytes) {
        var s = String.fromCharCode.apply(null, new Uint8Array(bytes))
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    }

    function randB64url(n) {
        return b64url(crypto.getRandomValues(new Uint8Array(n)))
    }

    function sha256B64url(input) {
        var bytes = new TextEncoder().encode(input)
        if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
            return crypto.subtle.digest('SHA-256', bytes).then(b64url)
        }
        return Promise.resolve(b64url(sha256Bytes(bytes)))
    }

    // FIPS 180-4. Only reached without SubtleCrypto; only ever fed the PKCE verifier.
    function sha256Bytes(bytes) {
        var K = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ]
        var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
        function rotr(x, n) { return (x >>> n) | (x << (32 - n)) }

        var blockCount = ((bytes.length + 8) >> 6) + 1
        var buf = new Uint8Array(blockCount << 6)
        buf.set(bytes)
        buf[bytes.length] = 0x80
        var view = new DataView(buf.buffer)
        view.setUint32(buf.length - 8, Math.floor(bytes.length / 0x20000000), false)
        view.setUint32(buf.length - 4, (bytes.length * 8) >>> 0, false)

        var w = new Int32Array(64)
        for (var off = 0; off < buf.length; off += 64) {
            var i
            for (i = 0; i < 16; i++) w[i] = view.getUint32(off + (i << 2), false)
            for (i = 16; i < 64; i++) {
                var x15 = w[i - 15], x2 = w[i - 2]
                var s0 = rotr(x15, 7) ^ rotr(x15, 18) ^ (x15 >>> 3)
                var s1 = rotr(x2, 17) ^ rotr(x2, 19) ^ (x2 >>> 10)
                w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
            }
            var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
            for (i = 0; i < 64; i++) {
                var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
                var ch = (e & f) ^ (~e & g)
                var t1 = (hh + S1 + ch + K[i] + w[i]) | 0
                var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
                var maj = (a & b) ^ (a & c) ^ (b & c)
                var t2 = (S0 + maj) | 0
                hh = g; g = f; f = e; e = (d + t1) | 0
                d = c; c = b; b = a; a = (t1 + t2) | 0
            }
            h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0
            h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0
        }
        var out = new Uint8Array(32)
        var ov = new DataView(out.buffer)
        for (var j = 0; j < 8; j++) ov.setUint32(j << 2, h[j] >>> 0, false)
        return out
    }

    // ── constants / state ───────────────────────────────────────────────────
    var STATE_KEY = 't3k_state'
    var VERIFIER_KEY = 't3k_code_verifier'
    var TOKENS_KEY = 't3k_grid_tokens'
    var REDIRECT_PATH = '/tone3000-connect.html'
    var POPUP_NAME = 't3k_connect'
    var PLACEHOLDER = 't3k_pub_REPLACE_ME'

    var SIZE_HINT = { nano: 'lightest', feather: 'light', lite: 'medium', standard: 'heaviest' }
    var SORTS = [['trending', 'Trending'], ['newest', 'Newest'],
                 ['downloads-all-time', 'Most downloaded'], ['best-match', 'Best match']]

    var overlay, gridEl, searchInput, countEl, statusEl, sortSel, archSel, sizeSel
    var detailOverlay, detailInner, connectBar
    var connectPopup = null
    var refreshing = null
    var searchSeq = 0
    var loading = false
    var shownCount = 0
    var query = '', sort = 'trending', arch = '', sizeFilter = '', page = 1, totalPages = 1

    // ── token storage ───────────────────────────────────────────────────────
    function getStored() {
        try { return JSON.parse(sessionStorage.getItem(TOKENS_KEY)) } catch (e) { return null }
    }
    function setStored(t) {
        try { sessionStorage.setItem(TOKENS_KEY, JSON.stringify(t)) } catch (e) { /* private mode */ }
    }
    function clearStored() {
        try { sessionStorage.removeItem(TOKENS_KEY) } catch (e) { /* private mode */ }
    }
    function isConnected() {
        var t = getStored()
        return !!(t && t.refresh_token)
    }
    function configured() {
        return typeof TONE3000_CLIENT_ID === 'string' && TONE3000_CLIENT_ID && TONE3000_CLIENT_ID !== PLACEHOLDER
    }

    // ── auth ────────────────────────────────────────────────────────────────
    function buildAuthorizeUrl() {
        var verifier = randB64url(32)
        var state = randB64url(16)
        return sha256B64url(verifier).then(function (challenge) {
            sessionStorage.setItem(VERIFIER_KEY, verifier)
            sessionStorage.setItem(STATE_KEY, state)
            var p = {
                client_id: TONE3000_CLIENT_ID,
                redirect_uri: window.location.origin + REDIRECT_PATH,
                response_type: 'code',
                code_challenge: challenge,
                code_challenge_method: 'S256',
                state: state,
                // scope the account connect to NAM; harmless if ignored
                format: 'nam'
            }
            var qs = []
            for (var k in p) qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(p[k]))
            return TONE3000_API + '/api/v1/oauth/authorize?' + qs.join('&')
        })
    }

    function connect() {
        if (!configured()) {
            notify('error', 'TONE3000 is not set up on this device.')
            return
        }
        if (connectPopup && !connectPopup.closed) {
            connectPopup.focus()
            return
        }
        // open synchronously, before the PKCE promise, or it is blocked as unsolicited
        var w = 460, h = 640
        var left = Math.round(window.screenX + Math.max(0, (window.outerWidth - w) / 2))
        var top = Math.round(window.screenY + Math.max(0, (window.outerHeight - h) / 3))
        connectPopup = window.open('', POPUP_NAME,
            'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top +
            ',toolbar=no,menubar=no,location=no,status=no,resizable=yes,scrollbars=yes')
        if (!connectPopup) {
            notify('error', 'Popup blocked -- allow popups for this site and try again.')
            return
        }
        var popup = connectPopup
        buildAuthorizeUrl().then(function (url) {
            popup.location = url
        }).catch(function (e) {
            popup.close()
            connectPopup = null
            notify('error', 'TONE3000 sign-in failed: ' + (e && e.message || e))
        })
    }

    // called from tone3000-connect.html (same-origin) once it has the tokens
    function receiveTokens(tokens, err) {
        connectPopup = null
        try { sessionStorage.removeItem(STATE_KEY); sessionStorage.removeItem(VERIFIER_KEY) } catch (e) {}
        if (err || !tokens || !tokens.access_token) {
            notify('error', 'Could not connect to TONE3000' + (err ? ': ' + err : ''))
            return
        }
        setStored(tokens)
        notify('info', 'Connected to TONE3000')
        render()
    }

    function refreshTokens() {
        var t = getStored()
        if (!t || !t.refresh_token) return Promise.reject(new Error('not connected'))
        return fetch(TONE3000_API + '/api/v1/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: t.refresh_token,
                client_id: TONE3000_CLIENT_ID
            }).toString()
        }).then(function (r) {
            if (!r.ok) throw new Error('token refresh failed (HTTP ' + r.status + ')')
            return r.json()
        }).then(function (d) {
            var nt = {
                access_token: d.access_token,
                refresh_token: d.refresh_token || t.refresh_token,
                expires_at: Date.now() + (d.expires_in || 3600) * 1000
            }
            setStored(nt)
            return nt
        })
    }

    // resolves to a usable access token, refreshing (once, shared) when near expiry
    function accessToken() {
        var t = getStored()
        if (!t) return Promise.reject(new Error('not connected'))
        if (t.expires_at && Date.now() < t.expires_at - 60000) {
            return Promise.resolve(t.access_token)
        }
        if (!refreshing) {
            refreshing = refreshTokens()
                .then(function (nt) { refreshing = null; return nt })
                .catch(function (e) { refreshing = null; clearStored(); throw e })
        }
        return refreshing.then(function (nt) { return nt.access_token })
    }

    function apiGet(path) {
        return accessToken().then(function (tok) {
            return fetch(TONE3000_API + path, { headers: { Authorization: 'Bearer ' + tok } })
        }).then(function (r) {
            if (r.status === 401) { clearStored(); throw new Error('TONE3000 session expired -- reconnect') }
            if (!r.ok) throw new Error('TONE3000 request failed (HTTP ' + r.status + ')')
            return r.json()
        })
    }

    // ── filenames (same scheme as tone3000-callback.html) ───────────────────
    function sanitize(name) {
        return String(name).replace(/[\/\\:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim()
    }
    // The download folder is named after the tone's own page URL -- its stable,
    // public identity (e.g. .../tones/1234-fender-deluxe -> "1234-fender-deluxe").
    // Falls back to the title when the URL is missing or unusable.
    function folderFor(tone) {
        var slug = ''
        if (tone.url) {
            try {
                var parts = new URL(tone.url, TONE3000_API).pathname.split('/').filter(Boolean)
                slug = sanitize(parts[parts.length - 1] || '')
            } catch (e) { /* fall through */ }
        }
        return slug || ((sanitize(tone.title) || ('Tone ' + tone.id)) + ' (' + tone.id + ')')
    }
    function fileNamesFor(tone, models) {
        var title = sanitize(tone.title) || ('Tone ' + tone.id)
        var base = models.map(function (m) { return title + ' - ' + sanitize(m.name) + '.nam' })
        var counts = {}
        base.forEach(function (n) { counts[n] = (counts[n] || 0) + 1 })
        var seen = {}
        return base.map(function (n, i) {
            seen[n] = (seen[n] || 0) + 1
            if (counts[n] === 1 || seen[n] === 1) return n
            return n.slice(0, -4) + ' (' + models[i].id + ').nam'
        })
    }
    function isNam(model) {
        try { return (/\.nam$/i).test(new URL(model.model_url, TONE3000_API).pathname) }
        catch (e) { return (/\.nam(\?|$)/i).test(model.model_url || '') }
    }

    // ── search (infinite scroll) ───────────────────────────────────────────
    var PAGE_SIZE = 48

    // append === false starts a fresh search; append === true adds the next page.
    // A fresh search always runs -- it bumps searchSeq so any in-flight request's
    // result is ignored -- so changing a filter mid-load is never dropped. Only a
    // scroll-triggered "load more" backs off while a request is already running.
    function doSearch(append) {
        if (append && loading) return
        var seq = append ? searchSeq : ++searchSeq
        if (!append) { page = 1; shownCount = 0; gridEl.empty() }
        loading = true
        statusEl.text(append ? 'Loading more…' : 'Searching…')
        var qs = new URLSearchParams({ format: 'nam', sort: sort, page: String(page), page_size: String(PAGE_SIZE) })
        if (query) qs.set('query', query)
        if (arch) qs.set('architecture', arch)
        if (sizeFilter) qs.set('sizes', sizeFilter)
        apiGet('/api/v1/tones/search?' + qs.toString()).then(function (res) {
            if (seq !== searchSeq) return   // superseded; the newer request owns `loading`
            loading = false
            totalPages = res.total_pages || 1
            addResults(res.data || [], append)
        }).catch(function (e) {
            if (seq !== searchSeq) return
            loading = false
            statusEl.text(e && e.message || String(e))
            if (!isConnected()) renderDisconnected()
        })
    }

    function addResults(tones, append) {
        statusEl.text('')
        if (!append) {
            gridEl.empty()
            if (!tones.length) {
                gridEl.append($('<div class="grid-t3k-empty">').text('No NAM tones found'))
                countEl.text('')
                return
            }
        }
        tones.forEach(function (tone) { gridEl.append(buildCard(tone)) })
        shownCount += tones.length
        var more = page < totalPages
        countEl.text(shownCount + ' shown' + (more ? ' — scroll for more' : ''))
        // keep pulling pages until the grid is scrollable, so it always fills the space
        if (more) setTimeout(maybeLoadMore, 0)
    }

    function maybeLoadMore() {
        if (loading || page >= totalPages || !isConnected()) return
        var el = gridEl[0]
        if (!el) return
        var nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 500
        var notFilled = el.scrollHeight <= el.clientHeight + 4
        if (nearBottom || notFilled) {
            page += 1
            doSearch(true)
        }
    }

    // ── render ──────────────────────────────────────────────────────────────
    function render() {
        connectBar.toggleClass('grid-hidden', !isConnected())
        if (!configured()) { renderNotConfigured(); return }
        if (!isConnected()) { renderDisconnected(); return }
        doSearch(false)
    }

    function renderNotConfigured() {
        statusEl.text(''); countEl.text('')
        gridEl.empty().append($('<div class="grid-t3k-empty">')
            .text('TONE3000 is not set up on this device -- see the TONE3000 section of the README.'))
    }

    function renderDisconnected() {
        statusEl.text(''); countEl.text('')
        gridEl.empty()
        var box = $('<div class="grid-t3k-connect-box">')
        box.append($('<p>').text('Connect your TONE3000 account to browse and download NAM captures.'))
        var btn = $('<button type="button" class="grid-t3k-action-btn">').text('Connect TONE3000')
        btn.click(connect)
        box.append(btn)
        gridEl.append(box)
    }

    function buildCard(tone) {
        var card = $('<div class="grid-t3k-card">')
        var thumb = $('<div class="grid-t3k-thumb">')
        if (tone.images && tone.images[0]) thumb.append($('<img loading="lazy">').attr('src', tone.images[0]))
        card.append(thumb)
        card.append($('<div class="grid-t3k-name">').text(tone.title || ('Tone ' + tone.id)).attr('title', tone.title || ''))
        card.append($('<div class="grid-t3k-author">').text((tone.user && tone.user.username) || ''))
        var chips = $('<div class="grid-t3k-chips">')
        if (tone.gear) chips.append($('<span class="grid-t3k-chip">').text(tone.gear))
        ;(tone.sizes || []).forEach(function (s) {
            chips.append($('<span class="grid-t3k-chip grid-t3k-size-' + s + '">').text(s))
        })
        card.append(chips)
        card.click(function () { openDetail(tone) })
        return card
    }

    // ── detail + download ───────────────────────────────────────────────────
    function fetchAllModels(toneId, pageN, acc) {
        pageN = pageN || 1
        acc = acc || []
        return apiGet('/api/v1/models?tone_id=' + encodeURIComponent(toneId) + '&page=' + pageN).then(function (res) {
            acc = acc.concat(res.data || [])
            if (res.page && res.total_pages && res.page < res.total_pages) {
                return fetchAllModels(toneId, pageN + 1, acc)
            }
            return acc
        })
    }

    function openDetail(tone) {
        detailInner.empty()

        var header = $('<div class="grid-t3k-detail-header">')
        header.append($('<h3>').text(tone.title || ('Tone ' + tone.id)))
        var close = $('<button type="button" class="grid-t3k-detail-close" title="Close">').html('&times;')
        close.click(function () { detailOverlay.addClass('grid-hidden') })
        header.append(close)
        detailInner.append(header)

        detailInner.append($('<div class="grid-t3k-detail-sub">').text(
            [(tone.user && tone.user.username), tone.gear, tone.license].filter(Boolean).join(' · ')))
        if (tone.description) detailInner.append($('<p class="grid-t3k-detail-desc">').text(tone.description))

        var list = $('<div class="grid-t3k-models">').text('Loading models…')
        detailInner.append(list)
        var actions = $('<div class="grid-t3k-detail-actions">')
        detailInner.append(actions)
        detailOverlay.removeClass('grid-hidden')

        fetchAllModels(tone.id).then(function (models) {
            var nam = models.filter(isNam)
            list.empty()
            if (!nam.length) {
                list.append($('<p>').text('This tone has no NAM models to download.'))
                return
            }
            var names = fileNamesFor(tone, nam)
            var folder = folderFor(tone)
            list.append($('<p class="grid-t3k-folder-note">').text('Saved to NAM Models / ' + folder))

            var btn = $('<button type="button" class="grid-t3k-action-btn">')
            var picks = []

            function selectedCount() {
                return picks.filter(function (p) { return p.checked() }).length
            }
            function syncHeader() {
                var n = selectedCount()
                masterCb.prop('checked', n === picks.length && n > 0)
                masterCb.prop('indeterminate', n > 0 && n < picks.length)
                btn.text(n ? ('Add ' + n + ' to NAM Models') : 'Add selected to NAM Models')
                    .prop('disabled', n === 0)
            }

            // header row: one checkbox to select / clear all, plus the count
            var head = $('<div class="grid-t3k-models-head">')
            var masterCb = $('<input type="checkbox">')
            masterCb.change(function () {
                var v = masterCb.prop('checked')
                picks.forEach(function (p) { p.setChecked(v) })
                syncHeader()
            })
            head.append($('<label class="grid-t3k-select-all">').append(masterCb).append($('<span>').text(' Select all')))
            head.append($('<span class="grid-t3k-models-count">').text(nam.length + (nam.length === 1 ? ' model' : ' models')))
            list.append(head)

            nam.forEach(function (m, i) {
                var row = $('<label class="grid-t3k-model-row">')
                var light = m.size === 'nano' || m.size === 'feather'
                var cb = $('<input type="checkbox">').prop('checked', nam.length === 1 || light)
                cb.change(syncHeader)
                var statusIco = $('<span class="grid-t3k-model-status">')
                row.append(cb).append(statusIco)
                row.append($('<span class="grid-t3k-model-name">').text(m.name).attr('title', names[i]))
                var tag = (m.size || '?') + (SIZE_HINT[m.size] ? ' · ' + SIZE_HINT[m.size] : '') +
                          ' · arch ' + (m.architecture_version || '?')
                row.append($('<span class="grid-t3k-model-tag grid-t3k-size-' + m.size + '">').text(tag))
                list.append(row)
                picks.push({
                    model: m, name: names[i],
                    checked: function () { return cb.prop('checked') },
                    setChecked: function (v) { cb.prop('checked', v) },
                    state: function (s) {
                        row.attr('data-state', s || '')
                        cb.css('display', s ? 'none' : '')
                        statusIco.html(
                            s === 'downloading' ? '<span class="grid-t3k-spin"></span>' :
                            s === 'saved' ? '&#10003;' : s === 'failed' ? '&#10005;' : '')
                    }
                })
            })

            if (nam.some(function (m) { return m.size === 'standard' })) {
                list.append($('<p class="grid-t3k-size-note">').text(
                    'Tip: "standard" models are the heaviest on CPU. On a Pi, prefer nano / feather / lite.'))
            }

            btn.click(function () {
                var chosen = picks.filter(function (p) { return p.checked() })
                if (!chosen.length) { notify('info', 'Select at least one model first'); return }
                downloadModels(tone, chosen, actions)
            })
            actions.append(btn)
            syncHeader()
        }).catch(function (e) {
            list.empty().append($('<p>').text('Could not load models: ' + (e && e.message || e)))
        })
    }

    function downloadModels(tone, chosen, actions) {
        var folder = folderFor(tone)
        var total = chosen.length
        var done = 0, ok = 0
        var written = []

        // swap the button for a live progress area
        actions.empty()
        var label = $('<div class="grid-t3k-progress-label">').text('Starting…')
        var fill = $('<div class="grid-t3k-progress-fill">')
        actions.append(label).append($('<div class="grid-t3k-progress-track">').append(fill))

        var chain = chosen.reduce(function (p, item, idx) {
            return p.then(function () {
                item.state('downloading')
                label.text('Downloading "' + item.model.name + '"  ·  ' + (idx + 1) + ' / ' + total)
                return accessToken().then(function (tok) {
                    return fetch(item.model.model_url, { headers: { Authorization: 'Bearer ' + tok } })
                }).then(function (r) {
                    if (!r.ok) throw new Error('model download HTTP ' + r.status)
                    return r.arrayBuffer()
                }).then(function (buf) {
                    return fetch('/files/upload/nammodel?folder=' + encodeURIComponent(folder) +
                                 '&name=' + encodeURIComponent(item.name), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/octet-stream' },
                        body: buf
                    })
                }).then(function (r) {
                    if (!r.ok) throw new Error('upload HTTP ' + r.status)
                    return r.json()
                }).then(function (saved) {
                    item.state('saved'); ok += 1; written.push(saved.fullname)
                }).catch(function (e) {
                    item.state('failed')
                    notify('error', 'Failed: ' + item.model.name + ' (' + (e && e.message || e) + ')')
                }).then(function () {
                    done += 1
                    fill.css('width', Math.round(done / total * 100) + '%')
                })
            })
        }, Promise.resolve())

        chain.then(function () {
            label.text(ok === total
                ? ('Done — ' + total + ' saved to NAM Models / ' + folder)
                : (ok + ' of ' + total + ' saved to NAM Models / ' + folder))
            if (ok) {
                notify('info', ok + ' model' + (ok === 1 ? '' : 's') + ' added to NAM Models')
                // If a NAM plugin's params panel is open, refresh its file dropdown in place
                // (feature-detected: only present where modgui.js carries the change).
                var gui = (typeof GridParams !== 'undefined' && GridParams.currentGui) ? GridParams.currentGui() : null
                if (gui && gui.refreshFileTypesLists) {
                    gui.refreshFileTypesLists('nammodel', written)
                }
                if (typeof GridParams !== 'undefined' && GridParams.refreshFileParams) {
                    GridParams.refreshFileParams('nammodel')
                }
            }
            var closeBtn = $('<button type="button" class="grid-t3k-action-btn">').text('Done')
            closeBtn.click(function () { detailOverlay.addClass('grid-hidden') })
            actions.append(closeBtn)
        })
    }

    function closePopup() {
        if (connectPopup && !connectPopup.closed) connectPopup.close()
        connectPopup = null
    }
    window.addEventListener('pagehide', closePopup)

    return {
        init: function () {
            overlay = $('#grid-t3k-overlay')
            gridEl = $('#grid-t3k-grid')
            searchInput = $('#grid-t3k-search')
            countEl = $('#grid-t3k-count')
            statusEl = $('#grid-t3k-status')
            sortSel = $('#grid-t3k-sort')
            archSel = $('#grid-t3k-arch')
            sizeSel = $('#grid-t3k-size')
            connectBar = $('#grid-t3k-connectbar')
            detailOverlay = $('#grid-t3k-detail-overlay')
            detailInner = $('#grid-t3k-detail-inner')

            if (sortSel.length && !sortSel.children().length) {
                SORTS.forEach(function (s) { sortSel.append($('<option>').val(s[0]).text(s[1])) })
                sortSel.val(sort)
            }

            $('#grid-tone3000-toggle').click(function () { GridTone3000.open() })
            $('#grid-t3k-close').click(function () { GridTone3000.close() })
            overlay.click(function (ev) { if (ev.target === overlay[0]) GridTone3000.close() })
            detailOverlay.click(function (ev) { if (ev.target === detailOverlay[0]) detailOverlay.addClass('grid-hidden') })
            $('#grid-t3k-disconnect').click(function () { clearStored(); notify('info', 'Disconnected from TONE3000'); render() })

            var deb
            searchInput.on('input', function () {
                clearTimeout(deb)
                deb = setTimeout(function () {
                    query = searchInput.val().trim()
                    render()
                }, 300)
            })
            sortSel.on('change', function () { sort = sortSel.val(); render() })
            archSel.on('change', function () { arch = archSel.val(); render() })
            sizeSel.on('change', function () { sizeFilter = sizeSel.val(); render() })

            // infinite scroll: pull the next page as the grid nears its end
            gridEl.on('scroll', maybeLoadMore)
        },
        open: function () { overlay.removeClass('grid-hidden'); render() },
        close: function () { overlay.addClass('grid-hidden'); detailOverlay.addClass('grid-hidden') },
        receiveTokens: receiveTokens,
        buildAuthorizeUrl: buildAuthorizeUrl,
        isConnected: isConnected,
        // exposed for tests
        _internals: {
            folderFor: folderFor, fileNamesFor: fileNamesFor, sha256B64url: sha256B64url,
            sha256Bytes: sha256Bytes, configured: configured, openDetail: openDetail
        }
    }
})()

if (typeof $ !== 'undefined' && $.fn) {
    $(document).ready(function () { GridTone3000.init() })
}
