// The common named HTML entities (XML + the Latin-1 supplement + frequent
// punctuation/currency). Numeric refs (`&#nnn;` / `&#xHH;`) already decode every
// code point, so this covers the named forms a real page actually uses; rare
// entities fall through undecoded (the lookup lowercases, so uppercase variants
// like `&Dagger;` resolve to their lowercase form — lenient, matching common
// page practice).
const NAMED_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  sbquo: "‚",
  bdquo: "„",
  dagger: "†",
  bull: "•",
  middot: "·",
  prime: "′",
  frasl: "⁄",
  cent: "¢",
  pound: "£",
  yen: "¥",
  euro: "€",
  curren: "¤",
  plusmn: "±",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  yuml: "ÿ",
  szlig: "ß",
  // case-sensitive uppercase variants (&Eacute;=É ≠ &eacute;=é)
  Agrave: "À",
  Aacute: "Á",
  Acirc: "Â",
  Atilde: "Ã",
  Auml: "Ä",
  Aring: "Å",
  AElig: "Æ",
  Ccedil: "Ç",
  Egrave: "È",
  Eacute: "É",
  Ecirc: "Ê",
  Euml: "Ë",
  Igrave: "Ì",
  Iacute: "Í",
  Icirc: "Î",
  Iuml: "Ï",
  Ntilde: "Ñ",
  Ograve: "Ò",
  Oacute: "Ó",
  Ocirc: "Ô",
  Otilde: "Õ",
  Ouml: "Ö",
  Oslash: "Ø",
  Ugrave: "Ù",
  Uacute: "Ú",
  Ucirc: "Û",
  Uuml: "Ü",
  Yacute: "Ý",
  Dagger: "‡",
  Prime: "″",
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity) => {
    const decoded = decodeEntity(entity);
    return decoded ?? match;
  });
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// Inline-split markup (`<span>$</span><span>10</span><span>.90</span>`) leaves
// "$ 10 .90" (stripHtmlTags turns each tag into a space). Narrowly collapse only
// number/price fragments: "$ 10"->"$10", "10 .90"->"10.90" (dot must be followed
// by a digit, so "3. item"/"Done. Next" untouched; commas left so lists survive).
export function normalizeFragmentedNumbers(text: string): string {
  return text
    .replace(/([€£¥₹$])\s+(\d[\d ,]*)\s*\.\s*(\d{1,4})/g, "$1$2.$3")
    .replace(/(\d)\s+\.(\d)/g, "$1.$2")
    .replace(/(\d)\s+([€£¥₹])/g, "$1$2");
}

function decodeEntity(entity: string): string | null {
  // Numeric refs are case-insensitive in their digits.
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    return decodeCodePoint(Number.parseInt(entity.slice(2), 16));
  }
  if (entity.startsWith("#")) {
    return decodeCodePoint(Number.parseInt(entity.slice(1), 10));
  }
  // HTML named entities are CASE-SENSITIVE: &Eacute;=É ≠ &eacute;=é, &Dagger;=‡ ≠
  // &dagger;=†. Look up the original case first; fall back to lowercase for pages
  // that uppercase a lowercase entity (&AMP; → &).
  if (Object.hasOwn(NAMED_ENTITIES, entity)) return NAMED_ENTITIES[entity as keyof typeof NAMED_ENTITIES];
  const lower = entity.toLowerCase();
  return Object.hasOwn(NAMED_ENTITIES, lower)
    ? NAMED_ENTITIES[lower as keyof typeof NAMED_ENTITIES]
    : null;
}

function decodeCodePoint(codePoint: number): string | null {
  if (!Number.isInteger(codePoint) || codePoint <= 0) return null;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return null;
  }
}
