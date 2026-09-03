// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Bottom parameter panel for the "grid" theme: left half mounts the plugin's
// real modgui skin (reused as-is from html/js/modgui.js), right half is a
// uniform generic control list built from port/parameter metadata, kept in
// sync with the skin by wrapping the GUI instance's own update methods
// (modgui.js's controlWidget dispatch is keyed off a fixed set of widget
// type names, so a custom widget can't be registered into port.widgets;
// wrapping is the seam that doesn't require touching modgui.js).

var GridParams = (function () {
    var panel, skinPane, genericPane
    var current = null // { instance, gui, symbolRows, paramRows }
    var filePathRows = [] // { parameter, row } for each open path-parameter row

    function wrap(obj, method, extra) {
        var orig = obj[method]
        obj[method] = function () {
            orig.apply(obj, arguments)
            extra.apply(obj, arguments)
        }
    }

    function paramValueType(parameter) {
        switch (parameter.type) {
            case 'http://lv2plug.in/ns/ext/atom#Bool':   return 'b'
            case 'http://lv2plug.in/ns/ext/atom#Int':    return 'i'
            case 'http://lv2plug.in/ns/ext/atom#Long':   return 'l'
            case 'http://lv2plug.in/ns/ext/atom#Float':  return 'f'
            case 'http://lv2plug.in/ns/ext/atom#Double': return 'g'
            default: return null
        }
    }

    function formatValue(value, isInteger) {
        return isInteger ? String(Math.round(value)) : Number(value).toFixed(2)
    }

    // Sits between the name and the control (slider/toggle/select) on every
    // row that has a known LV2 default — omitted entirely when defaultValue
    // is undefined (e.g. a writable parameter with no declared default)
    // rather than guessing one.
    function buildResetButton(defaultValue, setValue, onChange) {
        if (defaultValue === undefined || defaultValue === null) return null
        var btn = $('<button type="button" class="grid-param-reset" title="Reset to default">').html('&#8634;')
        btn.click(function () {
            setValue(defaultValue)
            onChange(defaultValue)
        })
        return btn
    }

    function buildSliderRow(name, value, min, max, isInteger, defaultValue, onChange) {
        var row = $('<div class="grid-param-row">')
        row.append($('<div class="grid-param-name">').text(name).attr('title', name))
        var control = $('<div class="grid-param-control">')
        var slider = $('<input type="range">').attr({ min: min, max: max, step: isInteger ? 1 : (max - min) / 500 || 0.01 }).val(value)
        var valueLabel = $('<div class="grid-param-value" tabindex="0" title="Double-click to type a value">')
            .text(formatValue(value, isInteger))

        function commitTyped(raw) {
            var v = parseFloat(raw)
            if (isNaN(v)) { valueLabel.text(formatValue(parseFloat(slider.val()), isInteger)); return }
            v = Math.min(max, Math.max(min, v))
            slider.val(v)
            valueLabel.text(formatValue(v, isInteger))
            onChange(v)
        }

        valueLabel.on('dblclick', function () {
            if (valueLabel.find('input').length) return
            var input = $('<input type="number" class="grid-param-value-edit">')
                .attr({ min: min, max: max, step: isInteger ? 1 : 'any' })
                .val(parseFloat(slider.val()))
            valueLabel.empty().append(input)
            input.trigger('focus')
            if (input[0].select) input[0].select()

            var done = false
            function finish(commit) {
                if (done) return
                done = true
                if (commit) commitTyped(input.val())
                else valueLabel.text(formatValue(parseFloat(slider.val()), isInteger))
            }
            input.on('blur', function () { finish(true) })
            input.on('keydown', function (ev) {
                if (ev.key === 'Enter') finish(true)
                else if (ev.key === 'Escape') finish(false)
            })
        })

        slider.on('input', function () {
            var v = parseFloat(slider.val())
            valueLabel.text(formatValue(v, isInteger))
            onChange(v)
        })
        var setValue = function (v) { slider.val(v); valueLabel.text(formatValue(v, isInteger)) }
        var resetBtn = buildResetButton(defaultValue, setValue, onChange)
        if (resetBtn) row.append(resetBtn)
        control.append(slider, valueLabel)
        row.append(control)
        return { row: row, setValue: setValue }
    }

    function buildToggleRow(name, value, defaultValue, onChange) {
        var row = $('<div class="grid-param-row">')
        row.append($('<div class="grid-param-name">').text(name).attr('title', name))
        var control = $('<div class="grid-param-control">')
        var btn = $('<button class="grid-toggle">').text(value ? 'On' : 'Off')
        btn.toggleClass('grid-toggle-on', !!value)
        btn.click(function () {
            var v = btn.hasClass('grid-toggle-on') ? 0 : 1
            btn.toggleClass('grid-toggle-on', !!v).text(v ? 'On' : 'Off')
            onChange(v)
        })
        var setValue = function (v) { btn.toggleClass('grid-toggle-on', !!v).text(v ? 'On' : 'Off') }
        var resetBtn = buildResetButton(defaultValue, setValue, onChange)
        if (resetBtn) row.append(resetBtn)
        control.append(btn)
        row.append(control)
        return { row: row, setValue: setValue }
    }

    function buildEnumRow(name, value, defaultValue, scalePoints, onChange) {
        var row = $('<div class="grid-param-row">')
        row.append($('<div class="grid-param-name">').text(name).attr('title', name))
        var control = $('<div class="grid-param-control">')
        var select = $('<select>')
        scalePoints.forEach(function (sp, i) {
            select.append($('<option>').val(i).text(sp.label))
        })
        function closestIndexTo(v) {
            var idx = 0, dist = Infinity
            scalePoints.forEach(function (sp, i) {
                var d = Math.abs(sp.value - v)
                if (d < dist) { dist = d; idx = i }
            })
            return idx
        }
        select.val(closestIndexTo(value))
        select.change(function () {
            onChange(scalePoints[parseInt(select.val())].value)
        })
        var setValue = function (v) { select.val(closestIndexTo(v)) }
        var resetBtn = buildResetButton(defaultValue, setValue, onChange)
        if (resetBtn) row.append(resetBtn)
        control.append(select)
        row.append(control)
        return { row: row, setValue: setValue }
    }

    // File / path parameters (e.g. NAM's model selector). The option list is
    // fetched async via modgui.js's loadFileTypesList, so the row is built empty
    // and filled by setFiles(); setValue() may arrive before or after that and
    // is re-applied once the options exist.
    function buildFileRow(name, onChange) {
        var row = $('<div class="grid-param-row">')
        row.append($('<div class="grid-param-name">').text(name).attr('title', name))
        var control = $('<div class="grid-param-control">')
        var select = $('<select>').prop('disabled', true)
        select.append($('<option value="">').text('Loading…'))
        select.change(function () { onChange(select.val()) })
        control.append(select)
        row.append(control)

        var wanted
        function apply() { if (wanted !== undefined) select.val(wanted) }
        return {
            row: row,
            setValue: function (v) { wanted = (v == null ? '' : String(v)); apply() },
            setFiles: function (files) {
                select.empty().prop('disabled', false)
                select.append($('<option value="">').text(files.length ? '— none —' : 'No files'))
                files.forEach(function (f) {
                    select.append($('<option>').val(f.fullname).text(f.basename).attr('title', f.fullname))
                })
                apply()
            },
        }
    }

    function buildControlPorts(gui, pluginData) {
        var symbolRows = {}

        // ':bypass' port semantics are inverted from what's useful to show here
        // (1 = bypassed/off): the row is presented as "Active" instead, so both
        // the initial value, the reset default, and the external-sync path all
        // need to flip the bit. Default is "Active" (unbypassed) — there's no
        // real LV2 port to read a declared default from, but that's the
        // sensible state for a freshly-added plugin.
        var activeRow = buildToggleRow('Active', gui.bypassed ? 0 : 1, 1, function (v) {
            gui.setPortValue(':bypass', v ? 0 : 1)
        })
        var activeSetValue = activeRow.setValue
        activeRow.setValue = function (bypassValue) { activeSetValue(bypassValue ? 0 : 1) }
        genericPane.append(activeRow.row)
        symbolRows[':bypass'] = activeRow

        var inputs = (pluginData.ports && pluginData.ports.control && pluginData.ports.control.input) || []
        inputs.forEach(function (port) {
            if (shouldSkipPort(port)) return

            var value = port.value !== undefined ? port.value : port.ranges.default
            var defaultValue = port.ranges ? port.ranges.default : undefined
            var isToggled = port.properties.indexOf('toggled') >= 0
            var isEnum = port.properties.indexOf('enumeration') >= 0 && port.scalePoints && port.scalePoints.length >= 2
            var isInteger = port.properties.indexOf('integer') >= 0

            var built
            if (isToggled) {
                built = buildToggleRow(port.name, value, defaultValue, function (v) { gui.setPortValue(port.symbol, v) })
            } else if (isEnum) {
                built = buildEnumRow(port.name, value, defaultValue, port.scalePoints, function (v) { gui.setPortValue(port.symbol, v) })
            } else {
                built = buildSliderRow(port.name, value, port.ranges.minimum, port.ranges.maximum, isInteger, defaultValue,
                    function (v) { gui.setPortValue(port.symbol, v) })
            }
            genericPane.append(built.row)
            symbolRows[port.symbol] = built
        })

        return symbolRows
    }

    function buildParameters(gui, pluginData) {
        var paramRows = {}
        var parameters = pluginData.parameters || []

        parameters.forEach(function (parameter) {
            if (!parameter.writable) return

            // file / path parameters -- show the same file list the plugin skin does
            if (parameter.type === 'http://lv2plug.in/ns/ext/atom#Path' &&
                parameter.fileTypes && parameter.fileTypes.length) {
                var fileRow = buildFileRow(parameter.label, function (v) {
                    gui.lv2PatchSet(parameter.uri, 'p', v)
                })
                genericPane.append(fileRow.row)
                paramRows[parameter.uri] = fileRow
                filePathRows.push({ parameter: parameter, row: fileRow })
                if (parameter.value !== undefined) fileRow.setValue(parameter.value)
                else if (parameter.ranges && parameter.ranges.default !== undefined) fileRow.setValue(parameter.ranges.default)
                if (typeof loadFileTypesList === 'function') {
                    loadFileTypesList(parameter, false, function () { fileRow.setFiles(parameter.files || []) })
                }
                return
            }

            var valuetype = paramValueType(parameter)
            if (!valuetype) return // string/uri/vector parameters are not supported in the generic panel yet

            var hasDefault = parameter.ranges && parameter.ranges.default !== undefined
            var value = hasDefault ? parameter.ranges.default : 0
            var defaultValue = hasDefault ? parameter.ranges.default : undefined
            var isToggled = (parameter.properties || []).indexOf('toggled') >= 0
            var isInteger = (parameter.properties || []).indexOf('integer') >= 0 || valuetype === 'i' || valuetype === 'l'

            var built
            if (isToggled) {
                built = buildToggleRow(parameter.label, value, defaultValue, function (v) { gui.lv2PatchSet(parameter.uri, valuetype, v) })
            } else if (parameter.ranges) {
                built = buildSliderRow(parameter.label, value, parameter.ranges.minimum, parameter.ranges.maximum, isInteger, defaultValue,
                    function (v) { gui.lv2PatchSet(parameter.uri, valuetype, v) })
            } else {
                return
            }
            genericPane.append(built.row)
            paramRows[parameter.uri] = built
        })

        return paramRows
    }

    var MIN_PANEL_HEIGHT = 160
    var MAX_PANEL_HEIGHT_RATIO = 0.75
    var MIN_SPLIT_PCT = 15
    // skin's max share is capped so the generic param pane never shrinks
    // below its own 33% minimum
    var MAX_SPLIT_PCT = 67
    // skin pane's share of the panel width; the generic param pane gets the
    // remaining 33% by default until the user drags the divider
    var DEFAULT_SPLIT_PCT = 67
    var currentPluginUri = null

    // Skin zoom: skinBaseFit is the scale that makes the skin fit the pane
    // with no scrollbars (recomputed whenever a new skin is mounted or the
    // pane is resized); skinUserZoom is an extra multiplier from the zoom
    // buttons or pinch gesture, reset to 1 on every new skin. panX/panY are a
    // plain screen-pixel offset from dragging (see bindSkinPan) — listed
    // before scale() in the transform so the drag distance stays 1:1 with
    // the mouse regardless of the current zoom level.
    var skinBaseFit = 1
    var skinUserZoom = 1
    var panX = 0
    var panY = 0
    var MIN_USER_ZOOM = 0.3
    var MAX_USER_ZOOM = 4

    // pluginData.presets is [{uri, label, path}], pluginData.preset is the
    // active one's uri ('' if none) — see the comment above presetLoad() in
    // grid-app.js for why the latter can only ever come from a websocket
    // broadcast. A preset only gets Save/Delete enabled when it has a
    // non-empty path (a factory preset's path is always '', it isn't a
    // writable bundle). Lives in its own #grid-preset-rows box, same
    // prepend-once/refill-in-place pattern as buildConnectionRows below —
    // topmost in the panel since it's prepended after, on every open().
    function buildPresetRows(instance, pluginData) {
        var box = $('#grid-preset-rows')
        if (!box.length) {
            box = $('<div id="grid-preset-rows">')
            genericPane.prepend(box)
        } else {
            box.empty()
        }
        var presets = (pluginData && pluginData.presets) || []

        var row = $('<div class="grid-param-row grid-preset-control">')
        row.append($('<div class="grid-param-name">').text('Preset'))
        var control = $('<div class="grid-param-control">')

        var activeUri = (pluginData && pluginData.preset) || ''
        var current = presets.filter(function (p) { return p.uri === activeUri })[0]

        var select = $('<select class="grid-preset-select">')
        select.append($('<option value="">').text(presets.length ? '— none —' : 'No presets'))
        presets.forEach(function (p) { select.append($('<option>').val(p.uri).text(p.label)) })
        select.val(activeUri)
        select.change(function () {
            var uri = select.val()
            if (uri) presetLoad(instance, uri)
        })
        control.append(select)

        var saveBtn = $('<button type="button" class="grid-preset-btn" title="Save over the selected preset">Save</button>')
        saveBtn.prop('disabled', !(current && current.path))
        saveBtn.click(function () { if (current && current.path) presetSaveReplace(instance, current) })
        control.append(saveBtn)

        var saveAsBtn = $('<button type="button" class="grid-preset-btn" title="Save as a new preset">Save As…</button>')
        saveAsBtn.click(function () {
            var name = window.prompt('Name for the new preset:', current ? current.label + ' copy' : '')
            if (name) presetSaveNew(instance, name)
        })
        control.append(saveAsBtn)

        var deleteBtn = $('<button type="button" class="grid-preset-btn grid-preset-btn-danger" title="Delete the selected preset">Delete</button>')
        deleteBtn.prop('disabled', !(current && current.path))
        deleteBtn.click(function () {
            if (current && current.path && window.confirm('Delete preset "' + current.label + '"?')) presetDelete(instance, current)
        })
        control.append(deleteBtn)

        row.append(control)
        box.append(row)
    }

    // portInfo: {inputs: [{name, symbol, path, connected, peers: [{path, label}]}],
    // outputs: [...]} — see audioPortConnectionInfo() in grid-app.js. Lives in
    // the generic panel (not overlaid on the skin) since the skin's own layout
    // is arbitrary third-party markup an overlay can end up covering
    // unpredictably (see grid-dashboard.css comment above .grid-connection-control).
    // Rows live in their own #grid-connection-rows box, prepended once and
    // refilled in place on refresh, so refreshPorts() never disturbs the
    // control-port/parameter rows built by buildControlPorts/buildParameters
    // below it (those hold live setValue() references used for external sync).
    // Read-only aside from removing an existing connection — adding new ones
    // is left to dragging on the canvas, not this panel.
    function buildConnectionRows(portInfo) {
        var box = $('#grid-connection-rows')
        if (!box.length) {
            box = $('<div id="grid-connection-rows">')
            genericPane.prepend(box)
        } else {
            box.empty()
        }
        if (!portInfo) return

        function portRow(port, isInput) {
            var row = $('<div class="grid-param-row grid-connection-control">')
            var label = (isInput ? 'In: ' : 'Out: ') + port.name
            row.append($('<div class="grid-param-name">').text(label).attr('title', label))
            var control = $('<div class="grid-param-control">')

            control.append($('<span class="grid-connection-dot">').toggleClass('grid-connection-connected', port.connected))

            if (port.peers.length) {
                port.peers.forEach(function (peer) {
                    control.append($('<span class="grid-connection-peer">').text(peer.label))
                    var rm = $('<button type="button" class="grid-connection-remove" title="Disconnect">').html('&times;')
                    rm.click(function () {
                        if (!window.confirm('Remove this connection?')) return
                        var from = isInput ? peer.path : port.path
                        var to = isInput ? port.path : peer.path
                        restDisconnect(from, to)
                        pedalboardModified = true
                        rewireChain()
                    })
                    control.append(rm)
                })
            } else {
                control.append($('<span class="grid-connection-peer">').text('not connected'))
            }

            row.append(control)
            return row
        }

        portInfo.inputs.forEach(function (p) { box.append(portRow(p, true)) })
        portInfo.outputs.forEach(function (p) { box.append(portRow(p, false)) })
    }

    function applySkinTransform() {
        skinPane.find('.grid-skin-zoom-wrap').css('transform',
            'translate(' + panX + 'px, ' + panY + 'px) scale(' + (skinBaseFit * skinUserZoom) + ')')
    }

    function fitSkinToPane() {
        var wrap = skinPane.find('.grid-skin-zoom-wrap')
        var content = wrap.children().first()
        if (!content.length) return
        wrap.css('transform', 'none')
        var cw = content.outerWidth() || content.width()
        var ch = content.outerHeight() || content.height()
        if (!cw || !ch) return
        var pw = skinPane.width() - 20
        var ph = skinPane.height() - 20
        skinBaseFit = Math.min(pw / cw, ph / ch, 1)
        applySkinTransform()
    }

    function waitForSkinSizeThenFit(triesLeft) {
        var content = skinPane.find('.grid-skin-zoom-wrap').children().first()
        if (content.length && content.width() > 0 && content.height() > 0) {
            fitSkinToPane()
            return
        }
        if (triesLeft <= 0) return
        setTimeout(function () { waitForSkinSizeThenFit(triesLeft - 1) }, 100)
    }

    function bindSkinZoom() {
        $('#grid-skin-zoom-in').click(function () {
            skinUserZoom = Math.min(MAX_USER_ZOOM, skinUserZoom * 1.2)
            applySkinTransform()
        })
        $('#grid-skin-zoom-out').click(function () {
            skinUserZoom = Math.max(MIN_USER_ZOOM, skinUserZoom / 1.2)
            applySkinTransform()
        })
        // Wheel zooms the skin -- but only from the pane around it (the letterbox
        // margins / the zoom-control strip), never while the pointer is over the
        // plugin GUI itself. There the wheel is left alone, so the skin's own
        // scrollable widgets (NAM's model list, a preset list) keep working.
        skinPane.on('wheel', function (ev) {
            if ($(ev.target).closest('.grid-skin-zoom-wrap').length) {
                return
            }
            ev.preventDefault()
            var oe = ev.originalEvent || ev
            var factor = oe.deltaY < 0 ? 1.1 : 1 / 1.1
            skinUserZoom = Math.min(MAX_USER_ZOOM, Math.max(MIN_USER_ZOOM, skinUserZoom * factor))
            applySkinTransform()
        })

        var pinchStartDist = null
        var pinchStartZoom = 1
        function touchDist(t1, t2) {
            var dx = t1.clientX - t2.clientX, dy = t1.clientY - t2.clientY
            return Math.sqrt(dx * dx + dy * dy)
        }
        skinPane.on('touchstart', function (ev) {
            var t = ev.originalEvent.touches
            if (t.length === 2) {
                pinchStartDist = touchDist(t[0], t[1])
                pinchStartZoom = skinUserZoom
            }
        })
        skinPane.on('touchmove', function (ev) {
            var t = ev.originalEvent.touches
            if (t.length === 2 && pinchStartDist) {
                ev.preventDefault()
                var ratio = touchDist(t[0], t[1]) / pinchStartDist
                skinUserZoom = Math.min(MAX_USER_ZOOM, Math.max(MIN_USER_ZOOM, pinchStartZoom * ratio))
                applySkinTransform()
            }
        })
        skinPane.on('touchend touchcancel', function (ev) {
            if (ev.originalEvent.touches.length < 2) pinchStartDist = null
        })
    }

    // Drag with the mouse to reposition the (possibly zoomed-in) skin within
    // its pane. Plain mouse events (not pointer events), specifically so this
    // never fires for the touch gesture bindSkinZoom already handles above.
    // A drag starting on an actual plugin control (knob, button, dropdown...)
    // is left alone so it still works normally instead of panning the image.
    function bindSkinPan() {
        var dragging = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0

        skinPane.on('mousedown', function (ev) {
            if ($(ev.target).closest('.mod-port, [mod-widget], input, select, button, textarea, a').length) return
            if (!skinPane.find('.grid-skin-zoom-wrap').length) return
            dragging = true
            startX = ev.clientX
            startY = ev.clientY
            startPanX = panX
            startPanY = panY
            skinPane.addClass('grid-skin-panning')
            ev.preventDefault()
        })
        $(document).on('mousemove.skinpan', function (ev) {
            if (!dragging) return
            panX = startPanX + (ev.clientX - startX)
            panY = startPanY + (ev.clientY - startY)
            applySkinTransform()
        })
        $(document).on('mouseup.skinpan', function () {
            if (!dragging) return
            dragging = false
            skinPane.removeClass('grid-skin-panning')
        })
    }

    function clientXY(ev) {
        var oe = ev.originalEvent || ev
        return { x: oe.clientX, y: oe.clientY }
    }

    function applyPanelHeight(h) {
        panel.css('height', h + 'px')
        // keep the canvas-wrap's bottom margin in sync only while the panel is
        // actually shown — otherwise a closed panel would still be reserving space
        if (panel.hasClass('grid-hidden')) return
        $('#grid-canvas-wrap').css('bottom', h + 'px')
    }

    function applySplit(pct) {
        skinPane.css('flex', '0 0 ' + pct + '%')
    }

    function loadSplitFor(uri) {
        try {
            var v = localStorage.getItem('grid-panel-split:' + uri)
            return v ? parseFloat(v) : DEFAULT_SPLIT_PCT
        } catch (e) {
            return DEFAULT_SPLIT_PCT
        }
    }

    function saveSplitFor(uri, pct) {
        try { localStorage.setItem('grid-panel-split:' + uri, pct) } catch (e) {}
    }

    // Both handles use Pointer Events so the same code drags with mouse, pen or touch.
    function bindHeightResize() {
        var handle = $('#grid-panel-resize-height')
        var dragging = false, startY = 0, startHeight = 0

        handle.on('pointerdown', function (ev) {
            dragging = true
            startY = clientXY(ev).y
            startHeight = panel.height()
            ev.preventDefault()
        })
        $(document).on('pointermove', function (ev) {
            if (!dragging) return
            // pointer deltas are in real screen px; #grid-app-root is scaled by
            // uiZoom, so convert back to the panel's own (pre-scale) px space
            var zoom = (typeof uiZoom === 'number' && uiZoom) || 1
            var maxH = window.innerHeight * MAX_PANEL_HEIGHT_RATIO
            var h = Math.min(maxH, Math.max(MIN_PANEL_HEIGHT, startHeight - (clientXY(ev).y - startY) / zoom))
            applyPanelHeight(h)
        })
        $(document).on('pointerup pointercancel', function () {
            if (!dragging) return
            dragging = false
            try { localStorage.setItem('grid-panel-height', panel.height()) } catch (e) {}
            fitSkinToPane()
        })
    }

    function bindDividerResize() {
        var handle = $('#grid-panel-divider')
        var dragging = false, startX = 0, startPct = DEFAULT_SPLIT_PCT

        handle.on('pointerdown', function (ev) {
            dragging = true
            startX = clientXY(ev).x
            startPct = (skinPane.outerWidth() / panel.width()) * 100
            ev.preventDefault()
        })
        $(document).on('pointermove', function (ev) {
            if (!dragging) return
            // clientX deltas are real screen px (scaled by uiZoom); panel.width()
            // is layout px (unaffected by the CSS transform) so convert first
            var zoom = (typeof uiZoom === 'number' && uiZoom) || 1
            var deltaPct = (((clientXY(ev).x - startX) / zoom) / panel.width()) * 100
            applySplit(Math.min(MAX_SPLIT_PCT, Math.max(MIN_SPLIT_PCT, startPct + deltaPct)))
        })
        $(document).on('pointerup pointercancel', function () {
            if (!dragging) return
            dragging = false
            if (currentPluginUri) {
                saveSplitFor(currentPluginUri, (skinPane.outerWidth() / panel.width()) * 100)
            }
            fitSkinToPane()
        })
    }

    return {
        init: function () {
            panel = $('#grid-bottom-panel')
            skinPane = $('#grid-panel-skin')
            genericPane = $('#grid-panel-generic')

            $('#grid-panel-close').click(function () {
                GridParams.close()
                GridBoard.deselect()
            })

            try {
                var savedHeight = parseFloat(localStorage.getItem('grid-panel-height'))
                if (savedHeight) applyPanelHeight(savedHeight)
            } catch (e) {}

            bindHeightResize()
            bindDividerResize()
            bindSkinZoom()
            bindSkinPan()
        },

        // pendingValues: {symbol: value}, pendingParams: {uri: value} — values that arrived
        // over the websocket (pedalboard replay or external change) while no panel was open
        // for this instance, applied once the real port/parameter metadata is ready.
        // pendingOutputs/pendingReadableParams are the same idea for output-only control
        // ports and non-writable patch parameters (see "output_set" / the non-writable
        // "patch_set" branch in grid-app.js) — e.g. Audio File's waveform preview data,
        // which is only ever sent once, right after a track loads.
        open: function (instance, block, wsCallbacks, pendingValues, pendingParams, portInfo, pendingOutputs, pendingReadableParams) {
            GridParams.close()

            currentPluginUri = block.pluginData.uri
            applySplit(loadSplitFor(currentPluginUri))

            var gui = new GUI(block.pluginData, {
                bypassed: block.bypassed,
                defaultIconTemplate: DEFAULT_ICON_TEMPLATE,
                defaultSettingsTemplate: DEFAULT_SETTINGS_TEMPLATE,
                change: wsCallbacks.change,
                patchGet: wsCallbacks.patchGet,
                patchSet: wsCallbacks.patchSet,
            })

            genericPane.empty()
            filePathRows = []
            buildConnectionRows(portInfo)
            buildPresetRows(instance, block.pluginData)
            skinPane.find('.grid-skin-zoom-wrap').remove()
            skinUserZoom = 1
            panX = 0
            panY = 0

            var symbolRows, paramRows
            wrap(gui, 'setPortWidgetsValue', function (symbol, value) {
                if (symbolRows && symbolRows[symbol]) symbolRows[symbol].setValue(value)
            })
            wrap(gui, 'setWritableParameterValue', function (uri, valuetype, valuedata) {
                if (paramRows && paramRows[uri]) {
                    paramRows[uri].setValue(valuetype === 'p' || valuetype === 's' ? valuedata : parseFloat(valuedata))
                }
            })

            gui.render(instance, function (icon, settings) {
                var wrap = $('<div class="grid-skin-zoom-wrap">').append(icon)
                skinPane.append(wrap)
                symbolRows = buildControlPorts(gui, block.pluginData)
                paramRows = buildParameters(gui, block.pluginData)

                var pv = pendingValues || {}
                Object.keys(pv).forEach(function (symbol) { gui.setPortWidgetsValue(symbol, pv[symbol]) })
                var pp = pendingParams || {}
                Object.keys(pp).forEach(function (uri) { gui.setWritableParameterValue(uri, pp[uri].valuetype, pp[uri].value) })
                var po = pendingOutputs || {}
                Object.keys(po).forEach(function (symbol) { gui.setOutputPortValue(symbol, po[symbol]) })
                var prp = pendingReadableParams || {}
                Object.keys(prp).forEach(function (uri) { gui.setReadableParameterValue(uri, prp[uri].valuetype, prp[uri].value) })

                waitForSkinSizeThenFit(20)
            })

            current = { instance: instance, gui: gui }
            panel.removeClass('grid-hidden')
            $('#grid-canvas-wrap').addClass('grid-has-panel').css('bottom', panel.height() + 'px')
        },

        close: function () {
            if (!current) return
            skinPane.find('.grid-skin-zoom-wrap').remove()
            genericPane.empty()
            current = null
            currentPluginUri = null
            panel.addClass('grid-hidden')
            $('#grid-canvas-wrap').removeClass('grid-has-panel').css('bottom', '')
        },

        currentInstance: function () { return current ? current.instance : null },
        currentGui: function () { return current ? current.gui : null },
        // re-fetch the option list of the open path-parameter rows (e.g. after a
        // TONE3000 download adds NAM models) -- fileType optional filter.
        refreshFileParams: function (fileType) {
            if (typeof loadFileTypesList !== 'function') return
            filePathRows.forEach(function (entry) {
                var p = entry.parameter
                if (fileType && (!p.fileTypes || p.fileTypes.indexOf(fileType) < 0)) return
                loadFileTypesList(p, false, function () { entry.row.setFiles(p.files || []) })
            })
        },
        // called by rewireChain() in grid-app.js whenever connections change,
        // so the connection rows don't go stale while the panel stays open
        refreshPorts: function (portInfo) {
            if (!current) return
            buildConnectionRows(portInfo)
        },
        // called after a preset load/save/delete (see the "preset" websocket
        // case and refreshPluginPresets() in grid-app.js) so the preset row
        // doesn't go stale while the panel stays open
        refreshPresets: function (instance, pluginData) {
            if (!current || current.instance !== instance) return
            buildPresetRows(instance, pluginData)
        },
    }
})()
