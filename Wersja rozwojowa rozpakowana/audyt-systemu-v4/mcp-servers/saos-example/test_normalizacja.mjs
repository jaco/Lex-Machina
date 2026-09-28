// ⛔ 2026-09-27j: poprzednie fixture'y były WYMYŚLONE i miały ten sam błędny kształt co kod
// (caseNumber na poziomie trafienia) — test potwierdzał błąd zamiast go łapać.
// Obecne fixture'y to wycinki PRAWDZIWYCH odpowiedzi SAOS z 2026-09-27 (fixtures/).
import { normalizujOdpowiedzSAOS } from "./saos-mcp-server.js";
import assert from "node:assert";
import { readFileSync } from "node:fs";
const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/saos_${n}.json`, import.meta.url)));

{ const w = normalizujOdpowiedzSAOS(fx("SUPREME"), { sygnatura: "II PK 291/09" });
  assert.strictEqual(w.status, "FOUND");
  assert.strictEqual(w.result.identyfikator, "II PK 291/09");
  assert.match(w.result.sad, /^Sąd Najwyższy — Izba/);
  assert.strictEqual(w.result.rola, "KANDYDAT");
  assert.strictEqual(w.confidence, "candidate-only");
  console.log("OK: SN — sygnatura z courtCases, izba z division.chambers"); }

{ const w = normalizujOdpowiedzSAOS(fx("COMMON"));
  assert.ok(w.result.identyfikator, "identyfikator nie może być null");
  assert.match(w.result.sad, /^Sąd /);
  assert.ok(!/<em>/.test(w.result.fragment_tresci ?? ""), "znaczniki <em> usunięte");
  console.log("OK: sąd powszechny — sygnatura, nazwa sądu, fragment bez <em>"); }

{ const w = normalizujOdpowiedzSAOS(fx("NAC"));
  assert.match(w.result.identyfikator, /^KIO/);
  assert.strictEqual(w.result.sad, "Krajowa Izba Odwoławcza");
  console.log("OK: KIO — sygnatura i nazwa organu"); }

{ const w = normalizujOdpowiedzSAOS([]);
  assert.strictEqual(w.status, "NOT_FOUND");
  assert.match(w.uwaga, /nie jest dowodem/);
  console.log("OK: NOT_FOUND z zastrzeżeniem"); }

{ const w = normalizujOdpowiedzSAOS([], { courtType: "ADMINISTRATIVE" });
  assert.strictEqual(w.zakres, "OUT_OF_SCOPE");
  assert.strictEqual(w.snapshot, "🟨");
  console.log("OK: NSA/WSA → OUT_OF_SCOPE, nie „brak orzecznictwa”"); }

{ const w = normalizujOdpowiedzSAOS([...fx("COMMON"), ...fx("SUPREME")]);
  assert.strictEqual(w.status, "AMBIGUOUS");
  assert.ok(w.kandydaci.every((k) => k.identyfikator));
  console.log("OK: AMBIGUOUS — każdy kandydat z sygnaturą"); }

console.log("\nWSZYSTKIE TESTY JEDNOSTKOWE (bez sieci) PRZESZŁY");
