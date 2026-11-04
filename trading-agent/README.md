# KI-Agent Handelssimulation

Handelsagenten, die rund um die Uhr Krypto- und Devisenkurse auswerten, Trades im **Papier-Modell** (virtuelles Geld) eröffnen und schließen und Krypto-Trades zusätzlich auf einem **Bybit-Demo-Konto (Spielgeld)** nachbilden. Es gibt keine echten Orders und kein echtes Geld.

| | |
|---|---|
| App | https://russki741.github.io/Ki-Projekte/trading-agent/app/ |
| Bereiche | Übersicht · Trades · Märkte · Bybit-Demo · Nachrichten · Einstellungen (direkt erreichbar, z. B. `…/app/#bybit`) |
| Backend | Supabase-Projekt `lmgmeegwufbthxqlilkj` (kostenloser Tarif) |
| Zugang | Dashboard-Zugangscode (nur sein SHA-256-Hash liegt im Supabase Vault) |

## Was läuft

- **trend-tick** (alle 5 Minuten): die Trend-Agenten Beta (Momentum-Abstimmung 30/90/180 Tage) und Gamma (Turtle-Ausbruch 55/20 Tage) entscheiden einmal je abgeschlossener Tageskerze über BTC, ETH und SOL. Seit 4. November 2026 je 5.000 Rubel Startkapital (61,22 USDT), jeder Kauf mindestens 6 USDT (Bybit-Minimum 5 USDT), Rückgangs-Limit 10 %, Nachrichten und Termine als Schutzschicht. Details: [docs/REGELBUCH.md](docs/REGELBUCH.md).
- **agent-tick** (jede Minute): holt geschlossene 1-Minuten-Kerzen (BTC, ETH, SOL über Bybit, EUR/USD über Yahoo) und bewertet sie für die Marktübersicht. Der Minuten-Agent Alpha, der damit gehandelt hat, ist seit 3. November 2026 im Ruhestand.
- **bybit-demo** (alle 30 Sekunden): spiegelt neue Krypto-Käufe und -Verkäufe der Agenten auf das Bybit-Demo-Konto, speichert Ausführungen, Gebühren, Preisabweichung und Kontostand.
- **news-scan** (alle 10 Minuten): liest öffentliche Nachrichten-Feeds und bewertet Schlagzeilen mit einer Stichwort-Heuristik. Nach wichtigen Meldungen kaufen die Agenten 30 Minuten lang nichts Neues.
- **probe** (jede Minute bzw. alle 5 Minuten): prüft, ob die Datenquellen antworten und wie aktuell sie sind.
- **dashboard-api**, **bybit-view**: liefern die Daten für die App und nehmen Start, Stopp und Schalter entgegen.
- **backtest**, **strategy-lab**: Forschung auf historischen Daten, nur auf Abruf. strategy-lab enthält das Regelbuch, aus dem die Trend-Agenten stammen.

Details: [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md) · Bedienung und Notfälle: [docs/BETRIEB.md](docs/BETRIEB.md) · Sicherheit: [docs/SICHERHEIT.md](docs/SICHERHEIT.md)

## Ehrlicher Stand

- Die Minuten-Strategie hatte **keinen Vorteil nach Kosten**. Auf 1 bis 15 Minuten liegt der Vorteil vor Kosten etwa bei null; ein Hin- und Rückweg kostet rund 20 bis 25 Basispunkte. Deshalb der Wechsel auf Tagesregeln.
- Die Tagesregeln waren im Rückblick (Mai 2022 bis Oktober 2026, mit Kosten) besser als Halten, vor allem beim Rückgang. Das ist kein Beweis für die Zukunft: 36 Varianten wurden getestet, und ein starkes Jahr trägt den größten Teil des Gewinns. Die Agenten setzen nur ein Viertel der getesteten Größe ein, damit das 10-%-Limit hält; entsprechend klein ist der erwartete Gewinn.
- Eine Trefferquote von 80 % oder 95 % liefert keine der getesteten Strategien.
- Die Nachrichten-Auswertung ist eine Stichwort-Heuristik, kein Sprachmodell.
- EUR/USD läuft nur im Papier-Modell. Auf Bybit wird nur gekauft (Spot), Leerverkäufe gibt es dort nicht.
- Die App zählt seit dem Neustart am 4. November 2026. Ältere Trades (Agent Alpha) sind archiviert, nicht gelöscht.
- Echtes Geld: Dafür gibt es bewusst keinen Baustein. Er kommt frühestens nach einer Testphase von 2 bis 3 Monaten und nur mit ausdrücklicher Zustimmung.
- Nichts hier ist Anlageberatung.

## Ordner

```
trading-agent/
├── app/                    Web-App für GitHub Pages
│   ├── index.html          die App: Status und Start/Stopp oben, darunter die Bereiche
│   │                       Übersicht, Trades, Märkte, Bybit-Demo, Nachrichten, Einstellungen
│   └── bybit.html          alte Adresse, leitet in den Bereich Bybit-Demo weiter
├── tests/                  Browser-Tests der App mit Testdaten (keine echten Daten, kein Netz)
├── artifacts/
│   └── bybit-live.html     Quelltext der privaten Live-Ansicht in Claude (liest über den Supabase-Connector)
├── supabase/
│   ├── functions/<name>/   Quelltext jeder Edge Function, wie sie in Supabase läuft, mit Tests
│   └── migrations/         Datenbank-Änderungen in der Reihenfolge, in der sie angewendet wurden
└── docs/                   Architektur, Regelbuch, Betrieb, Sicherheit
```

## Tests

Node 22 genügt, ohne Installation:

```bash
cd supabase/functions
node --experimental-strip-types --test agent-tick/strategy.test.ts news-scan/newslib.test.ts bybit-demo/bybit.test.ts strategy-lab/lab.test.ts strategy-lab/study.test.ts trend-tick/engine.test.ts
node --experimental-strip-types backtest/sim.test.mjs
```

Browser-Tests der App (Playwright mit Chromium):

```bash
node tests/app.test.cjs
```

Stand 4. November 2026: 56 Tests der Funktionen, der Backtest-Selbsttest und 104 Tests der App, alle bestanden.

## Regeln für Änderungen

1. Dieses Repo ist die Quelle der Wahrheit. Jede Änderung an einer Edge Function oder der Datenbank kommt zuerst hierher.
2. Datenbank-Änderungen nur als neue Datei in `supabase/migrations/`, nie nachträglich in alten Dateien.
3. Vor dem Ausrollen laufen die Tests.
4. Keine Schlüssel, Tokens oder Passwörter im Repo. Es ist öffentlich.
5. `paper_only` bleibt `true`. Die Datenbank erzwingt das mit einer Prüfregel.

Die frühere Fassung liegt unverändert in `DeRus13/russki741` (Ordner `ki-agent-trading/`).
