'use strict'

// Standalone interaction concept. All audio, MIDI and transition state is simulated.
const storageKey = 'mod-dual-chain-mockup-v1'
const roles = ['guitar', 'microphone']
const roleName = { guitar: 'Guitar', microphone: 'Microphone', master: 'Master', none: 'Unassigned' }
const clone = value => JSON.parse(JSON.stringify(value))
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const plugin = (name, type) => ({ id: name.toLowerCase().replace(/\W+/g, '-'), name, type, level: 50, mix: 24, time: 38 })
const definition = (id, role, name, revision, plugins, model = '') => ({ id, role, name, revision, plugins, model })

function initialState() {
    const presets = [
        definition('g-clean', 'guitar', 'Clean', 2, [plugin('Noise Gate', 'gate'), plugin('Neural Amp Modeler', 'amp'), plugin('Cabinet Loader', 'cab'), plugin('Room Reverb', 'reverb')], 'American Clean.nam'),
        definition('g-crunch', 'guitar', 'Crunch', 1, [plugin('Noise Gate', 'gate'), plugin('Neural Amp Modeler', 'amp'), plugin('Cabinet Loader', 'cab'), plugin('Spring Reverb', 'reverb')], 'British Crunch.nam'),
        definition('g-drive', 'guitar', 'Drive', 3, [plugin('Noise Gate', 'gate'), plugin('Overdrive', 'drive'), plugin('Neural Amp Modeler', 'amp'), plugin('Cabinet Loader', 'cab')], 'Modern Drive.nam'),
        definition('g-lead', 'guitar', 'Lead', 1, [plugin('Overdrive', 'drive'), plugin('Neural Amp Modeler', 'amp'), plugin('Cabinet Loader', 'cab'), plugin('Digital Delay', 'delay'), plugin('Plate Reverb', 'reverb')], 'Singing Lead.nam'),
        definition('g-ambient', 'guitar', 'Ambient', 1, [plugin('Neural Amp Modeler', 'amp'), plugin('Cabinet Loader', 'cab'), plugin('Chorus', 'chorus'), plugin('Tape Delay', 'delay'), plugin('Hall Reverb', 'reverb')], 'American Clean.nam'),
        definition('g-acoustic', 'guitar', 'Acoustic', 1, [plugin('Compressor', 'dynamics'), plugin('Parametric EQ', 'eq'), plugin('Studio Reverb', 'reverb')]),
        definition('m-dry', 'microphone', 'Vocal Dry', 2, [plugin('High-pass Filter', 'eq'), plugin('Compressor', 'dynamics'), plugin('De-esser', 'dynamics')]),
        definition('m-delay', 'microphone', 'Vocal Delay', 1, [plugin('High-pass Filter', 'eq'), plugin('Compressor', 'dynamics'), plugin('De-esser', 'dynamics'), plugin('Tape Delay', 'delay'), plugin('Plate Reverb', 'reverb')]),
        definition('m-wide', 'microphone', 'Vocal Wide', 1, [plugin('High-pass Filter', 'eq'), plugin('Compressor', 'dynamics'), plugin('Chorus', 'chorus'), plugin('Hall Reverb', 'reverb')])
    ]
    const assignments = Array.from({ length: 12 }, (_, i) => ({ switch: i + 1, owner: i < 2 ? 'microphone' : 'guitar', type: 'cc', channel: 1, number: i + 20, press: 127, action: i === 0 ? 'previous' : i === 1 || i === 9 ? 'next' : i === 8 ? 'previous' : 'preset', target: i < 2 ? 'm-dry' : ['g-clean', 'g-crunch', 'g-drive', 'g-lead', 'g-ambient', 'g-acoustic', 'g-clean', 'g-clean', 'g-clean', 'g-ambient'][i - 2] }))
    return {
        version: 1, presets,
        masters: [{ id: 'verse', name: 'Verse', guitar: 'g-clean', microphone: 'm-dry' }, { id: 'chorus', name: 'Chorus', guitar: 'g-drive', microphone: 'm-dry' }, { id: 'solo', name: 'Solo', guitar: 'g-lead', microphone: 'm-delay' }],
        active: { guitar: clone(presets[0]), microphone: clone(presets[6]) },
        currentMaster: 'verse', ports: { guitar: { input: 'Input 1', output: 'Out 1 + 2' }, microphone: { input: 'Input 2', output: 'Out 1 + 2' } },
        spillover: { guitar: true, microphone: true }, assignments
    }
}

function loadState() {
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey))
        if (saved?.version === 1 && saved.presets?.length && saved.active?.guitar && saved.assignments?.length === 12) return saved
    } catch (e) { /* Storage may be unavailable for local files. */ }
    return initialState()
}

