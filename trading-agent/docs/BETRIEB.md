# Betrieb

## Täglich

In der App unter **Status** sieht man, ob die Agenten laufen und wann der letzte Minutenlauf war. Auf der Bybit-Seite steht oben, ob das Spiegeln läuft und wann es sich zuletzt gemeldet hat. Wird ein roter Hinweis gezeigt, steht dort auch die Ursache.

## Notbremse

In der App: **Alle stoppen**. Das setzt die Notbremse (`kill_switch`) und stoppt alle Agenten. Offene Papier-Positionen werden im nächsten Minutenlauf geschlossen, das Spiegeln verkauft sie dann auch auf Bybit.

Ohne App, im Supabase SQL-Editor:

```sql
update agent_core.settings set kill_switch = true where id;
```

## Spiegeln auf Bybit ein- und ausschalten

Auf der Bybit-Seite mit dem Schalter. Ausschalten geht nur, wenn auf Bybit nichts offen ist, damit keine Position liegen bleibt.

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

Die Zeitpläne erzeugen rund 186.000 Funktionsaufrufe pro Monat: bybit-demo 86.400, agent-tick 43.200, probe 51.840, news-scan 4.320. Der kostenlose Supabase-Tarif erlaubt 500.000. Die Datenbank bleibt klein, weil Probe-Protokolle nach 3 Tagen gelöscht werden.
