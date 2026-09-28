// Fixture'y: PRAWDZIWE odpowiedzi Sejm ELI z 2026-09-27 (fixtures/). AUDYT-2026-09-27o.
import { normalizujOdpowiedzELI, mapujStatusEli } from "./isap-eli-mcp-server.js";
import assert from "node:assert";
import { readFileSync } from "node:fs";
const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));
const kc = fx("eli_DU_1964_93"), tj = fx("eli_DU_2026_795"), tjStary = fx("eli_DU_2025_1071");

{ assert.match(tj.title, /jednolitego tekstu ustawy\s*[–-]\s*Kodeks cywilny/, "fixture t.j. dotyczy KC");
  const w = normalizujOdpowiedzELI([kc], "DU/1964/93", { identyfikator: "DU 2026 poz. 795", eli: "DU/2026/795" });
  assert.strictEqual(w.status, "FOUND");
  assert.strictEqual(w.result.status_obowiazywania, "tekst_jednolity_nieaktualny", "KC pierwotny NIE może być 'obowiazuje'");
  assert.strictEqual(w.result.status_eli, "akt posiada tekst jednolity");
  assert.match(w.uwaga, /Powołuj aktualny tekst jednolity: DU 2026 poz\. 795/);
  console.log("OK: KC DU/1964/93 → tekst_jednolity_nieaktualny + wskazanie aktualnego t.j."); }

{ assert.strictEqual(normalizujOdpowiedzELI([tj]).result.status_obowiazywania, "obowiazuje");
  assert.strictEqual(normalizujOdpowiedzELI([tjStary]).result.status_obowiazywania, "tekst_jednolity_nieaktualny",
    "t.j. z „wygaśnięcie aktu” = zastąpiony nowszym t.j., nie akt uchylony");
  console.log("OK: t.j. aktualny → obowiazuje; t.j. wygasły → tekst_jednolity_nieaktualny"); }

{ const m = { "obowiązujący": "obowiazuje", "akt objęty tekstem jednolitym": "tekst_jednolity_nieaktualny",
    "akt posiada tekst jednolity": "tekst_jednolity_nieaktualny", "wygaśnięcie aktu": "uchylony",
    "uznany za uchylony": "uchylony", "uchylony": "uchylony", "nieobowiązujący - uchylona podstawa prawna": "uchylony",
    "akt jednorazowy": "nieznany", "bez statusu": "nieznany" };
  for (const [k, v] of Object.entries(m)) assert.strictEqual(mapujStatusEli(k), v, k);
  console.log("OK: wszystkie 9 statusów ELI (zmierzone) → schemat 4 wartości"); }

{ const w = normalizujOdpowiedzELI(fx("eli_szukaj_kc"), "Kodeks cywilny");
  assert.strictEqual(w.status, "AMBIGUOUS");
  assert.ok(w.kandydaci.every((k) => k.tytul_lub_nazwa && k.status_obowiazywania && k.eli), "kandydat = tytuł + status + ELI");
  assert.ok(w.kandydaci.every((k) => ["obowiazuje", "uchylony", "tekst_jednolity_nieaktualny", "nieznany"].includes(k.status_obowiazywania)));
  console.log(`OK: wyszukiwanie „Kodeks cywilny” → AMBIGUOUS, ${w.kandydaci.length} kandydatów z tytułem i statusem`); }

{ assert.strictEqual(normalizujOdpowiedzELI([]).status, "NOT_FOUND");
  console.log("OK: brak pozycji → NOT_FOUND z zastrzeżeniem"); }
console.log("\nWSZYSTKIE TESTY JEDNOSTKOWE (bez sieci) PRZESZŁY");
