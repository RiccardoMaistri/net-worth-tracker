# Collegamenti broker

> **Quando aprire questa guida** — chi tocca `components/settings/BrokerConnectionsSection.tsx`,
> `components/settings/broker/ScalableConnectionTile.tsx`,
> `components/settings/broker/TradeRepublicConnectionTile.tsx`,
> `lib/utils/scalableImport.ts` o `lib/utils/tradeRepublicImport.ts` (i mapping puri),
> `lib/server/scalableCli.ts` (runner `sc`), `lib/server/scalableService.ts` (profili per
> email, device flow, guard dell'host),
> `lib/server/tradeRepublicQr.ts` (handshake QR), `lib/server/tradeRepublicClient.ts` (sessione),
> `lib/utils/tradeRepublicSession.ts` (involucro della sessione), `app/api/broker/traderepublic/session`,
> `lib/server/qrImage.ts`,
> `app/api/broker/**`, `lib/services/brokerConnectionService.ts` (metadati
> `brokerConnections/{ownerId}/brokers/{broker}`) o `firestore.rules` (la match `brokerSessions`).
> File: `CLAUDE.md` → *Key Features* → *Collegamenti broker*.

## I due ponti, e cosa li distingue

- **Ogni broker è un componente e un modulo puri propri.** `BrokerConnectionsSection` possiede la
   pagina e nient'altro: due tile in una griglia `items-start`. Il resto — come si ottiene la
   sessione, cosa contiene il payload, quali cifre si possono scrivere — è diverso per broker, e
   accorparlo avrebbe prodotto un file da 700 righe con un `broker ===` in ogni ramo. La griglia
   usa `items-start` perché le due colonne hanno altezze diverse: senza, la più corta verrebbe
   stirata fino all'altezza della vicina. (La seconda tile della colonna Scalable — «Refresh
   login», le istruzioni da terminale — è stata rimossa quando il login è diventato un device
   flow guidato dal server: `sc login` non si fa più dal terminale dell'utente.)
- **La regola comune è UNA SOLA: una sync legge e non scrive.** Per Scalable è una whitelist di
  argv (`READ_COMMAND_ARGS`); per Trade Republic è una whitelist di topic (`TR_READ_COMMANDS`).
  Trade Republic NON ha una sessione «sola lettura» come la CLI di Scalable, quindi la garanzia è
  **strutturale** — l'elenco chiuso in `tradeRepublicClient.ts` — e non un'impostazione lato
  broker. Aggiungere un comando in quella lista è il cambio che questa guida vieta, esattamente
  come aggiungere un argv in quella.
- **Il doc id dei metadati è il broker, non l'owner** (`brokerConnections/{ownerId}/brokers/{broker}`).
  Con due broker servono due documenti per owner, e le rules non possono estrarre una sottostringa
  da un doc id composto: l'owner resta sul padre, così le rule sopra non si toccano. Il documento
  piatto dell'era mono-broker NON è migrato, di proposito: ogni campo che conteneva
  (`lastSyncAt`, i conteggi, gli id degli asset) lo riscrive la sync successiva, quindi si perderebbe
  solo il «quando» di una lettura passata.

## Trade Republic — sola lettura, collegamento con QR (`tradeRepublicImport.ts`, `tradeRepublicQr.ts`)

- **TRE differenze rispetto a Scalable, e ognuna è imposta dal broker.** Ognuna è una cosa che un
  lettore del tile Scalable scambierebbe per un bug:
  - **Il portafoglio NON porta i prezzi.** `compactPortfolioByType` restituisce
    `{ isin, averageBuyIn, netSize, virtualSize, status, instrumentType, name }` e niente di
    quotabile: Trade Republic quota un titolo come `ticker` su `ISIN.EXCHANGE` e il suffisso
    exchange NON è nel payload. Quindi il ponte **non cerca un prezzo**: i nuovi asset nascono con
    `autoUpdatePrice: TRUE` e li quota il path Yahoo di sempre. Indovinare un exchange metterebbe
    un prezzo sbagliato su un asset reale, che è peggio di un prezzo che arriva al cron dopo.
    Conseguenze: **il plan non ha un ramo prezzo** (i `kind` sono `new` / `drift-only` /
    `unchanged`, e `plan.stats` non ha `priceUpdateCount`) e la chiusura della narrazione NON dice
    «i prezzi si aggiornano».
  - **La cassa è un saldo REALE, non un residuo.** `valuation − securities − crypto` era l'unico
    modo di Scalable perché la sua overview non espone altro; Trade Republic pubblica il conto
    cassa stesso (`cash`, importi in unità **maggiori** — `projectCash` dell'SDK mappa `amount`
    verbatim, nessuna divisione per 100). Niente da sottrarre, e il saldo non può diventare
    negativo per aritmetica.
  - **I piani di accumulo sono una REGOLA, non un fatto.** Uno Sparplan non è una posizione né una
    transazione, e nessun campo di `Asset` lo contiene: sono **dichiarati** nell'anteprima (con
    l'asset che comprano, agganciato per ISIN) e **mai scritti**. Stessa postura del tasso del
    deposito Scalable.
- **Il prezzo lo riempie la route, tre sorgenti in ordine** (`withQuotes`). PRIMA il topic
  `ticker` del broker stesso (`readTrTickerQuotes`: `<ISIN>.LSX`, misurato live — TSLA 310,7 €,
  VWCE 169,44 €): autorevole, in EUR, senza mapping di simboli. POI Yahoo sul simbolo risolto,
  MAI sull'ISIN grezzo — Yahoo non quota un ISIN nudo (misurato su ISIN azionario ed ETF:
  nessuna quotazione), e quotare `holding.isin` non prezzava nulla: ogni posizione entrava a
  0 con G/P −100% per sempre, perché anche il refresh quota `asset.ticker` e anche lì trovava
  l'ISIN. Il simbolo Yahoo viene dalla tabella curata o dalla derivazione crypto
  (sotto) e viaggia su `holding.yahooTicker`, così il ticker scritto resta quotabile per ogni
  refresh futuro. Il prezzo si allega SOLO in EUR: una quotazione estera sotto la currency EUR
  leggerebbe come euro fino al primo refresh. Serve perché `AssetFormData.currentPrice` è
  obbligatorio: senza, un portafoglio sincronizzato nasce a 0 e il patrimonio dell'utente cala
  di tutto ciò che possiede. Il fallimento **non è fatale e non è silenzioso**: una quotazione
  mancante lascia `price` ASSENTE e il plan ne fa un avviso che nomina la posizione. Uno `0`
  lì sarebbe una lettura che il broker non ha mai dato.
  - **Il topic `ticker` è pubblico** (niente sessione) ma si legge dal client di sessione per
    riuso connessione; una quota che non arriva mai bloccherebbe la sync, quindi ogni
    strumento ha un timeout rigido (8s) e il miss è fail-open. Misurato: la hanging osservata
    in locale è il motivo del timeout, non un dettaglio.
  - **Crypto: lo pseudo-ISIN `XF000…` porta il codice della moneta** (`XF000BTC0017` → la
    posizione Bitcoin misurata su un conto reale, 2026-09-30). `resolveTrYahooTicker` ne deriva
    `BTC-EUR`, che Yahoo quota: il ticker scritto è quello, l'`isin` resta l'id broker per il
    match, e una re-sync ripara il ticker di un asset tracciato solo se è ancora il
    pseudo-ISIN grezzo (mai uno corretto a mano).
  - **Azioni/ETF: il simbolo Yahoo lo mette l'utente, nella riga dell'anteprima.** Indovinare
    il suffisso exchange metterebbe un prezzo sbagliato su un asset reale — la regola della
    sezione Scalable vale identica. L'avviso non promette più «si aggiornerà alla prossima
    quotazione» (falso: non sarebbe mai arrivata) ma dice dove scrivere il simbolo. Uno
    strumento davvero non quotato da nessuna parte resta a prezzo manuale per costruzione
    (SpaceX e Bending Spoons sembravano il caso, poi misurate quotate — `SPCX` e `BSP`).