let state = loadState()
let view = new URLSearchParams(location.search).get('view') || 'perform'
if (!['perform', 'library', 'masters', 'switches'].includes(view)) view = 'perform'
let selected = { role: 'guitar', id: state.active.guitar.plugins[1].id }
let libraryRole = 'microphone'
let libraryId = 'm-dry'
let libraryDraft = null
let masterId = 'verse'
let masterDraft = null
let switchDraft = clone(state.assignments)
const pending = { guitar: null, microphone: null }
const tails = { guitar: [], microphone: [] }
const tokens = { guitar: 0, microphone: 0 }
let masterPending = null
let toastTimer
let dialogSave
const presetById = id => state.presets.find(p => p.id === id)
const presetsFor = role => state.presets.filter(p => p.role === role)
const references = id => state.masters.filter(m => m.guitar === id || m.microphone === id)
const saveState = () => { try { localStorage.setItem(storageKey, JSON.stringify(state)) } catch (e) {} }

function notify(message) {
    const el = document.getElementById('toast')
    el.textContent = message
    el.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.classList.remove('show'), 3800)
}

function option(value, label, current) {
    return `<option value="${esc(value)}"${String(value) === String(current) ? ' selected' : ''}>${esc(label)}</option>`
}

function presetOptions(role, current) {
    return presetsFor(role).map(p => option(p.id, p.name, current)).join('')
}

function icon(role) {
    return role === 'guitar'
        ? '<svg viewBox="0 0 24 24"><path d="m14 10 6-7 2 2-7 7M13 8l3 3M8 8c-3-1-6 1-6 4 0 2 2 4 4 5s5 1 7-1c2-2 1-4 0-5l-2 1-2-2z"/><circle cx="8" cy="13" r="1.7"/></svg>'
        : '<svg viewBox="0 0 24 24"><rect x="8" y="2" width="8" height="12" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>'
}

function go(nextView) {
    view = nextView
    const query = new URLSearchParams(location.search)
    query.set('view', view)
    query.delete('scenario')
    try { history.replaceState(null, '', `${location.pathname}?${query}`) } catch (e) {}
    render()
}

function render() {
    document.querySelectorAll('[data-view]').forEach(b => {
        if (b.dataset.view === view) b.setAttribute('aria-current', 'page')
        else b.removeAttribute('aria-current')
    })
    const pages = { perform: performView, library: libraryView, masters: mastersView, switches: switchesView }
    document.getElementById('content').innerHTML = pages[view]()
    bindView()
    updateTails()
}

function currentMasterLabel() {
    const master = state.masters.find(m => m.id === state.currentMaster)
    return master ? master.name : 'Custom combination'
}

function graphMarkup(role, preset, editable = true) {
    const nodes = [{ name: state.ports[role].input, type: 'input' }, ...preset.plugins, { name: state.ports[role].output, type: 'output' }]
    const width = 1360
    const spacing = (width - 170) / (nodes.length - 1)
    const blockWidth = Math.min(153, spacing - 32)
    const content = nodes.map((node, i) => {
        const x = 85 + i * spacing
        const io = i === 0 || i === nodes.length - 1
        const focused = !io && editable && selected.role === role && selected.id === node.id
        const fullName = node.name
        const title = fullName === 'Neural Amp Modeler' ? 'Neural Amp Modeler' : fullName
        const symbol = ({ gate: '≋', amp: 'NAM', cab: '▤', drive: 'OD', reverb: '≈', delay: '•••', dynamics: '∿', eq: 'EQ', chorus: '∿∿', input: '→◉', output: '◉→' })[node.type] || 'FX'
        const label = ({ gate: 'Dynamics', amp: 'Simulator', cab: 'Impulse response', drive: 'Distortion', reverb: 'Reverb', delay: 'Delay', dynamics: 'Dynamics', eq: 'Filter', chorus: 'Modulation', input: 'Physical input', output: 'Physical output' })[node.type] || 'Effect'
        const line = i < nodes.length - 1 ? `<path class="wire" d="M ${x + blockWidth / 2} 48 H ${x + spacing - blockWidth / 2}"/><circle class="wire-dot" cx="${x + blockWidth / 2}" cy="48" r="3"/>` : ''
        return `${line}<g class="${io ? 'io' : 'plugin'}${focused ? ' selected' : ''}" transform="translate(${x - blockWidth / 2},9)"${!io && editable ? ` role="button" tabindex="0" data-plugin="${esc(node.id)}" data-role="${role}" aria-label="Edit ${esc(roleName[role])} ${esc(fullName)}"` : ''}><title>${esc(fullName)}</title><rect width="${blockWidth}" height="78"/>${!io ? `<path class="topline" d="M 5 0 H ${blockWidth - 5}"/>` : ''}<text class="symbol" x="${blockWidth / 2}" y="27"${symbol === 'NAM' ? ' style="font-size:16px;letter-spacing:2px"' : ''}>${symbol}</text><text x="${blockWidth / 2}" y="49"${title.length > 17 ? ' style="font-size:10px"' : ''}>${esc(title)}</text><text class="sub-label" x="${blockWidth / 2}" y="67">${label}</text></g>`
    }).join('')
    return `<div class="graph"><svg viewBox="0 0 ${width} 98" aria-label="${esc(roleName[role])} effect chain">${content}</svg></div>`
}

