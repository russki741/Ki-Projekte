# KI-Agent Handelssimulation

Handelsagenten, die rund um die Uhr Krypto- und Devisenkurse auswerten, Trades im **Papier-Modell** (virtuelles Geld) eröffnen und schließen und Krypto-Trades zusätzlich auf einem **Bybit-Demo-Konto (Spielgeld)** nachbilden. Es gibt keine echten Orders und kein echtes Geld.

| | |
|---|---|
| App | https://russki741.github.io/Ki-Projekte/trading-agent/app/ |
| Bybit-Demo-Seite | https://russki741.github.io/Ki-Projekte/trading-agent/app/bybit.html |
| Backend | Supabase-Projekt `lmgmeegwufbthxqlilkj` (kostenloser Tarif) |
| Zugang | Dashboard-Zugangscode (nur sein SHA-256-Hash liegt im Supabase Vault) |

## Was läuft

- **agent-tick** (jede Minute): holt geschlossene 1-Minuten-Kerzen (BTC, ETH, SOL über Bybit, EUR/USD über Yahoo), bewertet sie mit der Strategie `mtf_pullback`, eröffnet und schließt Papier-Positionen, prüft Risiko-Grenzen, lernt aus Verlusten und schlägt bei Tagesgewinn ab 500 € einen neuen Agenten vor.
- **bybit-demo** (alle 30 Sekunden): spiegelt neue Krypto-Käufe und -Verkäufe der Agenten auf das Bybit-Demo-Konto, speichert Ausführungen, Gebühren, Preisabweichung und Kontostand.
- **news-scan** (alle 10 Minuten): liest öffentliche Nachrichten-Feeds, bewertet Schlagzeilen mit einer Stichwort-Heuristik und pausiert neue Einstiege nach wichtigen Meldungen für 30 Minuten.
- **probe** (jede Minute bzw. alle 5 Minuten): prüft, ob die Datenquellen antworten und wie aktuell sie sind.
- **dashboard-api**, **bybit-view**: liefern die Daten für die App und nehmen Start, Stopp und Schalter entgegen.
- **backtest**, **strategy-lab**: Forschung auf historischen Daten, nur auf Abruf.

Details: [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md) · Bedienung und Notfälle: [docs/BETRIEB.md](docs/BETRIEB.md) · Sicherheit: [docs/SICHERHEIT.md](docs/SICHERHEIT.md)

## Ehrlicher Stand

- Die Strategie hat bisher **keinen nachgewiesenen Vorteil nach Kosten**. Auf 1 bis 15 Minuten liegt der Vorteil vor Kosten etwa bei null; ein Hin- und Rückweg kostet rund 20 bis 25 Basispunkte (Gebühr 0,1 % je Seite plus Spread).
- Eine Trefferquote von 80 % oder 95 % liefert keine der getesteten Strategien.
- Die Nachrichten-Auswertung ist eine Stichwort-Heuristik, kein Sprachmodell.
- EUR/USD läuft nur im Papier-Modell. Auf Bybit wird nur gekauft (Spot), Leerverkäufe gibt es dort nicht.
- Nichts hier ist Anlageberatung.

## Ordner

```
trading-agent/
├── app/                    Web-App für GitHub Pages
│   ├── index.html          Haupt-Dashboard (Agenten, Trades, Kapital, Nachrichten, Start/Stopp)
│   └── bybit.html          Bybit-Demo: Konto, gespiegelte Orders, Bybit gegen Papier, Schalter
├── artifacts/
│   └── bybit-live.html     Quelltext der privaten Live-Ansicht in Claude (liest über den Supabase-Connector)
├── supabase/
│   ├── functions/<name>/   Quelltext jeder Edge Function, wie sie in Supabase läuft, mit Tests
│   └── migrations/         Datenbank-Änderungen in der Reihenfolge, in der sie angewendet wurden
└── docs/                   Architektur, Betrieb, Sicherheit
```

## Tests

Node 22 genügt, ohne Installation:

```bash
cd supabase/functions
node --experimental-strip-types --test agent-tick/strategy.test.ts news-scan/newslib.test.ts bybit-demo/bybit.test.ts strategy-lab/lab.test.ts
node --experimental-strip-types backtest/sim.test.mjs
```

Stand 3. November 2026: 48 Tests, alle bestanden.

## Regeln für Änderungen

1. Dieses Repo ist die Quelle der Wahrheit. Jede Änderung an einer Edge Function oder der Datenbank kommt zuerst hierher.
2. Datenbank-Änderungen nur als neue Datei in `supabase/migrations/`, nie nachträglich in alten Dateien.
3. Vor dem Ausrollen laufen die Tests.
4. Keine Schlüssel, Tokens oder Passwörter im Repo. Es ist öffentlich.
5. `paper_only` bleibt `true`. Die Datenbank erzwingt das mit einer Prüfregel.

Die frühere Fassung liegt unverändert in `DeRus13/russki741` (Ordner `ki-agent-trading/`).
