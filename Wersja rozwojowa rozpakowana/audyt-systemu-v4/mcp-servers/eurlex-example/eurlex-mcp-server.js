#!/usr/bin/env node
/**
 * eurlex-mcp-server.js — serwer MCP dla CELLAR SPARQL endpoint (EUR-Lex),
 * potwierdzonego jako w pełni publiczne API bez autoryzacji — najczęściej
 * referencjonowane źródło w skillach DR tego systemu (32 odwołania,
 * sesja 2026-07-13j).
 *
 * ⚠️ STATUS UCZCIWY — NAJWYŻSZA NIEPEWNOŚĆ CO DO KSZTAŁTU ZAPYTANIA ZE
 * WSZYSTKICH 6 SERWERÓW Z TEJ SESJI: CELLAR to endpoint SPARQL (semantyczny,
 * RDF/CDM ontology), nie prosty REST z płaskim JSON jak KRS/NBP/SUDOP.
 * Poniższe zapytanie SPARQL jest uproszczonym przybliżeniem na podstawie
 * publicznej dokumentacji (szukanie dokumentu po numerze CELEX) — realna
 * ontologia CDM ma dziesiątki predykatów, a dokładna struktura zapytania
 * wymaga weryfikacji względem aktualnego schematu CDM (eur-lex.europa.eu
 * /content/help/data-reuse/reuse-contents-eurlex-details.html) przez
 * developera ZNAJĄCEGO SPARQL, zanim trafi to na produkcję.
 *
 * Limity endpointu (z dokumentacji, sesja 2026-07-13j): timeout zapytania 60s,
 * max 5 równoległych połączeń per IP, wyniki >10 000 wierszy wymagają paginacji.
 *
 * Narzędzie: `eurlex_lookup`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ⛔ POPRAWKA 2026-09-27j (AUDYT-2026-09-27j) — diagnoza z 27h była BŁĘDNA.
//    27h: „SPARQL zwraca 406 przy Accept: application/json”. Zmierzone 27j: SPARQL zwraca
//    200 przy KAŻDYM z nagłówków (application/json, application/sparql-results+json),
//    GET i POST. Rzeczywiste przyczyny:
//    (1) 406: `format=application/sparql-results+json` doklejone BEZ kodowania — `+` w
//        query stringu to spacja, serwer dostawał „sparql-results json”.
//    (2) UKRYTY błąd pod spodem: literał bez typu ("32016R0679") zwraca PUSTE wyniki.
//        Sama naprawa (1) dałaby NOT_FOUND dla RODO — ciche fałszywe „akt nie istnieje”.
//        Wymagany literał typowany ^^xsd:string.
//    (3) CELEX był wklejany do zapytania bez walidacji (wstrzyknięcie SPARQL).
//    (4) Zapytanie nie pobierało statusu obowiązywania ani tytułu PL; zwracało zawsze
//        „obowiazuje”. Teraz: cdm:resource_legal_in-force + data końca + tytuł POL.
//    Kontrola: 32016R0679 → true; 31995L0046 → false, koniec 2018-05-24; fikcyjny → 0 wyników.
//    Pełny TEKST aktu: Cellar REST (Accept: application/xhtml+xml + Accept-Language: pol),
//    nie ten konektor — F-135: strona EUR-Lex ucina długie akty.
const CELLAR_SPARQL_URL = "https://publications.europa.eu/webapi/rdf/sparql";
const CELEX_RE = /^[0-9CE][0-9]{4}[A-Z]{1,2}[0-9A-Z()_.\-]{1,20}$/;

const server = globalThis.__LEX_MCP_WSPOLNY ?? new McpServer({ name: "eurlex-connector", version: "1.1.0" });

export function budujZapytanieSparql(celex) {
  if (!CELEX_RE.test(celex)) throw new Error(`Niepoprawny numer CELEX: ${celex}`);
  return `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?work (SAMPLE(?t) AS ?title) (SAMPLE(?d) AS ?date) (SAMPLE(?f) AS ?inforce) (SAMPLE(?e) AS ?end)
WHERE {
  ?work cdm:resource_legal_id_celex "${celex}"^^xsd:string .
  OPTIONAL { ?work cdm:work_date_document ?d . }
  OPTIONAL { ?work cdm:resource_legal_in-force ?f . }
  OPTIONAL { ?work cdm:resource_legal_date_end-of-validity ?e . }
  OPTIONAL { ?x cdm:expression_belongs_to_work ?work ;
                cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/POL> ;
                cdm:expression_title ?t . }
} GROUP BY ?work LIMIT 5`.trim();
}

function statusObowiazywania(v) {
  if (v === "1" || v === "true") return "obowiazuje";
  if (v === "0" || v === "false") return "uchylony";
  return "nieznany";
}

/** Normalizuje wynik SPARQL ({"results":{"bindings":[...]}}) do SCHEMAT-ODPOWIEDZI-MCP. */
export function normalizujOdpowiedzEURLEX(rawBindings, celex) {
  if (!Array.isArray(rawBindings) || rawBindings.length === 0) {
    return { status: "NOT_FOUND", query_type: "akt_prawny_ue", source: "eur-lex",
      uwaga: "Brak dzieła o tym numerze CELEX w Cellar. Sprawdź format numeru." };
  }
  if (rawBindings.length > 1) {
    return { status: "AMBIGUOUS", query_type: "akt_prawny_ue", source: "eur-lex",
      kandydaci: rawBindings.map((b) => ({ work: b.work?.value, tytul: b.title?.value ?? null })) };
  }
  const b = rawBindings[0];
  const status = statusObowiazywania(b.inforce?.value);
  const koniec = b.end?.value && !b.end.value.startsWith("9999") ? b.end.value : null;
  const wynik = {
    status: "FOUND",
    query_type: "akt_prawny_ue",
    source: "eur-lex",
    result: {
      identyfikator: `CELEX:${celex}`,
      tytul_lub_nazwa: b.title?.value ?? null,
      status_obowiazywania: status,
      data_publikacji_lub_wyroku: b.date?.value ?? null,
      koniec_obowiazywania: koniec,
      url_zrodlowy: `https://eur-lex.europa.eu/legal-content/PL/TXT/?uri=CELEX:${celex}`,
      cellar_work: b.work?.value ?? null,
    },
    retrieved_at: new Date().toISOString(),
    confidence: "deterministic",
  };
  if (!b.title?.value) wynik.uwaga = "Brak tytułu w wersji polskiej w Cellar.";
  if (status === "uchylony") {
    wynik.uwaga = `⛔ Akt nie obowiązuje${koniec ? ` od dnia następnego po ${koniec}` : ""} ` +
      `(uchylony lub wygasły). Nie powołuj jako prawa obowiązującego.`;
  }
  return wynik;
}

