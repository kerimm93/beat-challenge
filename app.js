'use strict';

const DB_NAME = 'beat-challenge-v1:' + new URL('.', location.href).pathname;
const MINUTES = [0, 2, 3, 5, 10, 15];
const STATUS = {
  unused: 'Noch nicht verwendet', shown: 'Nur angezeigt', active: 'Aktiv',
  done: 'Bearbeitet', partial: 'Teilweise bearbeitet', skipped: 'Übersprungen',
  deferred: 'Zurückgestellt',
};
const MODE = { sequence: 'Sequenziell', random: 'Zufällig' };
const ACTION = {
  start: 'Session gestartet', show: 'Beat angezeigt', accept: 'Beat übernommen',
  status: 'Status geändert', skip: 'Beat übersprungen', defer: 'Beat zurückgestellt',
  pause: 'Session pausiert', resume: 'Session fortgesetzt', finish: 'Session beendet',
  note: 'Notiz gespeichert', timerPause: 'Timer pausiert', timerResume: 'Timer fortgesetzt',
  timerReset: 'Timer neu gestartet',
};
const REASON = {
  first: 'Sessionstart', next: 'Weiter', previous: 'Zurück', select: 'Gezielt aufgerufen',
  repeat: 'Erneut angezeigt', skip: 'Nach Überspringen', defer: 'Nach Zurückstellen',
};
const MAX_CSV_BYTES = 2 * 1024 * 1024;

function newId() {
  // getRandomValues is also available when testing through a plain HTTP server.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
    byte.toString(16).padStart(2, '0')).join('');
}

function parseCsv(source) {
  const csv = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rows = [];
  let line = 1;
  let rowLine = 1;
  let row = [];
  let field = '';
  let phase = 'start';
  function endField() {
    row.push(field);
    field = '';
    phase = 'start';
  }
  function endRow() {
    endField();
    if (row.length > 1 || row[0].trim()) rows.push({ cells: row, line: rowLine });
    row = [];
    rowLine = line + 1;
  }
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (phase === 'quoted') {
      if (char !== '"') field += char;
      else if (csv[i + 1] === '"') {
        field += '"';
        i++;
      } else phase = 'closed';
    } else if (char === ',') endField();
    else if (char === '\n') endRow();
    else if (char === '"' && phase === 'start') phase = 'quoted';
    else if (char === '"' || phase === 'closed') {
      throw new Error(`Zeile ${line}: Unerwartetes Zeichen bei einem Anführungszeichen.`);
    } else {
      field += char;
      phase = 'plain';
    }
    if (char === '\n') line++;
  }
  if (phase === 'quoted') throw new Error(`Zeile ${rowLine}: Ein Textfeld hat kein schließendes Anführungszeichen.`);
  if (row.length || field || phase !== 'start') endRow();
  if (!rows.length) throw new Error('Die CSV-Datei ist leer.');
  const header = rows.shift().cells.map(cell => cell.trim().toLowerCase());
  const required = ['id', 'title', 'description', 'context'];
  const indexes = required.map(key => header.indexOf(key));
  if (indexes.includes(-1) || new Set(header).size !== header.length) {
    throw new Error('Die Kopfzeile braucht eindeutige, durch Kommas getrennte Spalten: id, title, description, context.');
  }
  if (!rows.length) throw new Error('Die CSV-Datei enthält keine Beats.');
  const ids = new Set();
  return rows.map(({ cells, line }) => {
    if (cells.length !== header.length) {
      throw new Error(`Zeile ${line}: Erwartet werden ${header.length} Spalten, gefunden wurden ${cells.length}.`);
    }
    const [id, title, description, context] = indexes.map(index => cells[index].trim());
    if (!id || !title || !description) throw new Error(`Zeile ${line}: ID, Titel und Beschreibung müssen ausgefüllt sein.`);
    if (ids.has(id)) throw new Error(`Zeile ${line}: Die Beat-ID „${id}“ ist doppelt.`);
    ids.add(id);
    return { id, title, description, context };
  });
}

function orderedIds(beats, mode) {
  const ids = beats.map(beat => beat.id);
  if (mode === 'random') {
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
  }
  return ids;
}

