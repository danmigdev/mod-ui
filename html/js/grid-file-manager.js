// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// Explorer/Finder-style file manager: a folder tree on the left, the current
// folder's contents on the right as either an icon grid or a detailed list
// (size/type/modified/created, sortable by column — see FileManagerStat in
// mod/webserver.py, since browsepy's own browse.html has no date columns to
// scrape at all), drag-and-drop to move files between folders. Talks to the
// separate MOD File Manager service
// (browsepy, its own process on port 8081) through the same-origin
// /filesvc/* proxy (see FileManagerProxy in mod/webserver.py on the device)
// — needed purely to dodge CORS, since a page served from this app's own
// origin can't fetch() cross-origin into a different port without the
// target sending Access-Control-Allow-Origin, which stock browsepy never
// does.
//
// browsepy itself only has list/browse/upload/remove/create-directory
// endpoints — no move or rename at all — so every operation below that
// looks like one is client-orchestrated on top of those four primitives:
//   - moving/renaming a FILE: download its bytes, upload them under the new
//     name/location, remove the original.
//   - moving/renaming a FOLDER: browsepy can only hand back a whole
//     directory as a .tgz archive, and upload has no way to extract one
//     back out — so instead this walks the folder's real tree recursively
//     (listRecursive), recreates the same subfolder structure at the
//     destination, copies every file into place, then removes the
//     now-empty original tree in one call.
// Rename is just a move with the same parent and a different name; cut+paste
// is just a move with a different parent, done in two steps instead of a
// drag so it works without a pointer device too.

