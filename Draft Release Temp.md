# Draft release notes

> Accumulates until the next tag (WORKFLOW.md § Where things are recorded). Grouped by area; one entry per surface, rewritten to its final state.

## ✨ New Features

- Added the per-sale detail to Rendimenti › Plusvalenze realizzate: opening the tile's breakdown now lists every sale of the fiscal year under the per-instrument rows — date, instrument, gross proceeds, the cost of the units sold at their average price, that average price itself, the gain and its share of the cost — with the units, the unit price, the commission, the tax withheld at the sale and what actually landed on the row beneath, and a total that is the sum of the rows you can see. The rows follow the year you pick in the modal, come from the same ledger replay as the totals above them, and refresh on every broker trade import. Below it, «Vendite non ancora nel registro»: the sales Trade Republic has recorded and your ledger does not, read from the broker and refreshed on every import. Each row says why it is missing (not imported yet, instrument not tracked, no ISIN, before the baseline) and the total is the money the broker paid out, never a profit — a gain only exists once the ledger replays the sale.


- Added an optional reading of Analisi › Flusso by 50/30/20 role (Necessità · Desideri · Risparmi): switch it on in Impostazioni › Spese, give each spending category a role (a subcategory can override it), and the Flusso opens on «Per ruolo» with «Per tipo» one tap away. What has no role yet reads «Da classificare», a period that spent more than it earned shows the gap as «Coperto dal patrimonio», and when some spending is itself a saving the reading says how much was set aside and how much was left over. (Contributed by Ciocc128.)

- Added, in Cashflow › Divisione, the income left «In comune» paying the shared spending first: a refund on a shared bill or a salary nobody attributed comes off the pool before the shares, the «In comune» tile shows it under its figure («Entrate in comune −300 €», «Da dividere 2110 €») and the verdict says it in the same sentence («le spese in comune sono 2410 €, meno 300 € di entrate in comune: 2110 € da dividere, 1266 € a Giuseppe (60%)…»); when the shared income covers the shared spending whole the surplus is stated («avanzano 100 €») rather than handed out. The shares now come from every income attributed to a person whatever its category, so the tab no longer depends on the categories marked as labor income and says «entrate» where it said «stipendio» («Registra le entrate di Marcella in Tracciamento e intestagliele»); the monthly email's «Spese in comune» section carries the same figures.

## 🐛 Bug Fixes

- Fixed a Trade Republic sale crediting more than the broker paid out: the ledger imported the gross proceeds and ignored the capital-gains tax the broker withheld at the sale, so an imported 2026 sale overstated the account by the withheld amount (659,97 € over that year's ten sales) and left the settlement reading an estimate the broker had already settled. Sales already imported keep the missing tax: the import is idempotent, so fix those from the asset's «Movimenti» dialog.

- Fixed an imported broker trade being converted twice: a broker settles on its own venue and reports what it charged there — both in euros, whatever the instrument is — and the currency it reported was read by nobody, so a €996,10 sale of a US stock was stored as a native dollar price and converted again at the day's rate (€869,12), and every figure derived from it measured against a price that never existed. A trade you enter by hand is unchanged: its price is the asset's own.

- Fixed an imported sale losing its name: a ledger row has no name of its own, so a sale of a position you later sold and deleted read «Strumento rimosso». The broker's name is now kept on the trade.

- Fixed a category edited in Impostazioni › Spese (name, type or role) keeping its old values in Analisi for up to five minutes: the change now arrives at once.

- Fixed the smallest categories of the Analisi › Flusso chart being painted black — invisible on a dark theme — when a branch held more than seven categories: a shade now never goes darker than 55% of its colour.

## 🔧 Improvements

- Improved Analisi › Flusso on a phone: it is now a bar of the period's spending split by type, each type's categories as rows (a row opens its Scheda) and what was left over as a closing line, instead of a Sankey too narrow to read; the printed shares always add up to 100, a type that rounds to zero reads «<1%», and when the period holds amounts that are only scheduled the closing line says so. From 640px up the Sankey is unchanged. (Contributed by Ciocc128.)

- Improved Patrimonio › Strumenti for a composite instrument (a 60/40 fund, a balanced ETF): still one row, but its class chip now shows every class it holds — one segment per class, as wide as its share and in that class's colour, «Azioni · Obbl.» for two, «Misto» for three or more. A class under 5% gets no segment, a screen reader hears every share, and the group headers and the sort by class keep the prevailing class. (Contributed by Ciocc128.)

## 📚 Documentation

- Added the specification for the new Esposizione as the first of the performance series — leverage as notional exposure, an honest coverage line, the Allocazione portfolio as the base, a cache per instrument — and amended the performance and mobile specifications to match the code after the three contributions above. The contributor's guide now says how a contribution that arrives while that work is open is reviewed and merged.

- Added the mobile composition dossier (no code touched): the current small-screen layout measured on 19 surfaces at 390, 768 and 1024px, three directions drawn and tested, the «first screen» one chosen (a short verdict, a strip of at most four figures, one open tile, the rest as closed rows), and nine specifications to implement after the performance ones.
