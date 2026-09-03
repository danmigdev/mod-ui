// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Collapsible left-side tree: Bank > Pedalboard > Snapshot. Snapshots can only
// be listed for whichever pedalboard is currently loaded (/snapshot/list has
// no notion of "which pedalboard", it always answers for the running one), so
// only the current pedalboard's node expands into snapshot children.
//
// Each row also gets a small "..." action button (rename/delete/duplicate),
// using the same window.prompt/confirm + notify() toast pattern as
// grid-manage.js's creation flows — no custom modal dialogs.

var GridNav = (function () {
    var panel, tree, backdrop
    var banksData = null
    var callbacks = {
        loadPedalboard: function (bundlepath, title) {},
        loadSnapshot: function (idx) {},
    }

    // load()/render() rebuild the whole tree from scratch on every refresh
    // (e.g. after saving/deleting a snapshot), so which bank was expanded
    // has to be remembered separately here — bank objects themselves get
    // replaced wholesale by each /banks/raw fetch, so this is keyed by
    // title rather than object identity.
    var expandedBanks = {}

    function el(tag, cls, text) {
        var e = $(document.createElement(tag))
        if (cls) e.addClass(cls)
        if (text !== undefined) e.text(text)
        return e
    }

    function safeNotify(type, message) {
        if (typeof notify === 'function') notify(type, message)
    }

    function refreshBankNameIfAvailable() {
        if (typeof refreshCurrentBankName === 'function') refreshCurrentBankName()
    }

    function refreshEmptyStateIfAvailable() {
        if (typeof updateEmptyState === 'function') updateEmptyState()
    }

    // ---- tiny contextual action menu (shared single instance) ----

    var actionMenu = null

    function closeActionMenu() {
        if (actionMenu) { actionMenu.remove(); actionMenu = null }
        $(document).off('click.gridNavMenu')
    }

    function openActionMenu(anchorEl, actions) {
        closeActionMenu()
        var menu = el('div', 'grid-nav-menu')
        actions.forEach(function (a) {
            var item = el('div', 'grid-nav-menu-item', a.label)
            if (a.danger) item.addClass('grid-nav-menu-item-danger')
            item.click(function (ev) {
                ev.stopPropagation()
                closeActionMenu()
                a.run()
            })
            menu.append(item)
        })
        $('body').append(menu)
        var rect = anchorEl.getBoundingClientRect()
        var top = rect.bottom + 4
        var left = Math.max(4, rect.right - menu.outerWidth())
        menu.css({ top: top, left: left })
        actionMenu = menu
        setTimeout(function () {
            $(document).on('click.gridNavMenu', closeActionMenu)
        }, 0)
    }

    function actionButton() {
        var btn = el('button', 'grid-nav-action-btn')
        btn.attr('type', 'button').html('&#8942;')
        btn.click(function (ev) {
            ev.stopPropagation()
        })
        return btn
    }

    // ---- REST actions ----

    // Starts empty — it used to seed itself with whatever pedalboard was
    // currently loaded, but that pedalboard usually already belongs to some
    // other bank, so it looked like a random pedalboard from elsewhere had
    // been copied in. Adding pedalboards to a bank is now pedalboardCreate's
    // job (pick a bank when creating) or an explicit action of its own.
    //
    // Writes banksData directly (like every other write in this file, e.g.
    // bankRename/bankDelete below) instead of fetching a fresh copy of
    // /banks to build on — GET /banks re-resolves every pedalboard reference
    // against the server's own pedalboard cache on every call, and that
    // cache can be transiently behind (see the comment in pedalboardCreate),
    // silently dropping a bank's real pedalboards from the response. Basing
    // a save on a fetch like that is genuinely destructive: it did once
    // wipe out the user's real BANK1/AUTOTUNE bank during testing here.
    // banksData is already the correct, currently-displayed state, so it's
    // both simpler and safe to build on directly.
    function bankCreate() {
        var name = window.prompt('Name for the new bank:', '')
        if (!name) return
        banksData = banksData || []
        banksData.push({ title: name, pedalboards: [] })
        $.ajax({
            url: '/banks/save', type: 'POST', contentType: 'application/json',
            processData: false, data: JSON.stringify(banksData), cache: false, dataType: 'json',
            success: function (ok) {
                if (!ok) { safeNotify('error', "Couldn't save the new bank"); return }
                safeNotify('info', 'Bank "' + name + '" created')
                render()
            },
            error: function () { safeNotify('error', "Couldn't save the new bank") },
        })
    }

    function currentBundle() {
        return (typeof BUNDLE_PATH !== 'undefined' && BUNDLE_PATH) ? BUNDLE_PATH : null
    }
    function currentTitle() {
        return (typeof PEDALBOARD_TITLE !== 'undefined' && PEDALBOARD_TITLE) ? PEDALBOARD_TITLE : 'Untitled'
    }
    function currentIsBanked() {
        var b = currentBundle()
        return !!b && (banksData || []).some(function (bank) {
            return (bank.pedalboards || []).some(function (pb) { return pb.bundle === b })
        })
    }

    // The tree only shows pedalboards that are in a bank. The one loaded at
    // boot usually isn't, so "Save" writes it to disk with nowhere on screen
    // showing where -- this files it into a bank (existing name or a new one)
    // so it appears in the tree like everything else.
    function addCurrentToBank() {
        var bundle = currentBundle()
        if (!bundle) return
        var title = currentTitle()
        var name = window.prompt(
            'Bank name -- "' + title + '" will be filed into it:', title)
        if (!name) return
        banksData = banksData || []
        var bank = banksData.filter(function (b) { return b.title === name })[0]
        if (!bank) { bank = { title: name, pedalboards: [] }; banksData.push(bank) }
        bank.pedalboards = bank.pedalboards || []
        if (!bank.pedalboards.some(function (pb) { return pb.bundle === bundle })) {
            bank.pedalboards.push({ bundle: bundle, title: title })
        }
        $.ajax({
            url: '/banks/save', type: 'POST', contentType: 'application/json',
            processData: false, data: JSON.stringify(banksData), cache: false, dataType: 'json',
            success: function (ok) {
                if (!ok) { safeNotify('error', "Couldn't save the bank"); return }
                safeNotify('info', '"' + title + '" is now in bank "' + name + '"')
                render()
            },
            error: function () { safeNotify('error', "Couldn't save the bank") },
        })
    }

    // A pedalboard not listed in any bank's "pedalboards" array never shows
    // up in this tree at all (it renders one node per bank, nothing else) —
    // so creating one only makes sense from a specific bank's own "..."
    // menu, which already tells this which bank to file it under; no more
    // separate picker needed.
    //
    // GET /reset clears the running pedalboard (the server broadcasts
    // "remove :all" over the websocket, which grid-app.js already handles by
    // clearing the canvas — see its ws.onmessage "remove"/":all" case), then
    // POST /pedalboard/save with asNew=1 saves the now-empty graph as a new
    // pedalboard bundle, appended to bank's pedalboards list and saved right
    // after.
    function pedalboardCreate(bank) {
        var name = window.prompt('Name for the new pedalboard:', '')
        if (!name) return
        if (typeof pedalboardModified !== 'undefined' && pedalboardModified &&
            !window.confirm('Discard unsaved changes to the current pedalboard and start a new one?')) {
            return
        }
        $.ajax({
            url: '/reset',
            cache: false,
            dataType: 'json',
            success: function (ok) {
                if (!ok) { safeNotify('error', "Couldn't reset the pedalboard"); return }
                $.ajax({
                    url: '/pedalboard/save', type: 'POST', data: { title: name, asNew: 1 },
                    cache: false, dataType: 'json',
                    success: function (result) {
                        if (!result || !result.ok) { safeNotify('error', "Couldn't save the new pedalboard"); return }
                        BUNDLE_PATH = result.bundlepath
                        PEDALBOARD_TITLE = result.title
                        $('#grid-title').text(result.title)
                        if (typeof pedalboardModified !== 'undefined') pedalboardModified = false
                        refreshEmptyStateIfAvailable()

                        bank.pedalboards = bank.pedalboards || []
                        bank.pedalboards.push({ bundle: result.bundlepath, title: result.title })
                        $.ajax({
                            url: '/banks/save', type: 'POST', contentType: 'application/json',
                            // bank is a reference into banksData itself, already mutated
                            // above, so this posts the correct full state either way
                            processData: false, data: JSON.stringify(banksData), cache: false, dataType: 'json',
                            success: function () {
                                safeNotify('info', 'New pedalboard "' + result.title + '" created in "' + bank.title + '"')
                                // GET /banks re-resolves each bundle against the server's
                                // own pedalboard cache, which /pedalboard/save only just
                                // told to refresh in the background — a re-fetch this soon
                                // would very likely race that and still find no match,
                                // silently dropping the pedalboard right back out of the
                                // response. banksData (mutated above) already is the
                                // correct end state, so render it directly instead.
                                render()
                            },
                            error: function () { safeNotify('error', 'Pedalboard created, but could not add it to the bank'); load() },
                        })
                    },
                    error: function () { safeNotify('error', "Couldn't save the new pedalboard") },
                })
            },
            error: function () { safeNotify('error', "Couldn't reset the pedalboard") },
        })
    }

    function bankRename(bank) {
        var name = window.prompt('Rename bank:', bank.title)
        if (!name || name === bank.title) return
        bank.title = name
        $.ajax({
            url: '/banks/save', type: 'POST', contentType: 'application/json',
            processData: false, data: JSON.stringify(banksData), cache: false, dataType: 'json',
            success: function (ok) {
                if (!ok) { safeNotify('error', "Couldn't rename bank"); return }
                safeNotify('info', 'Bank renamed to "' + name + '"')
                render()
            },
            error: function () { safeNotify('error', "Couldn't rename bank") },
        })
    }

    // A pedalboard can't exist outside of some bank (see pedalboardCreate)
    // and is only ever moved between banks (see pedalboardMoveToBank), never
    // shared by two at once — so a bank that still holds pedalboards can't
    // be deleted out from under them; they have to be moved or deleted
    // first, same as a non-empty folder.
    function bankDelete(bank) {
        if (bank.pedalboards && bank.pedalboards.length) {
            safeNotify('error', 'Move or delete the pedalboards in "' + bank.title + '" first')
            return
        }
        if (!window.confirm('Delete bank "' + bank.title + '"?')) return
        var idx = banksData.indexOf(bank)
        if (idx < 0) return
        banksData = banksData.slice(0, idx).concat(banksData.slice(idx + 1))
        $.ajax({
            url: '/banks/save', type: 'POST', contentType: 'application/json',
            // render() the already-updated banksData directly rather than
            // load()-ing a fresh copy afterwards — see the comment above
            // bankCreate for why re-fetching /banks right after a write is
            // its own hazard, not just a wasted round-trip.
            processData: false, data: JSON.stringify(banksData), cache: false, dataType: 'json',
            success: function (ok) {
                if (!ok) { safeNotify('error', "Couldn't delete bank"); return }
                safeNotify('info', 'Bank "' + bank.title + '" deleted')
                render()
            },
            error: function () { safeNotify('error', "Couldn't delete bank") },
        })
    }

    // Renaming/duplicating a pedalboard that ISN'T currently loaded requires
    // loading it first (PedalboardSave always acts on whatever is currently
    // running, it takes no bundlepath) — then, to avoid silently swapping the
    // user onto a different pedalboard as a side effect, we load the
    // original one back afterwards.
    function withPedalboardLoaded(pb, fn) {
        var isCurrent = pb.bundle === BUNDLE_PATH
        if (isCurrent) { fn(function (done) { done && done() }); return }

        if (typeof pedalboardModified !== 'undefined' && pedalboardModified &&
            !window.confirm('This needs to temporarily switch away from the current pedalboard. Unsaved changes will be lost. Continue?')) {
            return
        }
        var originalBundle = BUNDLE_PATH

        $.ajax({
            url: '/pedalboard/load_bundle/', type: 'POST',
            data: { bundlepath: pb.bundle, isDefault: 0 }, cache: false, dataType: 'json',
            success: function (resp) {
                if (!resp || !resp.ok) { safeNotify('error', "Couldn't open that pedalboard"); return }
                BUNDLE_PATH = pb.bundle
                PEDALBOARD_TITLE = resp.name
                fn(function (restoreTitle) {
                    $.ajax({
                        url: '/pedalboard/load_bundle/', type: 'POST',
                        data: { bundlepath: originalBundle, isDefault: 0 }, cache: false, dataType: 'json',
                        success: function (resp2) {
                            if (resp2 && resp2.ok) {
                                BUNDLE_PATH = originalBundle
                                PEDALBOARD_TITLE = resp2.name
                                $('#grid-title').text(resp2.name)
                            }
                            refreshBankNameIfAvailable()
                        },
                    })
                })
            },
            error: function () { safeNotify('error', "Couldn't open that pedalboard") },
        })
    }

    function pedalboardRename(pb) {
        var name = window.prompt('Rename pedalboard:', pb.title)
        if (!name || name === pb.title) return
        withPedalboardLoaded(pb, function (restore) {
            $.ajax({
                url: '/pedalboard/save', type: 'POST', data: { title: name, asNew: 0 },
                cache: false, dataType: 'json',
                success: function (result) {
                    if (!result || !result.ok) { safeNotify('error', "Couldn't rename pedalboard"); restore(); return }
                    if (pb.bundle === BUNDLE_PATH || result.bundlepath === BUNDLE_PATH) {
                        PEDALBOARD_TITLE = result.title
                        $('#grid-title').text(result.title)
                    }
                    safeNotify('info', 'Pedalboard renamed to "' + result.title + '"')
                    restore()
                    load()
                },
                error: function () { safeNotify('error', "Couldn't rename pedalboard"); restore() },
            })
        })
    }

    // The duplicate goes into the same bank as the original — a pedalboard
    // can't exist without one (see pedalboardCreate/bankDelete), and staying
    // in the same collection is the sensible default for a copy.
    function pedalboardDuplicate(pb, bank) {
        var name = window.prompt('Name for the duplicate:', pb.title + ' copy')
        if (!name) return
        withPedalboardLoaded(pb, function (restore) {
            $.ajax({
                url: '/pedalboard/save', type: 'POST', data: { title: name, asNew: 1 },
                cache: false, dataType: 'json',
                success: function (result) {
                    if (!result || !result.ok) { safeNotify('error', "Couldn't duplicate pedalboard"); restore(); return }
                    bank.pedalboards = bank.pedalboards || []
                    bank.pedalboards.push({ bundle: result.bundlepath, title: result.title })
                    $.ajax({
                        url: '/banks/save', type: 'POST', contentType: 'application/json',
                        processData: false, data: JSON.stringify(banksData), cache: false, dataType: 'json',
                        success: function () {
                            safeNotify('info', 'Pedalboard duplicated as "' + result.title + '"')
                            restore()
                            render()
                        },
                        error: function () { safeNotify('error', 'Duplicated, but could not add it to the bank'); restore(); load() },
                    })
                },
                error: function () { safeNotify('error', "Couldn't duplicate pedalboard"); restore() },
            })
        })
    }

    // Opens a second small menu (same anchor as the pedalboard's own "...")
    // listing every OTHER bank; picking one removes pb from fromBank and
    // appends it there instead — a pedalboard is only ever in one bank at a
    // time, so this is a move, never a copy.
    function pedalboardMoveToBank(pb, fromBank, anchorEl) {
        var others = banksData.filter(function (b) { return b !== fromBank })
        if (!others.length) { safeNotify('error', 'There is no other bank to move it to'); return }
        openActionMenu(anchorEl, others.map(function (b) {
            return { label: b.title, run: function () { doMovePedalboardToBank(pb, fromBank, b) } }
        }))
    }

    function doMovePedalboardToBank(pb, fromBank, toBank) {
        var idx = fromBank.pedalboards.indexOf(pb)
        if (idx >= 0) fromBank.pedalboards.splice(idx, 1)
        toBank.pedalboards = toBank.pedalboards || []
        toBank.pedalboards.push(pb)
        $.ajax({
            url: '/banks/save', type: 'POST', contentType: 'application/json',
            processData: false, data: JSON.stringify(banksData), cache: false, dataType: 'json',
            success: function (ok) {
                if (!ok) { safeNotify('error', "Couldn't move the pedalboard"); return }
                safeNotify('info', '"' + pb.title + '" moved to "' + toBank.title + '"')
                render()
            },
            error: function () { safeNotify('error', "Couldn't move the pedalboard") },
        })
    }

    // No hidden default pedalboard: rather than falling back to some other
    // real bundle on disk (which is itself "a pedalboard" the user never
    // chose to open), this clears the running graph and leaves BUNDLE_PATH
    // genuinely empty. updateEmptyState() (grid-app.js) is what makes that
    // state visible and enforced everywhere else — canvas overlay, disabled
    // Save/New Snapshot, blocked plugin adds — instead of silently leaving
    // stale title/canvas/BUNDLE_PATH pointing at a deleted bundle (which is
    // what let a later Save silently recreate a same-named bundle outside
    // of any bank).
    function clearCurrentPedalboard() {
        $.ajax({
            url: '/reset', cache: false, dataType: 'json',
            success: function (ok) {
                if (!ok) { safeNotify('error', "Couldn't clear the pedalboard"); return }
                BUNDLE_PATH = ''
                PEDALBOARD_TITLE = ''
                if (typeof pedalboardModified !== 'undefined') pedalboardModified = false
                if (typeof currentSnapshotName !== 'undefined') currentSnapshotName = null
                refreshBankNameIfAvailable()
                refreshEmptyStateIfAvailable()
            },
            error: function () { safeNotify('error', "Couldn't clear the pedalboard") },
        })
    }

    function pedalboardDelete(pb) {
        var isCurrent = pb.bundle === BUNDLE_PATH
        var msg = 'Delete pedalboard "' + pb.title + '"? This cannot be undone.'
        if (isCurrent) msg += '\n\nThis is the pedalboard currently open — you will need to open or create another one afterwards.'
        if (!window.confirm(msg)) return

        $.ajax({
            url: '/pedalboard/remove/', data: { bundlepath: pb.bundle }, cache: false, dataType: 'json',
            success: function (ok) {
                if (!ok) { safeNotify('error', "Couldn't delete pedalboard"); return }
                safeNotify('info', 'Pedalboard "' + pb.title + '" deleted')
                if (isCurrent) {
                    // The bundle backing the currently-open pedalboard is gone —
                    // title, canvas and BUNDLE_PATH would otherwise keep
                    // pointing at it (e.g. a later save would try to write back
                    // into a path that no longer exists).
                    clearCurrentPedalboard()
                }
                load()
            },
            error: function () { safeNotify('error', "Couldn't delete pedalboard") },
        })
    }

    function snapshotRename(idx, name) {
        var newName = window.prompt('Rename snapshot:', name)
        if (!newName || newName === name) return
        $.ajax({
            url: '/snapshot/rename', data: { id: idx, title: newName }, cache: false, dataType: 'json',
            success: function (resp) {
                if (!resp || !resp.ok) { safeNotify('error', "Couldn't rename snapshot"); return }
                safeNotify('info', 'Snapshot renamed to "' + resp.title + '"')
                load()
            },
            error: function () { safeNotify('error', "Couldn't rename snapshot") },
        })
    }

    function snapshotDelete(idx, name) {
        if (!window.confirm('Delete snapshot "' + name + '"?')) return
        $.ajax({
            url: '/snapshot/remove', data: { id: idx }, cache: false, dataType: 'json',
            success: function (ok) {
                if (!ok) { safeNotify('error', "Couldn't delete snapshot"); return }
                safeNotify('info', 'Snapshot "' + name + '" deleted')
                load()
            },
            error: function () { safeNotify('error', "Couldn't delete snapshot") },
        })
    }

    function snapshotDuplicate(idx, name) {
        var newName = window.prompt('Name for the duplicate snapshot:', name + ' copy')
        if (!newName) return
        $.ajax({
            url: '/snapshot/load', data: { id: idx }, cache: false, dataType: 'json',
            success: function (ok) {
                if (!ok) { safeNotify('error', "Couldn't duplicate snapshot"); return }
                $.ajax({
                    url: '/snapshot/saveas', data: { title: newName }, cache: false, dataType: 'json',
                    success: function (resp) {
                        if (!resp || !resp.ok) { safeNotify('error', "Couldn't duplicate snapshot"); return }
                        safeNotify('info', 'Snapshot duplicated as "' + resp.title + '"')
                        load()
                    },
                    error: function () { safeNotify('error', "Couldn't duplicate snapshot") },
                })
            },
            error: function () { safeNotify('error', "Couldn't duplicate snapshot") },
        })
    }

    // ---- tree building ----

    function buildSnapshotNode(idx, name) {
        var row = el('div', 'grid-nav-row grid-nav-snapshot')
        row.append(el('span', 'grid-nav-icon', '📷'), el('span', 'grid-nav-label', name))
        var btn = actionButton()
        btn.click(function () {
            openActionMenu(btn[0], [
                { label: 'Rename', run: function () { snapshotRename(idx, name) } },
                { label: 'Duplicate', run: function () { snapshotDuplicate(idx, name) } },
                { label: 'Delete', danger: true, run: function () { snapshotDelete(idx, name) } },
            ])
        })
        row.append(btn)
        row.click(function (ev) {
            ev.stopPropagation()
            callbacks.loadSnapshot(idx)
        })
        return row
    }

    function buildPedalboardNode(pb, bank) {
        var isCurrent = pb.bundle === BUNDLE_PATH
        var wrap = el('div', 'grid-nav-node')
        var row = el('div', 'grid-nav-row grid-nav-pedalboard' + (isCurrent ? ' grid-nav-current' : ''))
        var chevron = el('span', 'grid-nav-chevron', isCurrent ? '▾' : '▸')
        row.append(chevron, el('span', 'grid-nav-icon', '🎛️'), el('span', 'grid-nav-label', pb.title))
        var btn = actionButton()
        btn.click(function () {
            openActionMenu(btn[0], [
                { label: 'Move to bank…', run: function () { pedalboardMoveToBank(pb, bank, btn[0]) } },
                { label: 'Rename', run: function () { pedalboardRename(pb) } },
                { label: 'Duplicate', run: function () { pedalboardDuplicate(pb, bank) } },
                { label: 'Delete', danger: true, run: function () { pedalboardDelete(pb) } },
            ])
        })
        row.append(btn)
        wrap.append(row)

        var childrenBox = el('div', 'grid-nav-children')
        if (!isCurrent) childrenBox.addClass('grid-hidden')
        wrap.append(childrenBox)

        function renderSnapshots() {
            childrenBox.empty()
            $.ajax({
                url: '/snapshot/list',
                cache: false,
                dataType: 'json',
                success: function (snaps) {
                    var keys = Object.keys(snaps || {})
                    if (!keys.length) {
                        childrenBox.append(el('div', 'grid-nav-empty', 'No snapshots'))
                        return
                    }
                    keys.forEach(function (idx) {
                        childrenBox.append(buildSnapshotNode(idx, snaps[idx]))
                    })
                },
            })
        }

        row.click(function () {
            if (isCurrent) {
                var hidden = childrenBox.hasClass('grid-hidden')
                childrenBox.toggleClass('grid-hidden')
                chevron.text(hidden ? '▾' : '▸')
                if (hidden) renderSnapshots()
            } else {
                callbacks.loadPedalboard(pb.bundle, pb.title)
            }
        })

        if (isCurrent) renderSnapshots()
        return wrap
    }

    function buildBankNode(bank) {
        var wrap = el('div', 'grid-nav-node')
        var row = el('div', 'grid-nav-row grid-nav-bank')
        var isExpanded = !!expandedBanks[bank.title]
        var chevron = el('span', 'grid-nav-chevron', isExpanded ? '▾' : '▸')
        row.append(chevron, el('span', 'grid-nav-icon', '🗄️'), el('span', 'grid-nav-label', bank.title))
        var btn = actionButton()
        btn.click(function () {
            openActionMenu(btn[0], [
                { label: 'New Pedalboard…', run: function () { pedalboardCreate(bank) } },
                { label: 'Rename', run: function () { bankRename(bank) } },
                { label: 'Delete', danger: true, run: function () { bankDelete(bank) } },
            ])
        })
        row.append(btn)
        wrap.append(row)

        var childrenBox = el('div', 'grid-nav-children')
        if (!isExpanded) childrenBox.addClass('grid-hidden')
        bank.pedalboards.forEach(function (pb) { childrenBox.append(buildPedalboardNode(pb, bank)) })
        wrap.append(childrenBox)

        row.click(function () {
            var hidden = childrenBox.hasClass('grid-hidden')
            childrenBox.toggleClass('grid-hidden')
            chevron.text(hidden ? '▾' : '▸')
            if (hidden) expandedBanks[bank.title] = true
            else delete expandedBanks[bank.title]
        })
        return wrap
    }

    function render() {
        tree.empty()
        if (banksData === null) {
            tree.append(el('div', 'grid-nav-empty', 'Loading…'))
            return
        }

        // The pedalboard that's open but not in any bank (the boot one, or one
        // just saved for the first time) -- surface it so "saved... where?" has
        // an answer, with a one-click way to file it.
        if (currentBundle() && !currentIsBanked()) {
            var box = el('div', 'grid-nav-unbanked')
            box.append(el('div', 'grid-nav-unbanked-title', currentTitle()))
            box.append(el('div', 'grid-nav-empty', 'Open, but not in any bank.'))
            var btn = el('button', 'grid-toolbar-action grid-manage-new', 'Add to a bank…')
            btn.click(function (ev) { ev.stopPropagation(); addCurrentToBank() })
            box.append(btn)
            tree.append(box)
        }

        if (!banksData.length) {
            if (!currentBundle()) {
                tree.append(el('div', 'grid-nav-empty',
                    'No banks yet — use "New Bank" above, then add a pedalboard to it.'))
            }
            return
        }
        banksData.forEach(function (bank) { tree.append(buildBankNode(bank)) })
    }

    // /banks cross-references each pedalboard against the server's scanned
    // pedalboard-info cache and silently drops (then persists the drop of)
    // any entry the scanner doesn't currently vouch for — including a
    // just-created, still-empty pedalboard, which the scanner flags
    // "broken" until it has at least one plugin block. /banks/raw is the
    // exact, unfiltered banks.json content instead, so this tree (and every
    // guard/move/delete built on banksData) reflects what's actually saved.
    function load() {
        banksData = null
        render()
        $.ajax({
            url: '/banks/raw',
            cache: false,
            dataType: 'json',
            success: function (banks) { banksData = banks || []; render() },
            error: function () { banksData = []; render() },
        })
    }

    var pinned = false

    return {
        init: function (opts) {
            $.extend(callbacks, opts)
            panel = $('#grid-nav-panel')
            tree = $('#grid-nav-tree')
            backdrop = $('#grid-nav-backdrop')

            $('#grid-nav-toggle').click(function () { GridNav.toggle() })
            backdrop.click(function () { GridNav.close() })
            $('#grid-nav-add').click(function (ev) {
                ev.stopPropagation()
                bankCreate()
            })
            $('#grid-nav-pin').click(function () {
                pinned = !pinned
                $(this).toggleClass('grid-nav-pin-active', pinned)
                // pinning removes the click-outside-to-close backdrop so the
                // grid/shelf stay usable while the panel stays open, and shifts
                // the canvas/shelf right so the panel doesn't cover them
                if (pinned) backdrop.addClass('grid-hidden')
                else if (!panel.hasClass('grid-hidden')) backdrop.removeClass('grid-hidden')
                $('body').toggleClass('grid-nav-pinned', pinned)
            })
        },
        toggle: function () {
            if (panel.hasClass('grid-hidden')) GridNav.open()
            else GridNav.close()
        },
        open: function () {
            panel.removeClass('grid-hidden')
            if (!pinned) backdrop.removeClass('grid-hidden')
            load()
        },
        close: function () {
            if (pinned) return
            panel.addClass('grid-hidden')
            backdrop.addClass('grid-hidden')
        },
        // Re-fetch banks/pedalboards (and, for whichever pedalboard is current,
        // its snapshots) — used after creating a new bank/pedalboard/snapshot.
        refresh: function () { load() },
    }
})()
