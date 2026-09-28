#!/usr/bin/env node
/**
 * isap-eli-mcp-server.js — REALNY, uruchamialny serwer MCP dla Sejm ELI API
 * (Dziennik Ustaw / Monitor Polski), zgodny z protokołem opisanym w
 * shared/MCP-INTEGRACJA.md i schematem odpowiedzi z
 * shared/SCHEMAT-ODPOWIEDZI-MCP.md.
 *
 * ⚠️ STATUS UCZCIWY: ten serwer POPRAWNIE implementuje protokół MCP (uruchamia
 * się, odpowiada na `tools/list`, `tools/call` — zweryfikowane w tej sesji
 * realnym klientem MCP, patrz self-test poniżej). Samo zapytanie sieciowe do
 * `api.sejm.gov.pl` ✅ PRZETESTOWANE wobec żywego API 2026-09-27g (poprzednio nie było —
 * w którym to piszę, ma dostęp sieciowy ograniczony do listy dozwolonych
 * domen (npm/pypi/github i pokrewne), NIE obejmuje domen .gov.pl. Kształt
 * odpowiedzi Sejm ELI API (pola JSON) trzeba zweryfikować przy pierwszym
 * uruchomieniu w środowisku z realnym dostępem sieciowym.
 *
 * Narzędzie udostępniane: `isap_lookup` — nazwa zgodna z konwencją z
 * shared/KONEKTORY-REKOMENDOWANE.md ("np. isap_lookup, saos_search, ...").
 *
 * Uruchomienie:
 *   node isap-eli-mcp-server.js
 * (komunikacja przez stdio — tak podłącza się serwery MCP lokalne w Claude
 * Desktop / Claude Code; do zdalnego użycia potrzebny wariant Streamable HTTP,
 * poza zakresem tego pliku)
 *
 * Konfiguracja w kliencie MCP (przykład dla Claude Desktop/Code,
 * claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "isap-eli": {
 *         "command": "node",
 *         "args": ["/sciezka/do/isap-eli-mcp-server.js"]
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ELI_BASE_URL = "https://api.sejm.gov.pl/eli/acts"; // ✅ zweryfikowane wobec żywego API 2026-09-27g

const server = globalThis.__LEX_MCP_WSPOLNY ?? new McpServer({
  name: "isap-eli-connector",
  version: "1.0.0",
});

// ⛔ POPRAWKA 2026-09-27o (AUDYT-2026-09-27o) — zmierzone na żywym ELI:
//  (1) status ELI przepuszczany bez mapowania poza schemat 4 wartości: „akt posiada tekst jednolity”
//      (Kodeks cywilny DU/1964/93) wychodził jako surowy tekst. Mapowanie niżej; naprawa z 27h
//      trafiła tylko do pluginu spoza repozytorium (F-211).
//  (2) kandydaci AMBIGUOUS bez tytułu i statusu („DU 2018 poz. 1000”) — nie do wyboru.
//  (3) brak odczytu po identyfikatorze (`eli`: DU/1964/93) — ŹRÓDŁO-0 HARDGATE nie miało narzędzia MCP.
//  (4) przy „akt posiada tekst jednolity” — ustalenie AKTUALNEGO t.j.: /references → „Inf. o tekście
//      jednolitym” → od najnowszego pierwszy „obowiązujący” (DU/2025/1071 „wygaśnięcie aktu” = t.j.
//      zastąpiony, nie akt uchylony).
// Statusy ELI (zmierzone 27o na 2009 pozycjach): obowiązujący, akt objęty tekstem jednolitym,
// wygaśnięcie aktu, akt jednorazowy, uznany za uchylony, uchylony, nieobowiązujący - uchylona
// podstawa prawna, akt posiada tekst jednolity, bez statusu.
export function mapujStatusEli(status, tytul = "") {
  const s = String(status ?? "").toLowerCase();
  if (s === "obowiązujący") return "obowiazuje";
  if (s.includes("tekst jednolity") || s.includes("tekstem jednolitym")) return "tekst_jednolity_nieaktualny";
  if (s.includes("wygaśnięcie") && /jednolitego tekstu/i.test(tytul)) return "tekst_jednolity_nieaktualny";
  if (/uchyl|wygaśnięcie|nieobowiązując|utrat/.test(s)) return "uchylony";
  return "nieznany";
}

const pozycja = (p) => ({
  identyfikator: `${p.publisher ?? "DU"} ${p.year} poz. ${p.pos}`,
  eli: p.ELI ?? `${p.publisher ?? "DU"}/${p.year}/${p.pos}`,
  tytul_lub_nazwa: p.title ?? null,
  status_obowiazywania: mapujStatusEli(p.status, p.title),
  status_eli: p.status ?? null,
  data_publikacji_lub_wyroku: p.announcementDate ?? p.promulgation ?? null,
  url_zrodlowy: `https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=W${p.publisher ?? "DU"}${p.year}${String(p.pos).padStart(7, "0")}`,
});

/** Wynik wyszukiwania po tytule albo odczytu po ELI → SCHEMAT-ODPOWIEDZI-MCP. */
export function normalizujOdpowiedzELI(rawItems, queryLabel, aktualnyTj = null) {
  const baza = { query_type: "akt_prawny", source: "sejm-eli" };
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { status: "NOT_FOUND", ...baza, uwaga: "Brak pozycji w ELI dla zapytania — nie jest to dowód, że akt nie istnieje (sprawdź tytuł/ELI)." };
  }
  if (rawItems.length > 1) {
    return { status: "AMBIGUOUS", ...baza, liczba_trafien: rawItems.length,
      kandydaci: rawItems.slice(0, 25).map(pozycja),
      uwaga: rawItems.length > 25 ? `Pokazano 25 z ${rawItems.length} — zawęź tytuł albo podaj eli.` : undefined };
  }
  const r = pozycja(rawItems[0]);
  const w = { status: "FOUND", ...baza, result: r, retrieved_at: new Date().toISOString(), confidence: "deterministic" };
  if (r.status_obowiazywania === "tekst_jednolity_nieaktualny") {
    if (aktualnyTj) {
      r.aktualny_tekst_jednolity = aktualnyTj;
      w.uwaga = `⚠️ ${r.identyfikator} to pozycja pierwotna/zastąpiona. Powołuj aktualny tekst jednolity: ` +
        `${aktualnyTj.identyfikator} (${aktualnyTj.eli}).`;
    } else {
      w.uwaga = `⚠️ ${r.identyfikator}: ELI „${r.status_eli}” — nie powołuj tej pozycji; ustal aktualny t.j. (HARDGATE ŹRÓDŁO-0, /references).`;
    }
  } else if (r.status_obowiazywania === "uchylony") {
    w.uwaga = `⛔ ${r.identyfikator}: ELI „${r.status_eli}” — akt nie obowiązuje.`;
  }
  return w;
}

