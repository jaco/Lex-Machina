#!/usr/bin/env node
/**
 * krs-mcp-server.js — serwer MCP dla Otwartego API Krajowego Rejestru
 * Sądowego (KRS), uruchomionego przez Ministerstwo Sprawiedliwości w 2022 r.
 * na podstawie ustawy o otwartych danych (zbadane i potwierdzone jako
 * publiczne, bez logowania — sesja 2026-07-13j/k).
 *
 * Zgodne z protokołem shared/MCP-INTEGRACJA.md i schematem
 * shared/SCHEMAT-ODPOWIEDZI-MCP.md.
 *
 * ⚠️ STATUS UCZCIWY: protokół MCP zweryfikowany realnym klientem (patrz
 * test_protokol_mcp.mjs). Kształt odpowiedzi API OPARTY na publicznie
 * udokumentowanym wzorcu endpointu "odpis aktualny" (api-krs.ms.gov.pl/api/
 * krs/OdpisAktualny/{numerKRS}?rejestr=P&format=json) — NIE zostało to
 * potwierdzone żywym wywołaniem z tego środowiska (brak dostępu do domen
 * .gov.pl w sandboksie). Struktura JSON (pole `odpis.dane.dzial1...`) jest
 * wzorowana na oficjalnej dokumentacji Ministerstwa Sprawiedliwości, ale
 * MUSI zostać potwierdzona przez developera przy pierwszym uruchomieniu.
 *
 * Narzędzie: `krs_lookup` (nazwa zgodna z shared/KONEKTORY-REKOMENDOWANE.md).
 *
 * Szczególnie istotne dla PODMIOT-GATE w prawny-router-v3, który weryfikuje
 * status podmiotu/organu przed generowaniem pism.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KRS_BASE_URL = "https://api-krs.ms.gov.pl/api/krs";

const server = globalThis.__LEX_MCP_WSPOLNY ?? new McpServer({ name: "krs-connector", version: "1.1.0" });

// ⛔ POPRAWKA 2026-09-27q (AUDYT-2026-09-27q) — zmierzone na żywym API KRS:
//  (1) tylko rejestr=P → fundacje i stowarzyszenia (rejestr S) dawały NOT_FOUND jak nieistniejący podmiot
//      (Fundacja WOŚP 0000030897: P → 404, S → 200). Teraz P, potem S.
//  (2) status „wykreslony” spoza schematu 4 wartości → „uchylony” + status_rejestru.
//  (3) NOWE `krs_reprezentacja` (luka F-212 wobec mcp-krs `get_board`): organ, sposób reprezentacji,
//      skład z `czyZawieszona`, prokurenci, organ nadzoru, stan rejestru. Pole organu to `nazwaOrganu` —
//      konkurencja czyta `nazwa` (brak w API) i nazwy organu nie pokazuje nigdy.
//  (4) PESEL w WOLNYM tekście: rejestr maskuje pola strukturalne, ale „rodzajProkury” ORLEN (0000028860)
//      zawiera pełne nazwisko i niezamaskowany PESEL innej osoby — maskowane tu, spójnie z API.

export function maskujPesel(t) {
  return typeof t === "string" ? t.replace(/(PESEL\s*:?\s*)(\d)\d{10}/gi, "$1$2**********").replace(/\b(\d)\d{10}\b/g, "$1**********") : t;
}
const osoba = (o) => [o?.imiona?.imie, o?.imiona?.imieDrugie, o?.nazwisko?.nazwiskoICzlon, o?.nazwisko?.nazwiskoCzlonPierwszy]
  .filter(Boolean).join(" ") || null;
const naglowek = (raw) => raw?.odpis?.naglowekA ?? {};

/** Normalizuje odpis aktualny (P albo S) do SCHEMAT-ODPOWIEDZI-MCP. Czysta funkcja. */
export function normalizujOdpowiedzKRS(raw, numerKrs) {
  if (raw?.status === 404 || raw == null) {
    return { status: "NOT_FOUND", query_type: "podmiot", source: "krs",
      uwaga: "Brak w rejestrze przedsiębiorców (P) i stowarzyszeń/fundacji (S). Sprawdź numer." };
  }
  const n = naglowek(raw);
  const dp = raw?.odpis?.dane?.dzial1?.danePodmiotu ?? {};
  const nazwa = dp.nazwa ?? dp.nazwaPodmiotu ?? null;
  if (!nazwa) return { status: "NOT_FOUND", query_type: "podmiot", source: "krs" };
  // pole wykreślenia — ⚠️ niezmierzone na podmiocie wykreślonym (brak przypadku testowego)
  const wykreslony = Boolean(raw?.odpis?.dane?.dzial6?.wykreslenie?.czyWykreslono || n.dataWykresleniaZRejestru);
  const w = {
    status: "FOUND", query_type: "podmiot", source: "krs",
    result: {
      identyfikator: `KRS ${numerKrs}`,
      tytul_lub_nazwa: nazwa,
      status_obowiazywania: wykreslony ? "uchylony" : "obowiazuje",
      status_rejestru: wykreslony ? "wykreślony" : "wpisany",
      rejestr: n.rejestr === "RejS" ? "S (stowarzyszenia, fundacje, SPZOZ)" : "P (przedsiębiorcy)",
      forma_prawna: dp.formaPrawna ?? null,
      data_publikacji_lub_wyroku: n.stanZDnia ?? null,
      stan_z_dnia: n.stanZDnia ?? null,
      data_ostatniego_wpisu: n.dataOstatniegoWpisu ?? null,
      url_zrodlowy: `https://prs.ms.gov.pl/krs/podglad-informacji-aktualnej/${numerKrs}`,
    },
    retrieved_at: new Date().toISOString(),
    confidence: "deterministic",
  };
  if (wykreslony) w.uwaga = "⛔ Podmiot wykreślony z KRS.";
  return w;
}