function record(session, type, at, detail = {}, visit = null) {
  session.events.push({
    type, at: new Date(at).toISOString(), beatId: visit?.beatId ?? null,
    visit: visit?.number ?? null, ...detail,
  });
}

function currentVisit(session) {
  return session.visits.at(-1);
}

function showBeat(session, id, reason, at) {
  const visit = {
    number: session.visits.length + 1, beatId: id,
    shownAt: new Date(at).toISOString(), acceptedAt: null, status: 'shown',
  };
  session.visits.push(visit);
  session.timer = null;
  record(session, 'show', at, { reason }, visit);
  return visit;
}

function newSession(set, mode, minutes, at = Date.now()) {
  const queue = orderedIds(set.beats, mode);
  const first = queue.shift();
  const session = {
    id: newId(), setId: set.id, setName: set.name,
    beats: set.beats, mode, minutes, startedAt: new Date(at).toISOString(),
    endedAt: null, paused: false, timer: null, queue, trail: [first], cursor: 0,
    visits: [], events: [], note: '', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  record(session, 'start', at);
  showBeat(session, first, 'first', at);
  return session;
}

function forwardId(session) {
  return session.trail[session.cursor + 1] ?? session.queue[0];
}

function navigateBeat(session, direction, at, selectedId = null) {
  let id;
  if (direction === 'previous') {
    if (session.cursor === 0) return;
    id = session.trail[--session.cursor];
  } else if (direction === 'select') {
    if (!session.beats.some(beat => beat.id === selectedId)) return;
    id = selectedId;
    if (id === currentVisit(session).beatId) {
      showBeat(session, id, 'repeat', at);
      return;
    }
    session.queue = session.queue.filter(beatId => beatId !== id);
    session.trail = [...session.trail.slice(0, session.cursor + 1), id];
    session.cursor++;
  } else if (session.cursor + 1 < session.trail.length) {
    id = session.trail[++session.cursor];
  } else if (session.queue.length) {
    id = session.queue.shift();
    session.trail.push(id);
    session.cursor++;
  }
  if (id !== undefined) showBeat(session, id, direction, at);
}

function moveAside(session, type, at) {
  const visit = currentVisit(session);
  if (!['shown', 'active'].includes(visit.status)) return;
  const status = type === 'skip' ? 'skipped' : 'deferred';
  visit.status = status;
  session.timer = null;
  record(session, type, at, { status }, visit);
  const advance = forwardId(session);
  if (type === 'defer' && advance !== undefined && advance !== visit.beatId) {
    session.queue = session.queue.filter(id => id !== visit.beatId);
    session.queue.push(visit.beatId);
  }
  if (advance !== undefined) navigateBeat(session, type, at);
}

function timerLeft(timer, at = Date.now()) {
  return timer.deadline === null ? timer.remaining : Math.max(0, timer.deadline - at);
}

function pauseTimer(session, at) {
  if (!session.timer || session.timer.deadline === null) return;
  session.timer = { deadline: null, remaining: timerLeft(session.timer, at) };
}

function restartTimer(session, at) {
  session.timer = session.minutes ? { deadline: at + session.minutes * 60_000 } : null;
}

function changeSession(session, action, value, at = Date.now()) {
  const visit = currentVisit(session);
  if (action === 'note') {
    if (value === session.note) return;
    session.note = value;
    record(session, 'note', at, { text: value });
    return;
  }
  if (session.endedAt) return;
  if (action === 'finish') {
    pauseTimer(session, at);
    session.endedAt = new Date(at).toISOString();
    record(session, 'finish', at);
    return;
  }
  if (action === 'pause' && !session.paused) {
    const wasRunning = session.timer?.deadline != null;
    pauseTimer(session, at);
    if (wasRunning && session.timer.remaining > 0) session.timer.resumeWithSession = true;
    session.paused = true;
    record(session, 'pause', at);
    return;
  }
  if (action === 'resume' && session.paused) {
    session.paused = false;
    if (session.timer?.resumeWithSession) session.timer = { deadline: at + session.timer.remaining };
    record(session, 'resume', at);
    return;
  }
  if (session.paused) return;
  if (['previous', 'next', 'select'].includes(action)) {
    navigateBeat(session, action, at, value);
  } else if (action === 'repeat') {
    showBeat(session, visit.beatId, 'repeat', at);
  } else if (action === 'accept' && visit.status === 'shown') {
    visit.acceptedAt = new Date(at).toISOString();
    visit.status = 'active';
    restartTimer(session, at);
    record(session, 'accept', at, { status: 'active' }, visit);
  } else if (action === 'status' && visit.acceptedAt && ['done', 'partial'].includes(value)) {
    if (visit.status === value) return;
    visit.status = value;
    session.timer = null;
    record(session, 'status', at, { status: value }, visit);
  } else if (action === 'skip' || action === 'defer') {
    moveAside(session, action, at);
  } else if (visit.status === 'active' && session.timer) {
    if (action === 'timerPause' && session.timer.deadline !== null) {
      pauseTimer(session, at);
      record(session, action, at, {}, visit);
    } else if (action === 'timerResume' && session.timer.deadline === null && session.timer.remaining > 0) {
      session.timer = { deadline: at + session.timer.remaining };
      record(session, action, at, {}, visit);
    } else if (action === 'timerReset') {
      restartTimer(session, at);
      record(session, action, at, {}, visit);
    }
  }
}

function beatStatuses(session) {
  const result = new Map();
  for (const visit of session.visits) {
    if (visit.status !== 'shown' || !result.has(visit.beatId)) result.set(visit.beatId, visit.status);
  }
  return result;
}

function getBeat(session, visit) {
  return session.beats.find(beat => beat.id === visit.beatId);
}

function dateText(iso, timeZone) {
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'medium', timeZone })
    .format(new Date(iso));
}

