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
    var overlay, pctEl
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

    return {
        init: function () {
            overlay = $('#grid-settings-overlay')
            pctEl = $('#grid-settings-font-pct')

            $('#grid-settings-toggle').click(function () { overlay.removeClass('grid-hidden') })
            $('#grid-settings-close').click(function () { overlay.addClass('grid-hidden') })
            overlay.click(function (ev) { if (ev.target === overlay[0]) overlay.addClass('grid-hidden') })

            $('#grid-settings-font-dec').click(function () { applyFontScale(fontScale - 0.1) })
            $('#grid-settings-font-inc').click(function () { applyFontScale(fontScale + 0.1) })
            $('#grid-settings-font-reset').click(function () { applyFontScale(1) })

            var saved = null
            try { saved = parseFloat(localStorage.getItem('grid-font-scale')) } catch (e) {}
            applyFontScale(saved || 1)
        },
    }
})()

$(document).ready(function () { GridSettings.init() })