- **Più saldi EUR sono PIÙ conti, mai una somma** (`parseTrCash` ritorna una LISTA). Il piano
  traccia il primo e **dichiara** gli altri per importo. La lezione Scalable (deposito ≠ liquidità)
  vale identica: due saldi presso un broker sono due conti, e sommarli li fonderebbe silenziosamente.
- **`amount` dei piani di accumulo è l'unica cifra non verificata** contro un account reale: l'SDK
  passa il valore del topic intatto (a differenza di `cash`, non ha un `projectMoney`), e il client
  web di Trade Republic lo manda in unità minori. Passa quindi da **UNA costante**
  (`SAVINGS_PLAN_MINOR_UNIT_DIVISOR`) e l'anteprima stampa la cifra calcolata, così un'assunzione
  sbagliata è visibile e non solo sbagliata. Non inlineare un `100` altrove.
- **`netSize`, non `virtualSize`.** `virtualSize` conta gli ordini non regolati: una vendita in
  attesa si leggerebbe come una posizione che l'utente non ha più. E uno `status` **non
  riconosciuto** mantiene la posizione: cancellare una posizione reale perché il broker ha
  rinominato uno stato è il fallimento peggiore qui, e sarebbe invisibile.
- **Il login è un QR e il FRONTEND lo mostra** (`tradeRepublicQr.ts` + `login/start` +
  `login/status`), misurato sull'API prima di scriverlo:
  `POST /api/v2/auth/web/login/qr-challenges` → `challengeId`; il poll su `qr-challenges/{id}`
  restituisce `qrCodePayload` (il payload da **codificare**, e **ruota** finché non viene
  scansionato: l'UI sostituisce l'immagine, non la congela) e poi `processId`; da lì il poll su
  `login/processes/{id}` finché non arriva il cookie `tr_session`.
  - **Il QR è una CREDENZIALE finché il challenge vive**, quindi è reso in immagine **sul server**
    (`qrImage.ts`) e al browser viaggia solo la `data:` URL. Il payload è comunque mostrato come
    testo accanto all'immagine: un QR richiede un **secondo dispositivo**, e chi legge da telefono
    non può scansionare lo schermo che ha davanti.
  - **La sessione SOPRAVVIVE al riavvio** (`brokerSessions/{ownerId}`, solo Admin SDK, rules
    `allow read, write: if false`). È la differenza vera rispetto a Scalable: lì la sessione sta
    nel keyring della macchina e un riavvio la dimentica; qui è un documento, e i cookie che
    l'SDK rinnova vengono riscritti dopo ogni lettura (`persistRefreshedSession`). L'in-flight
    vive invece in memoria e un riavvio lo dimentica → 404 → l'UI riavvia il flusso.
  - **Il jar è unito per NOME**: il broker ri-emette `tr_session` durante l'handshake e deve
    vincere il valore più recente, altrimenti il poll ripropone per sempre il cookie
    pre-approvazione. Il traguardo sono **ENTAMBI** i cookie, `tr_session` **e** `tr_refresh`:
    l'SDK rifiuta un restore senza il secondo (non può rinnovare senza) e anche il suo login
    li controlla entrambi. Fermarsi al primo avrebbe salvato una sessione leggibile una volta e mai
    rinnovabile — un fallimento che l'utente avrebbe incontrato alla prima sync, senza indizi.
  - **L'involucro della sessione sta in `lib/utils/tradeRepublicSession.ts`, non nel modulo server**,
    per un motivo misurato: `version` è il **NUMERO** `1`. Lo schema dell'SDK è
    `type({ version: "1", cookies: "string[]" })` e in **arktype un letterale numerico tra apici è
    un numero**, quindi la forma stringa è rifiutata con «version must be 1 (was "1")». Scriverla
    come `"1"` ha prodotto «Invalid exported Session» alla **prima sync**, molto dopo che il login
    QR era riuscito e aveva salvato una sessione perfettamente valida. `parseTrSession` tollera la
    forma legacy e la riscrive: quei cookie sono buoni e obbligare a riscanire un QR per riparare
    un dettaglio di serializzazione sarebbe il consiglio sbagliato. Il test asserisce contro
    `TRClient` vero, non contro un commento.
  - **Una sessione che l'SDK rifiuta è una sessione MORTA**, non un errore inatteso: il costruttore
    la parla e può buttare, quindi `buildClient` la traduce in «ricallegati» (401). Non tralasciata,
    la stessa cosa arrivava come 500 con dentro il messaggio di arktype.
  - **Per UTENTE, non per macchina** (a differenza di `sc`): ogni entry porta il proprio jar, quindi
    due proprietari di uno stesso host non condividono la sessione. `getTrLogin` esige `ownerId` e
    una sessione d'altri è un 404, non uno stato — altrimenti un utente qualsiasi potrebbe vedere
    il QR di un altro.
  - **Il WAF è dichiarato, non nascosto.** Tre client Trade Republic alternativi girano un browser
    headless solo per un `x-aws-waf-token`; questo modulo non lo chiede, perché nemmeno il path
    telefono+PIN dell'SDK ne ha bisogno. **Se gli endpoint QR siano protetti non è stato verificabile
    da qui**: un 403 con challenge WAF diventa quindi `TradeRepublicWafError`, con parole sue e uno
    status proprio, perché il rimedio (un passo col token) è un altro lavoro e l'utente deve poterlo
    dire. Non è un errore di credenziali e non si risolve ritentando.
