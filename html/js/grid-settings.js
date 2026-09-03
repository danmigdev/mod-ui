// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Text size setting: independent of the toolbar's "Zoom" (which scales the
// whole #grid-app-root layout — blocks, spacing, everything — via a CSS
// transform, see zoomUi in grid-app.js). This instead adjusts the root
// font-size that every font-size in grid-dashboard.css is expressed in rem
// against (see the comment above "html { font-size: ... }" there), so only
// the text grows or shrinks, leaving layout/spacing untouched. The two
// controls are independent and can be combined freely.

var GridSettings = (function () {
    var overlay, pctEl, bufBtns
    var ROOT_FONT_PX = 10 // must match grid-dashboard.css's "html { font-size }"
    var MIN_SCALE = 0.8
    var MAX_SCALE = 1.5
    var fontScale = 1

    function applyFontScale(scale) {
        fontScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
        document.documentElement.style.fontSize = (ROOT_FONT_PX * fontScale) + 'px'
        pctEl.text(Math.round(fontScale * 100) + '%')
        try { localStorage.setItem('grid-font-scale', fontScale) } catch (e) {}
    }

    // Audio buffer size: the backend only offers 128 or 256 frames (see
    // SetBufferSize / /set_buffersize in webserver.py). Changing it restarts
    // JACK, so audio drops for a moment.
    var currentBuffer = (typeof BUFFER_SIZE === 'number' && BUFFER_SIZE) || 128

    function markBuffer(size) {
        currentBuffer = size
        bufBtns.each(function () {
            var b = $(this)
            b.toggleClass('grid-settings-seg-active', parseInt(b.attr('data-size'), 10) === size)
        })
    }

    function setBuffer(size) {
        if (size === currentBuffer) return
        bufBtns.prop('disabled', true)
        if (typeof notify === 'function') notify('info', 'Switching audio buffer to ' + size + ' frames…')
        $.ajax({
            url: '/set_buffersize/' + size,
            method: 'POST',
            cache: false,
            dataType: 'json',
            success: function (resp) {
                bufBtns.prop('disabled', false)
                if (resp && resp.ok) {
                    markBuffer(resp.size)
                    if (typeof notify === 'function') notify('info', 'Audio buffer is now ' + resp.size + ' frames')
                } else {
                    markBuffer(resp && resp.size ? resp.size : currentBuffer)
                    if (typeof notify === 'function') notify('error', "Couldn't change the audio buffer size")
                }
            },
            error: function () {
                bufBtns.prop('disabled', false)
                if (typeof notify === 'function') notify('error', "Couldn't change the audio buffer size")
            },
        })
    }

    return {
        init: function () {
            overlay = $('#grid-settings-overlay')
            pctEl = $('#grid-settings-font-pct')
            bufBtns = $('#grid-buffer-128, #grid-buffer-256')

            $('#grid-settings-toggle').click(function () { overlay.removeClass('grid-hidden') })
            $('#grid-settings-close').click(function () { overlay.addClass('grid-hidden') })
            overlay.click(function (ev) { if (ev.target === overlay[0]) overlay.addClass('grid-hidden') })

            $('#grid-settings-font-dec').click(function () { applyFontScale(fontScale - 0.1) })
            $('#grid-settings-font-inc').click(function () { applyFontScale(fontScale + 0.1) })
            $('#grid-settings-font-reset').click(function () { applyFontScale(1) })

            bufBtns.click(function () { setBuffer(parseInt($(this).attr('data-size'), 10)) })
            markBuffer(currentBuffer === 256 ? 256 : 128)

            var saved = null
            try { saved = parseFloat(localStorage.getItem('grid-font-scale')) } catch (e) {}
            applyFontScale(saved || 1)
        },
    }
})()

$(document).ready(function () { GridSettings.init() })
