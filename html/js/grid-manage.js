// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// New-pedalboard and new-bank creation live in the left nav panel now (see
// GridNav's "+" button in grid-nav.js) — this module only covers the one
// creation flow that toolbar keeps: a new snapshot of the current
// pedalboard's live state (GET /snapshot/saveas). Uses plain
// window.prompt/confirm, same as the rest of this theme's power-off and
// pedalboard-switch confirmations — no extra dialog needed.

var GridManage = (function () {
    function refreshNav() {
        if (typeof GridNav !== 'undefined') GridNav.refresh()
    }

    function newSnapshot() {
        var name = window.prompt('Name for the new snapshot:', '')
        if (!name) return

        $.ajax({
            url: '/snapshot/saveas',
            data: { title: name },
            cache: false,
            dataType: 'json',
            success: function (resp) {
                if (!resp || !resp.ok) {
                    notify('error', "Couldn't save the new snapshot")
                    return
                }
                notify('info', 'Snapshot "' + resp.title + '" saved')
                refreshNav()
            },
            error: function () { notify('error', "Couldn't save the new snapshot") },
        })
    }

    return {
        init: function () {
            $('#grid-new-snapshot').click(newSnapshot)
        },
    }
})()

$(document).ready(function () { GridManage.init() })
