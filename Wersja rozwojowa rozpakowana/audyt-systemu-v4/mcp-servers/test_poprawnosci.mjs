#!/usr/bin/env node
// test_poprawnosci.mjs — POPRAWNOŚĆ odpowiedzi serwerów MCP (AUDYT-2026-10-01).
//
// test_na_zywo.mjs sprawdza KSZTAŁT i statusy. Ten test sprawdza, czy treść odpowiedzi jest PRAWDZIWA:
// każdą wartość zwróconą przez narzędzie porównuje z NIEZALEŻNYM odczytem tego samego źródła
// (inny endpoint / surowe API / pełny tekst), bez wartości wpisanych z pamięci.
//   node test_poprawnosci.mjs                 — wszystkie przypadki (CBOSA pomijana bez sieci do NSA)
//   LEX_POMIN="SAOS|CBOSA" node test_poprawnosci.mjs
//   CEIDG_API_KEY=… — włącza przypadek CEIDG (klucz tylko w zmiennej środowiskowej, nigdzie nie zapisywany)
// Klient MCP używa DOMYŚLNEGO timeoutu SDK (60 s) — jak prawdziwy host; przekroczenie = FAIL.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import http from "node:http";
import path from "node:path";
import { sygnal, owinSerwer } from "./wspolne/budzet.mjs";

const TU = path.dirname(fileURLToPath(import.meta.url));
const SERW = { isap: ["isap-eli-example", "isap-eli-mcp-server.js"], krs: ["krs-example", "krs-mcp-server.js"],
  nbp: ["nbp-example", "nbp-mcp-server.js"], wl: ["wl-example", "wl-mcp-server.js"], eureka: ["eureka-example", "eureka-mcp-server.js"],
  saos: ["saos-example", "saos-mcp-server.js"], eurlex: ["eurlex-example", "eurlex-mcp-server.js"], uodo: ["uodo-example", "uodo-mcp-server.js"],
  ceidg: ["ceidg-example", "ceidg-mcp-server.js"], cbosa: ["cbosa-example", "cbosa-mcp-server.js"] };

async function narzedzie(s, nazwa, args) {
  const [kat, plik] = SERW[s];
  const t = new StdioClientTransport({ command: "node", args: [plik], cwd: path.join(TU, kat), env: { ...process.env }, stderr: "ignore" });
  const c = new Client({ name: "test-poprawnosci", version: "1.0.0" });
  await c.connect(t);
  const start = Date.now();
  try { const r = await c.callTool({ name: nazwa, arguments: args }); return { ...JSON.parse(r.content[0].text), _ms: Date.now() - start }; }
  finally { await c.close(); }
}

