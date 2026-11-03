# Sicherheit

## Grundsätze

- **Kein echtes Geld.** `paper_only` ist in `agent_core.settings` per Prüfregel immer `true`, `agents.mode` ist per Prüfregel immer `paper`.
- **Bybit nur Demo.** Die Adresse `https://api-demo.bybit.com` steht fest im Code (`bybit-demo/bybit.ts`). An die echte Börse (`api.bybit.com`) gehen nur öffentliche Marktdaten-Abfragen ohne Schlüssel.
- **Keine Geheimnisse im Repo.** Dieses Repo ist öffentlich. Alle Schlüssel liegen im Supabase Vault.

## Geheimnisse im Supabase Vault

Hier stehen nur die Namen, nie die Werte.

| Name | Wofür |
|---|---|
| `agent_cron_secret` | Zeitpläne rufen die Funktionen mit diesem Wert im Header `x-agent-secret` auf |
| `project_url` | Adresse des Supabase-Projekts für die Zeitpläne |
| `dashboard_token_sha256` | SHA-256-Hash des Dashboard-Zugangscodes, der Code selbst wird nirgends gespeichert |
| `bybit_demo_api_key` | Bybit-Demo API-Schlüssel |
| `bybit_demo_api_secret` | Bybit-Demo API-Secret |

## Zugriff

- Datenbank: Row Level Security ohne Richtlinien, keine Rechte für `anon` und `authenticated`. Von außen kommt niemand direkt an die Tabellen.
- Die App spricht nur mit `dashboard-api` und `bybit-view`. Beide prüfen den Zugangscode (Hash-Vergleich in konstanter Zeit) und erlauben Browser-Zugriffe nur von `https://derus13.github.io` und `https://russki741.github.io`.
- Die App kann nur Folgendes ändern: Agenten starten und stoppen, Notbremse, Vermehrungs-Einstellungen, Spiegeln an/aus. Sie kann keine Order senden.
- Der Zugangscode liegt nur im Browser (Sitzung oder, wenn gewählt, dauerhaft auf dem Gerät).

## Offene Punkte

- Das Bybit-Demo-Secret wurde einmal im Chat geteilt. Das Schlüsselpaar sollte erneuert werden (Anleitung in [BETRIEB.md](BETRIEB.md)).
- Den Dashboard-Zugangscode bei Bedarf wechseln: neuen Code wählen, seinen SHA-256-Hash in `dashboard_token_sha256` eintragen.
