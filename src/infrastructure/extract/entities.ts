const NAMED_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\"",
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
  const lower = entity.toLowerCase();
  if (lower.startsWith("#x")) {
    return decodeCodePoint(Number.parseInt(lower.slice(2), 16));
  }
  if (lower.startsWith("#")) {
    return decodeCodePoint(Number.parseInt(lower.slice(1), 10));
  }
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
