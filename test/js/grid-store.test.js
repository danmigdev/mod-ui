// SPDX-License-Identifier: AGPL-3.0-or-later

// Drive the actual store UI against catalog and device API responses. No
// internal helpers are exported solely for these tests.
const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { makeWindow } = require('./harness')

const API = 'https://catalog.example/patches'
const BODY =
    '<button id="grid-store-toggle"></button>' +
    '<div id="grid-store-overlay" class="grid-hidden">' +
    '<button id="grid-store-close"></button><input id="grid-store-search">' +
    '<div id="grid-store-tabs"></div><div id="grid-store-filters"></div>' +
    '<span id="grid-store-count"></span><div id="grid-store-grid"></div></div>' +
    '<div id="grid-store-detail-overlay" class="grid-hidden"><div id="grid-store-detail-inner"></div></div>'

let ctx, $, store, requests, notifications, pages, details, localPlugins, localBundles
let catalogError, uninstallPayload, shelfRefreshes, downloads, installResult, installStatus

function cloud(id, uids, extra) {
    return Object.assign({ id, uids, title: 'Store ' + id, revision: '1.0',
        tags: [{ slug: 'delay' }], targets: [{ id: 8280 }] }, extra || {})
}

function local(uri, extra) {
    return Object.assign({ uri, name: uri, label: uri, category: ['Delay'] }, extra || {})
}

function card(uri) {
    return $('#grid-store-grid .grid-store-card').filter(function () {
        return $(this).attr('data-store-uri') === uri
    })
}

function action(label) {
    return $('#grid-store-detail-inner button').filter(function () { return $(this).text() === label })
}

function filter(label) {
    $('#grid-store-filters button').filter(function () { return $(this).text() === label }).trigger('click')
}

function openWith(plugins) {
    ctx.window.pluginLibrary = plugins || []
    store.open()
}

async function settle() {
    await new Promise(resolve => setImmediate(resolve))
}

beforeEach(() => {
    ctx = makeWindow({ url: 'http://localhost/', body: BODY })
    $ = ctx.$
    ctx.window.eval('var PATCHSTORAGE_ENABLED = "true"; var PATCHSTORAGE_API_URL = ' + JSON.stringify(API) +
        '; var PATCHSTORAGE_PLATFORM_ID = 8046; var PATCHSTORAGE_TARGET_ID = 8280; var pluginLibrary = [];')
    requests = []
    notifications = []
    pages = [[]]
    details = {}
    localPlugins = []
    localBundles = {}
    catalogError = false
    uninstallPayload = null
    shelfRefreshes = 0
    downloads = []
    installResult = { result: { ok: true } }
    installStatus = 200
    ctx.window.notify = (level, message) => notifications.push({ level, message })
    ctx.window.loadShelf = () => { shelfRefreshes++ }
    ctx.window.confirm = () => true
    ctx.$.ajax = options => {
        requests.push(options)
        const url = options.url
        if (url.startsWith(API + '?')) {
            if (catalogError) options.error({}, 'error')
            else {
                const page = Number(new URL(url).searchParams.get('page')) - 1
                options.success(pages[page] || [], 'success', {
                    getResponseHeader: name => name.toLowerCase() === 'x-wp-totalpages' ? String(pages.length) : null,
                })
            }
        } else if (url.startsWith(API + '/')) {
            const detail = details[url.slice(API.length + 1)]
            if (detail) options.success(detail)
            else options.error()
        } else if (url === '/effect/get') {
            if (localBundles[options.data.uri]) options.success({ bundles: localBundles[options.data.uri] })
            else options.error()
        } else if (url === '/package/uninstall') {
            uninstallPayload = JSON.parse(options.data)
            options.success({ ok: true })
        } else if (url === '/effect/list') options.success(localPlugins)
        else throw new Error('Unexpected AJAX request: ' + url)
        return { done: () => {} }
    }
    ctx.window.fetch = async (url, options) => {
        downloads.push({ url, options })
        if (url === '/effect/install/') return { ok: installStatus < 400, status: installStatus,
            json: async () => installResult }
        return { ok: true, status: 200, blob: async () => ({ type: 'application/gzip' }) }
    }
    ctx.load('js/grid-store.js')
    store = ctx.window.GridStore
    store.init()
})

afterEach(() => { ctx.window.close() })

