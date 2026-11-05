# Betrieb

## Täglich

Oben in der App sieht man, ob die Agenten laufen und wann der letzte Minutenlauf war. Die Trend-Agenten entscheiden nur einmal am Tag kurz nach 00:00 UTC (03:00 Uhr Moskau); an den übrigen Läufen passiert meist nichts. Der Punkt am Bereich **Bybit-Demo** ist grün, wenn das Spiegeln läuft, und rot bei einem Problem. Im Bereich selbst steht dann die Ursache.

## Notbremse

In der App: **Alle stoppen**. Das setzt die Notbremse (`kill_switch`) und stoppt alle Agenten. Offene Papier-Positionen werden im nächsten Lauf geschlossen (Minuten-Agenten nach höchstens einer Minute, Trend-Agenten nach höchstens 5 Minuten), das Spiegeln verkauft sie dann auch auf Bybit. Währungspositionen von Delta werden am Wochenende erst geschlossen, wenn der Markt wieder offen ist. Das Handkonto („Ich · Selbst gehandelt“) wird nicht gestoppt: neue eigene Trades sind gesperrt, offene eigene Positionen bleiben, bis der Nutzer sie selbst schließt.

Ohne App, im Supabase SQL-Editor:

```sql
update agent_core.settings set kill_switch = true where id;
```

## Statistik-Zeitraum und Archiv

Die App zählt nur Trades, die nach `settings.stats_since` eröffnet wurden. Der letzte Neustart war am 4. November 2026: je Agent 5.000 Rubel (61,22 USDT zum Kurs der Zentralbank Russland). Nichts wurde gelöscht. Das Archiv abfragen:

```sql
select a.name, count(*) as trades, round(sum(p.pnl_usd), 2) as ergebnis_usd
from agent_core.positions p join agent_core.agents a on a.id = p.agent_id
where p.status = 'closed' and p.entry_time < (select stats_since from agent_core.settings where id)
group by a.name;
```

Der Rubelkurs kommt stündlich von der Zentralbank Russland (`cbr.ru/scripts/XML_daily.asp`), ersatzweise von Yahoo (`RUB=X`). Er dient nur der Anzeige. Gehandelt wird in USDT.

## Termin-Kalender pflegen

Die Trend-Agenten kaufen von 20 Stunden vor bis 2 Stunden nach wichtigen Terminen nichts Neues. Den US-Arbeitsmarktbericht berechnet trend-tick selbst (erster Freitag im Monat). US-Zinsentscheide stehen in der Tabelle `event_calendar`. Eingetragen sind alle Termine bis Dezember 2027 (Quelle: Pressemitteilung der Fed vom 5. September 2025). Neue Termine nachtragen, sobald die Fed sie veröffentlicht. Die Uhrzeit ist 14:00 Uhr New York, also 19:00 UTC im Winter und 18:00 UTC im Sommer:

```sql
insert into agent_core.event_calendar (starts_at, name) values ('2028-01-26 19:00:00+00', 'FOMC Zinsentscheid')
on conflict do nothing;
```

Das Datum 2028 oben zeigt nur das Format und ist nicht geprüft. Nicht enthalten sind US-Inflationsdaten und EZB-Termine.

## Handkonto und Kurse prüfen

```sql
select name, round(cash, 2) as frei_usd, state->>'last_tick_at' as bewertet from agent_core.agents where config->>'engine' = 'manual';
select id, symbol, side, round(entry_notional, 2) as einsatz_usd, entry_price, entry_time from agent_core.positions
where status = 'open' and agent_id in (select id from agent_core.agents where config->>'engine' = 'manual');
select symbol, market, last, quote_time, now() - quote_time as alter, source from agent_core.quotes order by symbol;
```

Ein Währungskurs, der älter als 20 Minuten ist, gilt als „kein aktueller Kurs“. Freitag 22:00 bis Sonntag 22:00 UTC ist das normal (Wochenende). Unter der Woche ist es eine Störung bei Yahoo: Am 5. November 2026 kamen ab 17:10 UTC für Währungen, Aktien und Gold-Futures keine neuen Kurse mehr, nur Krypto lief weiter. Die App sagt dann „Yahoo liefert seit … keine neuen Kurse“; Trades in Währungen sind gesperrt, Delta wartet mit Entscheidungen.

Kerzen und Kurse ohne App prüfen (aus der Datenbank, mit dem Server-Schlüssel, nur Marktdaten):

```sql
select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/dashboard-api',
  headers := jsonb_build_object('content-type', 'application/json', 'x-agent-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'agent_cron_secret')),
  body := '{"action":"manual_chart","symbol":"BTCUSDT","tf":"15","limit":3}'::jsonb);
-- danach: select status_code, content from net._http_response order by id desc limit 1;
```

## Trend-Agenten prüfen

```sql
select name, status, round(cash, 2) as cash, state->>'last_tick_at' as letzter_lauf, state->'decided' as entschiedene_kerzen
from agent_core.agents where config->>'engine' = 'trend';

select ts, symbol, side, decision, reason, features->>'want_long' as kauf_an, features->>'want_short' as verkauf_an from agent_core.signals
where agent_id in (select id from agent_core.agents where config->>'engine' = 'trend') order by ts desc limit 20;
```

