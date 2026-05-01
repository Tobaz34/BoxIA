#!/usr/bin/env node
/**
 * Test rapide du PII scrubber FR sur les 7 patterns.
 * Patterns dupliqués depuis src/lib/pii-scrub.ts (Node n'exécute pas .ts direct).
 * Usage : node scripts/test-pii-scrub.mjs
 */

// Ordre = du + spécifique au - spécifique (cf src/lib/pii-scrub.ts).
const PATTERNS = [
  { name: "iban",        re: /\b[A-Z]{2}\d{2}[\s]?(?:[A-Z0-9]{4}[\s]?){4,7}[A-Z0-9]{1,4}\b/g },
  { name: "credit_card", re: /\b(?:\d{4}[\s-]?){3}\d{4}\b/g },
  { name: "nir_fr",      re: /\b[12]\s?\d{2}\s?\d{2}\s?\d{2,3}\s?\d{3}\s?\d{3}\s?\d{2}\b/g },
  { name: "siret",       re: /\b\d{3}[\s]?\d{3}[\s]?\d{3}[\s]?\d{5}\b/g },
  { name: "siren",       re: /\b\d{3}[\s]?\d{3}[\s]?\d{3}\b(?!\d)/g },
  { name: "email",       re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { name: "phone_fr",    re: /(?:\+33[\s.-]?|0)[1-9](?:[\s.-]?\d{2}){4}/g },
];

function scrub(text) {
  let out = text, count = 0;
  const byType = {};
  for (const p of PATTERNS) {
    out = out.replace(p.re, () => {
      count++;
      byType[p.name] = (byType[p.name] || 0) + 1;
      return `[${p.name.toUpperCase()}_REDACTED]`;
    });
  }
  return { redacted: out, count, by_type: byType };
}

const samples = [
  { name: "email",       text: "Contacte-moi à jean.dupont@acme.fr ou pierre.martin+dev@gmail.com", expect: "email" },
  { name: "phone_fr",    text: "Mon numero : 06 12 34 56 78 ou +33 6 98 76 54 32 ou 04.72.00.00.00", expect: "phone_fr" },
  { name: "iban",        text: "IBAN: FR76 3000 6000 0112 3456 7890 189", expect: "iban" },
  { name: "credit_card", text: "CB: 4532 1488 0343 6467", expect: "credit_card" },
  { name: "siret",       text: "SIRET de l'entreprise : 552 100 554 00013", expect: "siret" },
  { name: "siren",       text: "Notre SIREN: 552 100 554", expect: "siren" },
  { name: "nir_fr",      text: "NIR : 1 84 04 75 116 003 42", expect: "nir_fr" },
  { name: "mixed",       text: "Hello, jean@acme.fr / 06 12 34 56 78 / SIRET 552 100 554 00013 / IBAN FR76 3000 6000 0112 3456 7890 189", expect: "multi" },
];

let pass = 0, fail = 0;
for (const s of samples) {
  const r = scrub(s.text);
  const ok = s.expect === "multi" ? r.count >= 3 : (r.by_type[s.expect] || 0) > 0;
  console.log(`[${ok ? "OK" : "KO"}] ${s.name.padEnd(12)} count=${r.count} by_type=${JSON.stringify(r.by_type)}`);
  console.log(`         in : ${s.text}`);
  console.log(`         out: ${r.redacted}`);
  ok ? pass++ : fail++;
}

console.log(`\n=== ${pass}/${pass + fail} OK ===`);
process.exit(fail === 0 ? 0 : 1);
