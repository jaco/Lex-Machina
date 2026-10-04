#!/usr/bin/env python3
"""Odtwarza mapę źródeł/routingu. Nie podnosi automatycznie poziomu komentarza."""
import csv
import json
import re
from prup import DATA, ROOT, load

SOURCE_MODULE = 'mod-PrUpad-zrodla-i-wersje.md'
CLAIMS = 'mod-PrUpad-wierzytelnosci-235-266.md'
FUNDS = 'mod-PrUpad-podzial-335-360.md'
SYNDIC = 'mod-PrUpad-syndyk-likwidacja.md'
CONSUMER = 'mod-PrUpad-konsument-workflow.md'
MAIN = 'mod-PrUpad-upadlosc-restrukturyzacja.md'
ENDING = 'mod-PrUpad-uklad-likwidacja-zakonczenie.md'
SPECIAL = 'mod-PrUpad-postepowania-odrebne-426-491-38.md'
INTERNATIONAL = 'mod-PrUpad-likwidacja-miedzynarodowe-szczegolne.md'


def routes(article):
    n=int(re.match(r'\d+',article)[0])
    if article.startswith('491^'):
        sup=int(re.search(r'\^(\d+)',article)[1])
        return [CONSUMER] if sup<=24 else [SPECIAL]
    if 235<=n<=266 and not article.startswith('266a') and not re.fullmatch(r'266[b-f]',article):
        return [CLAIMS]
    if article.startswith('216'):
        return [CLAIMS]
    if 335<=n<=360:
        return [FUNDS]
    if 156<=n<=178 or 306<=n<=334 or n in (206,210,213):
        return [SYNDIC]
    if n==266 or 361<=n<=372:
        return [ENDING]
    if 378<=n<=425:
        return [INTERNATIONAL]
    if 426<=n<=491:
        return [SPECIAL]
    if n in (522,523):
        return []  # tekst w korpusie; kwalifikacja kierowana do DR-03
    return [MAIN]


def build():
    meta, articles, raw=load()
    units=[]
    workflows={CLAIMS,FUNDS,SYNDIC,CONSUMER}
    for a in articles:
        modules=routes(a['id'])
        fragment=raw[a['start']:a['end']]
        first=re.sub(r'^[ \t]*Art\.[ \t]+\S+\.[ \t]*','',fragment,count=1)
        paragraphs=list(dict.fromkeys(re.findall(r'^[ \t]*(\d+[a-z]*)\.[ \t]+',first,re.M)))
        units.append({**a, 'source_url':meta['pdf_url']+'#page='+str(a['page']),
                      'source_module':SOURCE_MODULE,'procedure_modules':modules,
                      'commentary_status':'WORKFLOW_CZESCIOWY' if set(modules)&workflows else 'DO_POGLEBIENIA',
                      'independent_legal_review':'NIE_PRZEPROWADZONO_DLA_CALEJ_JEDNOSTKI',
                      'detected_paragraphs':paragraphs,
                      'paragraph_index_status':'EKSTRAKCJA_POMOCNICZA_NIE_AUDYT_USTEPOW',
                      'jurisdiction_route':'DR-03' if a['id'] in ('522','523') else 'DR-02'})
    for row in units:
        for name in [row['source_module']]+row['procedure_modules']:
            if not (ROOT/'modules'/name).is_file():
                raise ValueError(f'Brak modułu: {name}')
    out={'verified_source_on':meta['verified_on'], 'scope':'Wszystkie jawne nagłówki artykułów/grup w t.j.; źródło i routing oddzielone od oceny merytorycznej.',
         'full_commentary':False, 'articles':units,
         'excluded_sections':meta['excluded_from_article_index']}
    (DATA/'coverage.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
    with (DATA/'coverage.csv').open('w',newline='') as f:
        w=csv.writer(f);w.writerow(['artykul','strona_pdf','status_zrodla','moduly','status_komentarza','ustepy_wykryte'])
        for a in units:w.writerow([a['id'],a['page'],a['source_status'],'; '.join(a['procedure_modules']),a['commentary_status'],', '.join(a['detected_paragraphs'])])
    # Struktura pobrana z nagłówków PDF, zagnieżdżone zakresy ustalane offsetami.
    hp=re.compile(r'^[ \t]*(CZĘŚĆ [A-ZĄĆĘŁŃÓŚŹŻ]+|TYTUŁ [IVX]+A?|DZIAŁ [IVX]+A?)[ \t]*$',re.M)
    headings=list(hp.finditer(raw,raw.index('CZĘŚĆ PIERWSZA')))
    lines=['# PrUp — struktura tekstu jednolitego i dostęp do przepisów','',
           'Źródło: Dz.U. 2026 poz. 913, odczyt 2026-10-04. Zakresy wynikają z nagłówków PDF.',
           'Każda jednostka ma tekst w korpusie. Tabela nie deklaruje pełnego komentarza.',
           'Uchylone tytuły/części bez indywidualnych nagłówków pozostają jawne; nie tworzymy fikcyjnych artykułów.','',
           '| Część / tytuł / dział | Nazwa w źródle | Jawne nagłówki od–do | Liczba nagłówków |','|---|---|---|---|']
    hierarchy={}
    ranks={'CZĘŚĆ':0,'TYTUŁ':1,'DZIAŁ':2}
    for i,h in enumerate(headings):
        rank=ranks[h[1].split()[0]]
        hierarchy={k:v for k,v in hierarchy.items() if k<rank};hierarchy[rank]=h[1]
        end=next((x.start() for x in headings[i+1:] if ranks[x[1].split()[0]]<=rank),len(raw))
        aa=[a for a in articles if h.end()<a['start']<end]
        after=raw[h.end():].lstrip().splitlines();title=[]
        for line in after:
            t=line.strip()
            if not t or t.startswith(('Art.','TYTUŁ','DZIAŁ','Rozdział','CZĘŚĆ')):break
            title.append(t)
        span=aa[0]['id']+' – '+aa[-1]['id'] if aa else 'brak indywidualnych nagłówków'
        lines.append('| '+' / '.join(hierarchy.values())+' | '+' '.join(title).replace('|','/')+' | '+span+' | '+str(len(aa))+' |')
    (DATA/'struktura.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps({'article_records':len(units),'structure_nodes':len(headings),'full_commentary':False}))

if __name__=='__main__':build()