// Niezależny odczyt źródła: krótkie próby, bo źródła (EUREKA) potrafią zawiesić połączenie.
async function pobierz(url, init = {}, jak = "json", proby = 5) {
  let ost;
  for (let p = 0; p < proby; p++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return jak === "json" ? await r.json() : await r.text();
    } catch (e) { ost = e; }
  }
  throw ost;
}
const bezHtml = (h) => String(h ?? "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const norm = (s) => bezHtml(s).replace(/[\u00AD]/g, "").replace(/-\s*\n\s*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const dzis = () => new Date().toISOString().slice(0, 10);

const wyniki = [];
async function przypadek(opis, fn) {
  if (process.env.LEX_POMIN && new RegExp(process.env.LEX_POMIN).test(opis)) { console.log(`⏭️  ${opis}`); return; }
  try {
    const bledy = [];
    const info = await fn((warunek, komunikat) => { if (!warunek) bledy.push(komunikat); });
    wyniki.push(!bledy.length);
    console.log(`${bledy.length ? "⛔ FAIL" : "✅ PASS"}  ${opis}${info ? `  [${info}]` : ""}`);
    for (const b of bledy) console.log(`         ✗ ${b}`);
  } catch (e) { wyniki.push(false); console.log(`⛔ FAIL  ${opis}\n         wyjątek: ${String(e?.message ?? e).slice(0, 300)}`); }
}

// ── 0. Budżet czasu (offline): źródło zawiesza połączenie, pętla 3 × 30 s musi skończyć się w budżecie.
await przypadek("BUDŻET: zawieszone źródło → błąd w budżecie (LEX_BUDZET_MS), nie timeout klienta 60 s", async (ok) => {
  const srv = http.createServer(() => {}); // nigdy nie odpowiada
  await new Promise((r) => srv.listen(0, r));
  const falszywy = { registerTool(n, m, h) { this.h = h; } };
  owinSerwer(falszywy);
  falszywy.registerTool("x", {}, async () => {
    let ost;
    for (let p = 1; p <= 3; p++) {
      try { await fetch(`http://127.0.0.1:${srv.address().port}/`, { signal: sygnal(30000) }); } catch (e) { ost = e; }
    }
    return String(ost?.message ?? ost);
  });
  const start = Date.now();
  const msg = await falszywy.h();
  const ms = Date.now() - start;
  srv.closeAllConnections?.(); srv.close();
  const budzet = Number(process.env.LEX_BUDZET_MS) || 50000;
  ok(ms <= budzet + 1500, `trwało ${ms} ms > budżet ${budzet} ms`);
  ok(/budżet/i.test(msg), `komunikat nie mówi o budżecie: ${msg}`);
  return `${ms} ms`;
});

// ── 1. ISAP: brzmienie art. 118 KC z narzędzia == brzmienie z TEGO SAMEGO PDF wyciągnięte INNYM ekstraktorem
//    (poppler `pdftotext`, niezależny od pdfjs serwera; ELI nie ma HTML dla t.j. 2026). Do tego: t.j. jest najnowszy.
await przypadek("ISAP: art. 118 KC — treść == PDF t.j. przez niezależny ekstraktor (pdftotext); t.j. jest najnowszy", async (ok) => {
  const w = await narzedzie("isap", "isap_tekst", { eli: "DU/1964/93", artykul: "118" });
  ok(w.status === "FOUND", `status ${w.status} ${w.detail ?? ""}`);
  const eli = w.result.eli_zrodla_tekstu;
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  let info = `${eli}, ${w._ms} ms`;
  try {
    const kat = mkdtempSync(path.join(os.tmpdir(), "lex-pdf-"));
    const r = await fetch(`https://api.sejm.gov.pl/eli/acts/${eli}/text.pdf`, { signal: AbortSignal.timeout(60000) });
    writeFileSync(path.join(kat, "a.pdf"), Buffer.from(await r.arrayBuffer()));
    const t = norm(execFileSync("pdftotext", ["-enc", "UTF-8", path.join(kat, "a.pdf"), "-"], { maxBuffer: 1 << 28 }).toString("utf8"))
      .replace(/©kancelaria sejmu[^]*?\d{4}-\d{2}-\d{2}/g, " ").replace(/\s+/g, " ");
    const od = t.indexOf("art. 118.");
    const wzor = t.slice(od, t.indexOf("art. 119.", od)).trim();
    ok(od >= 0, "brak „Art. 118.” w PDF");
    ok(norm(w.result.tresc) === wzor, `rozbieżność brzmienia:\n           narzędzie : ${norm(w.result.tresc)}\n           pdftotext : ${wzor}`);
  } catch (e) {
    if (e.code === "ENOENT") info += "; pdftotext niedostępny — porównanie brzmienia pominięte"; else throw e;
  }
  const s = await pobierz(`https://api.sejm.gov.pl/eli/acts/search?publisher=DU&title=${encodeURIComponent("jednolitego tekstu ustawy - Kodeks cywilny")}&limit=200`);
  const tj = (s.items ?? []).filter((a) => /Kodeks cywilny$/i.test(a.title.trim())).sort((a, b) => b.year - a.year || b.pos - a.pos)[0];
  ok(tj && `DU/${tj.year}/${tj.pos}` === eli, `najnowszy t.j. KC w ELI = ${tj ? `DU/${tj.year}/${tj.pos}` : "?"}, narzędzie = ${eli}`);
  return info;
});

// ── 2. KRS: nazwa, stan z dnia i forma == surowy odpis aktualny.
await przypadek("KRS: 0000019193 — nazwa/forma/stan z dnia == surowy OdpisAktualny", async (ok) => {
  const w = await narzedzie("krs", "krs_lookup", { numerKrs: "0000019193" });
  const r = await pobierz("https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/0000019193?rejestr=P&format=json");
  const p = r.odpis.dane.dzial1.danePodmiotu;
  ok(w.result.tytul_lub_nazwa === p.nazwa, `nazwa: ${w.result.tytul_lub_nazwa} ≠ ${p.nazwa}`);
  ok(w.result.forma_prawna === p.formaPrawna, `forma: ${w.result.forma_prawna} ≠ ${p.formaPrawna}`);
  ok(w.result.stan_z_dnia === r.odpis.naglowekA.stanZDnia, `stan: ${w.result.stan_z_dnia} ≠ ${r.odpis.naglowekA.stanZDnia}`);
});

// ── 3. NBP: kurs i tabela == ostatnia tabela A opublikowana ≤ data (także dla soboty).
for (const data of ["2026-09-25", "2026-09-26"]) {
  await przypadek(`NBP: EUR ${data} — kurs i tabela == ostatnia tabela A ≤ data (surowe API)`, async (ok) => {
    const w = await narzedzie("nbp", "nbp_kurs_waluty", { kodWaluty: "EUR", data });
    const od = new Date(Date.parse(data) - 10 * 864e5).toISOString().slice(0, 10);
    const r = await pobierz(`https://api.nbp.pl/api/exchangerates/rates/a/eur/${od}/${data}/?format=json`);
    const ost = r.rates.at(-1);
    ok(w.result.kurs_sredni === ost.mid, `kurs ${w.result.kurs_sredni} ≠ ${ost.mid}`);
    ok(w.result.data_tabeli === ost.effectiveDate, `data tabeli ${w.result.data_tabeli} ≠ ${ost.effectiveDate}`);
    ok(w.result.identyfikator.includes(ost.no), `tabela ${w.result.identyfikator} ≠ ${ost.no}`);
  });
}

// ── 4. Biała lista: nazwa, status, liczba rachunków == surowe API z dzisiejszą datą.
await przypadek("WL: 5261040828 — nazwa/status/REGON/rachunki == surowe API", async (ok) => {
  const w = await narzedzie("wl", "wl_sprawdz_nip", { nip: "5261040828" });
  const s = (await pobierz(`https://wl-api.mf.gov.pl/api/search/nip/5261040828?date=${dzis()}`)).result.subject;
  ok(w.result.tytul_lub_nazwa === s.name, `nazwa ${w.result.tytul_lub_nazwa} ≠ ${s.name}`);
  ok(w.result.status_vat === s.statusVat, `status ${w.result.status_vat} ≠ ${s.statusVat}`);
  ok(w.result.regon === s.regon, `regon ${w.result.regon} ≠ ${s.regon}`);
  ok(w.result.liczba_rachunkow === (s.accountNumbers ?? []).length, `rachunki ${w.result.liczba_rachunkow} ≠ ${(s.accountNumbers ?? []).length}`);
});

// ── 5. EUREKA: trafność wyszukiwania (każdy kandydat merytorycznie o frazie) + porównanie z trybem słów.
const EUREKA = "https://eureka.mf.gov.pl/api/public/v1";
async function eurekaDok(id) {
  const d = await pobierz(`${EUREKA}/informacje/${id}`, { headers: { Accept: "application/json" } });
  const f = Object.fromEntries((d?.dokument?.fields ?? []).map((x) => [x.key, x.value]));
  return { f, tekst: norm(`${f.TEZA ?? ""} ${f.TRESC_INTERESARIUSZ ?? f.TRESC ?? ""}`) };
}
const oFrazie = (t) => /akcyz/.test(t) && /alkohol/.test(t);
await przypadek("EUREKA: „akcyza alkohol” — ≥80% kandydatów zawiera oba pojęcia w tezie/treści (precyzja)", async (ok) => {
  const w = await narzedzie("eureka", "eureka_szukaj", { fraza: "akcyza alkohol", rozmiar: 10 });
  const kand = w.kandydaci ?? (w.result ? [w.result] : []);
  ok(kand.length > 0, `brak kandydatów (${w.status}: ${w.detail ?? ""})`);
  let trafne = 0;
  for (const k of kand) if (oFrazie((await eurekaDok(k.id_eureka)).tekst)) trafne++;
  // tryb słów (stan sprzed poprawki) — ta sama miara, dla porównania
  const stary = await pobierz(`${EUREKA}/wyszukiwarka/informacje/?size=10&page=0&sort=DT_WYD%2Cdesc`, { method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ filter: {}, columns: ["ID_INFORMACJI"], searchInFullPhrase: false, searchInContent: false, searchInSynonyms: false, warunkiDodatkowe: [], searchQuery: "akcyza alkohol" }) });
  let trafneStary = 0;
  for (const x of stary.results ?? []) if (oFrazie((await eurekaDok(x.ID_INFORMACJI)).tekst)) trafneStary++;
  ok(trafne / kand.length >= 0.8, `precyzja ${trafne}/${kand.length}`);
  return `po poprawce ${trafne}/${kand.length}; tryb słów sprzed poprawki ${trafneStary}/${(stary.results ?? []).length}`;
});
await przypadek("EUREKA: dokument 709097 — sygnatura, status i treść == surowy dokument (próbki zdań)", async (ok) => {
  const w = await narzedzie("eureka", "eureka_pobierz", { id: "709097" });
  ok(w.status === "FOUND", `status ${w.status} ${w.detail ?? ""}`);
  const { f } = await eurekaDok("709097");
  ok(w.result?.identyfikator === f.SYG, `SYG ${w.result?.identyfikator} ≠ ${f.SYG}`);
  const zrodlo = norm(f.TRESC_INTERESARIUSZ ?? f.TRESC).replace(/\s+/g, " ");
  const narz = norm(w.result?.tresc ?? "");
  ok(!/<[a-z][^>]*>/i.test(w.result?.tresc ?? ""), "w treści zostały znaczniki HTML");
  const slowa = zrodlo.split(" ");
  let brak = 0; const N = 20;
  for (let i = 0; i < N; i++) {
    const p = Math.floor(((i + 0.5) / N) * Math.min(slowa.length - 12, 2500)); // w pierwszej porcji (20 000 zn.)
    if (!narz.includes(slowa.slice(p, p + 8).join(" "))) brak++;
  }
  ok(brak === 0, `${brak}/${N} próbek tekstu źródła nie występuje w treści narzędzia`);
  ok(Math.abs(w.result.tresc_dlugosc - zrodlo.length) / zrodlo.length < 0.05, `długość ${w.result.tresc_dlugosc} vs źródło ~${zrodlo.length}`);
  return `${w._ms} ms`;
});