function chainView(role) {
    const active = state.active[role]
    const latest = presetById(active.id)
    const order = presetsFor(role)
    const next = order[(order.findIndex(p => p.id === active.id) + 1) % order.length]
    const status = pending[role]
    const statusLabel = status ? `${status.phase}: ${presetById(status.target).name}` : 'Active'
    return `<section class="chain ${role}" aria-label="${roleName[role]} chain">
      <div class="chain-header"><div class="chain-owner"><span class="owner-icon">${icon(role)}</span>${roleName[role]}</div><div class="chain-title"><strong>${esc(active.name)}</strong><span class="tag ${status ? 'amber' : 'green'}">${esc(statusLabel)}</span>${latest && latest.revision > active.revision ? '<span class="tag amber">Saved update available</span>' : ''}</div><div class="chain-recall"><button type="button" data-step="-1" data-role="${role}" aria-label="Previous ${role} preset">‹</button><select data-recall="${role}" aria-label="Recall ${role} preset">${presetOptions(role, active.id)}</select><button type="button" data-step="1" data-role="${role}" aria-label="Next ${role} preset">›</button><button type="button" class="small save-button" data-edit-chain="${role}">Edit preset</button></div></div>
      ${graphMarkup(role, active)}
      <div class="chain-footer"><span>Loaded revision ${active.revision}</span><button type="button" class="quiet small" data-spillover="${role}" aria-pressed="${state.spillover[role]}">Spillover ${state.spillover[role] ? 'On' : 'Off'}</button><span class="tails" id="tails-${role}"></span><span class="ready">● Ready next: ${esc(next.name)}</span></div>
    </section>`
}

function inspectorView() {
    const active = state.active[selected.role]
    let node = active.plugins.find(p => p.id === selected.id)
    if (!node) { node = active.plugins[0]; selected.id = node.id }
    const labels = node.type === 'amp' ? ['Gain', 'Output', 'Tone'] : node.type === 'gate' ? ['Threshold', 'Release', 'Range'] : node.type === 'eq' ? ['Frequency', 'Gain', 'Q'] : node.type === 'delay' ? ['Time', 'Feedback', 'Mix'] : node.type === 'reverb' ? ['Decay', 'Tone', 'Mix'] : ['Amount', 'Level', 'Mix']
    const params = labels.map((name, i) => `<div class="param-row"><label for="param-${i}">${name}</label><input id="param-${i}" type="range" min="0" max="100" value="${[node.level, node.time, node.mix][i]}" data-setting="${['level', 'time', 'mix'][i]}" aria-label="${esc(node.name)} ${name}"><output for="param-${i}">${[node.level, node.time, node.mix][i]}%</output></div>`).join('')
    return `<section class="inspector" aria-label="Plugin parameters"><div class="inspector-header"><span class="tag ${selected.role}">${roleName[selected.role]}</span><strong>${esc(node.name)}</strong><span class="muted">${esc(active.name)} · edits affect this chain only</span></div><div class="inspector-body"><div class="plugin-face"><div class="pedal"><div class="pedal-name">${esc(node.name).toUpperCase()}</div><div class="pedal-maker">PLUGIN INTERFACE CONCEPT</div><div class="knobs">${labels.map(label => `<span><i class="knob"></i>${label.toUpperCase()}</span>`).join('')}</div></div></div><div class="param-list">${params}${node.type === 'amp' ? `<div class="param-row"><label for="active-model">Model</label><select id="active-model">${['American Clean.nam', 'British Crunch.nam', 'Modern Drive.nam', 'Singing Lead.nam'].map(m => option(m, m, active.model)).join('')}</select></div>` : ''}</div></div></section>`
}

function assignmentLabel(a) {
    if (a.owner === 'none') return 'Unassigned'
    if (a.action === 'previous') return 'Previous'
    if (a.action === 'next') return 'Next'
    if (a.owner === 'master') return state.masters.find(m => m.id === a.target)?.name || 'Choose master'
    return presetById(a.target)?.name || 'Choose preset'
}

function switchDock() {
    return `<section class="switch-dock"><div class="switch-dock-header"><strong>MIDI footswitches</strong><span class="muted">Click a switch to simulate a press</span><button type="button" class="quiet small" data-goto="switches">Configure assignments →</button></div><div class="footswitches">${state.assignments.map(a => `<button type="button" class="footswitch ${a.owner}" data-press="${a.switch}" aria-label="Simulate switch ${a.switch}: ${roleName[a.owner]} ${esc(assignmentLabel(a))}"><span class="number">${String(a.switch).padStart(2, '0')}</span><strong>${esc(assignmentLabel(a))}</strong><small>${roleName[a.owner]}</small></button>`).join('')}</div></section>`
}

function performView() {
    return `<div class="page-heading"><div><h2>Two chains. One stage.</h2><p>Change Guitar or Microphone independently. Recall a master to select both together.</p></div><span class="tag purple">Independent mode</span></div>
    <section class="master-bar"><div class="master-current"><span class="eyebrow">CURRENT COMBINATION</span><strong>${esc(currentMasterLabel())}</strong>${!state.currentMaster ? '<span class="tag amber">Independent change</span>' : '<span class="tag purple">Master preset</span>'}<small>Guitar: ${esc(state.active.guitar.name)} &nbsp; / &nbsp; Microphone: ${esc(state.active.microphone.name)}</small></div><select id="perform-master" aria-label="Master preset to recall">${state.masters.map(m => option(m.id, m.name, state.currentMaster || masterId)).join('')}</select><button type="button" id="recall-master" class="primary">Recall master</button><button type="button" id="save-combination">Save combination…</button></section>
    ${chainView('guitar')}${chainView('microphone')}${inspectorView()}${switchDock()}<p class="sim-note">Transition timing, readiness and spillover indicators are simulated.</p>`
}