function md(value) {
  return String(value).replace(/[&<>`*_#[\]~\\|]/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char] || '\\' + char)
    .replace(/\n/g, '\n  ');
}

function eventText(event) {
  if (event.status) return STATUS[event.status];
  if (event.reason) return REASON[event.reason];
  return event.type === 'note' ? event.text : '';
}

function markdown(session) {
  const stamp = iso => dateText(iso, session.timeZone);
  const lines = [
    '# Beat Challenge · Session Export', '', '## Session',
    '- Beat-Set: ' + md(session.setName),
    '- Session-ID: ' + session.id,
    '- Start: ' + stamp(session.startedAt),
    '- Ende: ' + (session.endedAt ? stamp(session.endedAt) : 'Session noch offen'),
    '- Zeitzone: ' + session.timeZone,
    '- Modus: ' + MODE[session.mode],
    '- Timer: ' + (session.minutes ? session.minutes + ' Minuten pro Beat' : 'Aus'),
    '', '## Übernommene Beats', '',
  ];
  const accepted = session.visits.filter(visit => visit.acceptedAt);
  if (!accepted.length) lines.push('Es wurden keine Beats übernommen.', '');
  accepted.forEach((visit, i) => {
    const beat = getBeat(session, visit);
    const heading = value => md(value.replace(/\s*\n\s*/g, ' '));
    lines.push(
      `### ${i + 1}. ${heading(beat.id)} · ${heading(beat.title)}`,
      '- Anzeige Nr.: ' + visit.number,
      '- Übernommen: ' + stamp(visit.acceptedAt),
      '- Status: ' + (visit.status === 'active' ? 'Übernommen, ohne Bearbeitungsmarkierung' : STATUS[visit.status]),
      '- Beschreibung: ' + md(beat.description),
      '- Kontext: ' + (beat.context ? md(beat.context) : '—'),
      '',
    );
  });
  lines.push('## Chronologischer Verlauf', '');
  for (const event of session.events) {
    const beat = event.beatId === null ? null : getBeat(session, event);
    const detail = eventText(event);
    lines.push(`- ${stamp(event.at)} · ${ACTION[event.type]}` +
      (beat ? ` · Anzeige ${event.visit} · ${md(beat.id)} · ${md(beat.title)}` : '') +
      (detail ? ` · ${md(detail)}` : ''));
  }
  lines.push('', '## Eigene Notiz', '', session.note ? md(session.note) : '—', '',
    '## Hinweise zur Transkriptverarbeitung', '',
    'Dieser Export dokumentiert Schreibimpulse und ihren Ablauf. Anzeigen, Übernehmen und Statusmarkierungen belegen keinen diktierten Wortlaut. Der Wortlaut des separaten Voice-Memo-Transkripts hat Vorrang. Zeitstempel sind Orientierungspunkte, solange die Startzeiten von App und Diktiergerät nicht abgeglichen sind.',
    '');
  return lines.join('\n');
}