test('catalog requests paginate and select ARM64 instead of ARM32 files', () => {
    pages = [
        [cloud(1, ['urn:first']), cloud(2, ['urn:wrong-target'], { targets: [{ id: 8278 }] })],
        [cloud(3, ['urn:second'], { files: [
            { target: { id: '8278' }, url: 'https://files.example/arm32.tar.gz' },
            { target: { id: '8280' }, url: 'https://files.example/arm64.tar.gz' },
        ] }), cloud(4, ['urn:no-files'], { files: [] })],
    ]
    openWith()
    assert.equal($('#grid-store-grid .grid-store-card').length, 2)
    assert.equal(card('urn:first').length, 1)
    assert.equal(card('urn:second').length, 1)
    assert.equal(card('urn:wrong-target').length, 0)
    assert.equal(card('urn:no-files').length, 0)
    const catalog = requests.filter(request => request.url.startsWith(API + '?'))
    assert.equal(catalog.length, 2)
    for (const request of catalog) {
        const query = new URL(request.url).searchParams
        assert.equal(query.get('platforms'), '8046')
        assert.equal(query.get('targets'), '8280')
        assert.equal(query.get('per_page'), '100')
    }
    $('#grid-store-search').val('Second').trigger('input')
    assert.equal(requests.filter(request => request.url.startsWith(API + '?')).length, 2)
})

test('numeric and string revisions compare equally while real revision changes show Updates', () => {
    pages = [[cloud(1, ['urn:same'], { revision: 1 }), cloud(2, ['urn:old'], { revision: '2' })]]
    openWith([local('urn:same', { patchstorage: { id: 1, revision: '1' } }),
        local('urn:old', { patchstorage: { id: 2, revision: 1 } })])
    assert.equal(card('urn:same').attr('data-store-status'), 'installed')
    assert.equal(card('urn:old').attr('data-store-status'), 'outdated')
    filter('Updates')
    assert.equal($('#grid-store-grid .grid-store-card').length, 1)
    assert.equal(card('urn:old').length, 1)
})

test('searches during catalog loading reuse one request and apply the latest query', () => {
    let pending
    ctx.$.ajax = options => { requests.push(options); pending = options; return {} }
    openWith([local('urn:local')])
    assert.equal(card('urn:local').length, 1)
    assert.match($('#grid-store-grid').text(), /Loading Patchstorage/)
    $('#grid-store-search').val('Beta').trigger('input')
    store.open()
    assert.equal(requests.length, 1)
    pending.success([cloud(1, ['urn:alpha'], { title: 'Alpha' }),
        cloud(2, ['urn:beta'], { title: 'Beta' })], 'success', { getResponseHeader: () => '1' })
    assert.equal($('#grid-store-grid .grid-store-card').length, 1)
    assert.equal(card('urn:beta').length, 1)
})

test('failure after one catalog page does not claim unseen installed plugins were removed', () => {
    pages = [[cloud(1, ['urn:first'])], [cloud(2, ['urn:second'])]]
    const normalAjax = ctx.$.ajax
    ctx.$.ajax = options => {
        if (options.url.startsWith(API + '?') && new URL(options.url).searchParams.get('page') === '2') {
            requests.push(options)
            options.error({}, 'error')
            return {}
        }
        return normalAjax(options)
    }
    openWith([local('urn:second', { patchstorage: { id: 2, revision: '1.0' } })])
    assert.equal(card('urn:second').attr('data-store-status'), 'installed')
    assert.equal(card('urn:first').length, 0)
    ctx.$.ajax = normalAjax
    $('#grid-store-grid button').filter(function () { return $(this).text() === 'Retry' }).trigger('click')
    assert.equal(card('urn:first').length, 1)
    assert.equal(card('urn:second').attr('data-store-status'), 'installed')
})

test('a bundle with only its second plugin installed is represented once as partial', () => {
    pages = [[cloud(9, ['urn:first', 'urn:second'])]]
    openWith([local('urn:second', { patchstorage: { id: 9, revision: '1.0' } })])
    assert.equal($('#grid-store-grid .grid-store-card').length, 1)
    assert.equal(card('bundle_9').attr('data-store-status'), 'partial')
    assert.match(card('bundle_9').text(), /Partially installed/)
    card('bundle_9').trigger('click')
    assert.match($('#grid-store-detail-inner').text(), /Installed plugins: 1 \/ 2/)
    assert.equal(action('Install missing').length, 1)
    assert.equal(action('Remove').length, 1)
    filter('Installed')
    assert.equal(card('bundle_9').length, 1)
    filter('Available')
    assert.equal(card('bundle_9').length, 1)
})