- **Il salvataggio scrive solo asset nuovi e la cassa.** Nessun prezzo (non letto), nessuna
  quantità (è del Registro), nessun piano di accumulo (una regola del broker).
- **Le OPERAZIONI sono un'importazione a parte, e la tassa che il broker trattiene viaggia con
  loro** (2026-10-05): `POST /api/broker/traderepublic/trades` è `{ownerId}` → anteprima (nessuna
  scrittura) e `{ownerId, apply:[…]}` → scrive le righe approvate, una per una, ogni riga attraverso
  `createAssetTransaction` (la sync del portafoglio resta sola lettura e non tocca il registro).
  Il `timelineDetailV2` **ha** una cella `Tax` sulle vendite 2026 — 10 su 10, la KESt tedesca esce
  alla fonte — e non sulle 11 dell'archivio pre-2024 su cui era stato scritto il contrario: la
  contraddizione era nel docstring, non nel payload. `lordo − fee − tax = Total` è l'identità che il
  broker really salda, e senza la `Tax` il registro accrediterebbe 659,97 € in più di quanto sia
  uscito dal conto nel 2026. Il `Gain`/`Profit` del broker NON si importano (il costo è del PMC,
  doc/guide/registro-operazioni.md). **La valuta del broker viaggia con il prezzo** (`priceCurrency`,
  doc/guide/registro-operazioni.md): il venue regola in EUR qualunque sia il titolo, e senza quella
  riga l'iscrittura leggeva il prezzo come nativo e lo riconverteva — misurato sull'account reale,
  €996,10 finiti a €869,12. **E il nome del broker diventa la nota della vendita**, perché una riga
  del registro non ha un nome proprio e quella di un asset cancellato leggeva «Strumento rimosso».
  **Una riga già importata non si corregge**: l'idempotenza è sulla coppia broker+id, quindi tassa,
  prezzo e nome si sistemano a mano dalla finestra Movimenti.