// ── 6. SAOS: trafność frazy (pełne teksty) + tożsamość sygnatury + spójność cytatora.
await przypadek("SAOS: fraza „zachowek darowizna” — każdy kandydat zawiera oba pojęcia w pełnym tekście", async (ok) => {
  const w = await narzedzie("saos", "saos_search", { fraza: "zachowek darowizna", pageSize: 10 });
  const kand = w.kandydaci ?? [];
  ok(kand.length > 0, `brak kandydatów: ${w.status}`);
  let trafne = 0;
  for (const k of kand) {
    const t = norm((await pobierz(k.url_api)).data?.textContent);
    if (/zachowk|zachowek/.test(t) && /darowizn/.test(t)) trafne++;
  }
  ok(trafne === kand.length, `trafne ${trafne}/${kand.length}`);
  return `${trafne}/${kand.length}`;
});
await przypadek("SAOS: sygnatura II PK 291/09 — każdy kandydat ma DOKŁADNIE tę sygnaturę (surowe API)", async (ok) => {
  const w = await narzedzie("saos", "saos_search", { sygnatura: "II PK 291/09" });
  const lista = w.kandydaci ?? [w.result];
  for (const k of lista) {
    const d = (await pobierz(k.url_api)).data;
    ok((d.courtCases ?? []).some((c) => c.caseNumber === "II PK 291/09"), `kandydat ${k.url_api} ma ${(d.courtCases ?? []).map((c) => c.caseNumber)}`);
  }
});
await przypadek("SAOS: cytator III CRN 126/80 — przeskanowano > 0, liczniki spójne, cytujące naprawdę zawierają sygnaturę", async (ok) => {
  const w = await narzedzie("saos", "saos_cytator", { sygnatura: "III CRN 126/80" });
  ok(w.status === "FOUND", `status ${w.status} ${w.detail ?? ""}`);
  const cyt = w.cytujace ?? [];
  ok(w.result.przeskanowano > 0, `przeskanowano = ${w.result.przeskanowano} (pełne teksty pobrane: ${w.zakres_skanu?.przeskanowano_pelnych})`);
  ok(w.result.przeskanowano <= (w.zakres_skanu?.przeskanowano_pelnych ?? Infinity), "przeskanowano > pobranych pełnych tekstów");
  ok(w.result.z_sygnalem_odstapienia === cyt.filter((c) => c.sygnaly.some((s) => s.typ === "odstapienie")).length || cyt.length === 20,
    "licznik z_sygnalem_odstapienia ≠ lista");
  for (const c of cyt.slice(0, 5)) {
    const t = (await pobierz(c.url_zrodlowy.replace("/judgments/", "/api/judgments/"))).data?.textContent ?? "";
    ok(/III\s*CRN\s*126\s*\/\s*80/i.test(t), `${c.identyfikator} nie zawiera „III CRN 126/80”`);
  }
  ok(w.result.z_sygnalem_odstapienia >= 1, "brak jakiegokolwiek sygnału odstąpienia");
  // 2026-10-01: III CKN 1283/00 krytykuje pogląd III CRN 126/80, odsyłając do niego DATĄ (~2000 zn. od sygnatury);
  // przed dodaniem kotwic datowych był fałszywie ujemny. Teraz twardy warunek.
  ok(cyt.some((c) => /III CKN 1283\/00/.test(c.identyfikator) && c.sygnaly.some((s) => s.typ === "odstapienie")),
    "III CKN 1283/00 bez sygnału krytyki (odesłanie datą)");
  return `cytujących ${w.result.liczba_cytujacych}, przeskanowano ${w.result.przeskanowano}, z sygnałem ${w.result.z_sygnalem_odstapienia}, ${w._ms} ms`;
});

