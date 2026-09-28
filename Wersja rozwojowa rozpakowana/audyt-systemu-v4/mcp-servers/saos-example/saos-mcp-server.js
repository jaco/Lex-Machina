#!/usr/bin/env node
/**
 * saos-mcp-server.js — REALNY, uruchamialny serwer MCP dla SAOS REST API
 * (orzeczenia sądów powszechnych i SN), zgodny z protokołem opisanym w
 * shared/MCP-INTEGRACJA.md i schematem odpowiedzi z
 * shared/SCHEMAT-ODPOWIEDZI-MCP.md.
 *
 * Kształt odpowiedzi API oparty na dokumentacji już istniejącej w
 * orzeczenia-sadowe-v2/SKILL.md (sekcja 1-T.1 — Faza 1-T, opisana przed tą
 * sesją, niezależnie zweryfikowana wcześniej przez autorów tego skilla):
 * pola caseNumber, judgmentDate, division.court.name / chambers (SN),
 * textContent (fragment), href. To NIE jest zgadywanie jak w przypadku ISAP —
 * ale nadal NIE zostało to potwierdzone żywym wywołaniem z tego środowiska
 * (saos.org.pl nie jest w dozwolonej liście domen sandboxa).
 *
 * ✅ STATUS 2026-09-27j: zmierzone na żywym API (test_na_zywo.mjs) — patrz blok POPRAWKA niżej.
 * ⛔ Nazwy pól z orzeczenia-sadowe-v2 ≤2.20 były błędne (caseNumber na poziomie trafienia).
 *
 * ⚠️ WAŻNE (zgodnie z orzeczenia-sadowe-v2, Zasada 5 / Faza 1-T.1): SAOS to
 * projekt akademicki (ICM UW), pełni WYŁĄCZNIE rolę wsparcia/wyszukania
 * kandydatów — NIE jest samodzielnym źródłem weryfikacji. Ten connector,
 * zgodnie z KROK 2 z shared/MCP-INTEGRACJA.md, zwraca wynik jako kandydata
 * do potwierdzenia, nigdy jako ostateczne potwierdzenie sygnatury.
 *
 * Narzędzie udostępniane: `saos_search` — nazwa zgodna z konwencją z
 * shared/KONEKTORY-REKOMENDOWANE.md.
 *
 * Uruchomienie:
 *   node saos-mcp-server.js
 *
 * Konfiguracja w kliencie MCP:
 *   {
 *     "mcpServers": {
 *       "saos": {
 *         "command": "node",
 *         "args": ["/sciezka/do/saos-mcp-server.js"]
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ⭐ USTALENIE 2026-09-27h: SAOS zawiera także orzeczenia KIO — courtType=NATIONAL_APPEAL_CHAMBER
//    zwraca 22 168 orzeczeń (sygnatury typu "KIO/UZP 2/07"). Osobny konektor do KIO jest zbędny.
const SAOS_BASE_URL = "https://www.saos.org.pl/api/search/judgments";

const server = globalThis.__LEX_MCP_WSPOLNY ?? new McpServer({
  name: "saos-connector",
  version: "1.1.0",
});

// ⛔ POPRAWKA 2026-09-27j (AUDYT-2026-09-27j) — zmierzone na żywym API:
//  (1) Sygnatura NIE leży w `item.caseNumber`, tylko w `item.courtCases[].caseNumber`.
//      Poprzedni kod zwracał `identyfikator: null` dla KAŻDEGO trafienia. Błąd przeniesiony
//      z orzeczenia-sadowe-v2 § 1-T.1 pkt 2 (poprawione tamże w 2.21).
//  (2) Izba SN: `division.chambers[].name`, nie `item.chambers`.
//  (3) `caseNumber=` jako PARAMETR zapytania to kontrola istnienia sygnatury (V-SYG-0):
//      „II PK 291/09" → 1 trafienie, fabrykat „III CZP 999/11" → 0. Narzędzie tego nie
//      udostępniało — dodany parametr `sygnatura`.
//  (4) courtType=ADMINISTRATIVE → totalResults 0 dla KAŻDEGO zapytania (także bez frazy),
//      przy 74 571 trafieniach tej samej frazy bez filtra. SAOS nie ma NSA/WSA. Zwracamy
//      zakres OUT_OF_SCOPE, nigdy „brak orzecznictwa". Właściwe źródło: CBOSA.
//  (5) enum courtType uzupełniony o CONSTITUTIONAL_TRIBUNAL (107 trafień testowych)
//      i NATIONAL_APPEAL_CHAMBER (KIO, 22 168).
//  (6) V-SYG-0: min. 3 próby, timeout 45 s (F-171: 5 z 8 wywołań bez odpowiedzi).
//  (7) textContent zawiera znaczniki <em> z podświetlenia — usuwane.

const PROBY = 3;
const TIMEOUT_MS = 45000;

function czysc(t) {
  return typeof t === "string" ? t.replace(/<\/?em>/g, "").replace(/\s+/g, " ").trim() : null;
}

function nazwaSadu(item) {
  const d = item?.division;
  if (d?.court?.name) return d.court.name;
  if (Array.isArray(d?.chambers) && d.chambers.length) {
    return "Sąd Najwyższy — " + d.chambers.map((c) => c.name).join(", ");
  }
  const mapa = {
    SUPREME: "Sąd Najwyższy",
    CONSTITUTIONAL_TRIBUNAL: "Trybunał Konstytucyjny",
    NATIONAL_APPEAL_CHAMBER: "Krajowa Izba Odwoławcza",
  };
  return mapa[item?.courtType] ?? item?.courtType ?? "nieznany sąd";
}

/**
 * Normalizuje surową odpowiedź SAOS do schematu z shared/SCHEMAT-ODPOWIEDZI-MCP.md.
 * Czysta funkcja — testowalna bez sieci. Każdy wynik to KANDYDAT (Zasada 5).
 */
