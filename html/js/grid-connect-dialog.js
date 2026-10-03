// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shown whenever wiring two blocks together isn't a single obvious choice
// (their audio port counts don't match 1:1) — grid-app.js decides when that
// is and calls open() with the two port lists; this module only presents the
// choice and reports back which output->input pairs the user picked.

var GridConnectDialog = (function () {
    var overlay, rowsEl, titleEl
    var selects = []
    var onConfirmCb = null

    function portLabel(instance, path) {
        var b = GridBoard.getBlock(instance)
        if (!b) return path
        if (b.isHardware) return b.el.find('.grid-block-name').text()
        var symbol = path.substring(path.lastIndexOf('/') + 1)
        var all = (b.pluginData.ports.audio.output || []).concat(b.pluginData.ports.audio.input || [])
        var found = all.filter(function (p) { return p.symbol === symbol })[0]
        return found ? (found.shortName || found.name || symbol) : symbol
    }

    function blockLabel(instance) {
        var b = GridBoard.getBlock(instance)
        return b ? b.el.find('.grid-block-name').text() : instance
    }

    return {
        init: function () {
            overlay = $('#grid-connect-dialog')
            rowsEl = $('#grid-connect-rows')
            titleEl = $('#grid-connect-title')

            $('#grid-connect-cancel').click(function () {
                overlay.addClass('grid-hidden')
                if (onConfirmCb) onConfirmCb([])
            })
            $('#grid-connect-confirm').click(function () {
                var pairs = []
                selects.forEach(function (s) {
                    var to = s.select.val()
                    if (to) pairs.push([s.from, to])
                })
                overlay.addClass('grid-hidden')
                if (onConfirmCb) onConfirmCb(pairs)
            })
        },

        // outs/ins are arrays of full port paths (see outputPortsOf/inputPortsOf
        // in grid-app.js). onConfirm receives an array of [outPath, inPath]
        // pairs to connect — empty if the user cancelled or chose nothing.
        open: function (fromInstance, toInstance, outs, ins, onConfirm) {
            onConfirmCb = onConfirm
            rowsEl.empty()
            selects = []
            titleEl.text(blockLabel(fromInstance) + ' → ' + blockLabel(toInstance))

            outs.forEach(function (outPath, i) {
                var row = $('<div class="grid-connect-row">')
                row.append($('<div class="grid-connect-port-name">').text(portLabel(fromInstance, outPath)))
                var select = $('<select>')
                select.append($('<option value="">— none —</option>'))
                ins.forEach(function (inPath) {
                    select.append($('<option>').val(inPath).text(portLabel(toInstance, inPath)))
                })
                // best-guess default: same-index destination port only — once the
                // outputs run past however many inputs exist, the rest default to
                // "none" rather than piling onto the last input a second time
                if (ins[i] !== undefined) select.val(ins[i])
                row.append(select)
                rowsEl.append(row)
                selects.push({ from: outPath, select: select })
            })

            overlay.removeClass('grid-hidden')
        },
    }
})()