// ── 7. TSUE: CELEX, ECLI, data == niezależne zapytanie SPARQL Cellar.
await przypadek("TSUE: C-131/12 — ECLI i data wyroku == SPARQL Cellar", async (ok) => {
  const w = await narzedzie("eurlex", "eurlex_tsue", { sygnatura: "C-131/12" });
  const q = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?d ?e WHERE { ?w cdm:resource_legal_id_celex "62012CJ0131"^^<http://www.w3.org/2001/XMLSchema#string> .
OPTIONAL { ?w cdm:work_date_document ?d } OPTIONAL { ?w cdm:case-law_ecli ?e } } LIMIT 5`;
  const r = await pobierz("https://publications.europa.eu/webapi/rdf/sparql", { method: "POST",
    headers: { Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ query: q }) });
  const b = r.results.bindings[0] ?? {};
  ok(w.result.celex === "62012CJ0131", `celex ${w.result.celex}`);
  ok(w.result.ecli === b.e?.value, `ecli ${w.result.ecli} ≠ ${b.e?.value}`);
  ok(w.result.data_publikacji_lub_wyroku === String(b.d?.value).slice(0, 10), `data ${w.result.data_publikacji_lub_wyroku} ≠ ${b.d?.value}`);
});

// ── 8. UODO: sygnatura i prawomocność == strona dokumentu u źródła.
await przypadek("UODO: DKN.5112.33.2022 — sygnatura i prawomocność potwierdzone w treści źródła", async (ok) => {
  const w = await narzedzie("uodo", "uodo_sprawdz_sygnature", { sygnatura: "DKN.5112.33.2022" });
  const t = norm(await pobierz(w.result.url_zrodlowy, {}, "text"));
  ok(t.includes("dkn.5112.33.2022"), "sygnatura nie występuje w dokumencie źródłowym");
  ok(w.result.identyfikator === "DKN.5112.33.2022", `identyfikator ${w.result.identyfikator}`);
  // nagłówek dokumentu u źródła: „Warszawa, <data> <prawomocność> Decyzja <sygnatura>”
  const MIES = ["stycznia","lutego","marca","kwietnia","maja","czerwca","lipca","sierpnia","września","października","listopada","grudnia"];
  const [r, m, d] = w.result.data_publikacji_lub_wyroku.split("-").map(Number);
  ok(t.includes(`${d} ${MIES[m - 1]} ${r}`), `data ${w.result.data_publikacji_lub_wyroku} nie występuje w nagłówku źródła`);
  const pr = t.match(/warszawa, \d{1,2} \S+ \d{4} (prawomocna|nieprawomocna|częściowo prawomocna|uchylona)/)?.[1];
  ok(pr && pr.startsWith(w.result.prawomocnosc.replace("czesciowo", "częściowo")), `prawomocność: narzędzie ${w.result.prawomocnosc}, źródło ${pr ?? "?"}`);
  return `prawomocność wg narzędzia: ${w.result.prawomocnosc}, data ${w.result.data_publikacji_lub_wyroku}`;
});

// ── 9. CEIDG: firma wylosowana z surowego API (inny endpoint) → narzędzie zwraca tę samą nazwę i status.
await przypadek("CEIDG: firma z listy surowego API → ta sama nazwa i status przez narzędzie (NIP)", async (ok) => {
  if (!process.env.CEIDG_API_KEY) return "pominięto — brak CEIDG_API_KEY";
  const l = await pobierz("https://dane.biznes.gov.pl/api/ceidg/v3/firmy?miasto=Katowice&status=AKTYWNY&limit=5",
    { headers: { Authorization: `Bearer ${process.env.CEIDG_API_KEY}` } });
  const f = (l.firmy ?? []).find((x) => x.wlasciciel?.nip);
  ok(f, "brak firmy z NIP w próbce");
  const w = await narzedzie("ceidg", "ceidg_szukaj_firmy", { nip: f.wlasciciel.nip });
  const r = w.result ?? w.kandydaci?.[0] ?? {};
  ok(norm(r.tytul_lub_nazwa) === norm(f.nazwa), "nazwa z narzędzia ≠ nazwa z listy CEIDG");
  ok(String(JSON.stringify(r)).includes(f.status), `status ${f.status} nie występuje w odpowiedzi`);
  return "dane osobowe z próbki nie są wypisywane";
});

// ── 10. CBOSA (z sandboxa Claude: 503 bramy) — sygnatura z odpowiedzi występuje na stronie źródłowej.
await przypadek("CBOSA: III OSK 1959/22 — sygnatura obecna w dokumencie źródłowym, snapshot 🟨", async (ok) => {
  const w = await narzedzie("cbosa", "cbosa_sprawdz_sygnature", { sygnatura: "III OSK 1959/22" });
  ok(w.status === "FOUND", `status ${w.status} ${w.detail ?? ""}`);
  if (w.status === "FOUND") {
    const t = norm(await pobierz(w.result.url_zrodlowy, {}, "text"));
    ok(t.includes("iii osk 1959/22"), "sygnatura nie występuje w dokumencie źródłowym");
  }
});

const zle = wyniki.filter((x) => !x).length;
console.log(`\n${wyniki.length - zle}/${wyniki.length} przypadków poprawnych co do PRAWDZIWOŚCI treści.`);
process.exit(zle ? 1 : 0);
