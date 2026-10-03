// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { makeWindow, HTML } = require('./harness')

let ctx, $, panel, changes, patches, files, fileLoads

const BODY = '<div id="grid-canvas-wrap"></div>' +
    '<div id="grid-bottom-panel" class="grid-hidden" style="height:300px;width:900px">' +
    '<button id="grid-panel-close"></button><div id="grid-panel-skin"></div>' +
    '<div id="grid-panel-generic"></div></div>'

function port(symbol, name, group, properties) {
    return { symbol, name, group, properties: properties || [],
        ranges: { minimum: 0, maximum: 10, default: 2 } }
}

function plugin() {
    return {
        uri: 'urn:test:grouped-plugin',
        portGroups: [
            { uri: 'urn:group:tone', name: 'Tone', index: 20 },
            { uri: 'urn:group:empty', name: 'Hidden controls', index: 0 },
            { uri: 'urn:group:input', name: 'Input', index: 10 },
        ],
        ports: { control: { input: [
            port('bright', 'Bright', 'urn:group:tone', ['toggled']),
            port('gain', 'Gain', 'urn:group:input'),
            Object.assign(port('mode', 'Mode', 'urn:group:tone', ['enumeration']), {
                scalePoints: [{ value: 3, label: 'Clean' }, { value: 7, label: 'Drive' }], value: 7,
            }),
            port('loose', 'Ungrouped', 'urn:group:unknown'),
            port('hidden', 'Hidden', 'urn:group:empty', ['notOnGUI']),
        ] } },
        parameters: [{ uri: 'urn:parameter:model', label: 'Model', writable: true,
            type: 'http://lv2plug.in/ns/ext/atom#Path', fileTypes: ['nammodel'], value: '/models/clean.nam' }],
    }
}

function open(data) {
    panel.open('effect_1', { pluginData: data, bypassed: false }, {
        change: (symbol, value) => changes.push([symbol, value]),
        patchGet: () => {},
        patchSet: (uri, type, value) => patches.push([uri, type, value]),
    })
}

function row(name) {
    return $('#grid-panel-generic .grid-param-row').filter(function () {
        return $(this).find('.grid-param-name').text() === name
    })
}

function textList(elements) {
    return Array.from(elements.map(function () { return $(this).text() }).get())
}

beforeEach(() => {
    ctx = makeWindow({ url: 'http://localhost/', body: BODY })
    $ = ctx.$
    changes = []
    patches = []
    fileLoads = 0
    files = [{ fullname: '/models/clean.nam', basename: 'Clean' },
        { fullname: 't3k://browse', basename: 'Browse tones' }]
    ctx.window.eval('var DEFAULT_ICON_TEMPLATE = ""; var DEFAULT_SETTINGS_TEMPLATE = "";')
    // Use the real visibility rule without requiring a native plugin skin.
    const modgui = fs.readFileSync(path.join(HTML, 'js/modgui.js'), 'utf8')
    ctx.window.eval(modgui.match(/function shouldSkipPort\(port\) \{[\s\S]*?\n\}/)[0])
    ctx.window.GridBoard = { deselect: () => {} }
    ctx.window.loadFileTypesList = (parameter, dummy, callback) => {
        fileLoads++
        parameter.files = files
        callback()
    }
    ctx.window.GUI = function (data, callbacks) {
        this.bypassed = callbacks.bypassed
        this.render = (instance, callback) => callback($('<div style="width:100px;height:100px">'))
        this.setPortWidgetsValue = () => {}
        this.setWritableParameterValue = () => {}
        this.setOutputPortValue = () => {}
        this.setReadableParameterValue = () => {}
        this.setPortValue = (symbol, value) => {
            callbacks.change(symbol, value)
            this.setPortWidgetsValue(symbol, value)
        }
        this.lv2PatchSet = (uri, type, value) => {
            callbacks.patchSet(uri, type, value)
            this.setWritableParameterValue(uri, type, value)
        }
    }
    ctx.load('js/grid-params.js')
    panel = ctx.window.GridParams
    panel.init()
})

afterEach(() => ctx.window.close())

test('port-group headings use declared order and retain every visible control', () => {
    open(plugin())
    assert.deepEqual(textList($('.grid-param-group-heading')), ['Input', 'Tone'])
    assert.deepEqual(textList($('.grid-param-group').eq(1).find('.grid-param-name')), ['Bright', 'Mode'])
    assert.deepEqual(textList($('#grid-panel-generic > .grid-param-row .grid-param-name')), ['Active', 'Ungrouped', 'Model'])
    assert.equal(row('Hidden').length, 0)
    assert.equal($('#grid-preset-rows').length, 1)
    assert.equal($('#grid-connection-rows').length, 1)
})

test('plugins without group metadata keep their original flat control order', () => {
    const data = plugin()
    delete data.portGroups
    open(data)
    assert.equal($('.grid-param-group-heading').length, 0)
    assert.deepEqual(textList($('#grid-panel-generic > .grid-param-row .grid-param-name')), ['Active', 'Bright', 'Gain', 'Mode', 'Ungrouped', 'Model'])
})

test('group labels are text and equal-index groups keep their metadata order', () => {
    const data = plugin()
    data.portGroups[0].name = '<img src=x> Tone'
    data.portGroups[0].index = 10
    open(data)
    assert.deepEqual(textList($('.grid-param-group-heading')), ['<img src=x> Tone', 'Input'])
    assert.equal($('.grid-param-group-heading img').length, 0)
})

test('grouped slider, toggle and enum controls preserve writes, reset and external sync', () => {
    open(plugin())
    row('Gain').find('input[type=range]').val(5.5).trigger('input')
    row('Bright').find('.grid-toggle').trigger('click')
    row('Mode').find('select').val(0).trigger('change')
    assert.deepEqual(changes, [['gain', 5.5], ['bright', 0], ['mode', 3]])
    const gui = panel.currentGui()
    gui.setPortWidgetsValue('gain', 8)
    gui.setPortWidgetsValue('bright', 1)
    gui.setPortWidgetsValue('mode', 7)
    gui.setPortWidgetsValue(':bypass', 1)
    assert.equal(row('Gain').find('input[type=range]').val(), '8')
    assert.equal(row('Bright').find('.grid-toggle').text(), 'On')
    assert.equal(row('Mode').find('select').val(), '1')
    assert.equal(row('Active').find('.grid-toggle').text(), 'Off')
    row('Gain').find('.grid-param-reset').trigger('click')
    assert.deepEqual(changes.at(-1), ['gain', 2])
})

test('grouping preserves model selection, Tone3000 entry and file refresh', () => {
    open(plugin())
    const select = row('Model').find('select')
    assert.equal(select.val(), '/models/clean.nam')
    assert.equal(select.find('option[value="t3k://browse"]').length, 1)
    select.val('t3k://browse').trigger('change')
    assert.deepEqual(patches, [['urn:parameter:model', 'p', 't3k://browse']])
    panel.currentGui().setWritableParameterValue('urn:parameter:model', 'p', '/models/drive.nam')
    files = [{ fullname: '/models/drive.nam', basename: 'Drive' }].concat(files)
    panel.refreshFileParams('nammodel')
    assert.equal(select.val(), '/models/drive.nam')
    assert.equal(fileLoads, 2)
    assert.deepEqual(textList($('.grid-param-group-heading')), ['Input', 'Tone'])
})
