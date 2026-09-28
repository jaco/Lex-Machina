// ⛔ 2026-09-27j (AUDYT-2026-09-27j): poprzednia wersja tego testu uznawała `status: "ERROR"`
// za SUKCES („SELF-TEST OK”). Przechodziła więc dla serwera, który nigdy nie dotarł do API
// (ISAP z błędnym endpointem, EUR-Lex z 406, SUDOP z crashem). Ten test sprawdza WYŁĄCZNIE
// protokół MCP (handshake, lista narzędzi, schematy) i nie wykonuje zapytań sieciowych.
// Poprawność TREŚCI sprawdza ../test_na_zywo.mjs — „status poprawny” i „treść poprawna”
// to dwa różne pomiary.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert";

const OCZEKIWANE = ["isap_lookup", "isap_tekst"];
const transport = new StdioClientTransport({ command: "node", args: ["isap-eli-mcp-server.js"] });
const client = new Client({ name: "test-protokolu", version: "2.0.0" });
await client.connect(transport);
const nazwy = (await client.listTools()).tools.map((t) => t.name).sort();
await client.close();
assert.deepStrictEqual(nazwy, [...OCZEKIWANE].sort(), `narzędzia: ${nazwy}`);
console.log(`PROTOKÓŁ MCP OK: ${nazwy.join(", ")}`);
console.log("⚠️ TREŚĆ NIESPRAWDZONA tym testem — uruchom ../test_na_zywo.mjs");
