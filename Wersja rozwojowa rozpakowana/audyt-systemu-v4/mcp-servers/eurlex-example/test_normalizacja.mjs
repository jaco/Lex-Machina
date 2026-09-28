// ⛔ 2026-09-27j: fixture'y to PRAWDZIWE odpowiedzi Cellar SPARQL z 2026-09-27 (fixtures/).
import { normalizujOdpowiedzEURLEX, budujZapytanieSparql } from "./eurlex-mcp-server.js";
import assert from "node:assert";
import { readFileSync } from "node:fs";
const fx = (c) => JSON.parse(readFileSync(new URL(`./fixtures/cellar_${c}.json`, import.meta.url)));

{ const w = normalizujOdpowiedzEURLEX(fx("32016R0679"), "32016R0679");
  assert.strictEqual(w.status, "FOUND");
  assert.strictEqual(w.result.status_obowiazywania, "obowiazuje");
  assert.match(w.result.tytul_lub_nazwa, /^Rozporządzenie Parlamentu Europejskiego i Rady \(UE\) 2016\/679/);
  assert.strictEqual(w.result.koniec_obowiazywania, null);
  console.log("OK: RODO — obowiązuje, tytuł po polsku"); }

{ const w = normalizujOdpowiedzEURLEX(fx("31995L0046"), "31995L0046");
  assert.strictEqual(w.result.status_obowiazywania, "uchylony");
  assert.strictEqual(w.result.koniec_obowiazywania, "2018-05-24");
  assert.match(w.uwaga, /Nie powołuj jako prawa obowiązującego/);
  console.log("OK: dyrektywa 95/46 — uchylona, data końca, ostrzeżenie"); }

{ const w = normalizujOdpowiedzEURLEX(fx("39999R9999"), "39999R9999");
  assert.strictEqual(w.status, "NOT_FOUND");
  console.log("OK: fikcyjny CELEX → NOT_FOUND"); }

{ assert.match(budujZapytanieSparql("32016R0679"), /"32016R0679"\^\^xsd:string/);
  assert.throws(() => budujZapytanieSparql('3" } ; DROP'), /Niepoprawny numer CELEX/);
  console.log("OK: literał typowany; wstrzyknięcie odrzucone"); }

console.log("\nWSZYSTKIE TESTY JEDNOSTKOWE (bez sieci) PRZESZŁY");
