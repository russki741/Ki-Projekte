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

## Kleines Konto: 5.000 Rubel je Agent (seit 4. November 2026)

- Startkapital je Agent 5.000 Rubel = 61,22 USDT (Kurs der Zentralbank Russland 81,67 Rubel je Dollar).
- Bybit nimmt Orders erst ab 5 USDT an. Nach der Regel oben wären es je Markt nur 1 bis 5 USDT. Deshalb wird jeder Kauf auf mindestens 6 USDT angehoben (`risk.min_order_usd`), aber nie über ein Drittel des Kapitals. Praktisch kauft jeder Agent je Markt 6 USDT, also etwa 10 % des Kapitals, höchstens 3 Positionen gleichzeitig (etwa 30 %).
- Damit wirkt die Größe nach Schwankung und die halbe Größe bei vielen Nachrichten nicht mehr; die Schutzschicht kann Käufe nur noch verschieben.
- Grob geschätzt aus dem Test: größter Rückgang um 8 bis 10 %. Das liegt nah am Limit von 10 %. Wird es erreicht, verkauft der Agent alles und hält an, bis du ihn wieder startest.
- Fällt eine Position um mehr als etwa 16 %, ist sie weniger als 5 USDT wert. Auf der Börse ließe sie sich dann nicht mehr verkaufen und bliebe als Rest liegen. Im Papier-Modus wird sie normal geschlossen.

## Agent Alpha

Im Ruhestand seit 3. November 2026: `strategy.retired = true`, Status gestoppt. agent-tick hat seine drei offenen Positionen mit dem Grund `retired` geschlossen. Seine Märkte werden weiter gesammelt, die Marktübersicht in der App bleibt.

## Großer Test: mehr Märkte, kurze und lange Varianten (4. November 2026)

Funktion strategy-lab, Aktion `study` (Datei `study.ts`). Alle Kosten eingerechnet: Krypto 0,1 % Gebühr je Seite plus Schlupf und Spread, Rohstoffe und Währungen mit angenommenem Broker-Spread. Nicht eingerechnet: Finanzierungskosten für Rohstoff- und Währungspositionen über Nacht. Vergleich jeweils „Halten“ derselben Märkte zu gleichen Teilen.

**Tageskerzen, Januar 2022 bis November 2026**

| Märkte | Halten | Bestes Ergebnis | Momentum (Beta) | Turtle (Gamma) | Gewinnmitnahme bei +1 % |
|---|---|---|---|---|---|
| BTC, ETH, SOL | −8 % (Rückgang 77 %) | +242 % (200-Tage-Linie + Trailing-Stop, Rückgang 29 %) | +220 % (Rückgang 34 %) | +130 % (Rückgang 28 %) | −17 bis −38 %, obwohl 91 bis 94 % der Trades Gewinner waren |
| 15 große Coins von 2022 | −14 % (Rückgang 66 %) | +104 % (200-Tage-Linie + Trailing-Stop) | +49 % | +86 % | −23 bis −46 % |
| Rohstoffe (Gold, Silber, Öl, Kupfer, Gas) | +58 % (Rückgang 38 %) | +49 % (Turtle + Gewinnmitnahme 10 %, Rückgang 14 %) | +29 % | +31 % | −8 bis +1 % |
| Währungen (6 Paare, beide Richtungen, ohne Hebel) | ±0 % | ±0 % | −1 % | −6 % | −1 bis −5 % |
| Alles zusammen (32 Märkte) | — | +45 bis +47 % (Rückgang 16 bis 21 %) | +36 % | +47 % | nicht gerechnet |

**Stundenkerzen, letzte 2 Jahre („Gewinn in ein paar Stunden“)**

| Märkte | Halten | Regeln allein | Gewinnmitnahme 0,5 bis 2 % | Verkauf nach 6 Stunden | Ziel 1 % / Stop 1 % |
|---|---|---|---|---|---|
| 6 Coins | −49 % | −16 bis −79 % | −52 bis −99 % | −80 bis −97 % | −97 bis −99,8 % |
| Gold, Öl, EUR/USD, USD/JPY | +14 % | −4 bis +11 % | −22 bis +6 % | −16 bis −33 % | −17 bis −38 % |

Gebühren fraßen bei den schnellen Krypto-Varianten 45 bis 75 % des Kapitals. Jeder Trade verlor im Schnitt etwa so viel, wie er kostete (0,25 bis 0,3 %).

**Nachrichten:** 49 wichtige Krypto-Nachrichten in zwei Wochen. Danach bewegte sich BTC in 4 Stunden etwas stärker als sonst (im Schnitt 0,64 % statt 0,51 %), die Richtung ließ sich aber nicht vorhersagen: Auf „negative“ wie „positive“ Meldungen folgte im Schnitt dasselbe (−0,5 %), Zusammenhang 0,07. Zu wenige Daten für ein sicheres Urteil. Die Nachrichten bleiben eine Schutzschicht, keine Signalquelle.

**Folgerungen**
- Kurzfristiger Handel (Stunden) verliert in jeder getesteten Form. Je öfter gehandelt wird, desto größer der Verlust.
- Lange Regeln auf BTC, ETH und SOL waren am besten. Mehr Coins brachten weniger, nicht mehr.
- Ein Trailing-Stop (3 × ATR) verbesserte Momentum und 200-Tage-Linie bei Krypto (kleinerer Rückgang, beide Hälften im Plus), schadete aber bei Rohstoffen. Über 100 Varianten wurden getestet; die beste ist deshalb zu optimistisch.
- Rohstoffe: Regeln brachten weniger als Halten, dafür kleinere Rückgänge. Auf Bybit-Spot gibt es davon nur Gold als Token (XAUT, Historie seit April 2025).
- Währungen ohne Hebel bewegen sich zu wenig, die Kosten fressen den Rest.
