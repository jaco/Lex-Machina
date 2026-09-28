#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
instaluj_serwery_mcp.py — konfiguracja serwerów MCP Lex Machina z katalogu
audyt-systemu-v4/mcp-servers/ (pakiet dist/lex-mcp.mjs — bez npm, bez node_modules).

KIEDY POTRZEBNY (AUDYT-2026-09-27m):
  • Claude Code z pluginem audyt-systemu-v4 — NIE; serwery startują same z `.mcp.json` pluginu.
  • Claude Desktop — ZALECANE rozszerzenie dist/lex-machina.mcpb (bez Pythona i bez Node — Desktop ma
    własny Node.js); ten skrypt (`--scal-desktop`) to wariant zapasowy.
  • Claude Code bez pluginu albo sieć z proxy przechwytującym TLS — TAK: plugin nie może
    przekazać NODE_EXTRA_CA_CERTS / HTTPS_PROXY (w `.mcp.json` pluginu podstawiane są tylko
    CLAUDE_PLUGIN_ROOT i CLAUDE_PLUGIN_DATA), a SDK przekazuje serwerowi tylko HOME/PATH/SHELL/TERM.
  • claude.ai w przeglądarce — nie dotyczy: serwerów stdio tam nie ma, potrzebny HTTPS (F-8).

Wymaga: Python 3.8+, Node.js 18+. Windows, Linux, macOS.
    python instaluj_serwery_mcp.py --scal-desktop   # Claude Desktop (kopia zapasowa konfiguracji)
    python instaluj_serwery_mcp.py                  # tylko mcp-config.json + polecenia `claude mcp add`
    python instaluj_serwery_mcp.py --sprawdz        # handshake MCP każdego serwera (CI), bez zapisu
    python instaluj_serwery_mcp.py --diagnoza       # czy TA maszyna ma Claude Desktop → którą ścieżkę wybrać
    python instaluj_serwery_mcp.py --mcpb KATALOG   # rozszerzenie lex-machina.mcpb (czysty Python, bez sieci)