function libraryView() {
    const preset = presetById(libraryId)
    if (!libraryDraft || libraryDraft.id !== libraryId) libraryDraft = clone(preset)
    const draft = libraryDraft
    const refs = references(preset.id)
    const loaded = state.active[preset.role]
    return `<div class="page-heading"><div><h2>Reusable chain presets</h2><p>Save each chain once. Use it in as many master presets as you need.</p></div><span class="tag">${state.presets.length} shared definitions</span></div>
    <div class="two-column"><aside class="sidebar"><div class="sidebar-header"><h3>Preset library</h3><span class="muted">${presetsFor(libraryRole).length}</span></div><div class="owner-filter">${roles.map(role => `<button type="button" data-filter="${role}" class="${libraryRole === role ? 'selected' : ''}">${roleName[role]}</button>`).join('')}</div><div class="preset-list">${presetsFor(libraryRole).map(p => `<button type="button" class="preset-item ${p.id === libraryId ? 'selected' : ''}" data-library="${p.id}"><span class="color-line ${p.role}"></span><span><strong>${esc(p.name)}</strong><small>${references(p.id).length} master reference${references(p.id).length === 1 ? '' : 's'}</small></span><span class="revision">r${p.revision}</span></button>`).join('')}</div><p class="sidebar-note">Presets contain the complete effect chain, including plugin choices and connections.</p></aside>
    <section class="editor"><div class="editor-top"><div><div class="title-tags"><h2>${esc(preset.name)}</h2><span class="tag ${preset.role}">${roleName[preset.role]}</span><span class="tag">Revision ${preset.revision}</span></div><p>One saved definition · stable references in your masters</p></div><button type="button" id="library-recall">Recall on ${roleName[preset.role]}</button></div><div class="editor-content"><div class="form-grid"><label>Preset name<input id="preset-name" value="${esc(draft.name)}" maxlength="80"></label><label>Chain membership<select disabled>${option(preset.role, `${roleName[preset.role]} only`, preset.role)}</select></label></div><div class="section-title"><span>Effects & signal order</span><select id="add-effect" aria-label="Add an effect to the preset"><option value="">+ Add effect</option><option value="delay">Digital Delay</option><option value="reverb">Hall Reverb</option><option value="chorus">Chorus</option><option value="eq">Parametric EQ</option></select></div><div class="plugin-stack">${draft.plugins.map((p, i) => `<div class="stack-row"><span class="order">${String(i + 1).padStart(2, '0')}</span><strong>${esc(p.name)}</strong><small>${esc(p.type)}</small><button type="button" data-move-effect="${i}"${i === 0 ? ' disabled' : ''} aria-label="Move ${esc(p.name)} earlier">↑</button><button type="button" data-remove-effect="${i}"${draft.plugins.length === 1 ? ' disabled' : ''} aria-label="Remove ${esc(p.name)}">×</button></div>`).join('')}</div><div class="shared-box"><h3>${refs.length > 1 ? 'Shared by ' + refs.length + ' master presets' : refs.length === 1 ? 'Referenced by one master preset' : 'Ready to use in a master'}</h3><p>Saving updates this definition. Masters keep their references and use the saved revision on their next recall.</p><div class="reference-tags">${refs.map(m => `<button type="button" data-open-master="${m.id}">${esc(m.name)} ↗</button>`).join('')}</div></div>${loaded.id === preset.id ? `<div class="update-note">Currently playing: revision ${loaded.revision}. Saved: revision ${preset.revision}. Saving here leaves the playing chain unchanged until recall.</div>` : ''}</div><div class="editor-actions"><small>Physical inputs and outputs belong to the rig.</small><div class="actions"><button type="button" id="library-save-as">Save as new…</button><button type="button" class="primary" id="library-save">Save shared preset</button></div></div></section></div><p class="sim-note">This editor simulates plugin choices and their serial signal order.</p>`
}

function masterPicker(role, id) {
    const p = presetById(id)
    const refs = references(id)
    return `<section class="reference-picker ${role}"><div class="owner-label"><span>${roleName[role]} preset</span><span class="tag ${role}">Shared reference</span></div><select id="master-${role}" aria-label="${roleName[role]} preset reference">${presetOptions(role, id)}</select><div class="ref-details"><span>Saved revision ${p.revision} · ${refs.length} master reference${refs.length === 1 ? '' : 's'}</span><button type="button" class="quiet small" data-edit-reference="${id}">Edit shared preset ↗</button></div><div class="mini-graph">${p.plugins.map((p, i) => `${i ? '<i>→</i>' : ''}<span>${esc(p.name)}</span>`).join('')}</div></section>`
}

