// ⛔ 2026-09-27j: poprzedni test utrwalał błąd — „weekend → NOT_FOUND” był asercją POZYTYWNĄ.
// Fixture: prawdziwa odpowiedź zakresowa NBP 2026-09-12..2026-09-26 (fixtures/).
import { normalizujOdpowiedzNBP } from "./nbp-mcp-server.js";
import assert from "node:assert";
import { readFileSync } from "node:fs";
const raw = JSON.parse(readFileSync(new URL("./fixtures/nbp_eur_zakres.json", import.meta.url)));

{ const w = normalizujOdpowiedzNBP(raw, "eur", "2026-09-26"); // sobota
  assert.strictEqual(w.status, "FOUND");
  assert.strictEqual(w.result.data_tabeli, "2026-09-25");
  assert.strictEqual(w.result.przesuniecie_dni, 1);
  assert.match(w.uwaga, /nie opublikował tabeli A z dnia 2026-09-26/);
  console.log("OK: sobota → tabela z piątku, przesunięcie jawne"); }

{ const w = normalizujOdpowiedzNBP(raw, "eur", "2026-09-25"); // dzień roboczy
  assert.strictEqual(w.result.przesuniecie_dni, 0);
  assert.strictEqual(w.uwaga, undefined);
  console.log("OK: dzień roboczy → tabela z tego dnia, bez ostrzeżenia"); }

{ const w = normalizujOdpowiedzNBP(raw, "eur", "2026-09-20"); // niedziela w środku okna
  assert.strictEqual(w.result.data_tabeli, "2026-09-18");
  assert.strictEqual(w.result.przesuniecie_dni, 2);
  console.log("OK: niedziela → piątek, nie późniejsza tabela z okna"); }

{ const w = normalizujOdpowiedzNBP(null, "eur", "2026-09-26");
  assert.strictEqual(w.status, "NOT_FOUND");
  console.log("OK: brak tabel w całym oknie → NOT_FOUND"); }

console.log("\nWSZYSTKIE TESTY JEDNOSTKOWE (bez sieci) PRZESZŁY");
