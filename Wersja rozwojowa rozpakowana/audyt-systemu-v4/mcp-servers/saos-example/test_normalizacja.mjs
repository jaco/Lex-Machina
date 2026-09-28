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
  assert.strictEqual(w.status, "OUT_OF_SCOPE");
  assert.strictEqual(w.snapshot, "🟨");
  console.log("OK: NSA/WSA → OUT_OF_SCOPE, nie „brak orzecznictwa”"); }

{ const w = normalizujOdpowiedzSAOS([...fx("COMMON"), ...fx("SUPREME")]);
  assert.strictEqual(w.status, "AMBIGUOUS");
  assert.ok(w.kandydaci.every((k) => k.identyfikator));
  console.log("OK: AMBIGUOUS — każdy kandydat z sygnaturą"); }

console.log("\nWSZYSTKIE TESTY JEDNOSTKOWE (bez sieci) PRZESZŁY");

// ── saos_cytator: logika (kształt odpowiedzi z PRAWDZIWYCH fixture'ów SAOS; treść okna — konstrukcja testowa,
//    bo SAOS 27q w przerwie technicznej; skuteczność wzorców na żywo — F-212 pkt 1) ─────────────────────
import { skanujCytowanie, podsumujCytator, regexSygnatury } from "./saos-mcp-server.js";
{ const baza = fx("SUPREME")[0];
  const cyt = { ...baza, id: 1, courtCases: [{ caseNumber: "I CSK 1/20" }], judgmentDate: "2020-05-05",
    textContent: "… Sąd Najwyższy w składzie niniejszym nie podziela poglądu wyrażonego w wyroku z dnia 1 lutego 2010 r., II  PK 291 / 09, …" };
  const neutr = { ...baza, id: 2, courtCases: [{ caseNumber: "II PK 5/21" }], judgmentDate: "2021-01-01", textContent: "… por. wyrok SN z 2010 r., II PK 291/09 …" };
  const falsz = { ...baza, id: 3, courtCases: [{ caseNumber: "II PK 6/21" }], textContent: "… II PK 291/099 oraz II PK 2910/09 …" };
  assert.ok(regexSygnatury("II PK 291/09").test("sygn. II  PK 291 / 09."));
  assert.strictEqual(skanujCytowanie(falsz.textContent, "II PK 291/09").wystapienia, 0, "291/099 i 2910/09 to inne sygnatury");
  const w = podsumujCytator([baza, cyt, neutr, falsz], "II PK 291/09");
  assert.strictEqual(w.status, "FOUND"); assert.strictEqual(w.result.liczba_cytujacych, 2, "samo orzeczenie i fałszywe trafienie wykluczone");
  assert.strictEqual(w.result.z_sygnalem_odstapienia, 1); assert.match(w.result.werdykt, /^⚠️/);
  assert.strictEqual(w.cytujace.find((c) => c.identyfikator === "I CSK 1/20").sygnaly[0].etykieta, "niepodzielenie poglądu");
  assert.strictEqual(podsumujCytator([baza], "II PK 291/09").status, "NOT_FOUND");
  console.log("OK: cytator — ścisłe dopasowanie sygnatury, wykluczenie cytowanego i fałszywych trafień, sygnał w oknie");
  console.log("\nWSZYSTKIE TESTY saos_cytator PRZESZŁY"); }