Pozycja 14 menu audytu (FAZA 0E, od audyt 6.144) uruchamia ten skrypt: `--diagnoza`, potem
`--scal-desktop` (maszyna z Claude Desktop) albo `--mcpb` (piaskownica: claude.ai, czat Desktop, Cowork).
"""
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

TU = Path(__file__).resolve().parent
PAKIET = TU / "dist" / "lex-mcp.mjs"
SERWERY = ["isap", "saos", "krs", "nbp", "eurlex", "eureka", "sudop", "cbosa", "uodo", "wl", "ceidg"]
WYMAGA_KLUCZA = {"ceidg": "CEIDG_API_KEY"}
PREFIKS = "lex-"
ZMIENNE = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS"]


def node():
    p = shutil.which("node")
    if not p:
        raise SystemExit("⛔ Brak Node.js — zainstaluj 18+ (nodejs.org).")
    v = subprocess.run([p, "--version"], capture_output=True, text=True).stdout.strip()
    if not v.startswith("v") or int(v[1:].split(".")[0]) < 18:
        raise SystemExit(f"⛔ Node.js {v or '?'} — wymagany 18+.")
    return p


def handshake(nd, serwer, env):
    """initialize → initialized → tools/list przez stdio (JSON-RPC, linia na komunikat)."""
    wiad = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "lex-instalator", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    wejscie = "".join(json.dumps(m) + "\n" for m in wiad)
    try:
        r = subprocess.run([nd, str(PAKIET), serwer], input=wejscie, capture_output=True, text=True,
                           timeout=30, env={**os.environ, **env}, encoding="utf-8")
    except subprocess.TimeoutExpired as e:
        r = e  # serwer czeka na dalsze komunikaty — to normalne; odpowiedzi są już na stdout
    out = r.stdout if isinstance(r.stdout, str) else (r.stdout or b"").decode("utf-8", "replace")
    for linia in out.splitlines():
        try:
            m = json.loads(linia)
        except ValueError:
            continue
        if m.get("id") == 2 and "result" in m:
            return [t["name"] for t in m["result"].get("tools", [])]
    return None


def plik_desktop():
    s = platform.system()
    if s == "Windows":
        return Path(os.environ.get("APPDATA", "")) / "Claude" / "claude_desktop_config.json"
    if s == "Darwin":
        return Path.home() / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
    return Path.home() / ".config" / "Claude" / "claude_desktop_config.json"


def diagnoza():
    """Czy skrypt działa na komputerze z Claude Desktop? Tylko wtedy --scal-desktop ma sens."""
    plik = plik_desktop()
    katalog = plik.parent
    jest = katalog.is_dir()
    print(f"system: {platform.system()} | katalog Claude Desktop: {katalog} | istnieje: {'TAK' if jest else 'NIE'}")
    print(f"konfiguracja: {plik} | istnieje: {'TAK' if plik.is_file() else 'NIE'}")
    if jest:
        print("ŚCIEŻKA: --scal-desktop (ta maszyna ma Claude Desktop)")
        return 0
    print("ŚCIEŻKA: --mcpb (brak Claude Desktop na tej maszynie — np. piaskownica; zapis konfiguracji byłby fikcją)")
    return 3


def zbuduj_mcpb(wyjscie):
    """lex-machina.mcpb = ZIP: manifest.json, server/lex-mcp.mjs, server/NOTICE-THIRD-PARTY.txt, LICENSE.
    Czysty Python (bez npm/sieci), stałe znaczniki czasu → powtarzalny wynik."""
    wyjscie = Path(wyjscie).expanduser().resolve()
    wyjscie.mkdir(parents=True, exist_ok=True)
    cel = wyjscie / "lex-machina.mcpb"
    pliki = [(TU / "mcpb-manifest.json", "manifest.json"), (PAKIET, "server/lex-mcp.mjs"),
             (TU / "dist" / "NOTICE-THIRD-PARTY.txt", "server/NOTICE-THIRD-PARTY.txt"), (TU / "LICENSE", "LICENSE")]
    brak = [str(z) for z, _ in pliki if not z.is_file()]
    if brak:
        raise SystemExit(f"⛔ brak plików rozszerzenia: {brak}")
    json.loads((TU / "mcpb-manifest.json").read_text(encoding="utf-8"))  # manifest musi być poprawnym JSON
    with zipfile.ZipFile(cel, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for zrodlo, nazwa in pliki:
            info = zipfile.ZipInfo(nazwa, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, zrodlo.read_bytes())
    print(f"✅ {cel} ({cel.stat().st_size} B) — Claude Desktop: Ustawienia → Rozszerzenia → zainstaluj z pliku")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Serwery MCP Lex Machina z audyt-systemu-v4/mcp-servers.")
    ap.add_argument("--serwery", nargs="+", choices=SERWERY)
    ap.add_argument("--ceidg-klucz")
    ap.add_argument("--scal-desktop", action="store_true")
    ap.add_argument("--sprawdz", action="store_true", help="tylko handshake MCP (CI)")
    ap.add_argument("--cel", default=str(TU), help="gdzie zapisać mcp-config.json")
    ap.add_argument("--diagnoza", action="store_true", help="czy ta maszyna ma Claude Desktop (kod 0 = tak, 3 = nie)")
    ap.add_argument("--mcpb", metavar="KATALOG", help="zbuduj lex-machina.mcpb w KATALOGU i zakończ")
    a = ap.parse_args()
    if a.diagnoza:
        return diagnoza()
    if a.mcpb:
        return zbuduj_mcpb(a.mcpb)
    if not PAKIET.is_file():
        raise SystemExit(f"⛔ Brak {PAKIET} — uruchom zbuduj_pakiet.py.")
    nd = node()
    wybrane = a.serwery or [s for s in SERWERY if s not in WYMAGA_KLUCZA or a.ceidg_klucz]
    env_wsp = {k: os.environ[k] for k in ZMIENNE if os.environ.get(k)}
    wpisy, bledy = {}, []
    for s in wybrane:
        env = dict(env_wsp)
        if s in WYMAGA_KLUCZA:
            if not a.ceidg_klucz and not a.sprawdz:
                print(f"⚠️ {s}: wymaga --ceidg-klucz — pomijam."); continue
            if a.ceidg_klucz:
                env[WYMAGA_KLUCZA[s]] = a.ceidg_klucz
        narz = handshake(nd, s, env)
        if not narz:
            bledy.append(s); print(f"⛔ {PREFIKS}{s}: brak odpowiedzi na tools/list"); continue
        print(f"✅ {PREFIKS}{s}: {', '.join(narz)}")
        w = {"command": nd, "args": [str(PAKIET), s]}
        if env:
            w["env"] = env
        wpisy[PREFIKS + s] = w
    if a.sprawdz:
        return 1 if bledy else 0

    cfg = Path(a.cel) / "mcp-config.json"
    cfg.write_text(json.dumps({"mcpServers": wpisy}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"✅ {cfg}")
    if a.scal_desktop and wpisy:
        p = plik_desktop(); dane = {}
        if p.is_file():
            kopia = p.with_suffix(".json.kopia-przed-lex"); shutil.copy2(p, kopia)
            print(f"✅ kopia zapasowa: {kopia}")
            dane = json.loads(p.read_text(encoding="utf-8") or "{}")
        dane.setdefault("mcpServers", {}).update(wpisy)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(dane, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"✅ dopisano {len(wpisy)} serwerów do {p} — zrestartuj Claude Desktop.")
    print("\nClaude Code bez pluginu / za proxy (zakres user):")
    for n, w in wpisy.items():
        e = " ".join(f'-e {k}="{v}"' for k, v in w.get("env", {}).items())
        print(f'  claude mcp add --scope user {e + " " if e else ""}{n} -- "{w["command"]}" "{w["args"][0]}" {w["args"][1]}')
    print("Kontrola w rozmowie: narzędzia mcp__lex-<serwer>__<narzędzie>.")
    return 1 if bledy else 0


if __name__ == "__main__":
    sys.exit(main())
