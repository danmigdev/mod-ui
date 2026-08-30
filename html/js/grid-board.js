// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Grid canvas rendering for the independent "grid" theme.
// See docs/plans/20260822_164312_grid_theme_fractal.md for the overall design.

// Same canonical category set the default theme's plugin browser uses
// (html/js/effects.js showPlugins), plus our own 'I/O' for hardware ports.
var CATEGORY_COLORS = {
    'Delay':          '#2f5fa8',
    'Distortion':     '#b23a3a',
    'Dynamics':       '#8a8a3a',
    'Filter':         '#3a6a3a',
    'Generator':      '#a05a2f',
    'MIDI':           '#a08a2f',
    'Modulator':      '#2f7d7d',
    'Reverb':         '#6a3aa0',
    'Simulator':      '#3a5aa0',
    'Spatial':        '#5a7d3a',
    'Spectral':       '#7d3a6a',
    'Utility':        '#55555a',
    'ControlVoltage': '#4a4a8a',
    'I/O':            '#2f6b3a',
    'default':        '#44444c',
}

var CATEGORY_ORDER = ['Delay', 'Distortion', 'Dynamics', 'Filter', 'Generator', 'MIDI', 'Modulator',
                       'Reverb', 'Simulator', 'Spatial', 'Spectral', 'Utility', 'ControlVoltage']

function categoryColor(pluginData) {
    var cat = (pluginData.category && pluginData.category[0]) || 'default'
    return CATEGORY_COLORS[cat] || CATEGORY_COLORS['default']
}

// Every marquee label (block names here, shelf tiles in grid-app.js) phases
// itself against this one shared wall-clock instead of always starting at
// 0%. A label's DOM element often gets torn down and recreated for reasons
// that have nothing to do with it — the shelf rebuilding its tile set when a
// hardware port list changes in the background, a panel re-rendering — and
// without this, every single one of those would snap the animation back to
// the beginning, which reads as the scroll "stopping and restarting" even
// though nothing about the label itself actually changed.
var MARQUEE_DURATION_MS = 5000
function marqueePhaseDelay() {
    return '-' + ((Date.now() % MARQUEE_DURATION_MS) / 1000) + 's'
}