function eventsCsv(session) {
  const rows = [[
    'session_id', 'beat_set', 'event_number', 'timestamp_utc', 'time_zone', 'event',
    'visit', 'beat_id', 'title', 'description', 'context', 'status', 'reason', 'note',
  ]];
  session.events.forEach((event, i) => {
    const beat = getBeat(session, event);
    rows.push([
      session.id, session.setName, i + 1, event.at, session.timeZone, event.type,
      event.visit, event.beatId, beat?.title, beat?.description, beat?.context,
      event.status, event.reason, event.text,
    ]);
  });
  return '\uFEFF' + rows.map(row => row.map(cell => {
    let value = String(cell ?? '');
    if (/^[\t\r\n]|^\s*[=+@-]/u.test(value)) value = "'" + value;
    return '"' + value.replace(/"/g, '""') + '"';
  }).join(',')).join('\r\n') + '\r\n';
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Bitte schließe andere Beat-Challenge-Tabs und lade neu.'));
  });
}

function transaction(db, mutate) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', mutate ? 'readwrite' : 'readonly');
    const store = tx.objectStore('state');
    const request = store.get('app');
    let result;
    let failure;
    request.onsuccess = () => {
      try {
        result = request.result ?? { sets: [], sessions: [] };
        if (mutate) {
          mutate(result);
          store.put(result, 'app');
        }
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || tx.error || new Error('Der Speichervorgang wurde abgebrochen.'));
  });
}

const app = document.querySelector('#app');
const notice = document.querySelector('#notice');
const storageError = document.querySelector('#storage-error');
const themeButton = document.querySelector('#theme');
const finishDialog = document.querySelector('#finish-dialog');
const ui = {
  view: 'home', setId: null, sessionId: null, mode: 'sequence',
  minutes: 0, pending: false, notice: '',
};
let db;
let state;
let channel;
let exportUrls = [];

const html = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function button(label, action, options = {}) {
  const { primary, disabled, value } = options;
  return `<button type="button" data-action="${action}"${value === undefined ? '' : ` data-value="${html(value)}"`}${primary ? ' class="primary"' : ''}${disabled ? ' disabled' : ''}>${label}</button>`;
}

function pill(status) {
  return `<span class="pill${status === 'active' ? ' active' : ''}">${STATUS[status]}</span>`;
}

function heading(label, title, text = '') {
  return `<header class="hero">
    <p class="eyebrow">${label}</p>
    <h1 tabindex="-1">${title}</h1>
    ${text ? `<p class="lede">${text}</p>` : ''}
  </header>`;
}

function activeSession(data = state) {
  return data.sessions.find(session => !session.endedAt);
}

function selectedSession() {
  return state.sessions.find(session => session.id === ui.sessionId);
}