test('complete bundles use every installed member revision and uninstall their paths once', () => {
    pages = [[cloud(9, ['urn:first', 'urn:second'], { revision: '2.0' })]]
    localBundles = { 'urn:first': ['/plugins/shared.lv2', '/presets/first.lv2'],
        'urn:second': ['/plugins/shared.lv2', '/presets/second.lv2'] }
    openWith([local('urn:first', { patchstorage: { id: 9, revision: '2.0' } }),
        local('urn:second', { patchstorage: { id: 9, revision: '1.0' } })])
    assert.equal($('#grid-store-grid .grid-store-card').length, 1)
    assert.equal(card('bundle_9').attr('data-store-status'), 'outdated')
    card('bundle_9').trigger('click')
    action('Remove').trigger('click')
    assert.deepEqual(uninstallPayload, ['/plugins/shared.lv2', '/presets/first.lv2', '/presets/second.lv2'])
    assert.equal(requests.filter(request => request.url === '/package/uninstall').length, 1)
    assert.equal(shelfRefreshes, 1)
})

test('same-revision complete bundles stay installed and partial outdated bundles appear in Updates', () => {
    pages = [[cloud(9, ['urn:first', 'urn:second'], { revision: 2 })]]
    openWith([local('urn:first', { patchstorage: { id: 9, revision: '2' } }),
        local('urn:second', { patchstorage: { id: 9, revision: 2 } })])
    assert.equal(card('bundle_9').attr('data-store-status'), 'installed')
    ctx.window.pluginLibrary = [local('urn:second', { patchstorage: { id: 9, revision: '1' } })]
    filter('Updates')
    assert.equal(card('bundle_9').attr('data-store-status'), 'partial')
})

