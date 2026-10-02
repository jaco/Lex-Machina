#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""graf_przyczynowy.py — silnik MOD-GRAF-PRZYCZYNOWY (shared 3.99, AUDYT-2026-10-01b).

Liczy na grafie zdarzeń:
  • wsparcie każdego węzła (czy zdarzenie zaszło ORAZ czy wynika z przyczyn w grafie),
  • ścieżki do tezy i ich najsłabsze ogniwa,
  • ogniwa krytyczne (o ile spada teza po obaleniu danego węzła),
  • scenariusze „co jeśli” (obalone / udowodnione),
  • sprzężenia zwrotne (cykle) i błędy czasowe (przyczyna późniejsza niż skutek),
  • flagi prawne: post hoc (krawędzie „tylko korelacja”), csqn, art. 361 § 1 KC (normalne następstwa),
    art. 362 KC (przyczynienie poszkodowanego), art. 441 KC (kilku sprawców), art. 2 KK (zaniechanie).

Model liczbowy (jawny, ten sam co w widgecie chronologia-sprawy-v1/assets/widget-graf-przyczynowy.html):
  węzeł źródłowy:   s = p(węzeł)
  brama „I”:        s = p(węzeł) · Π (s_c · p_e)            — każda przyczyna konieczna (szeregowo)
  brama „LUB”:      s = p(węzeł) · [1 − Π (1 − s_c · p_e)]  — każda przyczyna wystarcza (równolegle)
  WZMACNIA:         czynnik przyczynowy f ← 1 − (1 − f) · Π (1 − s_c · p_e)
  OSLABIA/PRZERYWA: s ← s · Π (1 − s_c · p_e)
⛔ Założenie niezależności ogniw — liczby są oceną PORZĄDKOWĄ siły materiału, nie statystyką orzeczniczą.

Użycie:
  python3 graf_przyczynowy.py graf.json            → raport Markdown
  python3 graf_przyczynowy.py graf.json --json     → wynik JSON
  python3 graf_przyczynowy.py graf.json --mermaid  → diagram Mermaid
  python3 graf_przyczynowy.py --selftest