var GridBoard = (function () {
    var canvasWrap, canvas, cableSvg
    // Blocks are always square, never a rectangle. Zoom is handled at the page
    // level (see grid-app.js applyUiZoom) so this geometry stays fixed.
    var cellW = 118, cellH = 118, gap = 16
    var cols = 6, rows = 3
    var blocks = {}     // instance -> block state
    var occupancy = {}  // "col_row" -> instance
    var selectedInstance = null

    var callbacks = {
        onSelect: function (instance) {},
        onDeselect: function () {},
        onEmptyCellClick: function (col, row) {},
        onDimensionsChanged: function (cols, rows) {},
        onBlockMoved: function (instance) {},
        onRemoveRequested: function (instance) {},
        onShelfItemDropped: function (payload, col, row) {},
        onManualConnect: function (fromInstance, toInstance) {},
        onManualDisconnect: function (fromInstance, toInstance) {},
    }

    function key(c, r) { return c + '_' + r }

    function cellLeft(c) { return c * (cellW + gap) + gap }
    function cellTop(r) { return r * (cellH + gap) + gap }

    function canvasWidth() { return cols * (cellW + gap) + gap }
    function canvasHeight() { return rows * (cellH + gap) + gap }

    function colFromX(x) { return Math.min(cols - 1, Math.max(0, Math.round((x - gap) / (cellW + gap)))) }
    function rowFromY(y) { return Math.min(rows - 1, Math.max(0, Math.round((y - gap) / (cellH + gap)))) }

    function findFreeCell() {
        for (var r = 0; r < rows; r++) {
            for (var c = 0; c < cols; c++) {
                if (!occupancy[key(c, r)]) return { col: c, row: r }
            }
        }
        return null
    }

    function resizeCanvasEl() {
        canvas.css({ width: canvasWidth(), height: canvasHeight() })
        cableSvg.attr('width', canvasWidth()).attr('height', canvasHeight())
    }

    function attachDropTarget(el, getTargetCell) {
        el.on('dragover', function (ev) { ev.preventDefault() })
        el.on('drop', function (ev) {
            ev.preventDefault()
            var target = getTargetCell()
            if (!target) return

            var dt = ev.originalEvent.dataTransfer
            var shelfPayload = dt.getData('application/x-grid-shelf-item')
            if (shelfPayload) {
                callbacks.onShelfItemDropped(JSON.parse(shelfPayload), target.col, target.row)
                return
            }

            var instance = dt.getData('text/plain')
            if (!instance || !blocks[instance]) return
            if (moveBlock(instance, target.col, target.row)) callbacks.onBlockMoved(instance)
        })
    }

    function moveBlock(instance, col, row) {
        var block = blocks[instance]
        if (!block || (block.col === col && block.row === row)) return false
        var occupant = occupancy[key(col, row)]
        var oldCol = block.col, oldRow = block.row
        if (occupant && occupant !== instance) {
            placeAt(occupant, oldCol, oldRow)
            positionBlock(blocks[occupant])
        } else {
            delete occupancy[key(oldCol, oldRow)]
        }
        placeAt(instance, col, row)
        positionBlock(block)
        redrawEmptyCells()
        redrawCables()
        return true
    }

    function redrawEmptyCells() {
        canvas.find('.grid-cell-empty').remove()
        for (var r = 0; r < rows; r++) {
            for (var c = 0; c < cols; c++) {
                if (occupancy[key(c, r)]) continue
                var cell = $('<div class="grid-cell-empty">').css({
                    left: cellLeft(c), top: cellTop(r), width: cellW, height: cellH,
                })
                ;(function (col, row) {
                    cell.click(function () { callbacks.onEmptyCellClick(col, row) })
                    attachDropTarget(cell, function () { return { col: col, row: row } })
                })(c, r)
                canvas.append(cell)
            }
        }
    }

    function positionBlock(block) {
        block.el.css({ left: cellLeft(block.col), top: cellTop(block.row), width: cellW, height: cellH })
    }

    var manualLinks = [] // [{from: instance, to: instance}], set by grid-app.js from currentConnections —
                         // every real connection looks and behaves the same, regardless of how the two
                         // blocks happen to be arranged on the grid right now

    function drawCableLine(a, b, fromInstance, toInstance) {
        if (!a || !b) return
        var x1 = cellLeft(a.col) + cellW
        var y1 = cellTop(a.row) + cellH / 2
        var x2 = cellLeft(b.col)
        var y2 = cellTop(b.row) + cellH / 2

        var tag = 'line', d = null
        if (a.row !== b.row) {
            // crosses rows: a straight diagonal reads badly against the grid,
            // so use a horizontal-tangent bezier (spline) instead
            var dx = Math.max(40, (x2 - x1) / 2)
            d = 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2
            tag = 'path'
        }

        function makeEl(cls) {
            var el = document.createElementNS('http://www.w3.org/2000/svg', tag)
            if (tag === 'path') {
                el.setAttribute('d', d)
                el.setAttribute('fill', 'none')
            } else {
                el.setAttribute('x1', x1)
                el.setAttribute('y1', y1)
                el.setAttribute('x2', x2)
                el.setAttribute('y2', y2)
            }
            el.setAttribute('class', cls)
            return el
        }

        // a thin visible line plus a much fatter invisible one underneath for
        // an actually clickable hit target (see the CSS for both classes) —
        // the visible one is pointer-events:none so clicks fall through to it
        var visible = makeEl('grid-cable-line')
        var hit = makeEl('grid-cable-hit')
        hit.addEventListener('click', function (ev) {
            ev.stopPropagation()
            callbacks.onManualDisconnect(fromInstance, toInstance)
        })
        hit.addEventListener('mouseenter', function () { visible.classList.add('grid-cable-hover') })
        hit.addEventListener('mouseleave', function () { visible.classList.remove('grid-cable-hover') })
        cableSvg[0].appendChild(hit)
        cableSvg[0].appendChild(visible)
    }

    function redrawCables() {
        cableSvg.empty()
        manualLinks.forEach(function (link) {
            drawCableLine(blocks[link.from], blocks[link.to], link.from, link.to)
        })
    }

    function selectBlock(instance) {
        if (selectedInstance === instance) return
        if (selectedInstance && blocks[selectedInstance]) {
            blocks[selectedInstance].el.removeClass('grid-block-selected')
        }
        selectedInstance = instance
        if (instance && blocks[instance]) {
            blocks[instance].el.addClass('grid-block-selected')
            callbacks.onSelect(instance)
        }
    }

    function deselect() {
        if (selectedInstance && blocks[selectedInstance]) {
            blocks[selectedInstance].el.removeClass('grid-block-selected')
        }
        selectedInstance = null
        callbacks.onDeselect()
    }

    function placeAt(instance, col, row) {
        occupancy[key(col, row)] = instance
        blocks[instance].col = col
        blocks[instance].row = row
    }

    function makeBlockNameEl(label) {
        var nameEl = $('<div class="grid-block-name">').text(label)
        // if the label is too long to fit the square block, scroll it instead of clipping
        setTimeout(function () {
            if (nameEl[0].scrollWidth > nameEl[0].clientWidth + 1) {
                nameEl.empty().addClass('grid-marquee')
                var track = $('<div class="grid-marquee-track">').css('animation-delay', marqueePhaseDelay())
                track.append($('<span>').text(label)).append($('<span>').text(label))
                nameEl.append(track)
            }
        }, 0)
        return nameEl
    }

    // jQuery 1.9.1 predates the Pointer Events spec, so it doesn't normalize
    // clientX/clientY/pointerId onto its wrapped Event for pointer* types —
    // always read those off the native event.
    function nativeEvent(ev) { return ev.originalEvent || ev }

    // Converts a pointer event's screen coordinates into the canvas's own
    // local coordinate space, independent of whatever CSS transform (e.g. the
    // page-wide zoom in grid-app.js) is currently scaling it on screen.
    function pointerToCanvasCoords(ev) {
        var ne = nativeEvent(ev)
        var rect = canvas[0].getBoundingClientRect()
        var sx = rect.width / canvas[0].offsetWidth
        var sy = rect.height / canvas[0].offsetHeight
        return { x: (ne.clientX - rect.left) / sx, y: (ne.clientY - rect.top) / sy }
    }

    // Fractal-style manual cable handle: drag from a block's right edge onto
    // any other block to request a connection (grid-app.js validates ports
    // and decides whether it's actually possible).
    function addConnectorHandle(el, instance) {
        var handle = $('<div class="grid-block-handle">').attr('draggable', 'false')
        el.append(handle)
        var tempLine = null

        handle.on('pointerdown', function (ev) {
            ev.stopPropagation()
            ev.preventDefault()
            var ne = nativeEvent(ev)
            try { ne.target.setPointerCapture(ne.pointerId) } catch (e) {}

            var b = blocks[instance]
            var x0 = cellLeft(b.col) + cellW
            var y0 = cellTop(b.row) + cellH / 2
            tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'line')
            tempLine.setAttribute('class', 'grid-cable-dragging')
            tempLine.setAttribute('x1', x0)
            tempLine.setAttribute('y1', y0)
            tempLine.setAttribute('x2', x0)
            tempLine.setAttribute('y2', y0)
            cableSvg[0].appendChild(tempLine)

            function onMove(mev) {
                var p = pointerToCanvasCoords(mev)
                tempLine.setAttribute('x2', p.x)
                tempLine.setAttribute('y2', p.y)
            }
            function onUp(uev) {
                handle.off('pointermove', onMove)
                handle.off('pointerup', onUp)
                if (tempLine) { tempLine.remove(); tempLine = null }
                var nu = nativeEvent(uev)
                var underPointer = document.elementFromPoint(nu.clientX, nu.clientY)
                var targetBlockEl = underPointer ? $(underPointer).closest('.grid-block')[0] : null
                var targetInstance = targetBlockEl ? $(targetBlockEl).attr('data-instance') : null
                if (targetInstance && targetInstance !== instance) {
                    callbacks.onManualConnect(instance, targetInstance)
                }
            }
            handle.on('pointermove', onMove)
            handle.on('pointerup', onUp)
        })
    }

    function addBlockCommon(instance, col, row, label, isHardware, iconEl, hasInputs, hasOutputs) {
        // Guards against double-creation: a REST add response and a
        // websocket "add" broadcast for the same instance can race (see
        // pluginAdd in grid-app.js). Returning null (not the existing block)
        // makes the caller skip its own one-time setup too — otherwise e.g.
        // addPluginBlock would rebind a second click handler onto the same
        // remove button, firing the confirm dialog twice per click.
        if (blocks[instance]) return null

        var el = $('<div class="grid-block">').attr('draggable', 'true').attr('data-instance', instance)
        if (isHardware) el.addClass('grid-block-hardware')

        // Everything that must never visually escape the block's footprint
        // (icon + name + led) lives in this inner, clipped layer; the
        // intentionally edge-hanging bits (remove/handle/no-io markers) are
        // appended to el directly, outside the clip, further down.
        var inner = $('<div class="grid-block-inner">')
        if (iconEl) inner.append(iconEl)
        inner.append(makeBlockNameEl(label))
        inner.append($('<div class="grid-block-led">'))
        el.append(inner)

        var remove = $('<div class="grid-block-remove">').html('&times;')
        el.append(remove)

        // Blocks that can't be a connection source/target at all are marked
        // so the user isn't left wondering why nothing happens when they try.
        if (!hasInputs) {
            el.addClass('grid-block-no-inputs')
            el.append($('<div class="grid-block-no-io grid-block-no-io-in" title="No audio input">'))
        }
        if (!hasOutputs) {
            el.addClass('grid-block-no-outputs')
            el.append($('<div class="grid-block-no-io grid-block-no-io-out" title="No audio output">'))
        }

        el.click(function (ev) {
            if ($(ev.target).is('.grid-block-remove, .grid-block-handle')) return
            selectBlock(instance)
        })

        el.on('dragstart', function (ev) {
            ev.originalEvent.dataTransfer.setData('text/plain', instance)
            ev.originalEvent.dataTransfer.effectAllowed = 'move'
        })
        attachDropTarget(el, function () {
            var b = blocks[instance]
            return b ? { col: b.col, row: b.row } : null
        })
        if (hasOutputs) addConnectorHandle(el, instance)

        canvas.append(el)

        blocks[instance] = {
            el: el,
            col: col,
            row: row,
            isHardware: !!isHardware,
            bypassed: false,
        }
        placeAt(instance, col, row)
        positionBlock(blocks[instance])
        redrawEmptyCells()
        redrawCables()
        return blocks[instance]
    }

    return {
        init: function (opts) {
            $.extend(callbacks, opts)
            canvasWrap = $('#grid-canvas-wrap')
            canvas = $('#grid-canvas')
            cableSvg = $(document.createElementNS('http://www.w3.org/2000/svg', 'svg')).attr('id', 'grid-cable-layer')
            canvas.append(cableSvg)
            resizeCanvasEl()
            redrawEmptyCells()

            canvas.click(function (ev) {
                if (ev.target === canvas[0]) deselect()
            })
        },

        setDimensions: function (newCols, newRows) {
            // guard: never shrink into an occupied row/column
            if (newCols < cols) {
                for (var r = 0; r < rows; r++) {
                    if (occupancy[key(cols - 1, r)]) return false
                }
            }
            if (newRows < rows) {
                for (var c = 0; c < cols; c++) {
                    if (occupancy[key(c, rows - 1)]) return false
                }
            }
            cols = Math.max(1, newCols)
            rows = Math.max(1, newRows)
            resizeCanvasEl()
            redrawEmptyCells()
            redrawCables()
            callbacks.onDimensionsChanged(cols, rows)
            return true
        },

        getDimensions: function () { return { cols: cols, rows: rows } },
        cellSize: function () { return { w: cellW, h: cellH, gap: gap } },
        colFromX: colFromX,
        rowFromY: rowFromY,
        cellLeft: cellLeft,
        cellTop: cellTop,

        addPluginBlock: function (instance, pluginData, bypassed, col, row) {
            if (occupancy[key(col, row)]) {
                var free = findFreeCell()
                if (!free) return null
                col = free.col
                row = free.row
            }
            var label = pluginData.label || pluginData.name || instance
            // same real pedal thumbnail as the shelf tile, not the generic
            // category glyph — no reason for the two to look different
            var iconEl = (typeof pluginThumbnailUrl === 'function')
                ? $('<img class="grid-shelf-item-thumb">').attr('src', pluginThumbnailUrl(pluginData))
                    .on('error', function () { $(this).attr('src', '/resources/pedals/default-thumbnail.png') })
                : null
            var hasIn = !!(pluginData.ports.audio.input && pluginData.ports.audio.input.length)
            var hasOut = !!(pluginData.ports.audio.output && pluginData.ports.audio.output.length)
            var block = addBlockCommon(instance, col, row, label, false, iconEl, hasIn, hasOut)
            if (!block) return blocks[instance] // already existed, one-time setup below already happened

            block.pluginData = pluginData
            block.bypassed = !!bypassed
            block.el.css('border-top-color', categoryColor(pluginData))
            if (block.bypassed) block.el.addClass('grid-block-bypassed')

            block.el.find('.grid-block-remove').click(function (ev) {
                ev.stopPropagation()
                callbacks.onRemoveRequested(instance)
            })
            return block
        },

        addHardwareBlock: function (instance, type, isOutput, name, col, row) {
            if (col === undefined || row === undefined || occupancy[key(col, row)]) {
                var free = findFreeCell()
                if (!free) return null
                col = free.col
                row = free.row
            }
            var label = name || instance
            var iconEl = (typeof hwIconSvg === 'function')
                ? $(hwIconSvg(type, isOutput)).removeClass('grid-shelf-item-thumb').addClass('grid-block-icon')
                : null
            // isOutput is the graph-direction flag: true means this port is a
            // SOURCE (a capture/system-in jack, displayed as "In N" — see
            // grid-app.js's outputPortsOf/friendlyHwName), so it has an
            // output/connector-handle and no input, not the other way round
            var block = addBlockCommon(instance, col, row, label, true, iconEl, !isOutput, !!isOutput)
            if (!block) return blocks[instance]

            block.hwType = type
            block.hwOutput = !!isOutput
            block.el.find('.grid-block-remove').click(function (ev) {
                ev.stopPropagation()
                callbacks.onRemoveRequested(instance)
            })
            return block
        },

        removeBlock: function (instance) {
            var block = blocks[instance]
            if (!block) return
            delete occupancy[key(block.col, block.row)]
            block.el.remove()
            delete blocks[instance]
            if (selectedInstance === instance) deselect()
            redrawEmptyCells()
            redrawCables()
        },

        setBypassed: function (instance, bypassed) {
            var block = blocks[instance]
            if (!block) return
            block.bypassed = !!bypassed
            block.el.toggleClass('grid-block-bypassed', block.bypassed)
        },

        getBlock: function (instance) { return blocks[instance] },
        hasInstance: function (instance) { return !!blocks[instance] },
        instanceAt: function (col, row) { return occupancy[key(col, row)] || null },

        reset: function () {
            for (var instance in blocks) blocks[instance].el.remove()
            blocks = {}
            occupancy = {}
            deselect()
            redrawEmptyCells()
            redrawCables()
        },
        setManualLinks: function (links) {
            manualLinks = links || []
            redrawCables()
        },
        selectBlock: selectBlock,
        deselect: deselect,
        getSelected: function () { return selectedInstance },
    }
})()