export function normalizujOdpowiedzSAOS(rawItems, kontekst = {}) {
  if (kontekst.courtType === "ADMINISTRATIVE") {
    return {
      status: "NOT_FOUND",
      zakres: "OUT_OF_SCOPE",
      query_type: "orzeczenie",
      source: "saos",
      uwaga:
        "SAOS nie zawiera orzeczeń NSA/WSA (zmierzone 2026-09-27: totalResults=0 dla każdego " +
        "zapytania). Brak trafień NIE jest dowodem braku orzecznictwa — źródło właściwe: CBOSA.",
      snapshot: "🟨",
    };
  }
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    const w = { status: "NOT_FOUND", query_type: "orzeczenie", source: "saos" };
    w.uwaga = kontekst.sygnatura
      ? "caseNumber: 0 dopasowań w SAOS. SAOS nie jest wyczerpujący — przed uznaniem sygnatury " +
        "za nieistniejącą sprawdź źródło Tier 1 (SYGNATURY.md, V-SYG-0)."
      : "Zero trafień nie jest dowodem nieistnienia orzeczenia.";
    return w;
  }

  const zmapowane = rawItems.map((item) => {
    const sygn = (item.courtCases ?? []).map((c) => c.caseNumber).filter(Boolean);
    return {
      identyfikator: sygn.length ? sygn.join("; ") : null,
      sad: nazwaSadu(item),
      typ_sadu: item.courtType ?? null,
      rodzaj: item.judgmentType ?? null,
      data_wyroku: item.judgmentDate ?? null,
      fragment_tresci: czysc(item.textContent)?.slice(0, 300) ?? null,
      url_zrodlowy: item.id ? `https://www.saos.org.pl/judgments/${item.id}` : item.href ?? null,
      url_api: item.href ?? null,
      rola: "KANDYDAT", // SAOS = wsparcie, nie weryfikacja — Zasada 5 orzeczenia-sadowe-v2
    };
  });

  if (zmapowane.length > 1) {
    return { status: "AMBIGUOUS", query_type: "orzeczenie", source: "saos", kandydaci: zmapowane };
  }
  return {
    status: "FOUND",
    query_type: "orzeczenie",
    source: "saos",
    result: zmapowane[0],
    retrieved_at: new Date().toISOString(),
    confidence: "candidate-only", // NIE "deterministic" — wymaga weryfikacji Tier 1
  };
}