/** Reprezentacja z działu 2 odpisu aktualnego. Czysta funkcja. */
export function normalizujReprezentacje(raw, numerKrs) {
  const podst = normalizujOdpowiedzKRS(raw, numerKrs);
  if (podst.status !== "FOUND") return podst;
  const d2 = raw.odpis.dane.dzial2 ?? {};
  const rep = d2.reprezentacja ?? {};
  const sklad = (rep.sklad ?? []).map((o) => ({ funkcja: o.funkcjaWOrganie ?? null, osoba_maska: osoba(o),
    zawieszony: o.czyZawieszona === true }));
  const prokurenci = (d2.prokurenci ?? []).map((p) => ({ osoba_maska: osoba(p), rodzaj_prokury: maskujPesel(p.rodzajProkury ?? null) }));
  const nadzor = (d2.organNadzoru ?? []).map((o) => ({ nazwa: o.nazwa ?? null, liczba_czlonkow: (o.sklad ?? []).length }));
  const r = podst.result;
  r.reprezentacja = {
    organ: rep.nazwaOrganu ?? null,
    sposob_reprezentacji: maskujPesel(rep.sposobReprezentacji ?? null),
    sklad, prokurenci, organ_nadzoru: nadzor,
  };
  const uw = [`Stan rejestru na dzień ${r.stan_z_dnia} (ostatni wpis ${r.data_ostatniego_wpisu}); wnioski w toku nie są widoczne w odpisie.`,
    "Imiona i nazwiska zamaskowane przez rejestr; PESEL w treści wolnej zamaskowany przez konektor."];
  const zaw = sklad.filter((s) => s.zawieszony);
  if (zaw.length) uw.unshift(`⚠️ Zawieszeni w czynnościach: ${zaw.map((s) => s.funkcja).join(", ")}.`);
  if (!rep.sposobReprezentacji) uw.unshift("⚠️ Odpis nie zawiera sposobu reprezentacji — ustal z umowy/statutu.");
  podst.uwaga = [podst.uwaga, ...uw].filter(Boolean).join(" ");
  return podst;
}

async function pobierzZKrs(numerKrs) {
  let ostatni;
  for (const rejestr of ["P", "S"]) {
    for (let proba = 1; proba <= 3; proba++) {
      try {
        const resp = await fetch(`${KRS_BASE_URL}/OdpisAktualny/${numerKrs}?rejestr=${rejestr}&format=json`, { signal: AbortSignal.timeout(20000) });
        if (resp.status === 404) { ostatni = null; break; }
        if (!resp.ok) throw new Error(`API KRS zwróciło HTTP ${resp.status}`);
        return await resp.json();
      } catch (e) { ostatni = e; }
    }
    if (ostatni) throw ostatni;
  }
  return { status: 404 };
}

const odpowiedz = (w) => ({ content: [{ type: "text", text: JSON.stringify(w, null, 2) }] });
const blad = (err) => ({ status: "ERROR", query_type: "podmiot", source: "krs", detail: String(err?.message ?? err), retrieved_at: new Date().toISOString() });
const NUMER = z.string().regex(/^\d{1,10}$/).transform((s) => s.padStart(10, "0")).describe("Numer KRS (zera wiodące opcjonalne)");

server.registerTool("krs_lookup", {
  title: "Podmiot w KRS — istnienie, nazwa, forma, rejestr (P i S)",
  description: "Odpis aktualny z KRS po numerze: rejestr przedsiębiorców (P) albo stowarzyszeń/fundacji (S). " +
    "PODMIOT-GATE: czy podmiot istnieje i nie jest wykreślony. FOUND/NOT_FOUND/ERROR.",
  inputSchema: { numerKrs: NUMER },
}, async ({ numerKrs }) => {
  try { return odpowiedz(normalizujOdpowiedzKRS(await pobierzZKrs(numerKrs), numerKrs)); }
  catch (e) { return odpowiedz(blad(e)); }
});

server.registerTool("krs_reprezentacja", {
  title: "KRS — kto i jak reprezentuje podmiot (zarząd, sposób reprezentacji, prokura)",
  description: "Dział 2 odpisu aktualnego: organ, sposób reprezentacji, skład (z zawieszeniem), prokurenci, organ " +
    "nadzoru, stan rejestru na dzień. Do weryfikacji umocowania osób podpisujących.",
  inputSchema: { numerKrs: NUMER },
}, async ({ numerKrs }) => {
  try { return odpowiedz(normalizujReprezentacje(await pobierzZKrs(numerKrs), numerKrs)); }
  catch (e) { return odpowiedz(blad(e)); }
});

// ⛔ POPRAWKA 2026-09-27m: `import.meta.url === \`file://${process.argv[1]}\`` był fałszywy na Windows
//    (ukośniki, litera dysku) i dla każdej ścieżki ze spacją (URL koduje %20) — serwer się wczytywał,
//    ale NIE otwierał transportu, więc host nie widział narzędzi. Porównanie po normalizacji ścieżek.
if (!globalThis.__LEX_MCP_WSPOLNY && process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("krs-mcp-server: nasłuchuję na stdio (MCP)");
}
