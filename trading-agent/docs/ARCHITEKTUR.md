# Architektur

Alles läuft auf kostenlosen Diensten: Supabase (Datenbank, Edge Functions, Zeitpläne, Vault) und GitHub Pages (Web-App). Es gibt keinen eigenen Server.

```mermaid
flowchart LR
  subgraph Quellen["Öffentliche Datenquellen"]
    BP["Bybit Marktdaten<br/>api.bybit.com"]
    YH["Yahoo Chart<br/>EUR/USD"]
    RSS["Nachrichten-Feeds<br/>Fed, EZB, BBC, CoinDesk ..."]
  end
  subgraph Supabase
    CRON["pg_cron + pg_net<br/>Zeitpläne"]
    AT["agent-tick<br/>jede Minute"]
    NS["news-scan<br/>alle 10 Min"]
    PR["probe<br/>1 bzw. 5 Min"]
    BD["bybit-demo<br/>alle 30 s"]
    API["dashboard-api<br/>bybit-view"]
    DB[("Postgres<br/>agent_core")]
    V["Vault<br/>Schlüssel"]
  end
  DEMO["Bybit Demo-Konto<br/>api-demo.bybit.com<br/>Spielgeld"]
  APP["Web-App<br/>GitHub Pages"]

  CRON --> AT & NS & PR & BD
  BP --> AT
  YH --> AT
  RSS --> NS
  AT --> DB
  NS --> DB
  PR --> DB
  DB --> BD
  BD <--> DEMO
  BD --> DB
  V -.-> BD & AT & API
  APP <--> API
  API <--> DB
```

## Ablauf eines Trades

1. **agent-tick** lädt jede Minute die geschlossenen Kerzen und bewertet jeden Markt mit `evaluateSetup` (Trend auf 15 Minuten, Einstieg über RSI auf 1 Minute, Kosten-Prüfung, Qualität 0 bis 100).
2. Vor einem Einstieg prüft er: Notbremse, Agent aktiv, Nachrichten-Pause, Tagesverlust-Grenze, Verlustserie, gesperrte Setups aus dem Lernen, maximale Anzahl Positionen.
3. Die Papier-Position wird in `agent_core.positions` gespeichert, inklusive Gebühren, Spread und Schlupf.
4. **bybit-demo** findet die neue Krypto-Long-Position beim nächsten Lauf, kauft dieselbe Menge auf dem Demo-Konto (Market-Order, Spot) und schreibt die Ausführung nach `agent_core.exchange_orders`.
5. Schließt der Agent die Papier-Position (Stop, Ziel, Zeit), verkauft bybit-demo auf dem Demo-Konto.
6. Nach jedem geschlossenen Trade aktualisiert `fn_after_close` die Lernstatistik des Setups. Setups mit klar negativem Erwartungswert werden für 24 Stunden gesperrt.
7. `fn_check_replication` schlägt bei mindestens 500 € realisiertem Tagesgewinn einen neuen Agenten vor (mit Freigabe, höchstens `max_agents`).

## Edge Functions

| Funktion | Version in Supabase | Aufgabe | Auslöser |
|---|---|---|---|
| agent-tick | 2 | Daten holen, bewerten, Papier-Trades, Risiko, Lernen, Vermehrung | Zeitplan, jede Minute |
| bybit-demo | 6 | Spiegeln auf Bybit-Demo, Kontostand, Selbsttest | Zeitplan, alle 30 s |
| news-scan | 1 | Nachrichten lesen und bewerten | Zeitplan, alle 10 Min |
| probe | 3 | Datenquellen prüfen (alte Tabelle `trading_sim`) | Zeitplan, 1 bzw. 5 Min |
| dashboard-api | 6 | Daten und Steuerung für die App | App |
| bybit-view | 3 | Daten und Schalter für die Bybit-Seite | App |
| backtest | 1 | Strategie auf gespeicherter 1-Min-Historie nachspielen | auf Abruf |
| strategy-lab | 1 | Bekannte Strategien auf höheren Zeiteinheiten testen | auf Abruf |

Alle Funktionen haben `verify_jwt = false` und prüfen selbst: die Zeitplan-Funktionen den Header `x-agent-secret`, die App-Funktionen den Header `x-dashboard-token`.

## Zeitpläne (pg_cron)

| Name | Takt | Ruft auf |
|---|---|---|
| agent_tick | `* * * * *` | agent-tick |
| bybit_reconcile | `30 seconds` | bybit-demo `{"action":"reconcile"}` |
| news_scan | `*/10 * * * *` | news-scan |
| probe_crypto | `* * * * *` | probe `{"group":"crypto"}` |
| probe_others | `*/5 * * * *` | probe `{"group":"others"}` |
| retention_source_checks | `17 3 * * *` | löscht Probe-Protokolle älter als 3 Tage |

## Tabellen (Schema `agent_core`)

| Tabelle | Inhalt |
|---|---|
| settings | eine Zeile: Notbremse, `paper_only` (immer true), Märkte, Vermehrungsregeln, EUR/USD-Kurs |
| agents | Agenten mit Konfiguration, Status, Kapital |
| positions | Papier-Trades, offen und geschlossen, mit Gebühren und Ergebnis |
| signals | Entscheidungen pro Minute und Markt |
| equity_snapshots | Kapitalverlauf pro Agent |
| lessons | Lernstatistik pro Setup (Markt, Richtung, Tageszeit) |
| candles, data_status | Kerzen und Zustand der Datenquellen |
| news_items, news_sources | Schlagzeilen und Zustand der Feeds |
| notifications | Meldungen für die App |
| replication_events | Vermehrungs-Vorschläge |
| exchange_config | eine Zeile: Spiegeln an/aus, letzter Lauf, letzter Fehler |
| exchange_orders | jede Bybit-Demo-Order mit Ausführung, Gebühren, Preisabweichung |
| exchange_wallet_snapshots | Kontostand des Demo-Kontos, höchstens alle 4 Minuten |
| hist_candles, hist_bars, bt_trades, lab_runs | Forschung: Historie und Backtest-Ergebnisse |

Alle Tabellen haben Row Level Security ohne Richtlinien und keine Rechte für `anon` und `authenticated`. Nur die Edge Functions (Service-Rolle) lesen und schreiben.

Das ältere Schema `trading_sim` stammt aus der ersten Phase und wird nur noch von `probe` beschrieben.
