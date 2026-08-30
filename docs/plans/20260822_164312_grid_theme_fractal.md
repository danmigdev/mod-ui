# Nuovo tema "Grid" per mod-ui (stile Fractal Audio)

## Contesto

Il tema di default di mod-ui (`index.html` + `pedalboard.js` + `desktop.js` + `dashboard.css`) usa un canvas libero: ogni plugin è disegnato con la propria skin custom (modgui) a dimensione variabile, posizionato liberamente, collegato con cavi trascinati a mano tra jack fissi; gli I/O hardware sono spine fisse ai lati del canvas. L'utente vuole un **secondo tema, completamente indipendente**, ispirato all'editor Fractal Audio FM3-Edit (screenshot fornito): griglia con righe/colonne configurabili, blocchi plugin di dimensione uniforme, I/O hardware come blocchi nella griglia (non spine fisse), catena lineare con cavo unico auto-disegnato tra i blocchi, e parametri del plugin mostrati in un pannello in basso (non in dialog) diviso in due: sinistra = skin reale del plugin, destra = lista generica di tutti i parametri.

Esisteva un tentativo precedente (2 agosto) che aveva patchato i 4 file core con una "grid mode" mista al tema esistente (413 righe aggiunte a `pedalboard.js`, classi in `dashboard.css`, script Python di supporto in root). L'utente ha confermato: pulire tutto e ripartire da zero come tema separato, riusando però il codice/infrastruttura esistente dove ha senso (non reinventare comunicazione col backend, rendering skin plugin, ecc.).

## Pulizia preliminare

1. `git checkout -- html/css/dashboard.css html/index.html html/js/desktop.js html/js/pedalboard.js` — ripristina i 4 file core alla versione HEAD.
2. Rimuovere i file non tracciati residui del tentativo precedente: `add_makeport.py`, `add_movable.py`, `apply_fixes.py`, `deploy_to_device.py`, `fix_grid_device.py`, `grid_methods_only.js`, `grid_only.css`, `port_grid_to_modep.py`, `html/css/dashboard_modep_grid.css`, `html/css/dashboard_original_modep.css`, `html/index_original_modep.html`, `html/js/desktop_modep_grid.js`, `html/js/desktop_original_modep.js`, `html/js/pedalboard_modep_grid.js`, `html/js/pedalboard_original_modep.js`.

## Architettura: cosa si riusa, cosa è nuovo

Il tema di default è troppo accoppiato (desktop.js pilota decine di dialog/menu specifici del DOM di index.html: banks, snapshot, file manager, cloud store, ecc.) per essere riusato "as-is" sotto un DOM completamente diverso. La scelta più solida è: **nuovo controller leggero e nuovo widget di rendering**, ma che parlano lo stesso protocollo REST/WS del backend e riusano i moduli di libreria condivisi così come sono.

**Riusato senza modifiche:**
- `mod/webserver.py` → `TemplateHandler` già serve qualunque `html/<nome>.html` via regex `r"/([a-z]+\.html)$"` (webserver.py:2380) e chiama `getattr(self, section)()` per il contesto. Basta aggiungere un metodo `grid(self)` che restituisce lo stesso contesto di `index()` (estrarre la logica comune in un helper condiviso).
- Endpoint REST esistenti: `GET /effect/add/<instance>?x=&y=&uri=`, `GET /effect/remove/<instance>`, `GET /effect/connect/<from>,<to>`, `GET /effect/disconnect/<from>,<to>`, `GET /effect/list`, `GET /effect/get?uri=&version=&plugin_version=`, `POST /effect/parameter/set/`.
- `html/js/modgui.js` **interamente**: `GUI(effect, options)` + `.render(instance, callback)` costruisce la skin (`icon`) e non la aggancia da nessuna parte — è il chiamante ad appenderla (oggi `pedalboard.js:1750` la mette sul canvas). Per il pannello sinistro nuovo basta chiamare `.render()` e appendere `icon` dentro il proprio div invece che sul canvas: zero modifiche a modgui.js.
- `gui.setPortValue(symbol, value, source)` / `gui.lv2PatchSet(uri, valuetype, value, source)` per scrivere i parametri (stessa via usata dalla skin, incluso bypass = port sintetica `:bypass`).
- Il meccanismo `port.widgets.push(control)` + fabbrica `$.fn.controlWidget` (modgui.js:1770+): per tenere sincronizzato il pannello generico di destra con cambi esterni (MIDI/HMI/altri client), si registra un widget leggero custom nello stesso array `port.widgets` così `setPortWidgetsValue` lo aggiorna automaticamente, esattamente come fa già per i controlli della skin — nessun bisogno di reinventare la sincronizzazione.
- Font (`css/fonts.css`, famiglia `Ek Mukta`) e librerie già incluse (jQuery, jQuery UI, Mustache) — stesso `<link>`/`<script>` in `grid.html`.
- Struttura dati hardware già disponibile lato server via `get_hardware_descriptor()` (usata da `index()`, webserver.py:1788): stesso dato riusabile per generare i blocchi "In N"/"Out N", con symbol `/graph/capture_N` / `/graph/playback_N` come già fa `createHardwarePorts` in `pedalboard.js`.