##Collegamenti broker — sync in sola lettura da Scalable (`scalableImport.ts`, `scalableCli.ts`)

- **L'app non parla mai con Scalable: parla con `sc`, e solo in locale.** Il login OAuth
  (device flow) e la sessione vivono nel keyring della macchina dell'utente, dove solo il
  binario `sc` li raggiunge. La route esegue con `execFile` (niente shell) TRE argv fissi —
  `broker holdings --json`, `broker overview --json` e `overnight --json` — e nessun campo
  della request tocca mai la riga di comando. Su un deploy ospitato il binario manca: la route
  risponde 503 e il tile offre il fallback incolla-JSON, che usa gli STESSI parser puri.
- **Solo lettura, per costruzione.** La whitelist è l'intera superficie eseguibile
  (`READ_COMMAND_ARGS` in `lib/server/scalableCli.ts`): aggiungere un comando di scrittura
  lì dentro è il cambio che questa guida vieta. `sc login --local-read-only` è l'unico argv
  fuori dalla superficie di LETTURA (`SCALABLE_LOGIN_ARGS`, stesso file) e non è una scrittura
  verso il broker: scrive una sessione nel keyring di questa macchina e non legge nulla
  dall'account. Il `--local-read-only` non è opzionale — è ciò che rende una sessione rubata
  incapace di ordinare, quindi solo di leggere.
