// budzet.mjs — wspólny budżet czasu wywołania narzędzia MCP (AUDYT-2026-10-01).
//
// ⛔ PO CO: domyślny timeout żądania klienta MCP (SDK) = 60 s. Serwery miały pętle prób
//    3 × 30–45 s (EUREKA 90 s, UODO 90 s, EUR-Lex 120 s, SAOS 135 s, PDF ISAP 90 s). Gdy źródło
//    zawiesza połączenie (EUREKA: zmierzone 25–50% żądań bez odpowiedzi 2026-10-01), klient zrywał
//    po 60 s z „MCP error -32001: Request timed out”, a własny ERROR serwera nigdy nie docierał.
//    Teraz każde wywołanie narzędzia ma jeden budżet (domyślnie 50 s); każda próba HTTP dostaje
//    min(własny limit, pozostały budżet). Po wyczerpaniu budżetu kolejne próby kończą się od razu
//    jawnym błędem, więc narzędzie zwraca ERROR przed timeoutem klienta.
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();
export const BUDZET_MS = Math.max(5000, Number(process.env.LEX_BUDZET_MS) || 50000);

export class BudzetWyczerpany extends Error {}

/** Sygnał przerwania dla jednej próby HTTP: min(limitMs, pozostały budżet wywołania). */
export function sygnal(limitMs) {
  const st = als.getStore();
  if (!st) return AbortSignal.timeout(limitMs); // poza wywołaniem narzędzia (testy offline)
  const zostalo = st.koniec - Date.now();
  if (zostalo <= 250) {
    st.wyczerpany = true;
    throw new BudzetWyczerpany(`Przekroczony budżet czasu wywołania (${BUDZET_MS} ms) — źródło nie odpowiada; spróbuj ponownie później.`);
  }
  return AbortSignal.timeout(Math.min(limitMs, zostalo));
}

/** Czy budżet bieżącego wywołania został wyczerpany (dla narzędzi zbierających wiele odpowiedzi). */
export const budzetWyczerpany = () => Boolean(als.getStore()?.wyczerpany);

/** Owija server.registerTool raz na serwer: każdy handler biegnie we własnym budżecie. */
export function owinSerwer(server) {
  if (server.__lexBudzet) return server;
  const oryg = server.registerTool.bind(server);
  server.registerTool = (nazwa, meta, handler) =>
    oryg(nazwa, meta, (...a) => als.run({ koniec: Date.now() + BUDZET_MS, wyczerpany: false }, () => handler(...a)));
  server.__lexBudzet = true;
  return server;
}
