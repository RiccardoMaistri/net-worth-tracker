# Valutazione merge upstream `v12.0.0`

- **Data**: 2026-11-27
- **Sorgente**: tag [`v12.0.0`](https://github.com/GiuseppeDM98/net-worth-tracker/releases/tag/v12.0.0) del repo `GiuseppeDM98/net-worth-tracker` (`843583db`, 24 novembre 2026)
- **Destinazione prevista**: nuovo branch da `main` (per scelta esplicita: solo report e piano, nessun merge/commit)
- **Stato del checkout**: `main` pulito a `e6c703ef` (merge PR #27 `okx-bridge-2`), tracking `origin/main`
- **Nota**: è stato aggiunto solo il remote `upstream` a `.git/config`; il worktree di prova è stato rimosso

## 1. Contesto e numeri

| Elemento | Valore |
| --- | --- |
| Merge base `main` ↔ `v12.0.0` | `22020f2bf8e90022fcc5fbedd5c7c587c4835214` (8 ottobre 2026) |
| Diff `main...v12.0.0` | 1.187 file, +149.807 / −15.760 righe |
| Voci del release notes | 131 |
| File toccati da `main` dalla base | 237 |
| File in comune con upstream | 86 |
| Conflitti stimati da `main` | 52 |
| Conflitti da `feat/costi-inflazione` | 64 |
| Conflitti da `feat/expense-halve` | 55 |
| Conflitti da `okx-poc` | 52 |
| `upstream/main` | `82973d95` (escluso: contiene DATI-08, DATI-09, cache, E2E parallelo) |
| `upstream/develop` | `590e00dc` |

Verifica con `git grep` sul tag: **nessuna** delle feature locali è già presente upstream (`okx`, `monthlyIncome`/`incomeOverride`, dimezzamento spese, `costDrag`/HICP assenti). Vanno quindi riapplicate a mano: non basta scegliere “ours” o “theirs”.

## 2. Verdetto sintetico

Il tag è un aggiornamento molto grande (~150 feature/fix) che riscrive buona parte dell’UI. Le aree a rischio per le modifiche locali sono:

1. `app/dashboard/cashflow/page.tsx`: i 539 righe locali contro il wrapper upstream di 2 righe (`CashflowPageClient`).
2. `types/assets.ts`: i tipi locali `fund` e `crowdfunding` contro il nuovo `loan` upstream.
3. Savings rate: la regola locale (reddito fisso + override mensili) contro quella upstream (entrate registrate, floor −100%).
4. `ExpenseTable` / `TransactionFeed` / `dialogNarrative`: stessi file del dimezzamento spese.
5. `firestore.rules`: regole locali `monthlyIncomeOverrides`, ledger/tombstone Trade Republic + nuove collection upstream (dailySnapshots, accumulo, Consulente).
6. `package.json`: pin locali Next `16.4.6` e `yahoo-finance2 ^4.0.2` contro `^16.4.6` e `^3.13.2` upstream.

## 3. Le 131 funzionalità del tag, raggruppate

I numeri seguono l’ordine di estrazione dal release notes.

### 3.1 Temi, font e identità visiva — voci 1, 9, 48, 52, 72, 93, 95, 100, 123

- **1** — Orbita: ottavo tema (spazio profondo + ambra), tessere quadrate e barra di riepilogo in Panoramica.
- **9** — L’“anello” (grafico a ciambella) accanto alle righe che sono parti di un tutto: categorie, composizione, previdenza.
- **48** — Egeo: settimo tema (marmo, mare, oro), con sfondo e tessere incise.
- **52** — Font Geist Sans al posto del font di sistema.
- **72** — Barra del browser colorata coerentemente col tema scuro (`theme-color`).
- **93** — I due temi “costume” vestono anche dialog, drawer e altre nove pagine.
- **95** — Anteprime dei temi con i colori reali, non approssimati.
- **100** — Nome dell’app uniforme in scheda, sidebar, login e landing: «Net Worth Tracker».
- **123** — Spazio ridotto tra numero e «€» in tutti i verdetti.

### 3.2 Composizione mobile/tablet, navigazione e touch — voci 19-33, 58, 102, 117, 118, 121, 122, 131

- **19** — Regola generale: sotto `desktop:` le tessere non si impilano più in una colonna infinita.
- **20** — Colonna di icone a sinistra su tablet orizzontale, al posto della barra superiore.
- **21** — Panoramica: tre cifre toccabili («Questo mese», «Da inizio anno», «Messo da parte»).
- **22** — Patrimonio: verdetto, plusvalenza e quote dei conti come celle apribili.
- **23** — Tracciamento: periodo + entrate/spese/risparmio come tre celle.
- **24** — Budget: «Fine mese» e residuo/sforamento come due celle.
- **25** — Centri di Costo: totale aperto, altre tessere chiuse e memorizzate.
- **26** — Divisione: una cella per persona, più la parte «in calendario» separata.
- **27** — Dividendi: nessuna cifra sotto il titolo (ricevuti e annunciati restano distinti).
- **28** — Analisi ricomposta su «Dove vanno i soldi», spese ad anello per tipo.
- **29** — Rendimenti: periodo e rendimento non annualizzato, con range custom a icona calendario.
- **30** — Storico: verdetto, ultimi 12 mesi e risparmio dell’anno toccabili.
- **31** — Hall of Fame: verdetto, «Quest’anno», entrate e risparmio record.
- **32** — Allocazione: verdetto e «Fuori posizione», tessere secondarie chiuse.
- **33** — Previdenza: anno fiscale + mercato/datore/fisco come celle.
- **58** — Segni delle scelte nei percorsi guidati allineati all’etichetta.
- **102** — Tutti i dropdown diventano bottom sheet su phone/tablet.
- **117** — «Crea snapshot», periodi del grafico e icona impostazioni: target da 44px.
- **118** — Pulsante menu su telefono ruotato: 44px invece di 28px.
- **121** — Landing: curva dell’hero più corta su schermi piccoli.
- **122** — Pill delle sezioni di Cashflow/FIRE/Impostazioni: 44px.
- **131** — Documentazione: regole della composizione mobile in DESIGN.md e guide.

### 3.3 Allocazione › Accumulo / piano di accumulo — voci 2, 3, 5, 6, 7, 15, 16, 53-57, 59, 96, 97

- **2** — Percorso guidato di 8 schermate per creare un PAC a mano.
- **3** — «Rivedi il piano» apre lo stesso percorso, non la vecchia finestra a 3 step.
- **5** — «Vendi a» su ogni vendita: il ricavato entra solo dal mese della vendita.
- **6** — Terzo conto predefinito, quello da cui attinge il piano.
- **7** — «Applica» del Consulente crea anche il piano attivo in un solo click.
- **15** — Nuova tab «Accumulo» in Allocazione: versamento mensile ripartito per pesi target.
- **16** — «Portafoglio modello»: oggi vs modello, differenze in euro per strumento.
- **53** — Una vendita saltata non blocca più «Rivedi il piano».
- **54** — Riepilogo vendite senza doppio punto.
- **55** — «Attiva piano» e «Rivedi piano» ricontrollano i conti al momento del click.
- **56** — Vendita totale: mostra le quote possedute; avviso di sostituzione solo se modificate.
- **57** — «Criteri del modello» parlano del portafoglio modello, non del vecchio step Target.
- **59** — Corretto l’errore del browser sull’avviso riserva (paragrafo dentro paragrafo).
- **96** — Se i pesi del piano diventano modello, uno strumento a 0% resta nel modello.
- **97** — «Salva bozza» aggiorna il modello se l’opzione è spuntata.

### 3.4 Consulente AI — voci 4, 8, 14, 129, 130

- **4** — Nuova pagina «Il piano operativo»: quanto versare, cosa comprare/vendere e quando, con tasse.
- **8** — Il Consulente legge il piano attivo e «Cosa fare adesso» dice cosa accumulare o sospendere.
- **14** — Percorso guidato con due agenti AI: 8 domande, bozza salvata nel browser.
- **129** — Guida aggiornata: colloquio, obbligazioni, percorsi precedenti, report a libro.
- **130** — Direzione visiva AI: palco che scorre, binario dei passaggi, report letto pagina per pagina.

### 3.5 Assistente chat, Registra e analisi AI — voci 10-12, 65, 66, 68, 69, 105-114, 119

- **10** — Assistente trasformato in chat: niente asse periodo/modalità, capisce lui cosa chiedi.
- **11** — «Registra» da linguaggio naturale: «ho speso 100 euro» diventa una proposta di riga.
- **12** — Link «Chiedi all’Assistente» accanto a «Nuova Spesa» in Tracciamento.
- **65** — Proposta obiettivo confermata non si ripropone dopo reload: niente doppi obiettivi.
- **66** — Entrate/uscite dell’Assistente allineate al mese italiano (non più quello del server).
- **68** — Risposte lunghe: budget 5×, niente messaggio «ho raggiunto il limite di lunghezza».
- **69** — Chat oltre 100 messaggi: mostra gli ultimi 100 e risponde con il contesto recente.
- **105** — Messaggio limitato a 4000 caratteri, contatore che appare da 3800.
- **106** — Durante l’attesa: indicatore pulsante e frase tipo «Sto leggendo la domanda…».
- **107** — L’analisi riceve lo split del Driver di Storico (risparmio, mercato, tasse, mutuo, fondo).
- **108** — Se la risposta si interrompe per una ricerca web, riprende con nuovo paragrafo.
- **109** — Per classe, l’Assistente sa quanto viene dai fondi pensione e dai versamenti.
- **110** — Entrate per sottocategoria (Rimborsi › …) come già per le spese.
- **111** — Versamenti al fondo pensione conteggiati nel mese in cui il valore si è mosso.
- **112** — Modifica di un obiettivo dalla chat, con card «Modifica di un obiettivo».
- **113** — L’Assistente vede asset, allocazione, registro operazioni, dividendi, pensione, obiettivi.
- **114** — Pulsante «Analizza con AI» con bordo viola dei contesti AI.
- **119** — Se un modello rifiuta, un altro risponde nella stessa risposta.

### 3.6 Patrimonio, compravendita, intestatari e prestiti — voci 13, 18, 40-43, 63, 70, 71, 77, 78, 98, 120

- **13** — «Compra o vendi casa» guidato: preliminare → rogito, una domanda per schermata.
- **18** — Intestatari di un asset per quota tra i membri della famiglia.
- **40** — Nuovo asset «Prestito»: mutuo collegato all’immobile o prestito personale, valore negativo del debito.
- **41** — Migrazione automatica del vecchio mutuo-campo dell’immobile al nuovo Prestito.
- **42** — Tessera «Mutuo»/«Prestito»: interessi e capitale pagati, debito, fine piano, «Estinto».
- **43** — Obbligazione «Unica a scadenza»: cedola unica con capitalizzazione del tasso annuo.
- **63** — Due tab aperti sul registro operazioni non sovrascrivono più correzioni né spostano due volte un conto.
- **70** — In Allocazione il mutuo segue l’immobile: esclusione e liquidità coerenti.
- **71** — «Asset principali» mostra la casa al netto del mutuo, con nota in euro.
- **77** — Errore di lettura del registro non più travestito da «Nessuna operazione».
- **78** — Incremento che arrotonda a zero: «0,00 €» invece di «+0,00 €» verde.
- **98** — Commissioni di acquisto/vendita (anche primo acquisto) diventano spese nella categoria commissioni.
- **120** — Verdetto Patrimonio: frase a sé per l’asset principale del mese e variazione da inizio anno.

### 3.7 Cashflow: budget, spese, debiti e immobili — voci 17, 44-47, 62, 64, 85-90, 124, 128

- **17** — «Fuori dal budget»: spesa per altri rimborsata, resta nel cashflow ma non nel tetto.
- **44** — Commissione su ogni voce, non solo transfer: riga di spesa dedicata.
- **45** — «Estinzione anticipata» su un debito: tutto a capitale, con debito residuo mostrato.
- **46** — Transfer tra conto e immobile: caparra in uscita, ricavato vendita in entrata.
- **47** — «Legata all’immobile»: polizza casa/CPI collegata a un immobile con scadenza della serie.
- **62** — Tasso di risparmio: con entrate basse parla in euro, non in percentuali tipo −16567%.
- **64** — Rata mutuo: quota capitale/interessi della data della rata, non di oggi.
- **85** — Risparmio e residui che arrotondano a zero senza segno né colore.
- **86** — «Carica altri» dopo aver aggiunto una spesa non accorcia più la lista.
- **87** — In demo il «+» della barra inferiore è nascosto: non si scrivono i dati condivisi.
- **88** — Centri di Costo: errore di lettura sostituisce il verdetto, non si dice “zero centri”.
- **89** — Eliminazione di una serie dalla tabella restituisce anche le commissioni.
- **90** — Analisi: la Scheda resta a schermo dopo la chiusura della ricerca.
- **124** — Rinomina: «Spese Fisse» → «Necessarie», «Spese Variabili» → «Non Necessarie».
- **128** — Tessera commissioni rinominata «Commissioni bancarie» e chiarita.

### 3.8 Dividendi e cedole — voci 49, 60, 61, 92

- **49** — Cedola successiva non duplicata (salvataggio obbligazione + aggiornamento serale).
- **60** — Cedola indicizzata resta nel banner fino al giorno di pagamento italiano.
- **61** — Campo strumento risponde di nuovo al testo digitato dopo un submit rifiutato.
- **92** — Dividendo annunciato segue compra/vendita fino all’ex-date; cedola segue la valuta.

### 3.9 Rendimenti, Storico e Driver — voci 50, 51, 75, 79-83, 91, 94, 99, 115, 126, 127

- **50** — Le due colonne di Rendimenti/Coast/Impostazioni finiscono sulla stessa riga.
- **51** — Sparkline di Previdenza e Panoramica non supera il proprio massimo.
- **75** — Previdenza: «+0,00%» colorato diventa «0,00%» neutro.
- **79** — Storico, chip «ultimi 12 mesi»: zero senza segno.
- **80** — «nei 8 mesi» diventa «negli 8 mesi» ovunque.
- **81** — Tasso di rendimento (TWR): scarto che arrotonda a zero senza segno.
- **82** — «Analizza con AI» disabilitato finché la pagina carica o ha fallito la lettura.
- **83** — Versamenti pensione e capitale mutuo non più etichettati «altre variazioni».
- **91** — Report AI vuoto o tagliato: subentra un altro modello e dice chi ha scritto.
- **94** — Segno meno tipografico nei valori negativi, zero senza segno.
- **99** — Driver: «altre variazioni» diviso in tre parti nominate che tornano al euro.
- **115** — Allocazione desktop: colonne «Per classe» e «Piano» stesse altezze.
- **126** — Driver mutuo: apertura prestito = debito in su, chiusura = rimborso.
- **127** — Prestiti esclusi da ogni base di Rendimenti, indipendentemente dai toggle.

### 3.10 FIRE e Simulazioni / Obiettivi — voci 34-39, 67, 73, 74, 76, 125

- **34** — Calcolatore mobile: verdetto, blocco fondo pensione e «Ti mancano».
- **35** — Coast FIRE mobile: modello ponte, margine e scenario orso.
- **36** — What If mobile: variazione del patrimonio FIRE e distanza dal traguardo.
- **37** — Monte Carlo mobile: mediana/orso e ventaglio accorciato.
- **38** — Obiettivi mobile: verdetto intero, lista aperta e tessere chiuse.
- **39** — Quote in quote: assegna un numero di quote invece di una percentuale.
- **67** — Obiettivi: immobile con mutuo conteggiato al netto del debito.
- **73** — What If: tabella sensibilità include tasse su prelievi e pensioni.
- **74** — «Numero Coast oggi» include la tassa sui prelievi: coincide con Coast FIRE.
- **76** — Monte Carlo: verdetto coerente con il grafico dopo azzeramento parametri.
- **125** — FIRE number: mutuo su casa esclusa non abbassa il fabbisogno.

### 3.11 Email periodiche e commenti AI — voci 84, 101, 116

- **84** — Commento AI troncato non viene inviato: mezza frase sparisce.
- **101** — Il commento AI legge tutto lo storico cashflow per contestualizzare il periodo.
- **116** — Tasse sotto 100 € e 5% non nominate nei verdetti di Panoramica/Patrimonio/email.

### 3.12 Sicurezza e campi — voci 103, 104

- **103** — Autocomplete e password manager disattivati sui campi dell’app (login escluso).
- **104** — Next.js 16.4.2: corregge due RCE critiche e un DoS nelle Server Actions.

## 4. Le feature locali da preservare

| Feature locale | Che cos’è | Dove collide con v12 |
| --- | --- | --- |
| **OKX bridge** (già in `main`) | Connessione read-only a OKX + import saldi/trade e tile impostazioni | `types/assets.ts`, `AssetDialog`, `AssetRow`, `StrumentiTile`, `settingsNarrative`, `package.json` |
| **Reddito mensile / override** (PR #21-25) | Dichiarazione del reddito fisso e correzioni mensili con data di attivazione, per i grafici del risparmio | Scontro semantico con voci **62/107/109/113** e con `SavingsRateTrendSection`, `cashflowNarrative`, `settingsDraft` |
| **Dimezzamento spese** (PR #26, branch `feat/expense-halve`) | Azione che dimezza una spesa e genera la riga correlata | Stessi file delle voci **17/44-47/85/89**: `ExpenseTable`, `TransactionFeed`, `dialogNarrative` |
| **Costi-inflazione** (branch `feat/costi-inflazione`, include il dimezzamento) | Costi indicizzati HICP, «Storico reale», drag dei costi e tasso FIRE dedicato | Voci **50/83/99/126/127** (`CostiTile`, `EvoluzioneTile`, `LiquiditaTile`, `fireService`, route HICP, regole) |
| **`okx-poc`** | Prototipo iniziale | Sostituito dal bridge integrato in `main`; da non mergere separatamente |

Nota: `feat/costi-inflazione` (`d078c164`) e `feat/expense-halve` (`f8595c66`) sono basate su `030e162a`, prima del merge OKX in `main`. `feat/cashflow-income-box` (`b4be25ec`) è già in `main`.

## 5. Impatto del merge, per macro

| Macro | Rischio | Motivo |
| --- | --- | --- |
| Temi/font/identità | Medio | Componenti riscritti; va riapplicata la mascheratura saldi e le chip broker |
| Mobile/tablet | **Alto** | La logica locale di `app/dashboard/cashflow/page.tsx` va portata nel nuovo `CashflowPageClient` |
| Accumulo/Consulente/Assistente | Basso-medio | Moduli nuovi, ma nuove collection in `firestore.rules` |
| Patrimonio/prestiti | **Alto** | `types/assets.ts` deve contenere insieme `fund`, `crowdfunding` e `loan` |
| Cashflow/spese | Medio-alto | Stessi file del dimezzamento |
| Rendimenti/Storico/FIRE | Medio | Sovrapposizione con costi-inflazione |
| Dipendenze | Scelta | Il tag ha Next 16.4.2 e yahoo 3.x; localmente Next 16.4.6 e yahoo ^4 — **non fare downgrade** di Next |

## 6. Decisioni aperte e piano proposto

Decisioni già prese dall’utente:

1. Solo report e piano: nessuna risoluzione conflitti applicata.
2. Sorgente: solo tag `v12.0.0` (non `upstream/main`).
3. Destinazione: nuovo branch da `main`.

Decisioni ancora aperte:

1. **Denominatore del risparmio**: tenere la regola locale (reddito fisso + override mensili, con mese di attivazione) o adottare quella upstream (entrate registrate, floor −100%)?
2. **Dipendenze**: tenere i pin locali (`yahoo-finance2 ^4`, Next esatto) o allinearsi al tag (`zod 4.6.7`, yahoo 3.x)?
3. **Perimetro futuro**: `upstream/main` contiene altre quattro feature successive al tag, escluse per scelta.

Piano proposto (da approvare):

- Aprire `integrate/upstream-v12` da `main`.
- Usare l’albero upstream come base nei file riscritti e riapplicare a hunk le feature locali in quattro lotti: (1) OKX + reddito mensile, (2) dimezzamento, (3) costi-inflazione, (4) regole, dipendenze, documentazione.
- Verificare con `npx tsc --noEmit`, `npm run lint`, Vitest in `Europe/Rome` e `UTC`, poi Playwright sugli emulatori.
- Distribuire `firestore.rules` separatamente.
- Nessun commit senza approvazione esplicita.

## 7. Stato finale della sessione

- `main` pulito, nessun commit, nessun merge applicato.
- Worktree di valutazione (`evaluate/upstream-v12`) rimosso.
- Unico cambiamento persistente: remote `upstream` aggiunto a `.git/config`.
- Le `firestore.rules` richiedono un deploy a parte: le modifiche alle rules sono inerti finché non vengono distribuite.