function mastersView() {
    const master = state.masters.find(m => m.id === masterId) || state.masters[0]
    masterId = master.id
    if (!masterDraft || masterDraft.id !== master.id) masterDraft = clone(master)
    return `<div class="page-heading"><div><h2>Master presets</h2><p>A master selects two shared presets. It keeps references to the originals.</p></div><button type="button" id="new-master">Save current combination…</button></div><div class="two-column"><aside class="sidebar"><div class="sidebar-header"><h3>Your masters</h3><span class="muted">${state.masters.length}</span></div><div class="master-list">${state.masters.map(m => `<button type="button" class="master-card ${m.id === masterId ? 'selected' : ''}" data-master-select="${m.id}">${m.id === state.currentMaster ? '<span class="tag green">Active</span>' : ''}<strong>${esc(m.name)}</strong><small>Guitar &nbsp; ${esc(presetById(m.guitar).name)}<br>Microphone &nbsp; ${esc(presetById(m.microphone).name)}</small></button>`).join('')}</div><p class="sidebar-note">Current combination: ${esc(currentMasterLabel())}. Independent changes do not overwrite saved masters.</p></aside><section class="editor"><div class="editor-top"><div><div class="title-tags"><h2>${esc(master.name)}</h2><span class="tag purple">Master preset</span></div><p>Both destinations are prepared before the combined recall.</p></div><button type="button" class="primary" id="master-recall">Recall both chains</button></div><div class="editor-content"><div class="form-grid"><label>Master name<input id="master-name" value="${esc(masterDraft.name)}" maxlength="80"></label><label>Recall behavior<select disabled>${option('both', 'Guitar + Microphone together', 'both')}</select></label></div>${masterPicker('guitar', masterDraft.guitar)}${masterPicker('microphone', masterDraft.microphone)}<div class="composition-note">Example: Verse and Chorus both reference Vocal Dry. Edit Vocal Dry once; both masters use that updated preset on their next recall.</div></div><div class="editor-actions"><small>Save references here. Edit sounds in the preset library.</small><div class="actions"><button type="button" id="master-revert">Revert edits</button><button type="button" class="primary" id="master-save">Save master</button></div></div></section></div>`
}

function conflicts(assignments) {
    const keys = new Map()
    const invalid = new Set()
    assignments.forEach((a, i) => {
        if (a.owner === 'none') return
        if (!Number.isInteger(a.channel) || a.channel < 1 || a.channel > 16 || !Number.isInteger(a.number) || a.number < 0 || a.number > 127 || !Number.isInteger(a.press) || a.press < 0 || a.press > 127) invalid.add(i)
        const key = `${a.type}:${a.channel}:${a.number}`
        if (keys.has(key)) { invalid.add(i); invalid.add(keys.get(key)) }
        else keys.set(key, i)
    })
    return invalid
}

function allocationMarkup() {
    return `<div class="allocation">${['microphone', 'guitar', 'master', 'none'].map(role => `<span class="tag ${role === 'master' ? 'purple' : role}">${switchDraft.filter(a => a.owner === role).length} ${roleName[role]}</span>`).join('')}</div>`
}