var GridFileManager = (function () {
    var overlay, treeEl, breadcrumbEl, gridEl, listEl, listBodyEl, diskEl
    var currentPath = ''
    var dragging = null // {name, path} of the file currently being dragged, path = its parent folder
    var clipboard = null // {name, isDir, path} set by the cut action, consumed by paste

    // Icons vs. detailed list, persisted like the theme's other display
    // preferences (font scale, zoom). List view needs size/dates/extension,
    // which browsepy's HTML never exposes (see fetchStat below) — icon view
    // keeps using the existing browse-HTML entries untouched.
    var viewMode = localStorage.getItem('grid-fm-view-mode') || 'icons'
    var sortKey = 'name'
    var sortAsc = true

    function joinPath(a, b) {
        return a ? a + '/' + b : b
    }

    function fmUrl(action, path) {
        var encoded = path ? path.split('/').map(encodeURIComponent).join('/') : ''
        return '/filesvc/' + action + (encoded ? '/' + encoded : '')
    }

    // browsepy's browse.html renders a plain HTML table (icon class "inode"
    // for directories, the mimetype group otherwise; name+link in the second
    // cell; size in the last cell) — true both for a normal folder and for
    // the root's special fixed category tables, so one parser covers both.
    function parseBrowseHtml(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html')
        var diskUsage = $(doc).find('.disk-space span').last().text().trim()
        var entries = []
        $(doc).find('table.browser tbody tr').each(function () {
            var cells = $(this).find('td')
            var link = cells.eq(1).find('a')
            if (!link.length) return
            var name = link.text().trim()
            if (name === '..') return
            var iconClass = cells.eq(0).attr('class') || ''
            entries.push({
                name: name,
                isDir: iconClass.indexOf('inode') >= 0,
                size: cells.last().text().trim(),
            })
        })
        return { diskUsage: diskUsage, entries: entries }
    }

    function fetchBrowse(path, callback) {
        $.ajax({
            url: fmUrl('browse', path),
            cache: false,
            dataType: 'text',
            success: function (html) { callback(parseBrowseHtml(html)) },
            error: function () { notify('error', 'Could not load folder'); callback({ diskUsage: '', entries: [] }) },
        })
    }

    // Real os.stat() data straight from disk (see FileManagerStat in
    // mod/webserver.py) for the list view's size/extension/modified/created
    // columns — browsepy's own browse.html has no date columns at all.
    function fetchStat(path, callback) {
        var encoded = path ? path.split('/').map(encodeURIComponent).join('/') : ''
        $.ajax({
            url: '/filesvc-stat/' + encoded,
            cache: false,
            dataType: 'json',
            success: function (entries) { callback(entries || []) },
            error: function () { notify('error', 'Could not load folder details'); callback([]) },
        })
    }

    function formatSize(bytes) {
        if (!bytes) return ''
        var units = ['B', 'KB', 'MB', 'GB', 'TB']
        var i = 0
        var n = bytes
        while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
        return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i]
    }

    function formatDate(unixSeconds) {
        if (!unixSeconds) return ''
        var d = new Date(unixSeconds * 1000)
        function pad(n) { return n < 10 ? '0' + n : '' + n }
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    // el is sometimes a long-lived container (gridEl in particular is never
    // recreated, only emptied — see openFolder) that this gets called on
    // again every time the folder changes, so any previous binding here
    // MUST be removed first. Without that, drop handlers pile up bound to
    // stale targetPath closures from earlier folders, and since jQuery fires
    // every bound handler in order, the very first one ever bound (always
    // targetPath '' — the fake category "root", see open()) would run
    // first, and empty-string paths do quietly resolve to a real, different
    // location server-side (see the moveFile guard below) — a plain
    // same-folder drag could silently vanish a file into it. This was a
    // real bug, not a hypothetical: two real user files were moved there
    // and had to be recovered by hand before this fix.
    // ev.originalEvent.dataTransfer carries real OS files when the drag
    // started outside the browser (a Finder/Explorer window) — internal
    // drags (see `dragging` below) never populate it, so this alone tells the
    // two kinds of drop apart without needing a flag.
    function isOsFileDrag(ev) {
        var dt = ev.originalEvent.dataTransfer
        return !!dt && dt.types && Array.prototype.indexOf.call(dt.types, 'Files') !== -1
    }

    function bindDropTarget(el, targetPath) {
        el.off('dragover.gridfm dragleave.gridfm drop.gridfm')
        el.on('dragover.gridfm', function (ev) {
            if (!dragging && !isOsFileDrag(ev)) return
            ev.preventDefault()
            el.addClass('grid-fm-drop-hover')
        })
        el.on('dragleave.gridfm', function () { el.removeClass('grid-fm-drop-hover') })
        el.on('drop.gridfm', function (ev) {
            el.removeClass('grid-fm-drop-hover')
            var osFiles = ev.originalEvent.dataTransfer && ev.originalEvent.dataTransfer.files
            if (osFiles && osFiles.length) {
                ev.preventDefault()
                uploadFilesTo(targetPath, osFiles)
                return
            }
            ev.preventDefault()
            if (!dragging) return
            var d = dragging
            dragging = null
            if (d.path === targetPath) return
            moveEntry(d.name, false, d.path, targetPath)
        })
    }

    // browsepy answers a successful upload/remove/subdir with a 302 redirect
    // to the browse page, not a 200 — and since the proxy doesn't relay the
    // Location header, fetch() has nothing to auto-follow and surfaces that
    // 302 directly, so response.ok (2xx-only) would wrongly read it as a
    // failure. Treat anything under 400 as success throughout this file.
    function okStatus(r) { return r.status < 400 }

    function downloadAsync(path) {
        return fetch(fmUrl('download/file', path)).then(function (r) {
            if (!r.ok) throw new Error('download failed')
            return r.blob()
        })
    }

    function uploadAsync(destPath, filename, blob) {
        var fd = new FormData()
        fd.append('file', blob, filename)
        return fetch(fmUrl('upload', destPath), { method: 'POST', body: fd }).then(function (r) {
            if (!okStatus(r)) throw new Error('upload failed')
        })
    }

    // Shared by both upload paths (the Upload button's <input multiple> and an
    // OS drag-and-drop drop — see bindDropTarget below). destPath === '' is the
    // fake root category view (see the comment above updateToolbarState) and
    // was never uploadable even via the button, so it's rejected the same way
    // moveEntry already rejects it as a move target.
    function uploadFilesTo(destPath, fileList) {
        if (destPath === '') {
            notify('error', "Can't upload to the top-level view")
            return
        }
        var files = Array.prototype.slice.call(fileList)
        if (!files.length) return
        notify('info', files.length > 1 ? 'Uploading ' + files.length + ' files…' : 'Uploading…')
        eachInSequence(files, function (f) { return uploadAsync(destPath, f.name, f) })
            .then(function () {
                if (destPath === currentPath) openFolder(currentPath)
            })
            .catch(function () { notify('error', 'Upload failed') })
    }

    function removeAsync(path) {
        return fetch(fmUrl('remove', path), { method: 'POST' }).then(function (r) {
            if (!okStatus(r)) throw new Error('remove failed')
        })
    }

    function createDirAsync(parentPath, name) {
        var body = new URLSearchParams()
        body.append('subdir', name)
        return fetch(fmUrl('subdir', parentPath), { method: 'POST', body: body }).then(function (r) {
            if (!okStatus(r)) throw new Error('create dir failed')
        })
    }

    function browseAsync(path) {
        return fetch(fmUrl('browse', path)).then(function (r) { return r.text() }).then(parseBrowseHtml)
    }

    // Recursively walks `path`, returning every descendant as
    // {relPath, isDir} with relPath relative to `path` itself (e.g. a file
    // directly inside a subfolder comes back as "Sub/name.wav").
    function listRecursive(path) {
        return browseAsync(path).then(function (result) {
            var acc = []
            var childPromises = result.entries.map(function (e) {
                acc.push({ relPath: e.name, isDir: e.isDir })
                if (!e.isDir) return null
                return listRecursive(joinPath(path, e.name)).then(function (sub) {
                    sub.forEach(function (s) { acc.push({ relPath: e.name + '/' + s.relPath, isDir: s.isDir }) })
                })
            })
            return Promise.all(childPromises).then(function () { return acc })
        })
    }

    function relDirOf(relPath) {
        var parts = relPath.split('/')
        return parts.slice(0, -1).join('/')
    }

    function baseNameOf(relPath) {
        var parts = relPath.split('/')
        return parts[parts.length - 1]
    }

    // Chains a list of items through an async step one at a time (in order)
    // rather than firing them all in parallel — this device's storage and
    // browsepy's own dev server handle one request at a time comfortably,
    // not a burst of them.
    function eachInSequence(items, fn) {
        return items.reduce(function (chain, item) {
            return chain.then(function () { return fn(item) })
        }, Promise.resolve())
    }

    // Moving/renaming a file is download+upload+remove; a folder is a
    // recursive walk that recreates the subfolder structure at the
    // destination, copies every file into place, then removes the whole
    // original tree in one call. newName defaults to the original name, so
    // the same function covers both "move" (different parent) and "rename"
    // (same parent, different name).
    function moveEntry(name, isDir, fromPath, toPath, newName) {
        newName = newName || name
        // The fake category "root" ('' path) isn't a real folder from the
        // user's point of view (browsepy renders it as a fixed list of
        // named categories, with no upload form) — but the bare /upload
        // endpoint accepts writes there anyway, into a location that never
        // shows up in this UI. Never treat it as a valid source/destination.
        if (toPath === '' || fromPath === '') {
            notify('error', "Can't move to or from the top-level view")
            return
        }
        var sourcePath = joinPath(fromPath, name)
        var destPath = joinPath(toPath, newName)

        if (!isDir) {
            notify('info', 'Moving ' + name + '…')
            downloadAsync(sourcePath)
                .then(function (blob) { return uploadAsync(toPath, newName, blob) })
                .then(function () { return removeAsync(sourcePath) })
                .then(function () {
                    notify('info', name + ' moved')
                    afterEntryMoved(sourcePath, destPath)
                })
                .catch(function () { notify('error', "Couldn't move " + name) })
            return
        }

        notify('info', 'Moving folder ' + name + '…')
        listRecursive(sourcePath)
            // destPath itself must exist before anything can be created or
            // uploaded inside it — unconditionally, not just when the
            // source folder happens to contain a subdirectory to trigger it
            .then(function (entries) { return createDirAsync(toPath, newName).then(function () { return entries }) })
            .then(function (entries) {
                var dirs = entries.filter(function (e) { return e.isDir })
                dirs.sort(function (a, b) { return a.relPath.split('/').length - b.relPath.split('/').length })
                return eachInSequence(dirs, function (d) {
                    var dir = relDirOf(d.relPath)
                    var parent = dir ? joinPath(destPath, dir) : destPath
                    return createDirAsync(parent, baseNameOf(d.relPath))
                }).then(function () { return entries })
            })
            .then(function (entries) {
                var files = entries.filter(function (e) { return !e.isDir })
                return eachInSequence(files, function (f) {
                    var srcFilePath = joinPath(sourcePath, f.relPath)
                    var dir = relDirOf(f.relPath)
                    var destDir = dir ? joinPath(destPath, dir) : destPath
                    return downloadAsync(srcFilePath).then(function (blob) { return uploadAsync(destDir, baseNameOf(f.relPath), blob) })
                })
            })
            .then(function () { return removeAsync(sourcePath) })
            .then(function () {
                notify('info', name + ' moved')
                afterEntryMoved(sourcePath, destPath)
            })
            .catch(function () { notify('error', "Couldn't move " + name) })
    }

    // Refreshes the tree (folder topology may have changed) and the current
    // grid view — redirecting it first if the folder being viewed was itself
    // the thing that just got moved/renamed out from under it.
    function afterEntryMoved(sourcePath, destPath) {
        renderTree()
        if (currentPath === sourcePath || currentPath.indexOf(sourcePath + '/') === 0) {
            openFolder(destPath + currentPath.slice(sourcePath.length))
        } else {
            openFolder(currentPath)
        }
    }

    function renameEntry(name, isDir, parentPath) {
        var newName = window.prompt('New name:', name)
        if (!newName || newName === name) return
        moveEntry(name, isDir, parentPath, parentPath, newName)
    }

    function cutEntry(name, isDir, path) {
        clipboard = { name: name, isDir: isDir, path: path }
        notify('info', name + ' cut — open the destination folder and click Paste')
        updateToolbarState()
    }

    function pasteClipboard() {
        if (!clipboard) return
        if (clipboard.path === currentPath) {
            notify('error', 'Already in this folder')
            return
        }
        var c = clipboard
        clipboard = null
        updateToolbarState()
        moveEntry(c.name, c.isDir, c.path, currentPath)
    }

    // The root is a fixed set of category folders — real directories
    // underneath, but browsepy doesn't support uploading/creating/pasting
    // directly inside the fake root view, and renaming/cutting/deleting one
    // of the categories themselves would fight the hardcoded template (see
    // browsepy_browse.html's rootdirgroups) — so both are blocked here.
    function updateToolbarState() {
        var atRoot = currentPath === ''
        $('#grid-fm-new-folder, #grid-fm-upload').prop('disabled', atRoot)
        $('#grid-fm-paste').prop('disabled', atRoot || !clipboard)
    }

    // ---- tree (left) ----

    function buildTreeNode(name, path) {
        var wrap = $('<div class="grid-fm-tree-node">')
        var row = $('<div class="grid-fm-tree-row">')
        var chevron = $('<span class="grid-fm-tree-chevron">').text('▸')
        row.append(chevron, $('<span class="grid-fm-tree-label">').text(name).attr('title', name))
        wrap.append(row)

        var childrenBox = $('<div class="grid-fm-tree-children grid-hidden">')
        wrap.append(childrenBox)

        var loaded = false
        function loadChildren() {
            loaded = true
            fetchBrowse(path, function (result) {
                childrenBox.empty()
                var dirs = result.entries.filter(function (e) { return e.isDir })
                dirs.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1 })
                if (!dirs.length) {
                    childrenBox.append($('<div class="grid-fm-tree-empty">').text('(no subfolders)'))
                    return
                }
                dirs.forEach(function (e) { childrenBox.append(buildTreeNode(e.name, joinPath(path, e.name))) })
            })
        }

        chevron.click(function (ev) {
            ev.stopPropagation()
            var hidden = childrenBox.hasClass('grid-hidden')
            if (hidden && !loaded) loadChildren()
            childrenBox.toggleClass('grid-hidden')
            chevron.text(hidden ? '▾' : '▸')
        })
        row.click(function () {
            openFolder(path)
            treeEl.find('.grid-fm-tree-row').removeClass('grid-fm-tree-current')
            row.addClass('grid-fm-tree-current')
        })
        bindDropTarget(row, path)

        return wrap
    }

    function renderTree() {
        fetchBrowse('', function (result) {
            treeEl.empty()
            var root = $('<div class="grid-fm-tree-row grid-fm-tree-root">').text('User-Files')
            root.click(function () {
                openFolder('')
                treeEl.find('.grid-fm-tree-row').removeClass('grid-fm-tree-current')
                root.addClass('grid-fm-tree-current')
            })
            bindDropTarget(root, '')
            treeEl.append(root)
            result.entries.filter(function (e) { return e.isDir })
                .sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1 })
                .forEach(function (e) {
                    treeEl.append(buildTreeNode(e.name, e.name))
                })
        })
    }

    // ---- grid (right) + breadcrumb ----

    function renderBreadcrumb(path) {
        breadcrumbEl.empty()
        var root = $('<span class="grid-fm-crumb">').text('User-Files')
        root.click(function () { openFolder('') })
        bindDropTarget(root, '')
        breadcrumbEl.append(root)

        var acc = ''
        ;(path ? path.split('/') : []).forEach(function (part) {
            breadcrumbEl.append($('<span class="grid-fm-crumb-sep">').text('/'))
            acc = joinPath(acc, part)
            var crumb = $('<span class="grid-fm-crumb">').text(part)
            ;(function (p) { crumb.click(function () { openFolder(p) }) })(acc)
            bindDropTarget(crumb, acc)
            breadcrumbEl.append(crumb)
        })
    }

    // Root-level entries are the fixed categories baked into browsepy's
    // template (see the comment above updateToolbarState) — only navigation
    // makes sense there, not rename/cut/delete. Shared between the icon
    // tile and the list row, which otherwise differ only in layout.
    function buildEntryActions(entry) {
        var actions = $('<div class="grid-fm-tile-actions">')

        var renameBtn = $('<button type="button" class="grid-fm-tile-action" title="Rename">').text('✎')
        renameBtn.click(function (ev) { ev.stopPropagation(); renameEntry(entry.name, entry.isDir, currentPath) })
        actions.append(renameBtn)

        var cutBtn = $('<button type="button" class="grid-fm-tile-action" title="Cut">').text('✂')
        cutBtn.click(function (ev) { ev.stopPropagation(); cutEntry(entry.name, entry.isDir, currentPath) })
        actions.append(cutBtn)

        var removeBtn = $('<button type="button" class="grid-fm-tile-action grid-fm-tile-action-danger" title="Delete">').html('&times;')
        removeBtn.click(function (ev) {
            ev.stopPropagation()
            if (!window.confirm('Delete "' + entry.name + '"?')) return
            removeAsync(joinPath(currentPath, entry.name))
                .then(function () { notify('info', entry.name + ' deleted') })
                .catch(function () { notify('error', "Couldn't delete " + entry.name) })
                .then(function () {
                    openFolder(currentPath)
                    if (entry.isDir) renderTree()
                })
        })
        actions.append(removeBtn)

        return actions
    }

    // Click-to-open/download and drag source/drop target — identical for a
    // tile and a list row.
    function wireEntryInteractions(el, entry) {
        el.click(function () {
            if (entry.isDir) openFolder(joinPath(currentPath, entry.name))
            else window.open(fmUrl('download/file', joinPath(currentPath, entry.name)), '_blank')
        })

        if (entry.isDir) {
            bindDropTarget(el, joinPath(currentPath, entry.name))
        } else {
            el.attr('draggable', 'true')
            el.on('dragstart', function () { dragging = { name: entry.name, path: currentPath } })
        }
    }

    function buildTile(entry) {
        var tile = $('<div class="grid-fm-tile">')
        tile.append($('<div class="grid-fm-tile-icon">').text(entry.isDir ? '📁' : '📄'))
        tile.append($('<div class="grid-fm-tile-name">').text(entry.name).attr('title', entry.name))
        if (!entry.isDir && entry.size) tile.append($('<div class="grid-fm-tile-size">').text(entry.size))

        if (!(entry.isDir && currentPath === '')) tile.append(buildEntryActions(entry))

        wireEntryInteractions(tile, entry)
        return tile
    }

    function renderGrid(result) {
        gridEl.empty()
        if (!result.entries.length) {
            gridEl.append($('<div class="grid-fm-empty">').text('This folder is empty'))
            return
        }
        result.entries
            .slice()
            .sort(function (a, b) {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
                return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1
            })
            .forEach(function (e) { gridEl.append(buildTile(e)) })
    }

    // ---- list (detailed) view ----

    var lastListEntries = []

    function buildListRow(entry) {
        var row = $('<tr class="grid-fm-list-row">')
        row.append($('<td class="grid-fm-list-col-name">').append(
            $('<span class="grid-fm-list-icon">').text(entry.isDir ? '📁' : '📄'),
            $('<span class="grid-fm-list-name-text">').text(entry.name).attr('title', entry.name)
        ))
        row.append($('<td class="grid-fm-list-col-ext">').text(entry.isDir ? 'Folder' : (entry.extension || '').toUpperCase()))
        row.append($('<td class="grid-fm-list-col-size">').text(entry.isDir ? '' : formatSize(entry.size)))
        row.append($('<td class="grid-fm-list-col-date">').text(formatDate(entry.mtime)))
        row.append($('<td class="grid-fm-list-col-date">').text(formatDate(entry.ctime)))

        var actionsCell = $('<td class="grid-fm-list-col-actions">')
        if (!(entry.isDir && currentPath === '')) actionsCell.append(buildEntryActions(entry).addClass('grid-fm-list-actions'))
        row.append(actionsCell)

        wireEntryInteractions(row, entry)
        return row
    }

    function sortedEntries(entries) {
        return entries.slice().sort(function (a, b) {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
            var av = a[sortKey]
            var bv = b[sortKey]
            if (typeof av === 'string') { av = av.toLowerCase(); bv = (bv || '').toLowerCase() }
            var cmp = av < bv ? -1 : (av > bv ? 1 : 0)
            return sortAsc ? cmp : -cmp
        })
    }

    function renderList(entries) {
        lastListEntries = entries
        listBodyEl.empty()
        if (!entries.length) {
            listBodyEl.append($('<tr>').append($('<td colspan="6" class="grid-fm-empty">').text('This folder is empty')))
            return
        }
        sortedEntries(entries).forEach(function (e) { listBodyEl.append(buildListRow(e)) })
    }

    function setViewMode(mode) {
        viewMode = mode
        localStorage.setItem('grid-fm-view-mode', mode)
        gridEl.toggleClass('grid-hidden', mode !== 'icons')
        listEl.toggleClass('grid-hidden', mode !== 'list')
        $('#grid-fm-view-icons').toggleClass('grid-fm-view-active', mode === 'icons')
        $('#grid-fm-view-list').toggleClass('grid-fm-view-active', mode === 'list')
        openFolder(currentPath)
    }

    function openFolder(path) {
        currentPath = path
        fetchBrowse(path, function (result) {
            renderBreadcrumb(path)
            if (viewMode === 'icons') renderGrid(result)
            diskEl.text(result.diskUsage)
            updateToolbarState()
        })
        if (viewMode === 'list') fetchStat(path, renderList)
        gridEl.addClass('grid-fm-drop-target')
        bindDropTarget(gridEl, path)
        bindDropTarget(listEl, path)
    }

    return {
        init: function () {
            overlay = $('#grid-file-manager-overlay')
            treeEl = $('#grid-fm-tree')
            breadcrumbEl = $('#grid-fm-breadcrumb')
            gridEl = $('#grid-fm-grid')
            listEl = $('#grid-fm-list')
            listBodyEl = $('#grid-fm-list-body')
            diskEl = $('#grid-fm-diskspace')

            $('#grid-file-manager-toggle').click(function () { GridFileManager.open() })
            $('#grid-file-manager-close').click(function () { GridFileManager.close() })
            overlay.click(function (ev) { if (ev.target === overlay[0]) GridFileManager.close() })

            // Safety net for OS file drags that end on a gap between bound drop
            // targets (grid/list/tree/breadcrumb, see bindDropTarget) — without
            // this the browser's default action for an unhandled drop is to
            // navigate the tab to open the dropped file, losing app state.
            overlay.on('dragover', function (ev) { if (isOsFileDrag(ev)) ev.preventDefault() })
            overlay.on('drop', function (ev) { if (isOsFileDrag(ev)) ev.preventDefault() })

            gridEl.toggleClass('grid-hidden', viewMode !== 'icons')
            listEl.toggleClass('grid-hidden', viewMode !== 'list')
            $('#grid-fm-view-icons').toggleClass('grid-fm-view-active', viewMode === 'icons').click(function () { setViewMode('icons') })
            $('#grid-fm-view-list').toggleClass('grid-fm-view-active', viewMode === 'list').click(function () { setViewMode('list') })
            $('#grid-fm-list thead th[data-sort]').click(function () {
                var key = $(this).data('sort')
                if (sortKey === key) sortAsc = !sortAsc
                else { sortKey = key; sortAsc = true }
                renderList(lastListEntries)
            })

            $('#grid-fm-new-folder').click(function () {
                var name = window.prompt('Folder name:')
                if (!name) return
                $.ajax({
                    url: fmUrl('subdir', currentPath),
                    type: 'POST',
                    data: { subdir: name },
                    complete: function () { openFolder(currentPath); renderTree() },
                })
            })

            $('#grid-fm-upload').click(function () { $('#grid-fm-upload-input').click() })
            $('#grid-fm-upload-input').on('change', function () {
                var files = this.files
                var input = this
                if (!files.length) return
                var fd = new FormData()
                for (var i = 0; i < files.length; i++) fd.append('file', files[i], files[i].name)
                notify('info', 'Uploading…')
                fetch(fmUrl('upload', currentPath), { method: 'POST', body: fd })
                    .then(function () { input.value = ''; openFolder(currentPath) })
                    .catch(function () { notify('error', 'Upload failed') })
            })

            $('#grid-fm-paste').click(function () { pasteClipboard() })
        },
        open: function () {
            overlay.removeClass('grid-hidden')
            renderTree()
            openFolder('')
        },
        close: function () {
            overlay.addClass('grid-hidden')
        },
    }
})()

$(document).ready(function () { GridFileManager.init() })
