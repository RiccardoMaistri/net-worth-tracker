# PERF-12 — Il React Compiler acceso: la memoizzazione che oggi nessuno scrive

> Stato: da fare · Priorità: 2 · Sforzo: M (poco codice, molto collaudo) · Dipende da: PERF-01 (misura) · Sblocca: PERF-13 e PERF-14 (le loro sezioni memoizzano da sole; il census in `scripts/` serve a entrambe e a PERF-11)

## 1. Il problema, misurato

Il repo vive come se il React Compiler fosse acceso — ESLint porta le regole `react-hooks/*` del compiler a zero dal
2026-09-06 (`set-state-in-effect`, `static-components`, `preserve-manual-memoization`, `refs`), e AGENTS.md le cita come
vincoli — ma **il compiler non gira**: `next.config.ts` non ha `reactCompiler`, `package.json` non ha
`babel-plugin-react-compiler`, non esiste `.babelrc` (verificato 2026-09-26). E **non c'è un solo `React.memo` in
`components/` o `app/`**. Quindi ogni cambio di stato in una pagina ri-renderizza l'intero sottoalbero:

- `app/dashboard/settings/page.tsx`: UN componente di 4105 righe con **70 chiamate a `useState`**; ogni tasto in un campo controllato
  (`setNewEmailInput :2511`, `setStampDutyRate :2151`, …) ri-renderizza tutto, comprese le sei tab visitate (il JSX di ogni
  tab montata è ricostruito ad ogni render).