async function pobierzZCellar(celex) {
  const body = new URLSearchParams({ query: budujZapytanieSparql(celex) });
  let ostatni;
  for (let proba = 1; proba <= 3; proba++) {
    try {
      const resp = await fetch(CELLAR_SPARQL_URL, {
        method: "POST",
        headers: { Accept: "application/sparql-results+json" },
        body,
        signal: AbortSignal.timeout(40000),
      });
      if (!resp.ok) throw new Error(`CELLAR SPARQL zwrócił HTTP ${resp.status}`);
      const dane = await resp.json();
      return dane?.results?.bindings ?? [];
    } catch (e) { ostatni = e; }
  }
  throw ostatni;
}

server.registerTool(
  "eurlex_lookup",
  {
    title: "Akt prawa UE w Cellar po numerze CELEX — metadane i status obowiązywania",
    description:
      "Tytuł (PL), data, status obowiązywania i data końca obowiązywania aktu UE z Cellar " +
      "(SPARQL) po numerze CELEX, np. 32016R0679 (RODO). FOUND/NOT_FOUND/AMBIGUOUS/ERROR. " +
      "Nie pobiera pełnego tekstu.",
    inputSchema: {
      celex: z.string().regex(CELEX_RE).describe("Numer CELEX, np. '32016R0679' (RODO)"),
    },
  },
  async ({ celex }) => {
    let wynik;
    try {
      wynik = normalizujOdpowiedzEURLEX(await pobierzZCellar(celex), celex);
    } catch (err) {
      wynik = { status: "ERROR", query_type: "akt_prawny_ue", source: "eur-lex",
        detail: String(err?.message ?? err), retrieved_at: new Date().toISOString() };
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
  console.error("eurlex-mcp-server: nasłuchuję na stdio (MCP)");
}
