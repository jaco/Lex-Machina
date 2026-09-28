// lex-mcp.js — jeden punkt wejścia dla wszystkich serwerów MCP Lex Machina (AUDYT-2026-09-27m).
// Budowany esbuildem do dist/lex-mcp.mjs z wbudowanymi zależnościami (SDK MCP, zod), żeby działał
// z katalogu pluginu bez `npm install` — Claude Code nie instaluje zależności pluginów.
// Użycie: node dist/lex-mcp.mjs <serwer>
const SERWERY = {
  isap: () => import("./isap-eli-example/isap-eli-mcp-server.js"),
  saos: () => import("./saos-example/saos-mcp-server.js"),
  krs: () => import("./krs-example/krs-mcp-server.js"),
  nbp: () => import("./nbp-example/nbp-mcp-server.js"),
  eurlex: () => import("./eurlex-example/eurlex-mcp-server.js"),
  eureka: () => import("./eureka-example/eureka-mcp-server.js"),
  sudop: () => import("./sudop-example/sudop-mcp-server.js"),
  ceidg: () => import("./ceidg-example/ceidg-mcp-server.js"),
  cbosa: () => import("./cbosa-example/cbosa-mcp-server.js"),
  uodo: () => import("./uodo-example/uodo-mcp-server.js"),
  wl: () => import("./wl-example/wl-mcp-server.js"),
};
const nazwa = process.argv[2];
if (nazwa === "wszystkie") {
  // Jeden serwer z narzędziami wszystkich konektorów (rozszerzenie MCPB dla Claude Desktop uruchamia
  // jeden proces). Moduły widzą __LEX_MCP_WSPOLNY: rejestrują narzędzia na nim i nie łączą się same.
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  globalThis.__LEX_MCP_WSPOLNY = new McpServer({ name: "lex-machina", version: "1.0.0" });
  for (const [n, zaladuj] of Object.entries(SERWERY)) {
    if (n === "ceidg" && !process.env.CEIDG_API_KEY) continue; // bez klucza zwraca wyłącznie błędy
    await zaladuj();
  }
  await globalThis.__LEX_MCP_WSPOLNY.connect(new StdioServerTransport());
  console.error("lex-mcp: wszystkie serwery na jednym połączeniu (stdio)");
} else if (!SERWERY[nazwa]) {
  console.error(`Użycie: node lex-mcp.mjs <${Object.keys(SERWERY).join("|")}|wszystkie>`);
  process.exit(2);
} else {
  await SERWERY[nazwa]();
}
