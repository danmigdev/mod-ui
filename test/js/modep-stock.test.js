// SPDX-License-Identifier: AGPL-3.0-or-later
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { makeWindow } = require('./harness')

function stock(body) {
    const ctx = makeWindow({ body, url: 'http://localhost/' })
    ctx.load('js/lib/jquery-ui-1.10.1.custom.min.js')
    ctx.load('js/lib/jquery.mousewheel.min.js')
    ctx.load('js/lib/jquery.svg.js')
    ctx.load('js/lib/arrive.min.js')
    ctx.load('js/modgui.js')
    ctx.load('js/common.js')
    return ctx
}

test('MODEP stock constructor initializes without Tone3000 globals and ignores late plugin parameters', () => {
    const ctx = stock('<div id="parent"><div id="board"></div></div>')
    try {
        ctx.load('js/wait.js')
        ctx.load('js/pedalboard.js')
        const board = ctx.$('#board')
        assert.doesNotThrow(() => board.pedalboard({}))
        assert.equal(board.data('T3KIntegration'), undefined)
        assert.doesNotThrow(() => board.pedalboard('setWritableParameterValue', '/graph/removed', 'urn:test', 's', 'value'))
        assert.doesNotThrow(() => board.pedalboard('resetConnections'))
    } finally { ctx.window.close() }
})

test('original MODEP store retains target selection, revision metadata and constructor refresh', () => {
    const ctx = stock('<div id="store"><input type="search"></div>')
    const { window, $ } = ctx
    try {
        window.PATCHSTORAGE_TARGET_ID = '8280'
        window.FAVORITES = []
        let transfer, refreshed = 0, result
        $.fn.window = function () { return this }
        window.Notification = function () {
            for (const name of ['open', 'close', 'closeAfter', 'html', 'type', 'bar']) this[name] = () => {}
        }
        window.desktop = { updateAllPlugins() { refreshed++ } }
        window.SimpleTransference = function (url, destination, options) {
            transfer = { url, destination, options }
            this.start = () => this.reportFinished({ result: { ok: true,
                installed: ['urn:echo'], removed: [], bundles: ['echo.lv2'] } })
        }
        ctx.load('js/patchstorage.js')
        const box = $('#store').patchstorageBox({})
        box.patchstorageBox('installPlugin', { psid: '9', cloud_revision: '2', files: [
            { target: { id: 8278 }, url: 'https://files.example/armhf', filename: 'armhf.tar.gz' },
            { target: { id: 8280 }, url: 'https://files.example/aarch64', filename: 'aarch64.tar.gz' },
        ] }, response => { result = response })
        assert.equal(transfer.url, 'https://files.example/aarch64')
        assert.equal(transfer.destination, '/effect/install')
        assert.equal(transfer.options.to_args.headers['Patchstorage-Item'], '9')
        assert.equal(transfer.options.to_args.headers['Patchstorage-Item-Version'], '2')
        assert.equal(result.ok, true)
        assert.equal(refreshed, 1)
        const local = box.patchstorageBox('transformLocalPlugin', {
            uri: 'urn:echo', category: ['Delay'], patchstorage: { id: 9, revision: '2' },
        })
        assert.equal(local.psid, '9')
        assert.equal(local.local_revision, '2')
    } finally { window.close() }
})

test('MODEP stock controls follow declared group order and retain unknown or ungrouped controls', () => {
    const ctx = stock('')
    try {
        ctx.load('js/utils/plugins.js')
        const plugin = { portGroups: [{ uri: 'urn:tone', index: 20 }, { uri: 'urn:input', index: 10 }],
            ports: { control: { input: [
                { symbol: 'tone', index: 0, group: 'urn:tone' },
                { symbol: 'gain', index: 1, group: 'urn:input' },
                { symbol: 'unknown', index: 2, group: 'urn:missing' },
                { symbol: 'ungrouped', index: 3 },
            ] } } }
        ctx.window.preparePluginPortGroups(plugin)
        const ports = plugin.ports.control.input
        assert.deepEqual(ports.map(p => p.symbol), ['gain', 'tone', 'unknown', 'ungrouped'])
        assert.equal(ports[0].groupStart, true)
        assert.equal(ports[0].groupEnd, true)
        assert.equal(ports[1].groupStart, true)
        assert.equal(ports[1].groupEnd, true)
        assert.equal(ports[2].group, undefined)
        assert.equal(ports[3].group, undefined)
    } finally { ctx.window.close() }
})