function switchesView() {
    const invalid = conflicts(switchDraft)
    const dirty = JSON.stringify(state.assignments) !== JSON.stringify(switchDraft)
    return `<div class="page-heading"><div><h2>Your switches. Your split.</h2><p>Assign any of the twelve switches to Guitar, Microphone or a master.</p></div><div id="allocation">${allocationMarkup()}</div></div><div class="port-settings"><span class="settings-title">Physical audio</span>${roles.map(role => `<label>${roleName[role]} input<select data-port="${role}" data-field="input">${['Input 1', 'Input 2'].map(p => option(p, p, state.ports[role].input)).join('')}</select></label><label>${roleName[role]} output<select data-port="${role}" data-field="output">${['Out 1', 'Out 2', 'Out 1 + 2'].map(p => option(p, p, state.ports[role].output)).join('')}</select></label>`).join('')}</div><div class="assignment-toolbar"><p>Example allocation: 2 Microphone + 10 Guitar. Every row can be reassigned.</p><span class="tag purple">PC / CC · 12 independent assignments</span></div><div class="assignment-table-wrap"><table aria-label="MIDI switch assignments"><colgroup><col style="width:7%"><col style="width:13%"><col style="width:15%"><col style="width:19%"><col style="width:10%"><col style="width:8%"><col style="width:10%"><col style="width:10%"><col style="width:8%"></colgroup><thead><tr><th>Switch</th><th>Target chain</th><th>Action</th><th>Preset / master</th><th>Message</th><th>Channel</th><th>CC / PC no.</th><th>CC press</th><th>Try</th></tr></thead><tbody>${switchDraft.map((a, i) => {
        const actions = a.owner === 'master' ? [['master', 'Recall master']] : [['previous', 'Previous preset'], ['next', 'Next preset'], ['preset', 'Recall preset']]
        const choices = a.owner === 'master' ? state.masters.map(m => option(m.id, m.name, a.target)).join('') : roles.includes(a.owner) ? presetOptions(a.owner, a.target) : option('', '—', '')
        const disabled = a.owner === 'none'
        return `<tr data-row="${i}" data-owner="${a.owner}" class="${invalid.has(i) ? 'conflict' : ''}"><td><span class="switch-id">${String(a.switch).padStart(2, '0')}</span></td><td><select data-map="owner" aria-label="Switch ${a.switch} target">${['microphone', 'guitar', 'master', 'none'].map(role => option(role, roleName[role], a.owner)).join('')}</select></td><td><select data-map="action" aria-label="Switch ${a.switch} action"${disabled ? ' disabled' : ''}>${actions.map(([value, label]) => option(value, label, a.action)).join('')}</select></td><td><select data-map="target" aria-label="Switch ${a.switch} preset"${disabled || !['preset', 'master'].includes(a.action) ? ' disabled' : ''}>${['previous', 'next'].includes(a.action) ? option('', 'Preset order', '') : choices}</select></td><td><select data-map="type" aria-label="Switch ${a.switch} message type"${disabled ? ' disabled' : ''}>${option('cc', 'CC', a.type)}${option('pc', 'PC', a.type)}</select></td><td><input data-map="channel" type="number" min="1" max="16" value="${a.channel}" aria-label="Switch ${a.switch} channel"${disabled ? ' disabled' : ''}></td><td><input data-map="number" type="number" min="0" max="127" value="${a.number}" aria-label="Switch ${a.switch} message number"${disabled ? ' disabled' : ''}></td><td><input data-map="press" type="number" min="0" max="127" value="${a.press}" aria-label="Switch ${a.switch} CC press value"${disabled || a.type === 'pc' ? ' disabled' : ''}></td><td><button type="button" class="small" data-test-assignment="${i}"${disabled || dirty || invalid.size ? ' disabled' : ''}>Press</button></td></tr>`
    }).join('')}</tbody></table></div><div class="table-bottom"><span id="mapping-status" class="${invalid.size ? 'error-text' : 'muted'}">${invalid.size ? 'Resolve duplicate messages or values outside the MIDI range.' : dirty ? 'Unsaved changes · apply before testing switches.' : 'Assignments applied · press events are simulated; CC release is ignored.'}</span><button type="button" id="apply-assignments" class="primary"${invalid.size ? ' disabled' : ''}>Apply assignments</button></div><div class="assignment-footer"><div class="info-box"><h3>No fixed switch allocation</h3><p>Use all twelve for Guitar, reserve any number for Microphone, add master recalls, or leave switches unassigned.</p></div><div class="info-box"><h3>MIDI message conventions</h3><p>Channels: 1–16. CC and PC numbers: 0–127. CC actions match the configured press value. SysEx learning is outside this concept.</p></div></div>`
}

function cancelMaster() {
    if (!masterPending) return
    roles.forEach(role => { if (pending[role]?.group === 'master') { pending[role] = null; tokens[role]++ } })
    masterPending = null
}

function commitLane(role, target) {
    const old = state.active[role]
    const next = presetById(target)
    if (JSON.stringify(old) === JSON.stringify(next)) { pending[role] = null; return }
    if (state.spillover[role] && old.plugins.some(p => ['delay', 'reverb'].includes(p.type))) tails[role].push({ name: old.name, start: Date.now(), until: Date.now() + 8500 })
    state.active[role] = clone(next)
    pending[role] = null
    if (selected.role === role && !next.plugins.some(p => p.id === selected.id)) selected.id = next.plugins[0].id
}

function recallChain(role, target) {
    const p = presetById(target)
    if (!p || p.role !== role) return
    cancelMaster()
    const token = ++tokens[role]
    pending[role] = { target, phase: 'Preparing', group: 'chain' }
    render()
    setTimeout(() => {
        if (tokens[role] !== token) return
        pending[role].phase = 'Ready'
        render()
        setTimeout(() => {
            if (tokens[role] !== token) return
            commitLane(role, target)
            state.currentMaster = null
            saveState()
            render()
            notify(`${roleName[role]} → ${p.name}. ${roleName[roles.find(r => r !== role)]} keeps its preset.`)
        }, 250)
    }, 650)
}

function stepChain(role, direction) {
    const order = presetsFor(role)
    const from = pending[role]?.target || state.active[role].id
    const index = order.findIndex(p => p.id === from)
    recallChain(role, order[(index + direction + order.length) % order.length].id)
}

function recallMaster(id) {
    const m = state.masters.find(m => m.id === id)
    if (!m) return
    cancelMaster()
    masterPending = id
    const guards = {}
    roles.forEach(role => { guards[role] = ++tokens[role]; pending[role] = { target: m[role], phase: 'Preparing', group: 'master' } })
    render()
    setTimeout(() => {
        if (masterPending !== id || roles.some(role => tokens[role] !== guards[role])) return
        roles.forEach(role => { pending[role].phase = 'Ready' })
        render()
        setTimeout(() => {
            if (masterPending !== id || roles.some(role => tokens[role] !== guards[role])) return
            roles.forEach(role => commitLane(role, m[role]))
            state.currentMaster = id
            masterPending = null
            saveState()
            render()
            notify(`Master ${m.name} recalled: ${presetById(m.guitar).name} + ${presetById(m.microphone).name}.`)
        }, 250)
    }, 850)
}

