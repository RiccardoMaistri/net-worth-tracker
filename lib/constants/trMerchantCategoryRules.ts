/**
 * Trade Republic card payments — the deterministic merchant → category rules.
 *
 * WHY A RULE TABLE AND NOT AN LLM: the import is a WRITE, it runs unattended after a preview, and
 * the same row must land in the same category on every sync. A model would make the plan
 * non-reproducible and could not be tested without a network. The table is the whole decision:
 * merchant patterns first, the card icon second, «Altro» last.
 *
 * The category names are the app's own vocabulary (Alimentari, Ristorazione, …), never the
 * broker's: Trade Republic's timeline has no MCC and no category, only a title and an icon. A
 * category that already exists is matched by (name, type) — and, when the rule names a
 * subcategory, by that subcategory too — in `lib/utils/tradeRepublicCardExpenses.ts`. A category
 * that does not exist is PROPOSED in the preview and created only after the user confirms.
 *
 * A pattern is a lowercase substring of the merchant line (`title` + `subtitle`). Keep it specific
 * enough not to catch a product name: `bar` catches a café, `car` would catch `card`.
 */

import type { ImportableExpenseType } from '@/types/expenseImport';

export interface TrMerchantCategoryRule {
  /** Stable id, used by tests and by the preview's disclosure. */
  id: string;
  /** Lowercase substrings matched against the merchant line. */
  patterns: readonly string[];
  categoryName: string;
  subCategoryName?: string;
  type: ImportableExpenseType;
}

/**
 * The fallback is a category a user can actually find and reclassify. It is NOT `Senza categoria`:
 * an Expense row needs a categoryId, and creating a category called «Senza categoria» would make
 * the app print a label that claims the opposite of what the document says.
 */
export const TR_CARD_FALLBACK_CATEGORY = {
  categoryName: 'Altro',
  type: 'variable' as const,
};