async function pobierzZSaos(params) {
  const qs = new URLSearchParams();
  if (params.sygnatura) qs.set("caseNumber", params.sygnatura);
  if (params.fraza) qs.set("all", params.fraza);
  if (params.courtType) qs.set("courtType", params.courtType);
  if (params.dataOd) qs.set("judgmentDateFrom", params.dataOd);
  if (params.dataDo) qs.set("judgmentDateTo", params.dataDo);
  qs.set("pageSize", String(params.pageSize ?? 10));
  const url = `${SAOS_BASE_URL}?${qs.toString()}`;

  let ostatni;
  for (let proba = 1; proba <= PROBY; proba++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`SAOS API zwróciło HTTP ${resp.status}`);
      const dane = await resp.json();
      return dane.items ?? [];
    } catch (e) {
      ostatni = e;
    }
  }
  throw new Error(`${ostatni?.message ?? ostatni} (po ${PROBY} próbach, V-SYG-0)`);
}

server.registerTool(
  "saos_search",
  {
    title: "Wyszukiwanie orzeczeń w SAOS (System Analizy Orzeczeń Sądowych)",
    description:
      "SAOS REST API (ICM UW): sądy powszechne, SN, TK, KIO. BEZ NSA/WSA (użyj CBOSA). " +
      "Parametr `sygnatura` = kontrola istnienia (dokładne dopasowanie caseNumber); " +
      "`fraza` = wyszukiwanie treści (NIE potwierdza bytu sygnatury). Zwraca KANDYDATÓW " +
      "do weryfikacji Tier 1 (Zasada 5). Status: FOUND/NOT_FOUND/AMBIGUOUS/ERROR.",
    inputSchema: {
      sygnatura: z.string().optional()
        .describe("Sygnatura do kontroli istnienia, np. 'II PK 291/09' (białe znaki istotne)"),
      fraza: z.string().optional().describe("Fraza pełnotekstowa (treść/teza/uzasadnienie)"),
      courtType: z.enum([
        "COMMON", "SUPREME", "CONSTITUTIONAL_TRIBUNAL", "NATIONAL_APPEAL_CHAMBER", "ADMINISTRATIVE",
      ]).optional().describe("Typ sądu. ADMINISTRATIVE zwraca OUT_OF_SCOPE — SAOS nie ma NSA/WSA."),
      dataOd: z.string().optional().describe("Data początkowa, format yyyy-MM-dd"),
      dataDo: z.string().optional().describe("Data końcowa, format yyyy-MM-dd"),
      pageSize: z.number().int().min(1).max(100).optional().describe("Liczba wyników (domyślnie 10)"),
    },
  },
  async ({ sygnatura, fraza, courtType, dataOd, dataDo, pageSize }) => {
    let wynik;
    if (!sygnatura && !fraza) {
      wynik = { status: "ERROR", query_type: "orzeczenie", source: "saos",
        detail: "Podaj `sygnatura` albo `fraza`.", retrieved_at: new Date().toISOString() };
    } else if (courtType === "ADMINISTRATIVE") {
      wynik = normalizujOdpowiedzSAOS([], { courtType, sygnatura });
    } else {
      try {
        const items = await pobierzZSaos({ sygnatura, fraza, courtType, dataOd, dataDo, pageSize });
        wynik = normalizujOdpowiedzSAOS(items, { courtType, sygnatura });
      } catch (err) {
        wynik = { status: "ERROR", query_type: "orzeczenie", source: "saos",
          detail: String(err?.message ?? err), retrieved_at: new Date().toISOString() };
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(wynik, null, 2) }] };
  }
);

// ⛔ POPRAWKA 2026-09-27m: `import.meta.url === \`file://${process.argv[1]}\`` był fałszywy na Windows
//    (ukośniki, litera dysku) i dla każdej ścieżki ze spacją (URL koduje %20) — serwer się wczytywał,
//    ale NIE otwierał transportu, więc host nie widział narzędzi. Porównanie po normalizacji ścieżek.
if (!globalThis.__LEX_MCP_WSPOLNY && process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("saos-mcp-server: nasłuchuję na stdio (MCP)");
}