- **Il login è un device flow che il FRONTEND può mostrare** (`ScalableService` +
  `login/start` + `login/status`). Misurato prima di scriverlo: con stdout in pipe e stdin
  chiuso `sc login` stampa `https://secure.scalable.capital/activate?user_code=…` e il codice,
  poi attende. Quindi `human_only` in `sc capabilities` riguarda l'APPROVAZIONE, non il
  terminale. L'output arriva a CHUNK: il parser accumula (`output += chunk`) e lo ri-matcha a
  ogni chunk, perché un `user_code=` spezzato in due letture non matcherebbe mai
  (`__tests__/scalableService.test.ts`, casi chunk-splitting).
  - **Il server deve essere SEMPRE ATTIVO.** Non è una preferenza: il processo figlio deve
    sopravvivere tra l'avvio e l'approvazione, e il token deve vivere in uno store persistente.
    Su Vercel/Lambda `assertLongLivedHost` (in `scalableService.ts`) rifiuta al click — la
    route lo risponde come 503 con «Anteprima dal testo» come rimedio — invece di half-working.
  - **Lo stato di una sessione non è leggibile da altri**: `getLoginSession` esige il
    PROFILO, e una sessione d'altri risponde 404 come se non esistesse. Un riavvio del server
    la dimentica: la UI riavvia il flow invece di mostrare un errore.
  - **Il consenso resta a Scalable**: l'app non vede né riceve credenziali, mostra un link e un
    codice monouso. Il codice non viene loggato.
- **Una sessione per EMAIL, non per macchina** (dal 2026-09-28; prima: una sola nel keyring).
  Ogni email in `SCALABLE_PROFILES` ottiene un profilo e un `XDG_CONFIG_HOME` proprio
  (`…/profiles/<profilo>`): `sc` risolve la config da quella variabile e, con
  `[auth] session_backend = "file"` nella `config.toml` (scritta al primo uso, un solo
  scrittore: `runScalableReadCommand`), sposta sessione, chiave DPoP e refresh token dal
  keyring a un file dentro la directory. Il login si rinnova da solo e il logout non serve
  più. Misurato su questo binario: con `XDG_CONFIG_HOME` vuoto l'errore è «The DPoP
  signing key … is missing» (sessione trovata nel keyring, chiave altrove); con
  `session_backend = "file"` diventa «No active session. Run 'sc login'» — il config è stato
  letto e lo store è un altro.
  - **Chi può sincronizzare è config di deploy, non codice**: `SCALABLE_PROFILES`
    (`profilo:email,…`, server-only, mai `NEXT_PUBLIC_`). Il profilo diventa un segmento di
    path, quindi il parser accetta solo `[A-Za-z0-9_-]`. Senza la variabile, ogni chiamata al
    ponte risponde 403. Vedi SETUP.md § 4b.
  - **`sc logout` dopo ogni sync NON è la risposta**, ed è importante dirne il perché: la
    finestra di esposizione è la sync stessa (fra «sessione salvata» e logout, qualsiasi lettura
    in corso prende la sessione corrente), e si pretenderebbe un MFA — quindi un link — prima di
    ogni singola sincronizzazione.
  - **Il file su disco è più debole di un keyring** (directory 0700, config 0600): per un
    server che deve per forza tenere i token è lo standard; su un desktop sarebbe un
    peggioramento che non ha senso fare.
  - **Bonus non previsto: risolve anche il deploy headless.** `session_backend = "file"` è la
    strada documentata quando il keyring D-Bus non esiste, quindi la stessa impostazione rende
    utilizzabile la sync su una VM senza keyring.
- **Un comando, un payload, nella sua chiave** (`{ holdings, skipped }` · `{ overview }` ·
  `{ overnight }`), mai un `plan`: il piano lo compone il client, che ha già gli asset
  tracciati. La route ha risposto `{ plan }` per `holdings`/`overview` mentre il client leggeva
  `res.holdings`/`res.overview`: due chiavi `undefined`, silenziosamente diventate `[]`/`null`
  dal `??` del client, e l'anteprima mostrava ZERO posizioni e NESSUNA liquidità dichiarando
  sincronizzazione riuscita. La forma della risposta è bloccata da
  `__tests__/scalableReadRoute.test.ts`, e il client rifiuta una chiave mancante invece di
  defaultedarla a zero.
- **La quantità dei tipi ledger non si scrive mai.** `quantity`/`averageCost` di
  stock/etf/bond/crypto/commodity sono del Registro (replay): la sync aggiorna solo
  `currentPrice` via `updateAssetMetadata` e riporta lo scostamento come avviso da
  riconciliare con una rettifica (`quantityDrift` nel plan, mai una write). I nuovi asset
  nascono con `autoUpdatePrice: false` e `ticker` = ISIN — il prezzo lo porta la sync, non Yahoo.