function homeView() {
  const selected = state.sets.find(set => set.id === ui.setId) ?? state.sets[0];
  const active = activeSession();
  const finished = state.sessions.filter(session => session.endedAt).reverse();
  return `${heading('Deine Schreibsession', 'Ein Beat nach dem anderen.', 'Wähle deine Schreibimpulse. Am Ende nimmst du den Verlauf als Kontext für dein Voice-Memo-Transkript mit.')}
    ${active ? `<section class="panel">
      <p class="eyebrow">Offene Session</p>
      <h2>${html(active.setName)}</h2>
      <p class="muted">${html(getBeat(active, currentVisit(active)).title)} · ${active.paused ? 'Pausiert' : 'Fortsetzbar'}</p>
      ${button('Session öffnen', 'open-session', { primary: true, value: active.id })}
    </section>` : ''}
    <section class="panel">
      <h2>Beat-Set wählen</h2>
      ${selected ? `
        <div>
          <label for="set-choice">Deine Beat-Sets</label>
          <select id="set-choice">${state.sets.map(set =>
            `<option value="${html(set.id)}"${set === selected ? ' selected' : ''}>${html(set.name)} · ${set.beats.length} Beats</option>`).join('')}</select>
        </div>
        <details>
          <summary>Beat-Liste ansehen</summary>
          <ol class="entries">${selected.beats.map(beat => `<li><span><small class="muted">${html(beat.id)}</small> <strong>${html(beat.title)}</strong><br>${html(beat.description)}</span></li>`).join('')}</ol>
        </details>
        ${active ? '<p class="small muted">Beende die offene Session, um eine neue zu starten.</p>' : `
          <div class="settings">
            <div><label for="mode">Reihenfolge</label><select id="mode">${Object.entries(MODE).map(([value, label]) => `<option value="${value}"${value === ui.mode ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
            <div><label for="minutes">Timer pro Beat</label><select id="minutes">${MINUTES.map(value => `<option value="${value}"${value === ui.minutes ? ' selected' : ''}>${value ? `${value} Minuten` : 'Aus'}</option>`).join('')}</select></div>
          </div>
          ${button('Neue Session starten', 'start', { primary: true, value: selected.id })}
        `}` : '<p>Importiere eine CSV-Datei, um anzufangen.</p>'}
    </section>
    <details class="panel"${selected ? '' : ' open'}>
      <summary>CSV importieren</summary>
      <p class="small muted">UTF-8 mit den Spalten id, title, description, context. Der Dateiname wird zum Namen des Beat-Sets.</p>
      <input class="file-input" type="file" id="csv-file" accept=".csv,text/csv" aria-label="Beat-Set als CSV importieren">
      <a class="button" href="data:text/csv;charset=utf-8,id%2Ctitle%2Cdescription%2Ccontext%0D%0A" download="beat-vorlage.csv">Leere CSV-Vorlage herunterladen</a>
    </details>
    ${finished.length ? `<section class="panel">
      <h2>Abgeschlossene Sessions</h2>
      <ul class="entries">${finished.map(session =>
        `<li><span><strong>${html(session.setName)}</strong><br><small class="muted">${dateText(session.startedAt, session.timeZone)}</small></span>${button('Übersicht', 'open-summary', { value: session.id })}</li>`).join('')}</ul>
    </section>` : ''}`;
}

function sessionView(session) {
  const visit = currentVisit(session);
  const beat = getBeat(session, visit);
  const index = session.beats.indexOf(beat) + 1;
  const count = session.beats.length;
  const displayed = new Set(session.visits.map(item => item.beatId)).size;
  const canAdvance = forwardId(session) !== undefined;
  const canSetAside = ['shown', 'active'].includes(visit.status);
  const primary = visit.status === 'shown'
    ? button('Beat übernehmen', 'accept', { primary: true })
    : canAdvance ? button('Nächster Beat', 'next', { primary: true }) : button('Zur Übersicht', 'summary', { primary: true });
  return `<div class="session-bar">
      <span class="eyebrow">${html(session.setName)} · ${MODE[session.mode]}</span>
      <div class="actions">${button('Übersicht', 'summary')}${button('Beenden', 'finish')}</div>
    </div>
    <article class="panel beat">
      <div class="beat-meta">
        <p class="eyebrow">Beat ${String(index).padStart(2, '0')} / ${String(count).padStart(2, '0')} · ${html(beat.id)}</p>
        ${pill(visit.status)}
      </div>
      <div class="track" role="progressbar" aria-label="Angezeigte Beats" aria-valuemin="0" aria-valuemax="${count}" aria-valuenow="${displayed}"><span style="width: ${100 * displayed / count}%"></span></div>
      <h1 tabindex="-1">${html(beat.title)}</h1>
      <p class="beat-description">${html(beat.description)}</p>
      ${beat.context ? `<p class="beat-context"><strong>Kontext</strong>${html(beat.context)}</p>` : ''}
    </article>
    ${session.paused ? `<section class="panel"><p>Session pausiert.</p>${button('Session fortsetzen', 'resume', { primary: true })}</section>` : `
      <div class="actions controls" aria-label="Beat-Steuerung">
        ${primary}
        ${visit.status === 'shown' ? button('Nächster Beat', 'next', { disabled: !canAdvance }) : ''}
        ${button('Vorheriger Beat', 'previous', { disabled: session.cursor === 0 })}
        ${canSetAside ? button('Überspringen', 'skip') + button('Später', 'defer') : ''}
      </div>
      ${visit.acceptedAt ? `<div class="actions controls" aria-label="Bearbeitungsstatus">
        ${button('Bearbeitet', 'status', { value: 'done', disabled: visit.status === 'done' })}
        ${button('Teilweise bearbeitet', 'status', { value: 'partial', disabled: visit.status === 'partial' })}
      </div>` : ''}
      ${visit.status === 'active' && session.timer ? `<section class="panel">
        <p class="eyebrow">Schreibtimer</p>
        <div class="timer-row"><span id="countdown" aria-label="Verbleibende Zeit"></span><span id="timer-text" role="status"></span></div>
        <div class="actions">
          <button id="timer-control" type="button" data-action="${session.timer.deadline === null ? 'timerResume' : 'timerPause'}">${session.timer.deadline === null ? 'Timer fortsetzen' : 'Timer pausieren'}</button>
          ${button('Timer neu starten', 'timerReset')}
        </div>
      </section>` : ''}
      ${!canAdvance ? '<p class="small muted controls">Ende der Reihenfolge. In der Übersicht kannst du einen Beat erneut öffnen.</p>' : ''}
      <div class="actions">${button('Beat erneut anzeigen', 'repeat')}${button('Session pausieren', 'pause')}</div>
    `}`;
}

function summaryView(session) {
  const statusById = beatStatuses(session);
  const done = session.beats.filter(beat => statusById.get(beat.id) === 'done').length;
  return `${heading('Sitzungsverlauf', 'Übersicht', html(session.setName) + ' · ' + done + ' von ' + session.beats.length + ' bearbeitet')}
    <div class="actions controls">
      ${button('Export ansehen', 'export', { primary: true })}
      ${!session.endedAt ? button('Zum aktuellen Beat', 'back-session') + button('Session beenden', 'finish') : button('Zur Startseite', 'home')}
    </div>
    <section class="panel">
      <h2>Beats und Status</h2>
      <ul class="entries">${session.beats.map(beat => `<li><span><small class="muted">${html(beat.id)}</small> <strong>${html(beat.title)}</strong></span>
        ${pill(statusById.get(beat.id) ?? 'unused')}
        ${!session.endedAt && !session.paused ? button('Anzeigen', 'select', { value: beat.id }) : ''}
      </li>`).join('')}</ul>
    </section>
    <section class="panel">
      <h2>Aufrufreihenfolge</h2>
      <ol class="entries">${session.visits.map(visit => `<li><span>${visit.number}. <strong>${html(getBeat(session, visit).title)}</strong><br><small class="muted">${dateText(visit.shownAt, session.timeZone)}${visit.acceptedAt ? ' · Übernommen' : ''}</small></span>${pill(visit.status)}</li>`).join('')}</ol>
    </section>
    <form id="note-form" class="panel">
      <label for="note">Eigene Notiz <span class="muted small">(optional)</span></label>
      <textarea id="note" rows="3" maxlength="2000" placeholder="Zum Beispiel der Zeitversatz zum Diktiergerät">${html(session.note)}</textarea>
      <button type="submit">Notiz speichern</button>
    </form>`;
}

function exportView(session) {
  const markdownText = markdown(session);
  const files = [
    ['md', 'text/plain', markdownText, 'Markdown', ' primary'],
    ['json', 'application/json', JSON.stringify({ schemaVersion: 1, session }, null, 2), 'JSON', ''],
    ['csv', 'text/csv', eventsCsv(session), 'CSV', ''],
  ];
  const links = files.map(([extension, mime, content, label, style]) => {
    const url = URL.createObjectURL(new Blob([content], { type: mime + ';charset=utf-8' }));
    exportUrls.push(url);
    return `<a class="button${style}" href="${html(url)}" download="${html(exportFilename(session, extension))}">${label} herunterladen</a>`;
  });
  return `${heading('Sitzungsverlauf', 'Export', html(session.setName) + (session.endedAt ? '' : ' · Zwischenstand der offenen Session'))}
    <section class="panel">
      <label for="export-content">Markdown-Vorschau</label>
      <textarea id="export-content" class="preview" readonly>${html(markdownText)}</textarea>
      <div class="actions">
        ${links[0]}
        ${button('Markdown kopieren', 'copy')}
        ${links[1]}
        ${links[2]}
      </div>
      <p id="copy-status" class="small muted" role="status"></p>
    </section>
    ${button('Zur Übersicht', 'summary')}`;
}

function render(focus) {
  if (exportUrls.length) {
    const stale = exportUrls;
    exportUrls = [];
    setTimeout(() => stale.forEach(url => URL.revokeObjectURL(url)), 30_000);
  }
  const session = selectedSession();
  if (!session || (session.endedAt && ui.view === 'session')) ui.view = session ? 'summary' : 'home';
  if (ui.view === 'session') app.innerHTML = sessionView(session);
  else if (ui.view === 'summary') app.innerHTML = summaryView(session);
  else if (ui.view === 'export') app.innerHTML = exportView(session);
  else app.innerHTML = homeView();
  app.setAttribute('aria-busy', 'false');
  notice.textContent = ui.notice;
  updateTimerDisplay();
  if (focus) {
    app.querySelector('h1')?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

function updateTimerDisplay() {
  const output = document.querySelector('#countdown');
  if (!output) return;
  const timer = selectedSession()?.timer;
  if (!timer) return;
  const seconds = Math.ceil(timerLeft(timer) / 1000);
  const text = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  if (output.textContent !== text) output.textContent = text;
  const message = document.querySelector('#timer-text');
  const label = seconds === 0 ? 'Zeit abgelaufen' : timer.deadline === null ? 'Pausiert' : '';
  if (message.textContent !== label) message.textContent = label;
  message.classList.toggle('elapsed', seconds === 0);
  document.querySelector('#timer-control').disabled = seconds === 0;
}

function setView(view, sessionId = ui.sessionId) {
  if (!state || ui.pending) return;
  ui.notice = '';
  ui.view = view;
  ui.sessionId = sessionId;
  render(true);
}

async function save(mutate, after, focus = true) {
  if (!db || ui.pending) return;
  ui.pending = true;
  try {
    state = await transaction(db, mutate);
    storageError.hidden = true;
    ui.notice = '';
    after?.();
    render(focus);
    channel?.postMessage('change');
  } catch (error) {
    storageError.textContent = 'Änderung konnte nicht gespeichert werden. ' + error.message;
    storageError.hidden = false;
  } finally {
    ui.pending = false;
  }
}

function updateSession(action, value) {
  const shown = selectedSession();
  if (!shown) return;
  const visitNumber = currentVisit(shown).number;
  void save(data => {
    const session = data.sessions.find(item => item.id === shown.id);
    if (session.events.length !== shown.events.length || currentVisit(session).number !== visitNumber) {
      throw new Error('Diese Session wurde in einem anderen Tab geändert. Bitte lade sie neu.');
    }
    changeSession(session, action, value);
  }, () => {
    if (action === 'finish') ui.view = 'summary';
    if (action === 'select') ui.view = 'session';
    if (action === 'note') ui.notice = 'Notiz gespeichert.';
  }, action !== 'note');
}

async function importCsv(file) {
  if (ui.pending) return;
  ui.pending = true;
  let set;
  try {
    if (file.size > MAX_CSV_BYTES) throw new Error('Die CSV-Datei darf höchstens 2 MB groß sein.');
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      throw new Error('Die Datei konnte nicht als UTF-8 gelesen werden.');
    }
    set = {
      id: newId(), name: file.name.replace(/\.csv$/i, '').trim() || 'Importiertes Beat-Set',
      beats: parseCsv(text),
    };
  } catch (error) {
    ui.notice = 'CSV-Import: ' + error.message;
    notice.textContent = ui.notice;
  } finally {
    ui.pending = false;
  }
  if (set) await save(data => data.sets.push(set), () => {
    ui.setId = set.id;
    ui.notice = `${set.beats.length} Beats als „${set.name}“ importiert.`;
  });
}

function exportFilename(session, format) {
  const name = session.setName.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 65);
  return `beat-challenge-${name || 'session'}-${session.startedAt.slice(0, 10)}-${session.id.slice(0, 8)}.${format}`;
}

async function copyMarkdown() {
  const output = document.querySelector('#export-content');
  const copyStatus = document.querySelector('#copy-status');
  output.focus();
  output.select();
  copyStatus.textContent = 'Markdown ist markiert. Du kannst den Text manuell kopieren.';
  if (!navigator.clipboard?.writeText) return;
  try {
    await navigator.clipboard.writeText(output.value);
    copyStatus.textContent = 'Markdown kopiert.';
  } catch { /* Leave the manual copy selection in place. */ }
}

function setTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = dark ? '#211b15' : '#f4ecdc';
  themeButton.textContent = dark ? '☀' : '☾';
  themeButton.setAttribute('aria-pressed', String(dark));
  try { localStorage.setItem(DB_NAME + ':theme', theme); } catch { /* Theme remains usable in memory. */ }
}

app.addEventListener('click', event => {
  const target = event.target.closest('button[data-action]');
  if (!target || ui.pending) return;
  const { action, value } = target.dataset;
  if (action === 'start') {
    let created;
    void save(data => {
      if (activeSession(data)) throw new Error('Es gibt bereits eine offene Session.');
      created = newSession(data.sets.find(set => set.id === value), ui.mode, ui.minutes);
      data.sessions.push(created);
    }, () => {
      ui.view = 'session';
      ui.sessionId = created.id;
    });
  } else if (action === 'home') setView('home');
  else if (action === 'open-session') setView('session', value);
  else if (action === 'open-summary') setView('summary', value);
  else if (action === 'summary') setView('summary');
  else if (action === 'back-session') setView('session');
  else if (action === 'export') setView('export');
  else if (action === 'copy') void copyMarkdown();
  else if (action === 'finish') {
    finishDialog.returnValue = '';
    finishDialog.showModal();
  } else updateSession(action, value);
});
finishDialog.addEventListener('close', () => {
  if (finishDialog.returnValue === 'finish') updateSession('finish');
});

app.addEventListener('change', event => {
  const input = event.target;
  if (input.id === 'set-choice') {
    ui.setId = input.value;
    ui.notice = '';
    render(false);
    document.querySelector('#set-choice').focus();
  } else if (input.id === 'mode') ui.mode = input.value;
  else if (input.id === 'minutes') ui.minutes = Number(input.value);
  else if (input.id === 'csv-file' && input.files[0]) {
    const file = input.files[0];
    input.value = '';
    void importCsv(file);
  }
});
app.addEventListener('submit', event => {
  if (event.target.id !== 'note-form') return;
  event.preventDefault();
  updateSession('note', document.querySelector('#note').value.trim());
});
document.querySelector('#home').addEventListener('click', () => setView('home'));
themeButton.addEventListener('click', () =>
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

async function registerOffline() {
  const status = document.querySelector('#offline-state');
  if (!('serviceWorker' in navigator)) {
    status.textContent = 'Offline-Modus benötigt HTTPS oder localhost';
    return;
  }
  try {
    await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    status.textContent = 'Offline bereit · Daten bleiben auf diesem Gerät';
  } catch {
    status.textContent = 'Offline-Modus konnte nicht eingerichtet werden';
  }
}

async function boot() {
  let theme;
  try { theme = localStorage.getItem(DB_NAME + ':theme'); } catch { /* Optional preference. */ }
  setTheme(theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  try {
    db = await openDatabase();
    state = await transaction(db);
    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel(DB_NAME);
      channel.onmessage = async () => {
        if (ui.pending) return;
        try {
          const updated = await transaction(db);
          const editedNote = document.querySelector('#note');
          if (!ui.pending && (!editedNote || editedNote.value === selectedSession()?.note)) {
            state = updated;
            render(false);
          }
        } catch { /* The next write still checks the stored revision. */ }
      };
    }
    const session = activeSession();
    if (session) ui.sessionId = session.id;
    render(false);
    setInterval(updateTimerDisplay, 250);
    void registerOffline();
  } catch (error) {
    app.setAttribute('aria-busy', 'false');
    app.textContent = 'Der lokale Speicher konnte nicht geöffnet werden. Öffne die App über HTTPS oder localhost und prüfe die Browsereinstellungen.';
    storageError.textContent = error.message;
    storageError.hidden = false;
  }
}

void boot();