export const TR_MERCHANT_RULES: readonly TrMerchantCategoryRule[] = [
  // ── Groceries ────────────────────────────────────────────────────────────
  {
    id: 'groceries',
    patterns: [
      'esselunga', 'coop', 'conad', 'lidl', 'eurospin', 'carrefour', 'pam', 'panorama',
      'penny market', 'md discount', 'iper', 'famila', 'despar', 'todis', 'bennet',
      'sigma', 'crai', 'auchan', 'mercadona', 'aldi', "in's mercato", 'supermercato',
      'supermarket', 'grocery', 'spesa',
    ],
    categoryName: 'Alimentari',
    subCategoryName: 'Supermercato',
    type: 'variable',
  },
  // ── Restaurants, bars, delivery ─────────────────────────────────────────
  {
    id: 'restaurants',
    patterns: [
      'ristorante', 'trattoria', 'osteria', 'pizzeria', 'caffetteria', 'caffè', 'caffe',
      'mcdonald', 'burger king', 'kfc', 'starbucks', 'sushi', 'gelateria', 'pasticceria',
      'panificio', 'bistrot', 'birreria', 'enoteca', 'pub ', 'deliveroo', 'glovo',
      'just eat', 'uber eats',
    ],
    categoryName: 'Ristorazione',
    subCategoryName: 'Ristorante',
    type: 'variable',
  },
  // ── Fuel and transport ──────────────────────────────────────────────────
  {
    id: 'fuel',
    patterns: [
      'eni', 'q8', 'tamoil', 'esso', 'shell', 'totalerg', 'api ', 'benzina', 'carburante',
      'distributore', 'stazione di servizio',
    ],
    categoryName: 'Trasporti',
    subCategoryName: 'Carburante',
    type: 'variable',
  },
  {
    id: 'public-transport',
    patterns: [
      'trenitalia', 'italo', 'atm ', 'atac', 'gtt', 'anm ', 'uber', 'taxi', 'flixbus',
      'itabus', 'autostrade', 'pedaggio', 'telepass', 'parcheggio',
    ],
    categoryName: 'Trasporti',
    subCategoryName: 'Trasporto pubblico',
    type: 'variable',
  },
  // ── Utilities and telecom ───────────────────────────────────────────────
  {
    id: 'utilities',
    patterns: [
      'eni gas', 'eni energia', 'enel', 'a2a', 'hera', 'acea', 'iren', 'sorgenia',
      'edison', 'engie', 'illumia', 'plenitude', 'luce', 'gas ', 'acquedotto',
    ],
    categoryName: 'Utenze',
    subCategoryName: 'Luce e gas',
    type: 'fixed',
  },
  {
    id: 'telecom',
    patterns: [
      'vodafone', 'tim ', 'windtre', 'wind tre', 'iliad', 'fastweb', 'ho.', 'spusu',
      'sky italia',
    ],
    categoryName: 'Utenze',
    subCategoryName: 'Telefono',
    type: 'fixed',
  },
  // ── Subscriptions and software ──────────────────────────────────────────
  {
    id: 'streaming',
    patterns: [
      'netflix', 'spotify', 'disney', 'prime video', 'now tv', 'dazn', 'apple music',
      'youtube premium', 'audible', 'kindle unlimited',
    ],
    categoryName: 'Abbonamenti',
    subCategoryName: 'Streaming',
    type: 'fixed',
  },
  {
    id: 'software',
    patterns: [
      'openai', 'chatgpt', 'anthropic', 'claude', 'microsoft', 'adobe', 'google one',
      'icloud', 'dropbox', 'notion',
    ],
    categoryName: 'Abbonamenti',
    subCategoryName: 'Software',
    type: 'fixed',
  },
  // ── Health ──────────────────────────────────────────────────────────────
  {
    id: 'pharmacy',
    patterns: [
      'farmacia', 'parafarmacia', 'asl', 'ospedale', 'poliambulatorio', 'medico',
      'dentista', 'odontoiatra', 'analisi cliniche',
    ],
    categoryName: 'Salute',
    subCategoryName: 'Farmacia',
    type: 'variable',
  },
  {
    id: 'fitness',
    patterns: ['palestra', 'gym', 'fitness', 'piscina', 'yoga'],
    categoryName: 'Salute',
    subCategoryName: 'Palestra',
    type: 'fixed',
  },
  // ── Shopping ────────────────────────────────────────────────────────────
  {
    id: 'shopping',
    patterns: [
      'amazon', 'zalando', 'shein', 'temu', 'aliexpress', 'ebay', 'decathlon', 'ikea',
      'leroy merlin', 'unieuro', 'mediaworld', 'euronics', 'zara', 'h&m', 'primark',
      'mango', 'foot locker', 'nike', 'adidas', 'apple store', 'brico', 'obi', 'castorama',
    ],
    categoryName: 'Acquisti',
    subCategoryName: 'Shopping',
    type: 'variable',
  },
  // ── Travel ──────────────────────────────────────────────────────────────
  {
    id: 'travel',
    patterns: [
      'booking', 'airbnb', 'ryanair', 'easyjet', 'vueling', 'ita airways', 'lufthansa',
      'hotel', 'albergo', 'b&b', 'trivago', 'expedia',
    ],
    categoryName: 'Viaggi',
    subCategoryName: 'Viaggi',
    type: 'variable',
  },
  // ── Leisure ─────────────────────────────────────────────────────────────
  {
    id: 'entertainment',
    patterns: ['cinema', 'teatro', 'ticketone', 'ticketmaster', 'eventim', 'museo', 'concerto'],
    categoryName: 'Tempo libero',
    subCategoryName: 'Spettacoli',
    type: 'variable',
  },
  // ── Pets ────────────────────────────────────────────────────────────────
  {
    id: 'pets',
    patterns: ['arcaplanet', 'petshop', 'veterinario', 'zooplus'],
    categoryName: 'Animali',
    subCategoryName: 'Animali',
    type: 'variable',
  },
  // ── Education ───────────────────────────────────────────────────────────
  {
    id: 'education',
    patterns: ['università', 'universita', 'scuola', 'corso ', 'udemy', 'coursera', 'duolingo'],
    categoryName: 'Formazione',
    subCategoryName: 'Corsi',
    type: 'fixed',
  },
  // ── Insurance ───────────────────────────────────────────────────────────
  {
    id: 'insurance',
    patterns: ['assicurazione', 'allianz', 'generali', 'unipol', 'zurich', 'axa'],
    categoryName: 'Assicurazioni',
    subCategoryName: 'Assicurazione',
    type: 'fixed',
  },
  // ── Bank fees and cash ──────────────────────────────────────────────────
  {
    id: 'fees',
    patterns: ['commissione', 'canone', 'bollo', 'tassa', 'imposta', 'fee '],
    categoryName: 'Commissioni',
    subCategoryName: 'Commissioni',
    type: 'variable',
  },
  {
    id: 'cash-withdrawal',
    patterns: ['prelievo', 'atm ', 'cash withdrawal'],
    categoryName: 'Prelievi',
    subCategoryName: 'Prelievo contanti',
    type: 'variable',
  },
  // ── Gifts ───────────────────────────────────────────────────────────────
  {
    id: 'gifts',
    patterns: ['regalo', 'gift'],
    categoryName: 'Regali',
    subCategoryName: 'Regali',
    type: 'variable',
  },
];

