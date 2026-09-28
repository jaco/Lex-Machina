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
      status: "OUT_OF_SCOPE", // 27o: status wprost — kontrakt SYGNATURY.md; NOT_FOUND = „prawdopodobnie zmyślona”
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
      // 27p: zmierzone — w czasie „Przerwy technicznej” SAOS zwraca HTTP 200 ze stroną HTML.
      const typ = resp.headers.get("content-type") ?? "";
      if (!typ.includes("json")) {
        const t = (await resp.text()).slice(0, 2000);
        throw new Error(/Przerwa techniczna/i.test(t) ? "SAOS: przerwa techniczna (HTML zamiast JSON)" : `SAOS zwrócił ${typ || "brak typu"} zamiast JSON`);
      }
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
      "do weryfikacji Tier 1 (Zasada 5). Status: FOUND/NOT_FOUND/AMBIGUOUS/OUT_OF_SCOPE/ERROR.",
    inputSchema: {
      sygnatura: z.string().optional()
        .describe("Sygnatura do kontroli istnienia, np. 'II PK 291/09' (białe znaki istotne)"),
      fraza: z.string().optional().describe("Fraza pełnotekstowa (treść/teza/uzasadnienie)"),
      courtType: z.enum([
        "COMMON", "SUPREME", "CONSTITUTIONAL_TRIBUNAL", "NATIONAL_APPEAL_CHAMBER", "ADMINISTRATIVE",
      ]).optional().describe("Typ sądu. ADMINISTRATIVE zwraca status OUT_OF_SCOPE — SAOS nie ma NSA/WSA."),
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

// ── saos_cytator (AUDYT-2026-09-27q; luka F-212 wobec mcp-saos `saos_cite_check`) ────────────────
// Mechanika jak u konkurencji (pełnotekstowe wyszukanie późniejszych orzeczeń zawierających sygnaturę + skan
// fraz W OKNIE wokół KAŻDEGO wystąpienia sygnatury), implementacja i lista wzorców własne. Różnice:
// ścisłe dopasowanie sygnatury w treści (sam wynik wyszukiwarki nie wystarcza), wykluczenie orzeczenia
// cytowanego, osobno sygnały odstąpienia i kontekst uchwały poszerzonego składu.
// ⚠️ NIEZMIERZONE NA ŻYWO: 27q SAOS w „przerwie technicznej”; skuteczność wzorców — F-212 pkt 1.
const WZORCE_ODSTAPIENIA = [
  [/odst[ąa]pi\w*\s+od\s+(?:tego\s+|powyższego\s+)?(?:pogl[ąa]d|stanowisk|zapatrywa|lini)/iu, "odstąpienie od poglądu"],
  [/nie\s+podziela\w*\s+(?:tego\s+|powyższego\s+|wyra[żz]onego\s+)?(?:pogl[ąa]d|stanowisk|zapatrywa)/iu, "niepodzielenie poglądu"],
  [/(?:utraci[łl]\w*|traci)\s+(?:na\s+)?aktualno/iu, "utrata aktualności"],
  [/zdezaktualizowa/iu, "zdezaktualizowanie"],
  [/nie\s+zas[łl]ugu\w*\s+na\s+aprobat/iu, "brak aprobaty"],
  [/odmienn\w*\s+(?:ni[żz]|od)\s+(?:stanowisk|pogl[ąa]d|wyra[żz]on)/iu, "stanowisko odmienne"],
  [/pogl[ąa]d\w*\s+odosobnion/iu, "pogląd odosobniony"],
];
const WZORCE_KONTEKSTU = [
  [/uchwa[łl]\w*\s+(?:sk[łl]adu\s+siedmiu|pe[łl]nego\s+sk[łl]adu|ca[łl]ej\s+izby|po[łl][ąa]czonych\s+izb)/iu, "uchwała poszerzonego składu"],
  [/zagadnieni\w*\s+prawn\w*\s+(?:przedstawion|budz[ąa]c|wymagaj[ąa]c)/iu, "przedstawione zagadnienie prawne"],
];

export function regexSygnatury(syg) {
  const esc = String(syg).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s*\\?\/\s*/g, "\\s*/\\s*").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\d])${esc}(?![\\d])`, "giu");
}

/** Czysta funkcja: skan okien wokół każdego wystąpienia sygnatury w treści. */
export function skanujCytowanie(tekst, syg, okno = 700) {
  const t = String(tekst ?? "").replace(/<\/?em>/g, "").replace(/\s+/g, " ");
  const sygnaly = [], wid = new Set();
  for (const m of t.matchAll(regexSygnatury(syg))) {
    const fr = t.slice(Math.max(0, m.index - okno), m.index + m[0].length + okno);
    for (const [re, et] of WZORCE_ODSTAPIENIA) if (re.test(fr) && !wid.has(et)) { wid.add(et); sygnaly.push({ typ: "odstapienie", etykieta: et, fragment: fr.slice(0, 1400) }); }
    for (const [re, et] of WZORCE_KONTEKSTU) if (re.test(fr) && !wid.has(et)) { wid.add(et); sygnaly.push({ typ: "kontekst", etykieta: et, fragment: fr.slice(0, 1400) }); }
  }
  return { wystapienia: [...t.matchAll(regexSygnatury(syg))].length, sygnaly };
}

export function podsumujCytator(items, syg) {
  const baza = { query_type: "cytowania", source: "saos" };
  const norm = (x) => String(x).replace(/\s+/g, " ").replace(/\s*\/\s*/g, "/").trim().toUpperCase();
  const cyt = [];
  for (const it of items ?? []) {
    const wlasne = (it.courtCases ?? []).map((c) => norm(c.caseNumber));
    if (wlasne.includes(norm(syg))) continue; // samo orzeczenie cytowane
    const s = skanujCytowanie(it.textContent, syg);
    if (!s.wystapienia) continue; // wyszukiwarka trafiła, ale sygnatury w treści nie ma — odrzucone
    cyt.push({ identyfikator: (it.courtCases ?? []).map((c) => c.caseNumber).join("; "), sad: nazwaSadu(it),
      data_wyroku: it.judgmentDate ?? null, url_zrodlowy: it.id ? `https://www.saos.org.pl/judgments/${it.id}` : null,
      sygnaly: s.sygnaly, rola: "KANDYDAT" });
  }
  if (!cyt.length) return { status: "NOT_FOUND", ...baza, uwaga: `Brak orzeczeń w SAOS cytujących ${syg}. SAOS nie obejmuje NSA/WSA i nie jest kompletny — to nie dowód braku cytowań.` };
  cyt.sort((a, b) => String(b.data_wyroku).localeCompare(String(a.data_wyroku)));
  const odst = cyt.filter((c) => c.sygnaly.some((x) => x.typ === "odstapienie"));
  const kont = cyt.filter((c) => c.sygnaly.some((x) => x.typ === "kontekst"));
  return { status: "FOUND", ...baza,
    result: { identyfikator: syg, liczba_cytujacych: cyt.length, z_sygnalem_odstapienia: odst.length, z_kontekstem_uchwaly: kont.length,
      werdykt: odst.length ? `⚠️ Sygnały odstąpienia/krytyki w ${odst.length} z ${cyt.length} orzeczeń cytujących — przeczytaj fragmenty przed powołaniem.`
        : `Brak sygnałów odstąpienia w ${cyt.length} orzeczeniach cytujących (heurystyka).` },
    cytujace: cyt.slice(0, 20),
    uwaga: "Heurystyka językowa w oknie wokół sygnatury — nie zastępuje lektury. Wyniki = KANDYDACI. ⚠️ Wzorce niezmierzone na żywo (F-212 pkt 1).",
    retrieved_at: new Date().toISOString(), confidence: "candidate-only" };
}