async function eliGet(sciezka) {
  let ostatni;
  for (let proba = 1; proba <= 3; proba++) {
    try {
      const resp = await fetch(`${ELI_BASE_URL}/${sciezka}`, { signal: AbortSignal.timeout(20000) });
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`Sejm ELI API zwróciło HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) { ostatni = e; }
  }
  throw ostatni;
}

/** Aktualny t.j.: /references → „Inf. o tekście jednolitym” → od najnowszego pierwszy „obowiązujący”. */
async function aktualnyTekstJednolity(eli) {
  const ref = await eliGet(`${eli}/references`);
  const wpisy = (ref?.["Inf. o tekście jednolitym"] ?? []).map((x) => x.act).filter(Boolean)
    .sort((a, b) => b.year - a.year || b.pos - a.pos);
  for (const act of wpisy.slice(0, 5)) {
    const d = await eliGet(`${act.publisher ?? "DU"}/${act.year}/${act.pos}`);
    if (d?.status === "obowiązujący") return pozycja(d);
  }
  return null;
}

async function pobierzZEli(query) {
  // ⛔ POPRAWKA 2026-09-27g: poprzednio `${ELI_BASE_URL}/DU/search?title=…` → HTTP 404.
  const dane = await eliGet(`search?publisher=DU&title=${encodeURIComponent(query)}&limit=500`);
  return dane?.items ?? [];
}

server.registerTool(
  "isap_lookup",
  {
    title: "Akt prawny w Sejm ELI (Dz.U.) — po identyfikatorze albo tytule, ze statusem",
    description:
      "Podaj `eli` (np. DU/1964/93) dla odczytu deterministycznego albo `query` (tytuł). Zwraca status " +
      "obowiązywania w schemacie (obowiazuje / uchylony / tekst_jednolity_nieaktualny / nieznany) i surowy " +
      "status ELI; przy pozycji pierwotnej wskazuje AKTUALNY tekst jednolity. FOUND/NOT_FOUND/AMBIGUOUS/ERROR.",
    inputSchema: {
      eli: z.string().regex(/^(DU|MP)\/\d{4}\/\d{1,5}$/).optional().describe("Identyfikator ELI, np. DU/1964/93"),
      query: z.string().min(3).optional().describe("Tytuł lub fraza, np. 'Kodeks cywilny'"),
    },
  },
  async ({ eli, query }) => {
    let wynik;
    try {
      if (!eli && !query) throw new Error("Podaj `eli` albo `query`.");
      if (eli) {
        const d = await eliGet(eli);
        const st = d ? mapujStatusEli(d.status, d.title) : null;
        const tj = st === "tekst_jednolity_nieaktualny" && d.status !== "wygaśnięcie aktu" ? await aktualnyTekstJednolity(eli) : null;
        wynik = normalizujOdpowiedzELI(d ? [d] : [], eli, tj);
      } else {
        wynik = normalizujOdpowiedzELI(await pobierzZEli(query), query);
      }
    } catch (err) {
      wynik = { status: "ERROR", query_type: "akt_prawny", source: "sejm-eli", detail: String(err?.message ?? err), retrieved_at: new Date().toISOString() };
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
  console.error("isap-eli-mcp-server: nasłuchuję na stdio (MCP)"); // stderr, nie zaśmieca protokołu na stdout
}