Probelauf ohne Wirkung (alles wird zurückgerollt): trend-tick mit `{"dry_run":true}` aufrufen.

## Spiegeln auf Bybit ein- und ausschalten

Im Bereich **Bybit-Demo** mit dem Schalter. Ausschalten geht nur, wenn auf Bybit nichts offen ist, damit keine Position liegen bleibt.

Im SQL-Editor, mit derselben Sicherung:

```sql
update agent_core.exchange_config set enabled = false, updated_at = now()
where id and not exists (
  select 1 from agent_core.exchange_orders i
  left join agent_core.exchange_orders o on o.position_id = i.position_id and o.leg = 'out'
  where i.leg = 'in' and i.status in ('filled', 'partial') and (o.id is null or o.status not in ('filled', 'partial', 'skipped')));
```

## Gesundheitsprüfung

```sql
select c.enabled, now() - c.last_reconcile_at as seit_letztem_spiegeln, c.last_error,
       (select max(ts) from agent_core.exchange_wallet_snapshots) as letzter_kontostand,
       (select count(*) from agent_core.exchange_orders where status = 'error' and created_at > now() - interval '24 hours') as fehler_24h,
       s.kill_switch, s.paper_only
from agent_core.exchange_config c, agent_core.settings s where c.id and s.id;

select jobname, schedule, active from cron.job order by jobid;
```

Erwartet: `seit_letztem_spiegeln` unter einer Minute, `last_error` leer, `fehler_24h` 0, `paper_only` true.

## Häufige Probleme

| Anzeige | Ursache | Lösung |
|---|---|---|
| "Das Spiegeln meldet sich nicht" | Zeitplan `bybit_reconcile` inaktiv oder Funktion fehlerhaft | `select * from cron.job_run_details order by start_time desc limit 20;` ansehen |
| Fehler `10004 Error sign` | Bybit-Schlüssel und Secret passen nicht zusammen | Neues Paar im Bybit-Demo-Konto erzeugen und im Vault ersetzen (unten) |
| Fehler `170131 Insufficient balance` | Demo-Guthaben reicht nicht | Demo-Konto bei Bybit auffüllen oder die Funktion `fund` nutzen |
| App zeigt "Zugangscode stimmt nicht" | falscher Code | Code neu eingeben, er wird nur im Browser gespeichert |
| App lädt keine Daten von einer neuen Adresse | Adresse nicht freigegeben | Adresse in `ALLOWED_ORIGINS` von dashboard-api und bybit-view eintragen und neu ausrollen |

## Bybit-Demo-Schlüssel erneuern

1. Im Bybit-Demo-Konto ein neues API-Schlüsselpaar anlegen (nur Spot-Handel, keine Auszahlung).
2. Im Supabase-Dashboard unter Vault die Werte von `bybit_demo_api_key` und `bybit_demo_api_secret` ersetzen.
3. Den alten Schlüssel bei Bybit löschen.
4. Selbsttest: `bybit-demo` mit `{"action":"selftest"}` aufrufen. Erwartet: Signatur gültig, Kontostand lesbar.

Schlüssel nie in den Chat, ins Repo oder in eine Datei schreiben.

## Ausrollen einer Änderung

1. Änderung hier im Repo machen und Tests laufen lassen (siehe README).
2. Edge Function mit genau dem Inhalt aus `supabase/functions/<name>/` ausrollen, `verify_jwt` bleibt aus.
3. Datenbank-Änderungen als neue Datei in `supabase/migrations/` anlegen und genau diese anwenden.
4. Danach die Gesundheitsprüfung oben laufen lassen.

## Grenzen des kostenlosen Tarifs

Die Zeitpläne erzeugen rund 195.000 Funktionsaufrufe pro Monat: bybit-demo 86.400, agent-tick 43.200, probe 51.840, trend-tick 8.640, news-scan 4.320. Dazu kommen die Aufrufe der App. Der kostenlose Supabase-Tarif erlaubt 500.000.

Datenbank: am 4. November 2026 belegt mit 241 MB von 500 MB. Die größten Tabellen sind `cron.job_run_details` (63 MB, Protokoll jedes Zeitplan-Laufs), `hist_candles` und `hist_bars` (52 und 45 MB, Labor-Historie), `signals` (42 MB, vor allem vom alten Minuten-Agenten) und `candles` (12 MB). Probe-Protokolle werden nach 3 Tagen gelöscht, die anderen Tabellen wachsen weiter. Ein Aufräumplan (zum Beispiel `cron.job_run_details` älter als 7 Tage löschen) ist noch nicht eingerichtet, weil er bestehende Daten löscht und vorher freigegeben werden soll.

Einmalige Aufräumaktion am 4. November 2026: agent-tick v3 hat nach dem Anlegen von Delta und dem Handkonto 9 Minuten lang Minutenkerzen für sechs neue Märkte gesammelt (GBP/USD, USD/JPY, AUD/USD, USD/CHF, USD/CAD, XAUT). Nach dem Ausrollen von v4 wurden diese 5.940 Kerzen und 6 Zeilen in `data_status` gelöscht. Für diese Märkte gab es vorher keine Daten.