function press(a) {
    if (a.owner === 'none') { notify(`Switch ${a.switch} is unassigned.`); return }
    if (a.owner === 'master') recallMaster(a.target)
    else if (a.action === 'previous') stepChain(a.owner, -1)
    else if (a.action === 'next') stepChain(a.owner, 1)
    else recallChain(a.owner, a.target)
}

function updateTails() {
    roles.forEach(role => {
        tails[role] = tails[role].filter(t => t.until > Date.now())
        const el = document.getElementById(`tails-${role}`)
        if (el) el.innerHTML = tails[role].map(t => `<span class="tail-chip"><span class="tail-wave"></span>${esc(t.name)} tail <span>${Math.ceil((t.until - Date.now()) / 1000)}s</span><span class="tag">Simulated</span></span>`).join('')
    })
}

function nameDialog(title, context, suggested, onSave) {
    document.getElementById('dialog-title').textContent = title
    document.getElementById('dialog-context').textContent = context
    document.getElementById('dialog-name').value = suggested
    dialogSave = onSave
    document.getElementById('name-dialog').showModal()
    document.getElementById('dialog-name').focus()
}

function saveCombination() {
    if (roles.some(role => pending[role])) { notify('Wait for the pending recall to finish before saving a combination.'); return }
    const dirty = roles.filter(role => JSON.stringify(state.active[role]) !== JSON.stringify(presetById(state.active[role].id)))
    if (dirty.length) { notify('Save or recall the edited chain first. A master stores saved preset references.'); return }
    nameDialog('Save current combination', `${state.active.guitar.name} + ${state.active.microphone.name}. References only; shared presets stay reusable.`, '', name => {
        const m = { id: `master-${Date.now()}`, name, guitar: state.active.guitar.id, microphone: state.active.microphone.id }
        state.masters.push(m)
        state.currentMaster = m.id
        masterId = m.id
        masterDraft = null
        saveState()
        render()
        notify(`Master ${name} saved with two preset references.`)
    })
}

function editLibrary(id) {
    libraryId = id
    libraryRole = presetById(id).role
    libraryDraft = null
    go('library')
}