- `app/dashboard/cashflow/page.tsx`: ogni tab visitata resta montata (`forceMount`) e si ri-renderizza a ogni stato della
  pagina (cambio tab, `loading`, `allExpenses`, l'arrivo delle impostazioni, un `handleRefresh` nuovo ad ogni render).
- `AssetDialog`/`ExpenseDialog`: 23 e 18 `useWatch` alla radice — un tasto, 2887 o 2238 righe.
- `useChartColors` fa `setState` un frame dopo il mount in ogni host: ogni pagina con un grafico renderizza due volte.
  `useCssColorTokens` (dal 2026-09-27, i cinque `--role-*` del Flusso per ruolo) fa lo stesso, ma solo quando il Sankey
  dei ruoli si disegna (`enabled`): a ruoli spenti, o sulle righe del telefono, `FlussoTile` renderizza una volta sola — il
  census lo conferma, ed è il caso che va rosso se qualcuno toglie il gate.

La regola di Next 16 (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/reactCompiler.md`):
`reactCompiler: true` + `babel-plugin-react-compiler`; Next applica il plugin solo ai file con JSX/hook tramite SWC, quindi
la build rallenta poco. Il post ha contato hook e sottoscrizioni prima di tagliarli; qui il taglio più grande è gratis.

## 2. Obiettivo misurabile

- `reactCompiler: true` in produzione; la build passa; lint resta a zero.
- Misura dei commit di React per interazione (il «React commits per interaction» del post) con uno script usa-e-getta
  Playwright + `React.Profiler` iniettato (o le DevTools via CDP): 10 tasti in Impostazioni › Generale → numero di
  componenti ri-renderizzati per tasto prima/dopo (atteso: da «tutta la pagina» a «il campo e i suoi genitori diretti»);
  10 tasti in «Nuova spesa» → idem; cambio tab su Cashflow → le tab nascoste non ri-renderizzano.
- Benchmark cold/warm (PERF-01): nessuna regressione su nessuna pagina; long task su Impostazioni e Cashflow ≤ prima.
- `npm run test:e2e` COMPLETO verde: è l'unico modo per vedere un componente che il compiler «salta» (`Compilation Skipped`)
  o memoizza male (un `useMemo` che il compiler pota, AGENTS.md § Motion: «memoized in source but not in output»).

## 3. Non-obiettivi

- Nessuna riscrittura di componenti: la spec accende il compiler e MISURA; le riscritture sono PERF-13 (Impostazioni) e
  PERF-11 (dialog).
- Non si aggiungono `React.memo` a mano dove il compiler basta.
- Non si cambia il comportamento di nessuna pagina.

## 4. Design

1. `npm i -D babel-plugin-react-compiler` (la versione che `eslint-plugin-react-hooks` del repo si aspetta: leggere
   `node_modules/eslint-plugin-react-hooks/package.json` e `npm view babel-plugin-react-compiler versions`).
2. `next.config.ts` → `reactCompiler: true`. Non `compilationMode: 'annotation'`: il lint è già pulito ovunque, e la modalità
   opt-in lascerebbe fuori proprio le pagine grandi.
3. **Il census**, in `scripts/perfRenderCensus.mjs` (tracciato: PERF-11 e PERF-13 lo riusano), lanciato con `npm run perf:census -- --route=settings`.
   La build di produzione supporta il profiling di React: `next build --profile` («Enables production profiling for
   React», `node_modules/next/dist/bin/next:88`) — lo script `perf:build` accetta `--profile`, e con quella build lo script
   avvolge la pagina in un `React.Profiler`? No: non si può avvolgere dall'esterno. **La misura scelta**: (a) long task e
   `layout`/`style` recalc per tasto con CDP (`Performance.enable`, `Performance.getMetrics` → `LayoutCount`, `RecalcStyleCount`,
   `ScriptDuration` prima/dopo 10 tasti), sulla build `--profile` — le stesse metriche del post; (b) il conteggio dei
   componenti ri-renderizzati per tasto con il hook delle React DevTools (`__REACT_DEVTOOLS_GLOBAL_HOOK__`, iniettato da
   `addInitScript` prima del bundle: sulla build `--profile` i fiber portano i tempi; `onCommitFiberRoot` conta i fiber con
   `actualDuration > 0` per commit). Se (b) si rivela fragile, il fallback è `next dev` con un wrapper `React.Profiler`
   usa-e-getta intorno alla pagina (dev esagera i costi ma il CONTEGGIO è quello vero). Entrambe prima e dopo.
4. La suite intera + il giro.
5. **Cosa può rompersi e come si vede**: un componente che muta un oggetto durante il render (vietato dalle regole, ma un caso
   sfuggito al lint) viene memoizzato e smette di aggiornarsi → una tessera che non cambia al cambio periodo. La E2E completa
   copre i periodi di ogni pagina; il giro copre gli occhi.

## 5. File da toccare

- `package.json` (devDependency; script `perf:census`; `perf:build` con `--profile` opzionale), `next.config.ts` (una riga), `package-lock.json`.
- `scripts/perfRenderCensus.mjs` (nuovo, tracciato); i numeri in SESSION_NOTES e poi in CLAUDE.md «Latest».
- Nessun file di app: se un componente richiede una modifica per compilare (un `Compilation Skipped` che prima non c'era),
  la modifica è UNA riga allineata al lint e va in SESSION_NOTES con il nome del componente.

## 6. Passi

1. Build di produzione + benchmark completo prima (cold+warm); il census (a) e (b) prima.
2. Plugin + flag; `npm run build` (annotare il tempo di build prima/dopo); lint; `tsc`.
3. Vitest completo nei due fusi; E2E completo.
4. Census (a) e (b) dopo; benchmark dopo.
5. Giro guidato; documentazione.

## 7. Test e falsificazione

- Non c'è un test nuovo da scrivere: la falsificazione è il census — con il flag spento i commit per tasto sono N, con il
  flag acceso M < N; se M = N il compiler non sta girando. Come si vede che gira: (da verificare, la doc di Next 16 non lo
  dice) l'output di `next build` o, con certezza, un chunk della build che contiene le chiamate a `react/compiler-runtime`
  (`_c(` / `useMemoCache`): grep sui chunk prima (0) e dopo (> 0).
- Un componente «saltato»: il plugin Babel non espone un logger nella config di Next (da verificare in
  `reactCompiler.md`); il lint è la mappa (zero `preserve-manual-memoization` = nessun salto noto).
- Suite: TUTTE (Vitest 190 file nei due fusi, E2E 39 spec).

## 8. Collaudo guidato

- A: TUTTO (è la spec dove A è la fase). C: il census prima/dopo.
- F (mirror, 390 e 1440, ≤ 5 punti): 1) Impostazioni › Generale: digitare in tre campi, salvare, ricaricare: i valori tengono;
  2) Cashflow: cambiare periodo e tab avanti e indietro, le cifre seguono; 3) Rendimenti: cambiare periodo, il hero cambia;
  4) Patrimonio: modificare un asset e vederlo nella riga; 5) Allocazione: spostare l'importo del piano, gli ordini cambiano.
  Non coperto: nulla di visivo cambia per costruzione; il giro cerca ciò che NON cambia più.
- G: `npm run mirror:remove`.

## 9. Rischi e rollback

- Il rischio è silenzioso (una tessera ferma): la E2E completa e i cinque punti del giro sono la difesa; la spec chiude solo
  con entrambi.
- Il tempo di build su Vercel cresce (poco, per la doc): annotarlo.
- Rollback: una riga di config; la devDependency può restare.

## 10. Documentazione da aggiornare

- CLAUDE.md «Latest» e § Current Status (stack: «React Compiler acceso»); AGENTS.md § Motion: la nota «il compiler GIRA dal
  <data>: `React.memo` a mano solo dove il census lo mostra necessario»; `Draft Release Temp.md`; doc/perf/README.md.

## 11. Prompt di implementazione

```text
Ciao, in questa sessione implementiamo doc/perf/PERF-12-react-compiler.md: accendiamo il React Compiler (reactCompiler:
true + babel-plugin-react-compiler) e MISURIAMO prima/dopo con scripts/perfRenderCensus.mjs (nuovo, tracciato, riusato da
PERF-11 e PERF-13) — componenti ri-renderizzati per tasto su Impostazioni e «Nuova spesa», layout/style recalc via CDP
sulla build --profile, benchmark completo — poi la suite intera e il giro guidato. Nessuna riscrittura di componenti: se
uno non compila, una riga allineata al lint e me lo dici.

Da fare TASSATIVAMENTE prima di ogni cosa:
- Leggi WORKFLOW.md, AGENTS.md (§ Motion: le quattro risposte a set-state-in-effect, static-components,
  preserve-manual-memoization, refs), CLAUDE.md
- Leggi node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/reactCompiler.md
- Leggi doc/guide/e2e-emulatori.md (la suite completa e il mirror)
- Leggi COMMENTS.md e DEVELOPMENT_GUIDELINES.md e APPLICALE se scrivi codice
- Leggi doc/perf/README.md e la spec PERF-12 per intero; PERF-01 deve essere chiusa
- Crea SESSION_NOTES.md; crea il branch dalla branch attiva PRIMA di editare

Regole: nessun commit senza il mio OK; un branch e un commit; rispondi in italiano.
Chiusura: il census prima/dopo in SESSION_NOTES (se i numeri non cambiano, il compiler non gira: dimmelo, non chiudere;
prova con il grep di react/compiler-runtime nei chunk); benchmark completo prima/dopo; tsc, lint 0, Vitest in ENTRAMBI i
fusi, npm run test:e2e COMPLETO; giro guidato di 5 punti sul mirror a 390 e 1440 cercando ciò che NON si aggiorna più, poi
mirror:remove; CLAUDE.md «Latest» e § Current Status, AGENTS.md § Motion, Draft Release Temp.md (senza dati privati),
doc/perf/README.md; proponi il commit.
```

## 12. Modello ed effort

**Claude Opus 5.5, effort high.** Una riga di codice e molta disciplina di collaudo; il modello serve per leggere l'output
della E2E completa e distinguere un flake noto (`modal.origin`, CLAUDE.md § Known Issues) da una tessera ferma.