server.registerTool("saos_cytator", {
  title: "SAOS — czy orzeczenie jest nadal aprobowane (późniejsze cytowania + sygnały odstąpienia)",
  description: "Późniejsze orzeczenia SN/SP/TK/KIO zawierające sygnaturę; w oknie wokół każdego wystąpienia wykrywa sygnały " +
    "odstąpienia od poglądu i kontekst uchwał poszerzonego składu. Heurystyka — wyniki są KANDYDATAMI.",
  inputSchema: {
    sygnatura: z.string().min(4).max(40).describe("np. III CZP 29/17"),
    dataOd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("tylko orzeczenia od tej daty (np. data orzeczenia cytowanego)"),
  },
}, async ({ sygnatura, dataOd }) => {
  try {
    const items = await pobierzZSaos({ fraza: sygnatura, dataOd, pageSize: 100 });
    return { content: [{ type: "text", text: JSON.stringify(podsumujCytator(items, sygnatura), null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", query_type: "cytowania", source: "saos", detail: String(e?.message ?? e), retrieved_at: new Date().toISOString() }, null, 2) }] };
  }
});

// ⛔ POPRAWKA 2026-09-27m: `import.meta.url === \`file://${process.argv[1]}\`` był fałszywy na Windows
//    (ukośniki, litera dysku) i dla każdej ścieżki ze spacją (URL koduje %20) — serwer się wczytywał,
//    ale NIE otwierał transportu, więc host nie widział narzędzi. Porównanie po normalizacji ścieżek.
if (!globalThis.__LEX_MCP_WSPOLNY && process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("saos-mcp-server: nasłuchuję na stdio (MCP)");
}