function bindView() {
    const all = (selector, event, handler) => document.querySelectorAll(selector).forEach(el => el.addEventListener(event, e => handler(el, e)))
    const on = (id, event, handler) => document.getElementById(id)?.addEventListener(event, handler)
    all('[data-goto]', 'click', el => go(el.dataset.goto))
    all('[data-step]', 'click', el => stepChain(el.dataset.role, Number(el.dataset.step)))
    all('[data-recall]', 'change', el => recallChain(el.dataset.recall, el.value))
    const selectPlugin = el => { selected = { role: el.dataset.role, id: el.dataset.plugin }; render() }
    all('[data-plugin]', 'click', selectPlugin)
    all('[data-plugin]', 'keydown', (el, e) => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); selectPlugin(el) } })
    all('[data-edit-chain]', 'click', el => {
        const role = el.dataset.editChain
        const current = state.active[role]
        libraryId = current.id
        libraryRole = role
        libraryDraft = clone(current)
        go('library')
    })
    all('[data-spillover]', 'click', el => { state.spillover[el.dataset.spillover] = !state.spillover[el.dataset.spillover]; saveState(); render() })
    all('[data-setting]', 'input', el => {
        const node = state.active[selected.role].plugins.find(p => p.id === selected.id)
        node[el.dataset.setting] = Number(el.value)
        el.nextElementSibling.textContent = `${el.value}%`
        state.currentMaster = null
        saveState()
    })
    all('[data-setting]', 'change', () => render())
    on('active-model', 'change', e => { state.active[selected.role].model = e.target.value; state.currentMaster = null; saveState(); render() })
    all('[data-press]', 'click', el => press(state.assignments.find(a => a.switch === Number(el.dataset.press))))
    on('recall-master', 'click', () => recallMaster(document.getElementById('perform-master').value))
    on('save-combination', 'click', saveCombination)
    on('new-master', 'click', saveCombination)
    all('[data-filter]', 'click', el => { libraryRole = el.dataset.filter; libraryId = presetsFor(libraryRole)[0].id; libraryDraft = null; render() })
    all('[data-library]', 'click', el => { libraryId = el.dataset.library; libraryDraft = null; render() })
    on('preset-name', 'input', e => { libraryDraft.name = e.target.value })
    on('add-effect', 'change', e => {
        if (!e.target.value) return
        if (libraryDraft.plugins.length >= 7) { notify('This mockup displays up to seven effects per chain.'); e.target.value = ''; return }
        const type = e.target.value
        const name = { delay: 'Digital Delay', reverb: 'Hall Reverb', chorus: 'Chorus', eq: 'Parametric EQ' }[type]
        const added = plugin(name, type)
        added.id += '-' + Date.now()
        libraryDraft.plugins.push(added)
        render()
    })
    all('[data-remove-effect]', 'click', el => { libraryDraft.plugins.splice(Number(el.dataset.removeEffect), 1); render() })
    all('[data-move-effect]', 'click', el => { const i = Number(el.dataset.moveEffect); [libraryDraft.plugins[i - 1], libraryDraft.plugins[i]] = [libraryDraft.plugins[i], libraryDraft.plugins[i - 1]]; render() })
    on('library-save', 'click', () => {
        if (!libraryDraft.name.trim()) { notify('Enter a preset name before saving.'); return }
        const original = presetById(libraryId)
        libraryDraft.name = libraryDraft.name.trim()
        libraryDraft.revision = original.revision + 1
        state.presets[state.presets.findIndex(p => p.id === libraryId)] = clone(libraryDraft)
        saveState()
        render()
        notify(`Saved ${libraryDraft.name} revision ${libraryDraft.revision}. Playing chains keep their loaded revision until recall.`)
    })
    on('library-save-as', 'click', () => nameDialog('Save a new chain preset', 'Creates a separate definition. Existing master references stay attached to the original.', `${libraryDraft.name} copy`, name => {
        const copied = clone(libraryDraft)
        copied.id = `preset-${Date.now()}`
        copied.name = name
        copied.revision = 1
        state.presets.push(copied)
        libraryId = copied.id
        libraryDraft = null
        saveState()
        render()
        notify(`New preset ${name} saved.`)
    }))
    on('library-recall', 'click', () => recallChain(presetById(libraryId).role, libraryId))
    all('[data-open-master]', 'click', el => { masterId = el.dataset.openMaster; masterDraft = null; go('masters') })
    all('[data-master-select]', 'click', el => { masterId = el.dataset.masterSelect; masterDraft = null; render() })
    on('master-name', 'input', e => { masterDraft.name = e.target.value })
    roles.forEach(role => on(`master-${role}`, 'change', e => { masterDraft[role] = e.target.value; render() }))
    all('[data-edit-reference]', 'click', el => editLibrary(el.dataset.editReference))
    on('master-recall', 'click', () => { recallMaster(masterId); go('perform') })
    on('master-revert', 'click', () => { masterDraft = null; render() })
    on('master-save', 'click', () => {
        if (!masterDraft.name.trim()) { notify('Enter a master name before saving.'); return }
        const index = state.masters.findIndex(m => m.id === masterId)
        masterDraft.name = masterDraft.name.trim()
        state.masters[index] = clone(masterDraft)
        if (state.currentMaster === masterId && roles.some(role => state.active[role].id !== masterDraft[role])) state.currentMaster = null
        saveState()
        render()
        notify('Master references saved. Playing chains are unchanged until recall.')
    })
    all('[data-port]', 'change', el => {
        const role = el.dataset.port
        const other = roles.find(r => r !== role)
        if (el.dataset.field === 'input' && state.ports[other].input === el.value) { notify('Choose a different input for each independent chain.'); el.value = state.ports[role].input; return }
        state.ports[role][el.dataset.field] = el.value
        saveState()
    })
    all('[data-map]', 'change', el => {
        const i = Number(el.closest('tr').dataset.row)
        const a = switchDraft[i]
        const key = el.dataset.map
        a[key] = ['channel', 'number', 'press'].includes(key) ? (el.value === '' ? NaN : Number(el.value)) : el.value
        if (key === 'owner') {
            a.action = a.owner === 'master' ? 'master' : 'preset'
            a.target = a.owner === 'master' ? state.masters[0].id : roles.includes(a.owner) ? presetsFor(a.owner)[0].id : ''
        }
        render()
    })
    on('apply-assignments', 'click', () => {
        if (conflicts(switchDraft).size) return
        state.assignments = clone(switchDraft)
        saveState()
        render()
        notify('All twelve switch assignments applied to the demo.')
    })
    all('[data-test-assignment]', 'click', el => { press(state.assignments[Number(el.dataset.testAssignment)]); go('perform') })
}

document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => go(el.dataset.view)))
document.getElementById('reset-demo').addEventListener('click', () => {
    try { localStorage.removeItem(storageKey) } catch (e) {}
    location.href = location.href.split('?')[0]
})
document.getElementById('help-button').addEventListener('click', () => document.getElementById('help-dialog').showModal())
document.getElementById('dialog-cancel').addEventListener('click', () => document.getElementById('name-dialog').close())
document.querySelector('#name-dialog form').addEventListener('submit', e => {
    e.preventDefault()
    const name = document.getElementById('dialog-name').value.trim()
    if (!name) return
    document.getElementById('name-dialog').close()
    dialogSave?.(name)
})

if (new URLSearchParams(location.search).get('scenario') === 'spillover') {
    const old = state.active.guitar
    state.active.guitar = clone(presetById('g-lead'))
    state.currentMaster = null
    selected = { role: 'guitar', id: 'digital-delay' }
    tails.guitar.push({ name: old.name, start: Date.now(), until: Date.now() + 30000 })
}
render()
setInterval(updateTails, 250)

// Inspection surface for prototype verification; no production backend is invoked.
window.MockRig = {
    state: () => clone(state), pending: () => clone(pending), tails: () => clone(tails),
    recallChain, recallMaster, stepChain, conflicts, go
}