- **La liquidità è un residuo, e va detto.** `valuation − securitiesValuation − cryptoValuation`
  dall'overview è la stima di cassa (`resolveScalableCashBalance`); il conto di destinazione
  lo sceglie l'utente (esistente o «Scalable — Liquidità», mai assegnato in silenzio).
- **Il deposito non vincolato NON è la liquidità broker** (2026-09-25, misurato: cassa broker
  120,00 € contro un deposito di 59.201,61 €). `sc overnight --json` legge un saldo separato,
  che la valuation del broker NON contiene: i due non si sommano mai e non si fondono in un
  conto solo. Ogni cifra ha il suo conto («Scalable — Liquidità» / «Scalable — Deposito»,
  `SCALABLE_CASH_TICKER` / `SCALABLE_DEPOSIT_TICKER`).
  - **L'identità dei due conti è il `ticker` scritto, non il nome né il `exchange`**: l'utente
    può rinominare un conto, e un match per nome (o per il `exchange: 'Scalable Capital'`
    condiviso) creerebbe un duplicato alla sync successiva.
  - **Il rendimento e la data di pagamento sono DICHIARATI, non scritti**: nessun campo di
    `Asset` tiene un tasso, e un cash asset non accresce nulla da solo. L'anteprima li mostra e
    dice che restano nel broker.
  - **Una lettura overnight fallita non è un deposito azzerato**: la `Promise.all` della sync la
    tiene FUORI apposta, così posizioni e cassa si sincronizzano comunque e l'anteprima dichiara
    («Deposito non vincolato non letto: …») invece di mostrare uno zero. `plan.deposit` è `null`
    quando non è stato letto, e un saldo 0 letto davvero resta uno zero da sincronizzare.
- **Persistono solo i metadati.** `brokerConnections/{ownerId}/brokers/{broker}` (rules
  sull'owner del padre, `userId` e `broker` coincidenti con il path) tiene quando/quante
  posizioni/cassa — mai token, mai output grezzo. La pagina resta senza verdetto: il tab
  Collegamenti è un form con due tile (una per broker, solo sync).
- **Le letture riuscite vivono 60 secondi in memoria, per profilo.** Il secondo
  «Sincronizza» entro un minuto rilegge la cache, non il broker — voluto (una sync sono tre
  spawn di CLI), ma la cache è per PROCESSO: su un deploy con più istanze ogni istanza ha la
  sua. Una lettura OVERNIGHT fallita non entra mai in cache: il fallimento non è una lettura,
  e la sync successiva riprova.
- **Il mapping del tipo broker è best-effort.** `mapScalableType` copre ETF/azioni/bond/fondi/crypto;
  l'ignoto cade su ETF azionario con `typeUncertain` — l'anteprima lo nomina, la correzione sta
  su Patrimonio. Stessa regola per il `taxRate` proposto (26%, 12,5% sui bond).

## Per-page blind spots

- **Collegamenti**: «Sincronizza» su un deploy ospitato risponde sempre 503 (manca `sc`) — è il
   degrado previsto, non un bug: il fallback incolla-JSON è la strada; con più portafogli la sync
   legge il contesto attivo del PROFILO (`sc broker context select` con l'`XDG_CONFIG_HOME` del
   profilo, non dal terminale dell'utente — il login ormai avviene lì); la liquidità può risultare
  negativa se i totali non quadrano — è il residuo dei totali broker, non un calcolo dell'app.
  Un utente SENZA conto overnight non deve perdere la sync: la terza lettura è separata e il suo
  fallimento compare come avviso, non come errore. Su Vercel anche «Ricollega Scalable» si
  rifiuta: il flusso è costruito per una VM, e il rifiuto è l'informazione utile. Trade Republic ha
  lo stesso `assertTrLongLivedHost` e lo stesso motivo.
- **Trade Republic**: i prezzi NON vengono dalla sync e la pagina non lo promette — se una posizione
  entra a 0 è perché Yahoo non l'ha quotata, e l'avviso la nomina. Uno Sparplan in pausa compare
  due volte (nel testo e nella colonna) per non poterlo distinguere a colpo d'occhio. Il secondo
  saldo EUR non viene sommato: se ti serve, creane il conto a parte. E un piano di accumulo qui è
  solo DICHIARATO: l'app non lo usa per calcolare la spesa futura, quindi non aspettarti che
  compaia nel Cashflow o nel piano FIRE.