export interface TrDetectedCardCategory {
  categoryName: string;
  subCategoryName?: string;
  type: ImportableExpenseType;
  /** The rule that matched, absent on the fallback. */
  ruleId?: string;
  /** True when no merchant rule matched and the row lands in «Altro». */
  fallback: boolean;
}

/**
 * The icon fallback, used only when no merchant rule matched.
 *
 * Trade Republic sends an icon path (`card/…`, `logos/…`). It is presentation, so this is a
 * FALLBACK and never the first source: a themed or missing avatar must not decide a category.
 * `car` is deliberately absent — every path starts with `card/`.
 */
const TR_ICON_RULES: readonly TrMerchantCategoryRule[] = [
  {
    id: 'icon-groceries',
    patterns: ['supermarket', 'grocery', 'food'],
    categoryName: 'Alimentari',
    subCategoryName: 'Supermercato',
    type: 'variable',
  },
  {
    id: 'icon-restaurants',
    patterns: ['restaurant', 'cafe', 'coffee', 'bar'],
    categoryName: 'Ristorazione',
    subCategoryName: 'Ristorante',
    type: 'variable',
  },
  {
    id: 'icon-fuel',
    patterns: ['fuel', 'gasstation', 'gas-station'],
    categoryName: 'Trasporti',
    subCategoryName: 'Carburante',
    type: 'variable',
  },
  {
    id: 'icon-transport',
    patterns: ['transport', 'train', 'bus', 'flight'],
    categoryName: 'Trasporti',
    subCategoryName: 'Trasporto pubblico',
    type: 'variable',
  },
  {
    id: 'icon-health',
    patterns: ['health', 'pharmacy', 'medical'],
    categoryName: 'Salute',
    subCategoryName: 'Farmacia',
    type: 'variable',
  },
  {
    id: 'icon-shopping',
    patterns: ['shopping', 'retail', 'store'],
    categoryName: 'Acquisti',
    subCategoryName: 'Shopping',
    type: 'variable',
  },
  {
    id: 'icon-travel',
    patterns: ['travel', 'hotel'],
    categoryName: 'Viaggi',
    subCategoryName: 'Viaggi',
    type: 'variable',
  },
  {
    id: 'icon-entertainment',
    patterns: ['entertainment', 'cinema', 'ticket'],
    categoryName: 'Tempo libero',
    subCategoryName: 'Spettacoli',
    type: 'variable',
  },
  {
    id: 'icon-pets',
    patterns: ['pet'],
    categoryName: 'Animali',
    subCategoryName: 'Animali',
    type: 'variable',
  },
  {
    id: 'icon-education',
    patterns: ['education', 'school'],
    categoryName: 'Formazione',
    subCategoryName: 'Corsi',
    type: 'fixed',
  },
  {
    id: 'icon-insurance',
    patterns: ['insurance'],
    categoryName: 'Assicurazioni',
    subCategoryName: 'Assicurazione',
    type: 'fixed',
  },
  {
    id: 'icon-cash',
    patterns: ['atm', 'withdrawal'],
    categoryName: 'Prelievi',
    subCategoryName: 'Prelievo contanti',
    type: 'variable',
  },
  {
    id: 'icon-streaming',
    patterns: ['subscription', 'streaming'],
    categoryName: 'Abbonamenti',
    subCategoryName: 'Streaming',
    type: 'fixed',
  },
];

function fromRule(rule: TrMerchantCategoryRule): TrDetectedCardCategory {
  return {
    categoryName: rule.categoryName,
    ...(rule.subCategoryName ? { subCategoryName: rule.subCategoryName } : {}),
    type: rule.type,
    ruleId: rule.id,
    fallback: false,
  };
}

/** Detect the category of one card row. Deterministic: merchant, then icon, then «Altro». */
export function detectTrCardCategory(input: {
  merchant: string;
  subtitle?: string;
  icon?: string;
}): TrDetectedCardCategory {
  const haystack = `${input.merchant} ${input.subtitle ?? ''}`.toLowerCase();
  for (const rule of TR_MERCHANT_RULES) {
    if (rule.patterns.some((pattern) => haystack.includes(pattern))) return fromRule(rule);
  }
  const icon = (input.icon ?? '').toLowerCase();
  if (icon) {
    for (const rule of TR_ICON_RULES) {
      if (rule.patterns.some((pattern) => icon.includes(pattern))) return fromRule(rule);
    }
  }
  return { ...TR_CARD_FALLBACK_CATEGORY, fallback: true };
}
