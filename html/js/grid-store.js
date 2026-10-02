// SPDX-FileCopyrightText: 2012-2023 MOD Audio UG
// SPDX-License-Identifier: AGPL-3.0-or-later

// "Plugin Store": browse/search/install/update/remove plugins from
// Patchstorage, in the grid theme's own visual style. Catalog and installation
// integration follows MODEP while keeping the Grid UI. See
// PATCHSTORAGE_API_URL/PLATFORM_ID/TARGET_ID in grid.html's bootstrap script
// (same server context grid() shares with index(), see mod/webserver.py).

var GridStore = (function () {
    var overlay, gridEl, tabsEl, filterEl, searchInput, countEl
    var detailOverlay, detailInner

    // Only the Patchstorage catalog fetch is cached across searches within a
    // session (it's the expensive, paginated, external one) — local plugin
    // state always comes fresh from the shared pluginLibrary global, which is
    // already kept current by loadShelf() elsewhere, so re-deriving the merge
    // on every render() is cheap and never goes stale.
    var cloudPlugins = null // uri -> transformed cloud plugin
    var cloudLoading = false
    var cloudError = false
    var cloudCallbacks = []
    var category = 'All'
    var statusFilter = 'all'

    var CATEGORIES = ['All', 'Delay', 'Distortion', 'Dynamics', 'Filter', 'Generator', 'MIDI',
        'Modulator', 'Reverb', 'Simulator', 'Spatial', 'Spectral', 'ControlVoltage', 'Utility']

    var CATEGORY_FROM_TAG = {
        delay: 'Delay', distortion: 'Distortion', dynamics: 'Dynamics', filter: 'Filter',
        generator: 'Generator', modulator: 'Modulator', reverb: 'Reverb', simulator: 'Simulator',
        spatial: 'Spatial', spectral: 'Spectral', controlvoltage: 'ControlVoltage',
        midi: 'MIDI', utility: 'Utility',
    }

    var STATUS_LABEL = {
        installed: 'Installed',
        outdated: 'Update available',
        unavailable: 'Removed from store',
        local: 'Local',
        partial: 'Partially installed',
    }

    var FILTERS = [['all', 'All'], ['installed', 'Installed'], ['available', 'Available'],
        ['outdated', 'Updates'], ['other', 'Other']]

    function categoryFromTags(tags) {
        for (var i = 0; i < tags.length; i++) {
            if (CATEGORY_FROM_TAG[tags[i]]) return CATEGORY_FROM_TAG[tags[i]]
        }
        return 'Other'
    }

    function storeEnabled() {
        return (PATCHSTORAGE_ENABLED === true || PATCHSTORAGE_ENABLED === 'true') &&
            typeof PATCHSTORAGE_TARGET_ID !== 'undefined' && /^[1-9][0-9]*$/.test(String(PATCHSTORAGE_TARGET_ID))
    }

    function revision(value) {
        if (value === null || value === undefined) return null
        var text = String(value).trim()
        return text || null
    }

    // Patchstorage's REST API, transformed into the flat shape the rest of
    // this file works with. Titles/excerpts come back URI-escaped from the
    // API, hence unescape() rather than any HTML-entity decoding.
    //
    // The bulk list endpoint (used for browsing/search) is already filtered
    // server-side by the ?targets= query param and doesn't include a `files`
    // array at all (too heavy for 100-at-a-time listing) — supported
    // defaults to true in that case, same as the reference implementation.
    // `files` (and therefore the real download URL) only ever comes from the
    // single-item detail endpoint, fetched lazily right before install (see
    // fetchInstallFile below) since that's the only place it's needed.
    function transformCloudPlugin(p) {
        var tags = []
        function addTags(list) {
            (list || []).forEach(function (item) {
                var name = (item.slug || '').replace(/-/g, '').toLowerCase()
                if (name && tags.indexOf(name) < 0) tags.push(name)
            })
        }
        addTags(p.categories)
        addTags(p.tags)

        var supported = !Array.isArray(p.targets) || p.targets.some(function (target) {
            return String(target.id) === String(PATCHSTORAGE_TARGET_ID)
        })
        var file = null
        if (Array.isArray(p.files)) {
            file = p.files.filter(function (f) {
                return f.target && String(f.target.id) === String(PATCHSTORAGE_TARGET_ID)
            })[0] || null
            supported = !!file
        }

        var uids = p.uids || []
        return {
            psid: String(p.id),
            cloud_revision: revision(p.revision),
            uri: uids.length === 1 ? uids[0] : ('bundle_' + p.id),
            uids: uids,
            name: unescape(p.title || ''),
            comment: unescape(p.content || p.excerpt || ''),
            thumbnail_href: p.artwork ? p.artwork.thumbnail_url : '',
            screenshot_href: p.artwork ? p.artwork.url : '',
            plugin_count: uids.length,
            uploader: p.author ? p.author.slug : '',
            download_count: p.download_count,
            url: p.url,
            donate_url: p.donate_url,
            source_code_url: p.source_code_url,
            category: categoryFromTags(tags),
            supported: supported,
            file: file,
            status: 'available',
        }
    }

    // pluginLibrary's shape (see loadShelf() in grid-app.js, straight off
    // /effect/list) — .patchstorage is {id, revision} if this copy was
    // installed from the store, null otherwise.
    function transformLocalPlugin(instance) {
        return {
            uri: instance.uri,
            name: instance.label || instance.name,
            comment: instance.comment,
            brand: instance.brand,
            category: (instance.category && instance.category[0]) || 'Other',
            thumbnail_href: instance.gui ? '/effect/image/thumbnail.png?uri=' + escape(instance.uri) + '&v=' + VERSION : '',
            screenshot_href: instance.gui ? '/effect/image/screenshot.png?uri=' + escape(instance.uri) + '&v=' + VERSION : '',
            local_revision: instance.patchstorage ? revision(instance.patchstorage.revision) : null,
            psid: instance.patchstorage ? String(instance.patchstorage.id) : null,
        }
    }

    // Local data wins for identity/display (name, thumbnail, category all
    // reflect what's actually installed on disk); cloud data adds the
    // store-only bits (install file, counts, links) needed to offer update.
    function mergePlugin(local, cloud) {
        if (!cloud) return $.extend({}, local, {
            status: local.psid ? (storeEnabled() && cloudPlugins !== null ? 'unavailable' : 'installed') : 'local',
            installed_uris: [local.uri],
        })
        if (!local) return $.extend({}, cloud, { status: 'available' })
        var merged = $.extend({}, local, {
            psid: cloud.psid,
            file: cloud.file,
            supported: cloud.supported,
            cloud_revision: cloud.cloud_revision,
            download_count: cloud.download_count,
            url: cloud.url,
            uploader: cloud.uploader || local.brand,
            donate_url: cloud.donate_url,
            source_code_url: cloud.source_code_url,
            plugin_count: cloud.plugin_count,
            installed_uris: [local.uri],
            status: 'installed',
        })
        if (local.local_revision !== null && cloud.cloud_revision !== null && local.local_revision !== cloud.cloud_revision) {
            merged.status = 'outdated'
        }
        return merged
    }

    function mergeBundle(local, cloud) {
        var members = Object.keys(local).filter(function (uri) {
            return cloud.uids.indexOf(uri) >= 0 || local[uri].psid === cloud.psid
        })
        if (!members.length) return mergePlugin(null, cloud)
        var installedCount = cloud.uids.filter(function (uri) { return !!local[uri] }).length
        var revisions = []
        var hasUpdate = false
        members.forEach(function (uri) {
            var value = local[uri].local_revision
            if (value !== null && revisions.indexOf(value) < 0) revisions.push(value)
            if (value !== null && cloud.cloud_revision !== null && value !== cloud.cloud_revision) hasUpdate = true
        })
        var result = $.extend({}, cloud, {
            installed_uris: members,
            installed_count: installedCount,
            local_revision: revisions.length ? revisions.join(', ') : null,
            has_update: hasUpdate,
            status: installedCount < cloud.uids.length ? 'partial' : (hasUpdate ? 'outdated' : 'installed'),
        })
        members.forEach(function (uri) { delete local[uri] })
        return result
    }

    function fetchCloudPlugins(callback) {
        if (cloudPlugins !== null || !storeEnabled()) { callback(); return }
        if (cloudCallbacks.indexOf(callback) < 0) cloudCallbacks.push(callback)
        if (cloudLoading) return
        cloudLoading = true

        function finish(error) {
            cloudLoading = false
            cloudError = !!error
            cloudPlugins = error ? null : map
            var callbacks = cloudCallbacks
            cloudCallbacks = []
            callbacks.forEach(function (ready) { ready() })
        }

        var base = PATCHSTORAGE_API_URL + '?per_page=100&platforms=' + PATCHSTORAGE_PLATFORM_ID +
            '&targets=' + PATCHSTORAGE_TARGET_ID
        var map = {}
        var page = 1

        function nextPage() {
            $.ajax({
                url: base + '&page=' + page,
                cache: false,
                dataType: 'json',
                timeout: 15000,
                success: function (data, status, xhr) {
                    if (!Array.isArray(data)) { finish(true); return }
                    if (!data.length) { finish(false); return }
                    var pages = parseInt(xhr.getResponseHeader('x-wp-totalpages'), 10) || 1
                    data.forEach(function (p) {
                        var t = transformCloudPlugin(p)
                        if (t.supported && t.uids.length) map[t.uri] = t
                    })
                    if (pages > page) { page++; nextPage() }
                    else finish(false)
                },
                error: function (xhr, status) {
                    if (status !== 'abort') notify('error', 'Could not reach Patchstorage')
                    finish(true)
                },
            })
        }
        nextPage()
    }

    function currentMerged() {
        var local = {}
        pluginLibrary.forEach(function (p) { local[p.uri] = transformLocalPlugin(p) })

        var merged = {}
        Object.keys(storeEnabled() ? (cloudPlugins || {}) : {}).forEach(function (key) {
            var cP = cloudPlugins[key]
            if (cP.uids.length > 1) {
                merged['bundle_' + cP.psid] = mergeBundle(local, cP)
            } else {
                var uri = cP.uids[0]
                if (local[uri]) { merged[uri] = mergePlugin(local[uri], cP); delete local[uri] }
                else merged[uri] = mergePlugin(null, cP)
            }
        })
        Object.keys(local).forEach(function (uri) { merged[uri] = mergePlugin(local[uri], null) })
        return merged
    }

    function matchesFilter(p) {
        switch (statusFilter) {
            case 'installed': return p.status === 'installed' || p.status === 'outdated' || p.status === 'partial'
            case 'available': return p.status === 'available' || p.status === 'partial'
            case 'outdated': return p.status === 'outdated' || p.has_update
            case 'other': return p.status === 'local' || p.status === 'unavailable'
            default: return true
        }
    }

    function render() {
        if (storeEnabled() && cloudPlugins === null && !cloudError) {
            fetchCloudPlugins(renderContent)
        }
        renderContent()
    }

    function renderContent() {
        var merged = currentMerged()
        var q = (searchInput.val() || '').toLowerCase().trim()
        var counts = { All: 0 }
        CATEGORIES.forEach(function (c) { counts[c] = 0 })
        var filtered = []

        Object.keys(merged).forEach(function (key) {
            var p = merged[key]
            if (!matchesFilter(p)) return
            var idx = (p.name + ' ' + (p.comment || '') + ' ' + (p.uploader || p.brand || '')).toLowerCase()
            if (q && idx.indexOf(q) < 0) return
            counts.All++
            if (counts[p.category] !== undefined) counts[p.category]++
            if (category === 'All' || p.category === category) filtered.push(p)
        })

        renderTabs(counts)
        renderFilters()
        renderGrid(filtered)
    }

    function renderTabs(counts) {
        tabsEl.empty()
        CATEGORIES.forEach(function (c) {
            var tab = $('<button type="button" class="grid-store-tab">').text(c + ' (' + (counts[c] || 0) + ')')
            tab.toggleClass('grid-store-tab-active', c === category)
            tab.click(function () { category = c; render() })
            tabsEl.append(tab)
        })
    }

    function renderFilters() {
        filterEl.empty()
        FILTERS.forEach(function (f) {
            var btn = $('<button type="button" class="grid-store-filter-btn">').text(f[1])
            btn.toggleClass('grid-store-filter-active', f[0] === statusFilter)
            btn.click(function () { statusFilter = f[0]; render() })
            filterEl.append(btn)
        })
    }

    function renderGrid(list) {
        list.sort(function (a, b) {
            var an = a.name.toLowerCase(), bn = b.name.toLowerCase()
            return an < bn ? -1 : (an > bn ? 1 : 0)
        })
        gridEl.empty()
        countEl.text(list.length + (list.length === 1 ? ' plugin' : ' plugins'))
        if (!storeEnabled() || cloudError || cloudLoading) {
            var note = $('<div class="grid-store-empty">')
            if (!storeEnabled()) note.text('Patchstorage downloads are disabled. Installed plugins remain available.')
            else if (cloudError) {
                note.text('Patchstorage is unavailable. Showing installed plugins. ')
                note.append($('<button type="button" class="grid-store-filter-btn">').text('Retry').click(function () {
                    cloudError = false
                    render()
                }))
            } else note.text('Loading Patchstorage. Showing installed plugins.')
            gridEl.append(note)
        }
        if (!list.length) {
            gridEl.append($('<div class="grid-store-empty">').text('No plugins found'))
            return
        }
        list.forEach(function (p) { gridEl.append(buildCard(p)) })
    }

    function buildCard(p) {
        var card = $('<div class="grid-store-card">').attr('data-store-uri', p.uri).attr('data-store-status', p.status)
        var thumb = $('<div class="grid-store-card-thumb">')
        if (p.thumbnail_href) thumb.append($('<img loading="lazy">').attr('src', p.thumbnail_href))
        card.append(thumb)
        var label = STATUS_LABEL[p.status]
        if (label) card.append($('<span class="grid-store-badge grid-store-badge-' +
            (p.status === 'partial' ? 'outdated' : p.status) + '">').text(label))
        card.append($('<div class="grid-store-card-name">').text(p.name).attr('title', p.name))
        card.append($('<div class="grid-store-card-author">').text(p.uploader || p.brand || ''))
        card.click(function () { openDetail(p) })
        return card
    }

    function metaRow(label, value) {
        if (!value) return null
        var row = $('<div class="grid-store-detail-row">')
        row.append($('<b>').text(label + ': '))
        row.append($('<span>').text(value))
        return row
    }

    function linkBtn(href, label) {
        if (!href || !/^https?:\/\//i.test(href)) return null
        return $('<a class="grid-store-link-btn" target="_blank" rel="noopener">').attr('href', href).text(label)
    }

    function openDetail(p) {
        detailInner.empty()

        var header = $('<div class="grid-store-detail-header">')
        header.append($('<h3>').text(p.name))
        var closeBtn = $('<button type="button" class="grid-store-detail-close" title="Close">').html('&times;')
        closeBtn.click(function () { detailOverlay.addClass('grid-hidden') })
        header.append(closeBtn)
        detailInner.append(header)

        if (p.screenshot_href) detailInner.append($('<img class="grid-store-detail-shot">').attr('src', p.screenshot_href))

        var meta = $('<div class="grid-store-detail-meta">')
        ;[
            metaRow('Category', p.category),
            metaRow('Author', p.uploader || p.brand),
            metaRow('Installed revision', p.local_revision),
            metaRow('Latest revision', p.cloud_revision),
            metaRow('Installed plugins', p.plugin_count > 1 && p.installed_count !== undefined ?
                p.installed_count + ' / ' + p.plugin_count : null),
            metaRow('Downloads', p.download_count),
        ].forEach(function (row) { if (row) meta.append(row) })
        detailInner.append(meta)

        if (p.comment) detailInner.append($('<p class="grid-store-detail-comment">').text(p.comment))

        var links = $('<div class="grid-store-detail-links">')
        ;[
            linkBtn(p.url, 'Comments'),
            linkBtn(p.donate_url, 'Donate to author'),
            linkBtn(p.source_code_url, 'Source code'),
        ].forEach(function (a) { if (a) links.append(a) })
        if (links.children().length) detailInner.append(links)

        var actions = $('<div class="grid-store-detail-actions">')
        if (p.status === 'available' || p.status === 'outdated' || p.status === 'partial') {
            var installBtn = $('<button type="button" class="grid-store-action-btn">')
                .text(p.status === 'partial' ? 'Install missing' : (p.status === 'outdated' ? 'Update' : 'Install'))
            installBtn.prop('disabled', !p.supported)
            installBtn.click(function () { installPlugin(p, installBtn) })
            actions.append(installBtn)
        }
        if (p.status === 'installed' || p.status === 'outdated' || p.status === 'partial' || p.status === 'local' || p.status === 'unavailable') {
            var removeBtn = $('<button type="button" class="grid-store-action-btn grid-store-action-danger">').text('Remove')
            removeBtn.click(function () { removePlugin(p, removeBtn) })
            actions.append(removeBtn)
        }
        detailInner.append(actions)

        detailOverlay.removeClass('grid-hidden')
    }

    // Refetches /effect/list directly (rather than relying on loadShelf()'s
    // own fetch timing) so the store's own re-render has fresh data as soon
    // as it's available; loadShelf() is still called too so the canvas's
    // plugin shelf picks up the change the same way it does after a
    // "rescan" websocket broadcast (see grid-app.js).
    function refreshAfterChange() {
        loadShelf()
        $.ajax({
            url: '/effect/list',
            cache: false,
            dataType: 'json',
            success: function (plugins) {
                pluginLibrary = plugins || []
                render()
            },
        })
    }

    // The list/search endpoint doesn't carry a `files` array (see the comment
    // above transformCloudPlugin), so the real download file is only ever
    // known once the single-item detail endpoint has been fetched — do that
    // lazily here, right before actually downloading, rather than for every
    // card up front.
    function fetchInstallFile(p, callback) {
        if (p.file) { callback(p.file); return }
        $.ajax({
            url: PATCHSTORAGE_API_URL + '/' + p.psid,
            cache: false,
            dataType: 'json',
            success: function (full) {
                var file = null
                if (full && revision(full.revision) !== null) {
                    p.cloud_revision = revision(full.revision)
                    Object.keys(cloudPlugins || {}).forEach(function (key) {
                        if (cloudPlugins[key].psid === p.psid) cloudPlugins[key].cloud_revision = p.cloud_revision
                    })
                }
                if (full && full.files && full.files.length) {
                    file = full.files.filter(function (f) {
                        return f.target && String(f.target.id) === String(PATCHSTORAGE_TARGET_ID)
                    })[0] || null
                }
                callback(file)
            },
            error: function () { callback(null) },
        })
    }

    function installPlugin(p, btn) {
        if (!storeEnabled()) { notify('error', 'Patchstorage downloads are disabled'); return }
        btn.prop('disabled', true)
        fetchInstallFile(p, function (file) {
            if (!file || !file.url) {
                notify('error', 'This plugin is not available for your platform')
                btn.prop('disabled', false)
                return
            }
            downloadAndInstall(p, file, btn)
        })
    }

    function downloadAndInstall(p, file, btn) {
        notify('info', 'Downloading ' + p.name + '…')

        fetch(file.url)
            .then(function (r) {
                if (!r.ok) throw new Error('download failed (' + r.status + ')')
                return r.blob()
            })
            .then(function (blob) {
                notify('info', 'Installing ' + p.name + '…')
                return fetch('/effect/install/', {
                    method: 'POST',
                    headers: {
                        'Content-Type': blob.type || 'application/octet-stream',
                        'Patchstorage-Item': p.psid,
                        'Patchstorage-Item-Version': revision(p.cloud_revision) || '0.0',
                    },
                    body: blob,
                })
            })
            .then(function (r) {
                if (r.ok === false) throw new Error('installation request failed (' + r.status + ')')
                return r.json()
            })
            .then(function (resp) {
                var result = resp && resp.result
                if (!result || !result.ok) {
                    notify('error', "Couldn't install " + p.name + (result && result.error ? ': ' + result.error : ''))
                    btn.prop('disabled', false)
                    return
                }
                notify('info', p.name + ' installed')
                detailOverlay.addClass('grid-hidden')
                refreshAfterChange()
            })
            .catch(function () {
                notify('error', "Couldn't install " + p.name)
                btn.prop('disabled', false)
            })
    }

    function removePlugin(p, btn) {
        if (!window.confirm('Remove "' + p.name + '"? Any pedalboard using it may break.')) return
        btn.prop('disabled', true)
        var uris = p.installed_uris || [p.uri]
        var pending = uris.length
        var bundles = []
        var failed = false

        function bundleResolved(full) {
            if (!full || !Array.isArray(full.bundles) || !full.bundles.length) failed = true
            else full.bundles.forEach(function (path) { if (bundles.indexOf(path) < 0) bundles.push(path) })
            pending--
            if (pending) return
            if (failed || !bundles.length) {
                notify('error', "Couldn't find files for " + p.name)
                btn.prop('disabled', false)
                return
            }
            uninstallBundles()
        }

        function uninstallBundles() {
            $.ajax({
                url: '/package/uninstall',
                type: 'POST',
                contentType: 'application/json',
                processData: false,
                data: JSON.stringify(bundles),
                cache: false,
                dataType: 'json',
                success: function (resp) {
                    if (!resp || !resp.ok) {
                        notify('error', "Couldn't remove " + p.name + (resp && resp.error ? ': ' + resp.error : ''))
                        btn.prop('disabled', false)
                        return
                    }
                    notify('info', p.name + ' removed')
                    detailOverlay.addClass('grid-hidden')
                    refreshAfterChange()
                },
                error: function () { notify('error', "Couldn't remove " + p.name); btn.prop('disabled', false) },
            })
        }

        uris.forEach(function (uri) { $.ajax({
            url: '/effect/get',
            data: { uri: uri, version: VERSION },
            cache: false,
            dataType: 'json',
            success: bundleResolved,
            error: function () { bundleResolved(null) },
        }) })
    }

    return {
        init: function () {
            overlay = $('#grid-store-overlay')
            gridEl = $('#grid-store-grid')
            tabsEl = $('#grid-store-tabs')
            filterEl = $('#grid-store-filters')
            searchInput = $('#grid-store-search')
            countEl = $('#grid-store-count')
            detailOverlay = $('#grid-store-detail-overlay')
            detailInner = $('#grid-store-detail-inner')

            $('#grid-store-toggle').click(function () { GridStore.open() })
            $('#grid-store-close').click(function () { GridStore.close() })
            overlay.click(function (ev) { if (ev.target === overlay[0]) GridStore.close() })
            detailOverlay.click(function (ev) { if (ev.target === detailOverlay[0]) detailOverlay.addClass('grid-hidden') })

            searchInput.on('input', render)
        },
        open: function () {
            overlay.removeClass('grid-hidden')
            cloudError = false
            render()
        },
        close: function () {
            overlay.addClass('grid-hidden')
            detailOverlay.addClass('grid-hidden')
        },
    }
})()

$(document).ready(function () { GridStore.init() })