Kod wyjścia: 0 OK; 1 błąd danych (np. przyczyna późniejsza niż skutek, nieznany węzeł); 2 selftest FAIL.
"""
import argparse
import json
import sys

P_WEZLA = {"BEZSPORNE": 0.98, "PEWNE": 0.9, "WYDEDUKOWANE": 0.7, "SPORNE": 0.5}
P_KRAWEDZI = {"BEZPOSREDNI": 0.9, "POSREDNI": 0.7, "KORELACJA": 0.4}
POZYTYWNE = {"WYWOLUJE", "WARUNKUJE"}
TYPY_KRAWEDZI = POZYTYWNE | {"WZMACNIA", "OSLABIA", "PRZERYWA"}
PROG_ZMIANY = 0.05


def _p_wezla(w):
    if w.get("p") is not None:
        return float(w["p"])
    return P_WEZLA.get(w.get("pewnosc", "SPORNE"), 0.5)


def _p_krawedzi(k):
    if k.get("csqn") == "NIE" and k["typ"] in POZYTYWNE:
        return 0.0  # bez zdarzenia A skutek i tak by nastąpił — A nie jest przyczyną
    if k.get("p") is not None:
        return float(k["p"])
    return P_KRAWEDZI.get(k.get("dowod", "KORELACJA"), 0.4)


def waliduj(g):
    bledy = []
    ids = [w["id"] for w in g.get("wezly", [])]
    if len(ids) != len(set(ids)):
        bledy.append("powtórzony identyfikator węzła")
    znane = set(ids)
    daty = {w["id"]: w.get("data") for w in g.get("wezly", [])}
    for k in g.get("krawedzie", []):
        if k.get("od") not in znane or k.get("do") not in znane:
            bledy.append(f"krawędź {k.get('od')}→{k.get('do')}: nieznany węzeł")
            continue
        if k.get("typ") not in TYPY_KRAWEDZI:
            bledy.append(f"krawędź {k['od']}→{k['do']}: nieznany typ {k.get('typ')}")
        d1, d2 = daty.get(k["od"]), daty.get(k["do"])
        if d1 and d2 and len(d1) >= 10 and len(d2) >= 10 and d1[:10] > d2[:10] and k.get("typ") != "OSLABIA":
            bledy.append(f"krawędź {k['od']}→{k['do']}: przyczyna ({d1}) późniejsza niż skutek ({d2})")
    if g.get("teza") and g["teza"] not in znane:
        bledy.append(f"teza {g['teza']}: nieznany węzeł")
    return bledy


def _scc(wezly, krawedzie):
    """Tarjan — silnie spójne składowe (cykle = sprzężenia zwrotne / wzajemny wpływ)."""
    sasiedzi = {w: [] for w in wezly}
    for k in krawedzie:
        sasiedzi[k["od"]].append(k["do"])
    indeks, low, stos, na_stosie, wynik, licz = {}, {}, [], set(), [], [0]

    def odwiedz(v):
        indeks[v] = low[v] = licz[0]; licz[0] += 1
        stos.append(v); na_stosie.add(v)
        for u in sasiedzi[v]:
            if u not in indeks:
                odwiedz(u); low[v] = min(low[v], low[u])
            elif u in na_stosie:
                low[v] = min(low[v], indeks[u])
        if low[v] == indeks[v]:
            skl = []
            while True:
                u = stos.pop(); na_stosie.discard(u); skl.append(u)
                if u == v:
                    break
            wynik.append(skl)

    sys.setrecursionlimit(max(1000, 4 * len(wezly) + 100))
    for v in wezly:
        if v not in indeks:
            odwiedz(v)
    petle = {k["od"] for k in krawedzie if k["od"] == k["do"]}
    return [s for s in wynik if len(s) > 1 or s[0] in petle]


def _rozetnij_cykle(g):
    """Usuwa krawędzie zamykające cykle (najpóźniejsza przyczyna, potem najsłabsza) — do obliczeń.
    Usunięte krawędzie są raportowane jako sprzężenia; nie znikają z grafu."""
    daty = {w["id"]: (w.get("data") or "") for w in g["wezly"]}
    aktywne = list(g["krawedzie"])
    sprzezenia, cykle = [], []
    while True:
        skl = _scc([w["id"] for w in g["wezly"]], aktywne)
        if not skl:
            break
        s = set(skl[0])
        cykle.append(sorted(s))
        wewn = [k for k in aktywne if k["od"] in s and k["do"] in s]
        wewn.sort(key=lambda k: (daty[k["od"]], -_p_krawedzi(k)), reverse=True)
        zamyk = wewn[0]
        aktywne = [k for k in aktywne if k is not zamyk]
        sprzezenia.append(zamyk)
    return aktywne, sprzezenia, cykle


def _porzadek(wezly, krawedzie):
    wej = {w: 0 for w in wezly}
    for k in krawedzie:
        wej[k["do"]] += 1
    kolejka = [w for w in wezly if wej[w] == 0]
    wynik = []
    while kolejka:
        v = kolejka.pop(0); wynik.append(v)
        for k in krawedzie:
            if k["od"] == v:
                wej[k["do"]] -= 1
                if wej[k["do"]] == 0:
                    kolejka.append(k["do"])
    return wynik


def wsparcie(g, aktywne, nadpisz=None):
    nadpisz = nadpisz or {}
    w = {x["id"]: x for x in g["wezly"]}
    s = {}
    for v in _porzadek(list(w), aktywne):
        if v in nadpisz:
            s[v] = nadpisz[v]
            continue
        wejscie = [k for k in aktywne if k["do"] == v]
        poz = [k for k in wejscie if k["typ"] in POZYTYWNE]
        wzm = [k for k in wejscie if k["typ"] == "WZMACNIA"]
        neg = [k for k in wejscie if k["typ"] in ("OSLABIA", "PRZERYWA")]
        p = _p_wezla(w[v])
        if not poz and not wzm:
            wart = p
        else:
            f = None
            if poz:
                if (w[v].get("brama") or "I") == "LUB":
                    iloczyn = 1.0
                    for k in poz:
                        iloczyn *= 1 - s[k["od"]] * _p_krawedzi(k)
                    f = 1 - iloczyn
                else:
                    f = 1.0
                    for k in poz:
                        f *= s[k["od"]] * _p_krawedzi(k)
            if wzm:
                iloczyn = 1.0
                for k in wzm:
                    iloczyn *= 1 - s[k["od"]] * _p_krawedzi(k)
                f = 1 - (1 - (f or 0.0)) * iloczyn
            wart = p * f
        for k in neg:
            wart *= 1 - s[k["od"]] * _p_krawedzi(k)
        s[v] = round(wart, 6)
    return s


def _przodkowie(cel, krawedzie):
    wynik, front = set(), [cel]
    while front:
        v = front.pop()
        for k in krawedzie:
            if k["do"] == v and k["od"] not in wynik:
                wynik.add(k["od"]); front.append(k["od"])
    return wynik


def _sciezki(cel, krawedzie, limit=50):
    poz = [k for k in krawedzie if k["typ"] in POZYTYWNE | {"WZMACNIA"}]
    zrodla = {k["od"] for k in poz} - {k["do"] for k in poz}
    wynik = []

    def dfs(v, droga, kraw):
        if len(wynik) >= limit:
            return
        if v == cel:
            wynik.append((list(droga), list(kraw)))
            return
        for k in poz:
            if k["od"] == v and k["do"] not in droga:
                droga.append(k["do"]); kraw.append(k)
                dfs(k["do"], droga, kraw)
                droga.pop(); kraw.pop()

    for z in sorted(zrodla):
        dfs(z, [z], [])
    return wynik


def analizuj(g):
    bledy = waliduj(g)
    if bledy:
        return {"status": "ERROR", "bledy": bledy}
    aktywne, sprzezenia, cykle = _rozetnij_cykle(g)
    s = wsparcie(g, aktywne)
    w = {x["id"]: x for x in g["wezly"]}
    teza = g.get("teza")
    wynik = {"status": "OK", "wsparcie": s, "cykle": cykle,
             "sprzezenia": [f"{k['od']}→{k['do']}" for k in sprzezenia],
             "zalozenie": "niezależność ogniw; liczby porządkowe, nie statystyka orzecznicza",
             "ostrzezenia": []}
    for k in g["krawedzie"]:
        if k.get("dowod") == "KORELACJA" and k["typ"] in POZYTYWNE:
            wynik["ostrzezenia"].append(f"POST HOC: {k['od']}→{k['do']} — tylko korelacja czasowa (MET-PT); wymaga dowodu mechanizmu")
        if k.get("csqn") == "NIE" and k["typ"] in POZYTYWNE:
            wynik["ostrzezenia"].append(f"CSQN: {k['od']}→{k['do']} — skutek nastąpiłby i bez przyczyny; krawędź wyzerowana")
    if cykle:
        wynik["ostrzezenia"].append(f"SPRZĘŻENIE: {len(cykle)} cykl(e) — wzajemny wpływ; do obliczeń rozcięte krawędzie {wynik['sprzezenia']}")
    if teza:
        sc = _sciezki(teza, aktywne)
        wynik["sciezki"] = []
        for droga, kraw in sc:
            ogniwa = [(f"{k['od']}→{k['do']}", round(s[k["od"]] * _p_krawedzi(k), 4)) for k in kraw]
            najsl = min(ogniwa, key=lambda x: x[1]) if ogniwa else None
            wynik["sciezki"].append({"droga": droga, "najslabsze_ogniwo": najsl})
        baza = s[teza]
        krytyczne = []
        for v in w:
            if v == teza:
                continue
            nowe = wsparcie(g, aktywne, {v: 0.0})[teza]
            if baza - nowe >= PROG_ZMIANY:
                krytyczne.append({"wezel": v, "teza_po_obaleniu": round(nowe, 4), "spadek": round(baza - nowe, 4)})
        wynik["ogniwa_krytyczne"] = sorted(krytyczne, key=lambda x: -x["spadek"])
        wynik["scenariusze"] = []
        for sc_def in g.get("scenariusze", []):
            nad = {i: 0.0 for i in sc_def.get("obalone", [])}
            nad.update({i: 1.0 for i in sc_def.get("udowodnione", [])})
            s2 = wsparcie(g, aktywne, nad)
            zmiany = {v: [s[v], s2[v]] for v in s if abs(s[v] - s2[v]) >= PROG_ZMIANY}
            wynik["scenariusze"].append({"nazwa": sc_def.get("nazwa", "?"), "teza": [round(baza, 4), round(s2[teza], 4)], "zmiany": zmiany})
        wynik["przypisanie_prawne"] = _przypisanie(g, teza, aktywne, sc, s)
    return wynik


def _przypisanie(g, teza, aktywne, sciezki, s):
    w = {x["id"]: x for x in g["wezly"]}
    dz = g.get("dziedzina", "cywilne")
    flagi = []
    dobre = [kr for _, kr in sciezki if all(k.get("csqn") != "NIE" and k.get("adekwatnosc") != "NIETYPOWE" for k in kr if k["typ"] in POZYTYWNE)]
    if not dobre:
        flagi.append("BRAK ścieżki spełniającej csqn i adekwatność — przypisanie skutku wątpliwe" +
                     (" (art. 361 § 1 KC: tylko normalne następstwa)" if dz == "cywilne" else ""))
    nieustalone = sorted({f"{k['od']}→{k['do']}" for _, kr in sciezki for k in kr
                          if k["typ"] in POZYTYWNE and ("NIEUSTALONE" in (k.get("csqn"), k.get("adekwatnosc")) or not k.get("csqn") or not k.get("adekwatnosc"))})
    if nieustalone:
        flagi.append(f"Test csqn/adekwatności NIEUSTALONY dla: {', '.join(nieustalone)}")
    przodkowie = _przodkowie(teza, aktywne)
    for k in aktywne:
        if k["typ"] == "PRZERYWA" and k["do"] in przodkowie | {teza} and s[k["od"]] * _p_krawedzi(k) >= 0.5:
            flagi.append(f"PRZERWANIE związku: {k['od']} (zdarzenie nowe, niezależne) — oceń, czy skutek pozostaje normalnym następstwem")
    # Flagi prawne wyłącznie z JAWNYCH oznaczeń węzłów — sama „strona” zdarzenia nie czyni nikogo sprawcą
    # (pomiar 2026-10-01b: skarga pracownika-powoda wśród przyczyn dawała fałszywą flagę art. 441 KC).
    if any(w[v].get("przyczynienie") for v in przodkowie):
        flagi.append("PRZYCZYNIENIE: wśród przyczyn jest działanie poszkodowanego" + (" — art. 362 KC (zmniejszenie odszkodowania)" if dz == "cywilne" else ""))
    sprawcy = {w[v].get("strona") or v for v in przodkowie if w[v].get("sprawca")}
    if len(sprawcy) >= 2 and dz == "cywilne":
        flagi.append(f"KILKU SPRAWCÓW ({', '.join(sorted(sprawcy))}) — art. 441 KC (solidarność, regres wg przyczynienia)")
    for v in przodkowie:
        if w[v].get("typ") == "ZANIECHANIE" and not w[v].get("obowiazek_dzialania"):
            flagi.append(f"ZANIECHANIE {v} bez wskazanego obowiązku działania" +
                         (" — art. 2 KK: tylko gdy ciążył prawny, szczególny obowiązek zapobiegnięcia skutkowi" if dz == "karne" else ""))
    return flagi


def mermaid(g, wynik=None):
    s = (wynik or {}).get("wsparcie", {})
    styl = {"WYWOLUJE": "-->", "WARUNKUJE": "==>", "WZMACNIA": "-.->", "OSLABIA": "--x", "PRZERYWA": "--x"}
    wiersze = ["graph LR"]
    for x in g["wezly"]:
        etyk = x.get("opis", x["id"]).replace('"', "'")[:60]
        wiersze.append(f'  {x["id"].replace("-", "_")}["{x["id"]}: {etyk}' + (f' ({s[x["id"]]:.2f})' if x["id"] in s else "") + '"]')
    for k in g["krawedzie"]:
        opis = k["typ"] + ("·korelacja" if k.get("dowod") == "KORELACJA" else "")
        wiersze.append(f'  {k["od"].replace("-", "_")} {styl.get(k["typ"], "-->")}|{opis}| {k["do"].replace("-", "_")}')
    return "\n".join(wiersze)


def raport(g, wynik):
    if wynik["status"] != "OK":
        return "## Graf przyczynowy — BŁĘDY DANYCH\n\n" + "\n".join(f"- ⛔ {b}" for b in wynik["bledy"])
    w = {x["id"]: x for x in g["wezly"]}
    out = ["## Graf przyczynowy", "", f"> Założenie: {wynik['zalozenie']}.", "",
           "| Węzeł | Opis | Data | Pewność | Wsparcie |", "|---|---|---|---|---|"]
    for v, x in w.items():
        out.append(f"| {v} | {x.get('opis', '')} | {x.get('data', '')} | {x.get('pewnosc', '')} | {wynik['wsparcie'][v]:.2f} |")
    if g.get("teza"):
        t = g["teza"]
        out += ["", f"**Teza {t}:** wsparcie {wynik['wsparcie'][t]:.2f}", "", "**Ścieżki do tezy (najsłabsze ogniwo):**"]
        out += [f"- {' → '.join(sc['droga'])} — {sc['najslabsze_ogniwo'][0]} ({sc['najslabsze_ogniwo'][1]:.2f})" for sc in wynik["sciezki"] if sc["najslabsze_ogniwo"]] or ["- brak"]
        out += ["", "**Ogniwa krytyczne (obalenie → teza):**"]
        out += [f"- {k['wezel']}: {wynik['wsparcie'][t]:.2f} → {k['teza_po_obaleniu']:.2f}" for k in wynik["ogniwa_krytyczne"]] or ["- brak ogniwa, którego obalenie zmienia tezę o ≥ 0,05"]
        for sc in wynik["scenariusze"]:
            out += ["", f"**Scenariusz „{sc['nazwa']}”:** teza {sc['teza'][0]:.2f} → {sc['teza'][1]:.2f}"]
            out += [f"- {v}: {a:.2f} → {b:.2f}" for v, (a, b) in sc["zmiany"].items()]
        out += ["", "**Przypisanie prawne:**"] + ([f"- ⚠️ {f}" for f in wynik["przypisanie_prawne"]] or ["- brak flag"])
    if wynik["ostrzezenia"]:
        out += ["", "**Ostrzeżenia:**"] + [f"- {o}" for o in wynik["ostrzezenia"]]
    return "\n".join(out)


# ── selftest ───────────────────────────────────────────────────────────────────
def _selftest():
    ok = True

    def sprawdz(warunek, opis):
        nonlocal ok
        print(("OK  " if warunek else "FAIL") + "  " + opis)
        ok &= bool(warunek)

    szereg = {"teza": "C", "wezly": [{"id": "A", "p": 0.9}, {"id": "B", "p": 1.0}, {"id": "C", "p": 1.0}],
              "krawedzie": [{"od": "A", "do": "B", "typ": "WYWOLUJE", "p": 0.9}, {"od": "B", "do": "C", "typ": "WYWOLUJE", "p": 0.9}]}
    r = analizuj(szereg)
    sprawdz(abs(r["wsparcie"]["C"] - 0.729) < 1e-6, "łańcuch szeregowy 3 × 0,9 = 0,729 (słabszy niż każde ogniwo)")
    rown = {"teza": "T", "wezly": [{"id": "D1", "p": 0.9}, {"id": "D2", "p": 0.9}, {"id": "D3", "p": 0.9}, {"id": "T", "p": 1.0, "brama": "LUB"}],
            "krawedzie": [{"od": d, "do": "T", "typ": "WYWOLUJE", "p": 1.0} for d in ("D1", "D2", "D3")]}
    sprawdz(abs(analizuj(rown)["wsparcie"]["T"] - 0.999) < 1e-6, "3 niezależne dowody po 0,9 (brama LUB) = 0,999")
    sprawdz(analizuj({"wezly": [{"id": "A", "data": "2024-05-01"}, {"id": "B", "data": "2024-04-01"}],
                      "krawedzie": [{"od": "A", "do": "B", "typ": "WYWOLUJE"}]})["status"] == "ERROR", "przyczyna późniejsza niż skutek → ERROR")
    csqn = {"teza": "B", "wezly": [{"id": "A", "p": 1}, {"id": "B", "p": 1}], "krawedzie": [{"od": "A", "do": "B", "typ": "WYWOLUJE", "p": 0.9, "csqn": "NIE"}]}
    r = analizuj(csqn)
    sprawdz(r["wsparcie"]["B"] == 0 and any("CSQN" in o for o in r["ostrzezenia"]), "csqn = NIE zeruje krawędź i ostrzega")
    cykl = {"wezly": [{"id": "S1", "typ": "STAN", "data": "2024-01-01", "p": 1}, {"id": "S2", "typ": "STAN", "data": "2024-02-01", "p": 1}],
            "krawedzie": [{"od": "S1", "do": "S2", "typ": "WZMACNIA", "p": 0.5}, {"od": "S2", "do": "S1", "typ": "OSLABIA", "p": 0.5}]}
    r = analizuj(cykl)
    sprawdz(r["status"] == "OK" and len(r["cykle"]) == 1 and r["sprzezenia"] == ["S2→S1"], "cykl wykryty, rozcięty na krawędzi o najpóźniejszej przyczynie")
    przyk = {"teza": "SZ", "dziedzina": "cywilne",
             "wezly": [{"id": "Z1", "typ": "ZDARZENIE", "strona": "pozwany", "sprawca": True, "pewnosc": "BEZSPORNE", "data": "2024-01-10"},
                       {"id": "Z2", "typ": "ZDARZENIE", "strona": "poszkodowany", "przyczynienie": True, "pewnosc": "PEWNE", "data": "2024-01-11"},
                       {"id": "Z3", "typ": "ZANIECHANIE", "strona": "osoba_trzecia", "sprawca": True, "pewnosc": "SPORNE", "data": "2024-01-12"},
                       {"id": "SZ", "typ": "SKUTEK_PRAWNY", "pewnosc": "BEZSPORNE", "brama": "LUB", "data": "2024-01-20"}],
             "krawedzie": [{"od": "Z1", "do": "SZ", "typ": "WYWOLUJE", "dowod": "BEZPOSREDNI", "csqn": "TAK", "adekwatnosc": "NORMALNE"},
                           {"od": "Z2", "do": "SZ", "typ": "WZMACNIA", "dowod": "POSREDNI"},
                           {"od": "Z3", "do": "SZ", "typ": "WYWOLUJE", "dowod": "KORELACJA"}],
             "scenariusze": [{"nazwa": "obalony Z1", "obalone": ["Z1"]}]}
    r = analizuj(przyk)
    fl = " ".join(r["przypisanie_prawne"])
    sprawdz("art. 362 KC" in fl and "art. 441 KC" in fl and "ZANIECHANIE Z3" in fl, "flagi: przyczynienie (362), kilku sprawców (441), zaniechanie bez obowiązku")
    sprawdz(any("POST HOC" in o for o in r["ostrzezenia"]), "krawędź KORELACJA → ostrzeżenie post hoc")
    sprawdz(r["ogniwa_krytyczne"] and r["ogniwa_krytyczne"][0]["wezel"] == "Z1", "ogniwo krytyczne = Z1")
    sprawdz(r["scenariusze"][0]["teza"][1] < r["scenariusze"][0]["teza"][0], "scenariusz: obalenie Z1 obniża tezę")
    karne = {"teza": "S", "dziedzina": "karne", "wezly": [{"id": "Z", "typ": "ZANIECHANIE", "p": 1}, {"id": "S", "p": 1}],
             "krawedzie": [{"od": "Z", "do": "S", "typ": "WYWOLUJE", "p": 1, "csqn": "TAK", "adekwatnosc": "NORMALNE"}]}
    sprawdz(any("art. 2 KK" in f for f in analizuj(karne)["przypisanie_prawne"]), "karne: zaniechanie bez obowiązku gwaranta → art. 2 KK")
    bez = {"teza": "B", "wezly": [{"id": "A", "strona": "powod", "typ": "ZDARZENIE", "p": 1}, {"id": "P", "strona": "pozwany", "typ": "ZDARZENIE", "p": 1, "sprawca": True}, {"id": "B", "p": 1, "brama": "LUB"}],
           "krawedzie": [{"od": "A", "do": "B", "typ": "WYWOLUJE", "p": 0.9}, {"od": "P", "do": "B", "typ": "WYWOLUJE", "p": 0.9}]}
    sprawdz(not any("441" in f or "362" in f for f in analizuj(bez)["przypisanie_prawne"]), "bez jawnych oznaczeń: brak fałszywych flag 441/362 KC")
    sprawdz("graph LR" in mermaid(przyk, r), "eksport Mermaid")
    return ok


def main():
    ap = argparse.ArgumentParser(description="Silnik MOD-GRAF-PRZYCZYNOWY")
    ap.add_argument("plik", nargs="?")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--mermaid", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return 0 if _selftest() else 2
    if not a.plik:
        ap.error("podaj plik JSON grafu albo --selftest")
    with open(a.plik, encoding="utf-8") as f:
        g = json.load(f)
    g = g.get("state", g)  # akceptuje też eksport z widgetu (MOD-WIDGET-IO: {_meta, state})
    wynik = analizuj(g)
    if a.json:
        print(json.dumps(wynik, ensure_ascii=False, indent=2))
    elif a.mermaid:
        print(mermaid(g, wynik if wynik["status"] == "OK" else None))
    else:
        print(raport(g, wynik))
    return 0 if wynik["status"] == "OK" else 1


if __name__ == "__main__":
    sys.exit(main())
