# Beat Challenge · v1.0.0

Eine mobile PWA, die eigene CSV-Schreibimpulse beim handschriftlichen Schreiben oder externen Diktieren anzeigt.

## Start

1. ZIP entpacken.
2. Im entpackten Ordner `python3 -m http.server 8000` ausführen und `http://localhost:8000/` im Browser öffnen.
3. Für das Smartphone alle Dateien einschließlich `icons/` gemeinsam auf einem statischen HTTPS-Host bereitstellen. GitHub Pages funktioniert auch in einem Projekt-Unterordner. Die Adresse im Smartphone-Browser öffnen und über das Browser-Menü zum Startbildschirm hinzufügen oder installieren.
4. Einmal online öffnen und unten auf „Offline bereit“ achten. Danach ist die App auch ohne Netz nutzbar.

Service Worker und PWA-Installation brauchen HTTPS oder localhost. Das direkte Öffnen von `index.html` per Doppelklick eignet sich dafür nicht.

Bei einem Update den Cache-Namen in `sw.js` hochzählen. Eine neue Version des Service Workers aktiviert sich, sobald keine geöffneten App-Fenster mehr von der alten Version kontrolliert werden.

## CSV importieren

Beim ersten Start öffnet sich der Bereich „CSV importieren“. Die leere CSV-Vorlage enthält die passende Kopfzeile. Jede importierte Datei wird als eigenes Beat-Set gespeichert.

Die CSV muss als UTF-8 mit Kommas und den vier Spalten `id,title,description,context` vorliegen. Die Spalten dürfen anders angeordnet sein. ID, Titel und Beschreibung müssen ausgefüllt sein. Der Kontext darf leer bleiben. IDs sind innerhalb eines Sets eindeutig. Felder mit Kommas, Zeilenumbrüchen oder Anführungszeichen in doppelte Anführungszeichen setzen. Innerhalb eines solchen Felds doppelte Anführungszeichen als `""` schreiben. Maximale Dateigröße 2 MB.

## Sitzung

- Vor dem Start sind Beat-Liste, Reihenfolge und optionaler Timer wählbar. Der Zufallsmodus mischt das Set einmal und zieht aus dieser Reihenfolge. Du kannst Beats gezielt aus der Übersicht erneut öffnen.
- „Beat übernehmen“ startet den optionalen Timer für diesen Aufruf. Mit „Bearbeitet“ und „Teilweise bearbeitet“ setzt du den Status ausdrücklich. Jeder Aufruf hat seinen eigenen Status. Die Übersicht zeigt zusätzlich den letzten aussagekräftigen Status pro Beat.
- „Nächster Beat“ wechselt ohne Statusänderung. „Überspringen“ markiert den aktuellen Aufruf. „Später“ stellt ihn hinter die noch anstehenden Impulse. Am Ende der Reihenfolge kannst du ihn gezielt über die Übersicht öffnen. Vorwärts und rückwärts durchlaufene Aufrufe werden separat protokolliert.
- Der Timer zeigt den Ablauf dezent an und lässt den Impuls stehen. Beim Pausieren der Session hält ein laufender Timer an und läuft beim Fortsetzen weiter. Ein manuell pausierter Timer bleibt pausiert. Solange eine Session läuft, zählt der Timer auch bei geschlossenem Browser ab seinem gespeicherten Endzeitpunkt.
- Es kann eine offene Session geben. Nach einem Neustart erscheint sie auf der Startseite. Kurze eigene Notizen lassen sich in der Übersicht speichern.

## Export und Daten

Markdown enthält die übernommenen Beats mit Beschreibung und Kontext, den vollständigen chronologischen Ereignisverlauf und die gespeicherte Notiz. JSON enthält die Session einschließlich aller Beat-Daten, Status und Ereignisse. CSV enthält pro Ereignis eine Zeile mit UTC-Zeit, Zeitzone, Aufrufnummer und zugehörigen Beat-Daten. Bei Zeichen, die Tabellenkalkulationen als Formeln auswerten könnten, schützt ein führendes Apostroph die CSV. JSON enthält den exakten Wortlaut. Ist der Browser-Zugriff auf die Zwischenablage gesperrt, markiert „Markdown kopieren“ die Vorschau zum manuellen Kopieren.

Beat-Sets und Sessions liegen in IndexedDB im Browserprofil und sind an Host, Port und App-Pfad gebunden. Ein anderer Browser, eine andere Bereitstellungsadresse oder das Löschen der Websitedaten ergibt einen eigenen beziehungsweise leeren Speicher. Exportierte Sessions kannst du als Dateien behalten.

Der Markdown-Verlauf lässt sich neben ein separat erstelltes Voice-Memo-Transkript legen. Die Zeitstempel geben Orientierung. Der Wortlaut des Transkripts hat Vorrang.