test('bundle removal waits for every member lookup and reports incomplete file discovery', () => {
    pages = [[cloud(9, ['urn:first', 'urn:second'])]]
    localBundles = { 'urn:first': ['/plugins/first.lv2'] }
    openWith([local('urn:first'), local('urn:second')])
    card('bundle_9').trigger('click')
    action('Remove').trigger('click')
    assert.equal(uninstallPayload, null)
    assert.equal(action('Remove').prop('disabled'), false)
    assert.ok(notifications.some(item => item.level === 'error' && /Couldn't find files/.test(item.message)))
})

test('disabled downloads still list local plugins and permit removal', () => {
    ctx.window.PATCHSTORAGE_ENABLED = 'false'
    localBundles['urn:local'] = ['/plugins/local.lv2']
    openWith([local('urn:local')])
    assert.equal(requests.length, 0)
    assert.match($('#grid-store-grid').text(), /downloads are disabled/)
    assert.equal(card('urn:local').attr('data-store-status'), 'local')
    card('urn:local').trigger('click')
    assert.equal(action('Install').length, 0)
    action('Remove').trigger('click')
    assert.deepEqual(uninstallPayload, ['/plugins/local.lv2'])
})

test('missing target disables catalog requests rather than fetching incompatible binaries', () => {
    ctx.window.PATCHSTORAGE_TARGET_ID = null
    openWith([local('urn:local')])
    assert.equal(requests.length, 0)
    assert.equal(card('urn:local').length, 1)
})

test('offline catalog preserves installed status and local removal, then Retry recovers', () => {
    catalogError = true
    localBundles['urn:store'] = ['/plugins/store.lv2']
    openWith([local('urn:store', { patchstorage: { id: 1, revision: '1.0' } })])
    assert.equal(card('urn:store').attr('data-store-status'), 'installed')
    assert.match($('#grid-store-grid').text(), /unavailable/)
    $('#grid-store-search').val('store').trigger('input')
    assert.equal(requests.filter(request => request.url.startsWith(API + '?')).length, 1)
    card('urn:store').trigger('click')
    action('Remove').trigger('click')
    assert.deepEqual(uninstallPayload, ['/plugins/store.lv2'])
    catalogError = false
    pages = [[cloud(2, ['urn:new'], { title: 'New store plugin' })]]
    $('#grid-store-grid button').filter(function () { return $(this).text() === 'Retry' }).trigger('click')
    assert.equal(card('urn:new').length, 1)
    assert.equal(requests.filter(request => request.url.startsWith(API + '?')).length, 2)
})

test('reopening after an offline failure retries and a successful empty catalog marks missing store items', () => {
    catalogError = true
    openWith([local('urn:store', { patchstorage: { id: 1, revision: '1.0' } })])
    store.close()
    catalogError = false
    store.open()
    assert.equal(requests.filter(request => request.url.startsWith(API + '?')).length, 2)
    assert.equal(card('urn:store').attr('data-store-status'), 'unavailable')
})

test('install resolves the ARM64 detail file and sends current metadata to the device', async () => {
    pages = [[cloud(1, ['urn:new'])]]
    details['1'] = { revision: '1.1', files: [
        { target: { id: 8278 }, url: 'https://files.example/arm32.tar.gz' },
        { target: { id: 8280 }, url: 'https://files.example/arm64.tar.gz' },
    ] }
    localPlugins = [local('urn:new', { patchstorage: { id: 1, revision: '1.1' } })]
    openWith()
    card('urn:new').trigger('click')
    action('Install').trigger('click')
    await settle()
    assert.equal(downloads[0].url, 'https://files.example/arm64.tar.gz')
    assert.equal(downloads[1].url, '/effect/install/')
    assert.equal(downloads[1].options.method, 'POST')
    assert.equal(downloads[1].options.headers['Patchstorage-Item'], '1')
    assert.equal(downloads[1].options.headers['Patchstorage-Item-Version'], '1.1')
    assert.equal(downloads[1].options.headers['Content-Type'], 'application/gzip')
    assert.equal(shelfRefreshes, 1)
    assert.equal(card('urn:new').attr('data-store-status'), 'installed')
    assert.ok($('#grid-store-detail-overlay').hasClass('grid-hidden'))
})

test('unknown cloud revision uses a nonempty metadata default', async () => {
    pages = [[cloud(1, ['urn:new'], { revision: null,
        files: [{ target: { id: 8280 }, url: 'https://files.example/new.tar.gz' }] })]]
    openWith()
    card('urn:new').trigger('click')
    action('Install').trigger('click')
    await settle()
    assert.equal(downloads[1].options.headers['Patchstorage-Item-Version'], '0.0')
})

test('unsupported detail never downloads and failed installation keeps the dialog actionable', async () => {
    pages = [[cloud(1, ['urn:new'])]]
    details['1'] = { files: [{ target: { id: 8278 }, url: 'https://files.example/arm32.tar.gz' }] }
    openWith()
    card('urn:new').trigger('click')
    action('Install').trigger('click')
    assert.equal(downloads.length, 0)
    assert.equal(action('Install').prop('disabled'), false)
    details['1'] = { revision: '1.0', files: [{ target: { id: 8280 }, url: 'https://files.example/new.tar.gz' }] }
    installResult = { result: { ok: false, error: 'Plugin bundle could not be loaded' } }
    action('Install').trigger('click')
    await settle()
    assert.equal(action('Install').prop('disabled'), false)
    assert.equal(shelfRefreshes, 0)
    assert.ok(!$('#grid-store-detail-overlay').hasClass('grid-hidden'))
    assert.ok(notifications.some(item => item.level === 'error' && /could not be loaded/.test(item.message)))
})

test('HTTP installation failures are reported without claiming success', async () => {
    pages = [[cloud(1, ['urn:new'], { files: [{ target: { id: 8280 }, url: 'https://files.example/new.tar.gz' }] })]]
    installStatus = 500
    openWith()
    card('urn:new').trigger('click')
    action('Install').trigger('click')
    await settle()
    assert.equal(shelfRefreshes, 0)
    assert.equal(action('Install').prop('disabled'), false)
    assert.ok(notifications.some(item => item.level === 'error' && /Couldn't install/.test(item.message)))
})

test('store-provided markup stays text and executable external links are omitted', () => {
    pages = [[cloud(1, ['urn:new'], { title: '<img onerror="alert(1)">',
        source_code_url: 'javascript:alert(1)', url: 'https://patchstorage.com/item/' })]]
    openWith()
    card('urn:new').trigger('click')
    assert.equal($('#grid-store-detail-inner h3').text(), '<img onerror="alert(1)">')
    assert.equal($('#grid-store-detail-inner h3 img').length, 0)
    assert.equal($('#grid-store-detail-inner a').length, 1)
    assert.equal($('#grid-store-detail-inner a').attr('href'), 'https://patchstorage.com/item/')
})