**Nuovo (da scrivere):**
- `html/grid.html` — pagina indipendente, markup proprio (header minimale, area griglia, toolbar righe/colonne, pannello inferiore a due colonne).
- `html/css/grid-dashboard.css` — foglio di stile nuovo, palette scura ispirata allo screenshot; riusa i design token del tema esistente dove hanno senso (sfondo scuro `#111`/`#0d0d0d`, pannelli `#222`/`#2b2b2b`, bordi `#444`, radius 3–6px) invece di inventarne di nuovi da zero.
- `html/js/grid-app.js` — controller: bootstrap pagina, WebSocket (stesso protocollo di `host.js` ma gestore proprio, più piccolo: solo `add/remove/connect/disconnect/param_set/patch_set/output_set`), chiamate REST dirette per add/remove/connect/save, gestione stato griglia (righe/colonne/occupazione celle), toolbar +/- righe/colonne.
- `html/js/grid-board.js` — rendering canvas a griglia: blocco uniforme per plugin (nome + colore categoria + LED bypass, nessun controllo interattivo nel blocco), blocchi I/O hardware come celle di bordo, cavo singolo auto-disegnato tra blocchi adiacenti nell'ordine della catena (nessun drag-cavo manuale).
- `html/js/grid-params.js` — pannello inferiore: sinistra monta la skin reale via `new GUI(...).render(...)` (append nel proprio div); destra genera controlli uniformi (slider/toggle/enum a bottoni) per **tutti** i control port + parametri patch, letti da `pluginData.ports`/`pluginData.parameters` (min/max/default/`properties` come `toggled`/`integer`/`enumeration`/`logarithmic`, `scalePoints`), collegati a `gui.setPortValue`/`gui.lv2PatchSet` e registrati in `port.widgets` per la sincronizzazione.
- Mappa colore-per-categoria nuova (non esiste nel codebase attuale): palette per `Delay, Distortion, Dynamics, Filter, Modulator, Reverb, Simulator, Utility, Generator, ...` (categorie già usate da `effects.js` per il browser plugin).

## Meccanica griglia

- Stato: `{cols, rows, cellSize (fisso, uguale per tutti i plugin — non calcolato dal plugin più grande come nel tentativo precedente), occupancy{ "col_row": instance }}`.
- Toolbar +/- righe e +/- colonne: rimozione bloccata se l'ultima riga/colonna contiene un blocco occupato (stesso guard-check dell'idea originale, riscritto pulito).
- Aggiunta plugin: dal browser esistente (riuso dati/ricerca di `effects.js`) trascinato o cliccato in una cella libera → `GET /effect/add/...` con `x,y` derivati da `(col,row) * cellSize`.
- Catena/segnale: **lineare**, ordine = posizione nella griglia (lettura riga per riga, come In1→Comp→Amp→...→Out1 nello screenshot). Il "cavo" tra due blocchi adiacenti è sempre una singola linea grafica, indipendentemente dal fatto che la connessione reale sottostante sia mono/stereo/multipla porta — la connessione reale viene comunque creata via `/effect/connect` per ciascuna coppia di porte audio compatibili tra i due plugin adiacenti.
- I/O hardware: blocchi come qualunque altro elemento della griglia (colonna iniziale = ingressi hardware, colonna finale = uscite), non elementi fissi ai lati del canvas.

## Fuori scope per la v1 (restano solo nel tema di default)

Bank management, snapshot/preset UI, cloud plugin store, file manager, gestione dispositivi MIDI/control-chain, tuner/tap tempo, condivisione social, dialog termini/upgrade. L'utente passa a `/` per queste funzioni; il tema griglia si concentra su: costruire/modificare la pedalboard corrente, editare parametri, salvare.

## File toccati/creati (riassunto)

- Ripristinati: `html/css/dashboard.css`, `html/index.html`, `html/js/desktop.js`, `html/js/pedalboard.js`
- Rimossi: script/file scratch elencati sopra
- Modificato: `mod/webserver.py` (nuovo metodo `grid()` in `TemplateHandler`, refactor minimo per condividere il contesto con `index()`)
- Nuovi: `html/grid.html`, `html/css/grid-dashboard.css`, `html/js/grid-app.js`, `html/js/grid-board.js`, `html/js/grid-params.js`

## Verifica

1. Avviare il backend mod-ui locale (comando di avvio esistente del progetto) e aprire `http://<host>/index.html?v=...` per confermare che il tema di default funziona esattamente come prima del cleanup (nessuna regressione).
2. Aprire `http://<host>/grid.html?v=...`: verificare caricamento pagina, connessione WebSocket, lista plugin disponibile.
3. Aggiungere 2-3 plugin in celle diverse, verificare che appaiano come blocchi uniformi colorati per categoria.
4. Cliccare un blocco: verificare che il pannello in basso mostri la skin reale a sinistra e i controlli generici a destra, che muovere uno slider a destra sposti anche il controllo nella skin a sinistra (e viceversa).
5. Aggiungere/rimuovere righe e colonne dalla toolbar, verificare il blocco della rimozione quando l'ultima riga/colonna è occupata.
6. Verificare che i blocchi In/Out hardware compaiano come blocchi di griglia e che la catena si ricolleghi correttamente quando si sposta un plugin in una nuova posizione della griglia.
7. Salvare la pedalboard e ricaricare la pagina: verificare che la disposizione a griglia venga ripristinata.
