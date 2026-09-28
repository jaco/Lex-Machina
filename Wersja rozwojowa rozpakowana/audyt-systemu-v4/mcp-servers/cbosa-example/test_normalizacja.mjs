// test_normalizacja.mjs = test równoważności z parserem referencyjnym (ta sama zawartość, nazwa wymagana przez CI i instalator).
// Równoważność portu JS z parserem referencyjnym Python (orzeczenia-sadowe-v2/tools/cbosa_parser.py).
// Wzorzec: fixtures/rownowaznosc.json — wyniki PYTHONA na tym samym HTML (generowane, nie pisane ręcznie).
import { parsujDokument, weryfikujSygnature } from "./cbosa-mcp-server.js";
import assert from "node:assert";
import { readFileSync } from "node:fs";
const K = JSON.parse(readFileSync(new URL("./fixtures/rownowaznosc.json", import.meta.url)));
let n = 0;
for (const d of K.dokumenty) {
  let js; try { js = parsujDokument(d.html, d.doc_id); } catch { js = { ERR: true }; }
  if (d.oczekiwane.ERR) assert.ok(js.ERR, `${d.nazwa}: Python odrzucił (${d.oczekiwane.ERR}), JS przyjął`);
  else for (const [k, v] of Object.entries(d.oczekiwane)) assert.deepStrictEqual(js[k] ?? null, v, `${d.nazwa}: pole ${k}`);
  n++;
}
for (const s of K.scenariusze) {
  const v = await weryfikujSygnature(s.search, s.oczekiwana, async () => { throw new Error("brak stron"); }, async (id) => s.docs[id]);
  assert.strictEqual(v.status, s.status, `${s.nazwa}: status`);
  assert.deepStrictEqual((v.matches ?? []).map((m) => m.case_number), s.matches, `${s.nazwa}: trafienia`);
  if (s.status !== "OUT_OF_SCOPE") assert.deepStrictEqual(v.rejected ?? [], s.rejected, `${s.nazwa}: odrzucone`);
  n++;
}
// paginacja (kontrakt shared/CBOSA-ADAPTER.md pkt 4–5)
const strona = (total, ids) => `<html><body><div>Znaleziono ${total} orzeczeń</div>${ids.map((i) => `<a href="/doc/${i}">x</a>`).join("")}</body></html>`;
const dok = K.dokumenty[0].html;
const ids = (a, b) => Array.from({ length: b - a }, (_, i) => `A${String(a + i).padStart(9, "0")}`);
{ const v = await weryfikujSygnature(strona(12, ids(0, 10)), "II FSK 100/24", async () => strona(12, ids(10, 12)), async () => dok);
  assert.strictEqual(v.status, "AMBIGUOUS"); assert.strictEqual(v.doc_ids.length, 12); n++; }
{ const v = await weryfikujSygnature(strona(11, ids(0, 10)), "II FSK 100/24", async () => strona(11, ids(0, 10)), async () => dok);
  assert.strictEqual(v.status, "OUT_OF_SCOPE"); assert.match(v.powod, /bez nowych ID/); n++; }
console.log(`OK: ${n} przypadków zgodnych z parserem referencyjnym (Python) + paginacja`);
