# Collegamenti broker

> **Quando aprire questa guida** — chi tocca `components/settings/BrokerConnectionsSection.tsx`,
> `lib/utils/scalableImport.ts` (mapping puro), `lib/server/scalableCli.ts` (runner `sc`),
> `app/api/broker/scalable/read/route.ts`, `lib/services/brokerConnectionService.ts`
> (metadati `brokerConnections/{ownerId}`). File: `CLAUDE.md` → *Key Features* → *Collegamenti broker*.

## Collegamenti broker — sync in sola lettura da Scalable (`scalableImport.ts`, `scalableCli.ts`)

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
- **Il login è un device flow che il FRONTEND può mostrare** (`scalableLogin.ts` +
  `login/start` + `login/status`). Misurato prima di scriverlo: con stdout in pipe e stdin
  chiuso `sc login` stampa `https://secure.scalable.capital/activate?user_code=…` e il codice,
  poi attende. Quindi `human_only` in `sc capabilities` riguarda l'APPROVAZIONE, non il
  terminale. L'output arriva a CHUNK: il parser accumula e lo ri-matcha a ogni chunk, perché
  un `user_code=` spezzato in due letture non matcherebbe mai (`__tests__/scalableLogin.test.ts`).
  - **Il server deve essere SEMPRE ATTIVO.** Non è una preferenza: il processo figlio deve
    sopravvivere tra l'avvio e l'approvazione, e il token deve vivire in uno store persistente.
    Su Vercel/Lambda `assertLongLivedHost` rifiuta al click invece di half-working.
  - **Lo stato di una sessione non è leggibile da altri**: `getScalableLogin` esige
    `ownerId`, e una sessione d'altri risponde 404 come se non esistesse. Un riavvio del server
    la dimentica: la UI riavvia il flow invece di mostrare un errore.
  - **Il consenso resta a Scalable**: l'app non vede né riceve credenziali, mostra un link e un
    codice monouso. Il codice non viene loggato.
- **Una sola sessione per MACCHINA, e come si scala davvero** (2026-09-25). `sc` nel keyring ne
  tiene UNA: su un host condiviso due proprietari leggerebbero lo stesso conto broker. Per un
  deploy personale — il caso d'uso — va bene così.
  - **`sc logout` dopo ogni sync NON è la risposta**, ed è importante dirne il perché: la
    finestra di esposizione è la sync stessa (fra «sessione salvata» e logout, qualsiasi lettura
    in corso prende la sessione corrente), e si pretenderebbe un MFA — quindi un link — prima di
    ogni singola sincronizzazione.
  - **La risposta è `XDG_CONFIG_HOME` per owner + `[auth] session_backend = "file"` nella
    `config.toml`.** `sc` risolve la config da quella variabile e, con quel backend, sposta la
    sessione dal keyring a un file dentro la directory: una directory per owner dà a ciascuno
    sessione, chiave DPoP e refresh token PROPRI, il login si rinova da solo e il logout non
    serve più. Misurato su questo binario: con `XDG_CONFIG_HOME` vuoto l'errore è «The DPoP
    signing key … is missing» (sessione trovata nel keyring, chiave altrove); con
    `session_backend = "file"` diventa «No active session. Run 'sc login'» — il config è stato
    letto e lo store è un altro. Non ancora implementato.
  - **Costa tre cose, e una è un peggioramento**: un lock per macchina attorno a ogni
    invocazione di `sc` (il `session.lock` del binario non basta con più utente), la
    `config.toml` scritta al primo uso, e **permessi 0600 sulla directory** — un file su disco è
    più debole di un keyring. Per un server che deve per forza tenere i token è lo standard; su
    un desktop sarebbe un peggioramento che non ha senso fare.
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
- **Persistono solo i metadati.** `brokerConnections/{ownerId}` (rules come `budgets`: doc id =
  owner, `userId` coincidente) tiene quando/quante posizioni/cassa — mai token, mai output grezzo.
  La pagina resta senza verdetto: il tab Collegamenti è un form con due tile (sync + refresh login).
- **Il mapping del tipo broker è best-effort.** `mapScalableType` copre ETF/azioni/bond/fondi/crypto;
  l'ignoto cade su ETF azionario con `typeUncertain` — l'anteprima lo nomina, la correzione sta
  su Patrimonio. Stessa regola per il `taxRate` proposto (26%, 12,5% sui bond).

## Per-page blind spots

- **Collegamenti**: «Sincronizza» su un deploy ospitato risponde sempre 503 (manca `sc`) — è il
  degrado previsto, non un bug: il fallback incolla-JSON è la strada; con più portafogli la sync
  legge il contesto attivo (`sc broker context select` dal terminale); la liquidità può risultare
  negativa se i totali non quadrano — è il residuo dei totali broker, non un calcolo dell'app.
  Un utente SENZA conto overnight non deve perdere la sync: la terza lettura è separata e il suo
  fallimento compare come avviso, non come errore. Su Vercel anche «Ricollega Scalable» si
  rifiuta: il flusso è costruito per una VM, e il rifiuto è l'informazione utile.