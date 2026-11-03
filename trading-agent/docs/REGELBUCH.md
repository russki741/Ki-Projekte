# Regelbuch und Trend-Agenten

Stand 3. November 2026. Alles ist Simulation mit virtuellem Geld, keine Anlageberatung.

## Warum der Wechsel

Agent Alpha handelte auf 1- bis 15-Minuten-Kerzen. Dort liegt der Vorteil vor Kosten bei etwa null, ein Hin- und Rückweg kostet aber 20 bis 25 Basispunkte. Nach Kosten blieb Verlust. Deshalb handeln jetzt zwei Agenten mit bekannten Trendregeln auf Tageskerzen: wenige Trades, die länger laufen, so dass die Kosten kaum ins Gewicht fallen.

## Der Test (strategy-lab, Aktion `rulebook`)

- Daten: Tageskerzen von Bybit für BTC, ETH und SOL, Mai 2022 bis Oktober 2026.
- Entscheidung zum Schlusskurs eines Tages, Ausführung zur Eröffnung des nächsten Tages (kein Blick in die Zukunft).
- Kosten bei jeder Ausführung: Gebühr 10 Basispunkte, Schlupf 2 Basispunkte und halber Spread.
- Positionsgröße beim Einstieg: 1/3 des Kapitals je Markt, bei Schwankung über 60 % im Jahr entsprechend weniger.
- Parameter aus der Literatur, nicht an diese Daten angepasst.
- Auswahlregel, vor dem Test festgelegt: Sharpe-Kennzahl besser als Halten, größter Rückgang höchstens 60 % des Rückgangs beim Halten, mindestens 60 % der Jahre im Plus.

| Regel | Ergebnis gesamt | Größter Rückgang | Sharpe | Letzte 12 Monate |
|---|---|---|---|---|
| Halten (gleich gewichtet, Vergleich) | +83 % | 63,4 % | 0,53 | −38,8 % |
| Momentum-Abstimmung 30/90/180 Tage (`tsmom_vote`) | +245 % | 34,4 % | 0,91 | −0,6 % |
| Turtle-Ausbruch 55/20 Tage (`turtle_55_20`) | +173 % | 27,7 % | 0,86 | −12,3 % |

Momentum-Abstimmung nach Jahren: 2022 −4,2 %, 2023 +106,7 %, 2024 +59,2 %, 2025 +3,7 %, 2026 bis Oktober +5,6 %. Der Gewinn kam fast nur aus zwei Jahren mit starkem Aufwärtstrend.

Auf 4-Stunden-Kerzen bestehen außerdem `turtle_20_10`, `turtle_55_20`, `sma200`, `macd` und `tsmom_90`.

## Was die Zahlen nicht sagen

- Es wurden 36 Varianten getestet. Die beste sieht deshalb besser aus, als sie in Zukunft sein wird. Darum laufen zwei Regeln statt nur der besten.
- Vier Jahre mit drei Märkten sind wenig. Ein einziges gutes Jahr (2023) trägt den größten Teil des Ergebnisses.
- Bei voller Größe wäre der größte Rückgang 28 bis 34 %. Das Limit ist 10 %. Deshalb setzen die Agenten nur ein Viertel der getesteten Größe ein (`scale 0.25`, höchstens 8,3 % des Kapitals je Markt). Grob geschätzt sinken damit Rückgang und Rendite auf etwa ein Viertel: Rückgang um 7 bis 9 %, Rendite im Schnitt um 5 bis 8 % pro Jahr. Diese Schätzung ist nicht nachgerechnet.
- 500 € Gewinn an einem Tag (Schwelle für die Vermehrung) sind mit dieser Größe praktisch ausgeschlossen.

## Wie die Agenten handeln (Funktion trend-tick)

- Alle 5 Minuten, ab 2 Minuten nach der vollen Stunde. Eine Entscheidung je Markt und abgeschlossener Tageskerze, also einmal am Tag kurz nach 00:00 UTC (03:00 Uhr Moskau).
- `engine.ts` trifft dieselbe Entscheidung wie die Simulation. Ein Test vergleicht beide Kerze für Kerze für alle neun Regeln.
- Nur Kauf (Long), kein Hebel, Spot. Verkauf, wenn die Regel aus ist. Regeln mit Trailing-Stop verkaufen auch, wenn der Schlusskurs mehr als 3 ATR unter den höchsten Schlusskurs seit dem Einstieg fällt.
- Größter Rückgang 10 %: Der Agent verkauft alles und hält an, bis du ihn wieder startest.
- Krypto-Käufe werden wie bisher auf dem Bybit-Demo-Konto gespiegelt.

## Schutzschicht

Sie kann einen Kauf nur verschieben oder verkleinern, nie etwas hinzufügen.

| Auslöser | Wirkung |
|---|---|
| Wichtige Krypto-Nachricht in den letzten 30 Minuten | Kauf wird verschoben und alle 5 Minuten neu versucht |
| Termin von 20 Stunden davor bis 2 Stunden danach: US-Zinsentscheid (Tabelle `event_calendar`, eingetragen bis Dezember 2027), US-Arbeitsmarktbericht (erster Freitag im Monat, wird berechnet) | Kauf wird verschoben; spätestens 22 Stunden nach Tagesschluss verfällt er, am nächsten Tag fragt die Regel neu |
| Mindestens 3 wichtige Krypto-Nachrichten in 24 Stunden | halbe Positionsgröße |

Verkäufe werden nie verschoben. Die Nachrichten-Bewertung ist eine Stichwort-Heuristik. In den letzten 10 Tagen galt die halbe Größe an etwa jedem zweiten Tag.

## Agent Alpha

Im Ruhestand seit 3. November 2026: `strategy.retired = true`, Status gestoppt. agent-tick hat seine drei offenen Positionen mit dem Grund `retired` geschlossen. Seine Märkte werden weiter gesammelt, die Marktübersicht in der App bleibt.
