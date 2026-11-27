import { DiscordSDK } from '@discord/embedded-app-sdk';
import { parseLrc, plainLyricLines } from '../../src/lib/utils';
import { activeLyricIndex, playbackPosition } from './timing.mjs';

const element = (id) => document.getElementById(id);
const controls = [...document.querySelectorAll('[data-command], #search-form input, #search-form button')];
const status = element('status');
const art = element('art');
const lyricPanel = element('lyrics-panel');
const lyricLines = element('lyric-lines');
const lyricMessage = element('lyrics-message');
const code = element('code');
const linkButton = element('link');
const storageKey = 'zeta:activity-ticket';
let ticket = readTicket();
let linked = false;
let playback = null;
let sending = false;
let timer;
let revision = 0;
let receivedAt = 0;
let mediaKey = null;
let media = null;
let loadingMedia = null;
let lyricText = null;
let timedRows = [];
let activeRow = -1;
let activeWord = -1;

function readTicket() {
    try { return sessionStorage.getItem(storageKey); } catch { return null; }
}

function setTicket(next) {
    ticket = next;
    revision++;
    try {
        if (next) sessionStorage.setItem(storageKey, next);
        else sessionStorage.removeItem(storageKey);
    } catch { /* The Activity still works when storage is unavailable. */ }
}

async function api(path, init = {}) {
    const response = await fetch(path, {
        ...init, signal: AbortSignal.timeout(25_000),
        headers: {
            ...(ticket && { Authorization: `Bearer ${ticket}` }),
            ...(init.body && { 'Content-Type': 'application/json' }),
        },
    });
    const data = await response.json();
    if (!response.ok) {
        const error = new Error(data.error ?? 'Could not connect to Zeta.');
        error.status = response.status;
        throw error;
    }
    return data;
}

function inform(message) {
    element('feedback').textContent = message;
    element('feedback').hidden = !message;
}

function setControls() {
    for (const control of controls) control.disabled = !linked || !playback || sending;
}

function showConnection() {
    element('connection-heading').textContent = linked ? 'Activity linked' : 'Connect to your Zeta player';
    element('guidance').textContent = linked
        ? 'Playback commands go to your running Zeta app.'
        : 'Open Zeta Music and connect it to Wayship. Then link this Activity from Discord.';
    linkButton.hidden = linked || !!ticket;
    element('unlink').hidden = !ticket;
    element('unlink').textContent = linked ? 'Disconnect Activity' : 'Cancel';
    if (!ticket || linked) code.hidden = true;
    setControls();
}

const timestamp = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

function showMedia(next) {
    media = next;
    const cover = typeof next?.cover === 'string' && next.cover.startsWith('data:image/jpeg;base64,') ? next.cover : null;
    if (!cover) {
        art.hidden = true;
        art.removeAttribute('src');
    } else if (art.getAttribute('src') !== cover) {
        art.hidden = true;
        art.src = cover;
    }

    const raw = next?.lyrics ?? null;
    lyricMessage.hidden = !!raw;
    if (!raw) {
        lyricMessage.textContent = !linked ? 'Connect Zeta to see lyrics.'
            : !playback?.track ? 'Play a track to see its lyrics.'
            : !mediaKey ? 'Open the updated Zeta app to see lyrics.'
            : !next || next.pending ? 'Waiting for lyrics from Zeta…'
            : 'No lyrics available for this track.';
    }
    if (raw === lyricText) return;
    lyricText = raw;
    activeRow = activeWord = -1;
    const timed = parseLrc(raw);
    lyricLines.classList.toggle('timed', timed.length > 0);
    if (!timed.length) {
        timedRows = [];
        lyricLines.replaceChildren(...plainLyricLines(raw).map((line) => {
            const row = document.createElement('p');
            row.className = 'lyric-line';
            row.textContent = line;
            return row;
        }));
        return;
    }
    timedRows = timed.map((line) => {
        const row = document.createElement('p');
        row.className = 'lyric-line';
        const words = line.words?.map((word) => {
            const node = document.createElement('span');
            node.textContent = word.text;
            return { ...word, node };
        });
        if (words?.length) row.append(...words.map(({ node }) => node));
        else row.textContent = line.text;
        return { ...line, row, words };
    });
    lyricLines.replaceChildren(...timedRows.map(({ row }) => row));
}

function drawTimeline(recenter = false) {
    const position = playbackPosition(playback, performance.now() - receivedAt);
    element('progress').value = position;
    const label = timestamp(position);
    if (element('position').textContent !== label) element('position').textContent = label;
    if (lyricPanel.hidden || !timedRows.length) return;

    const rowIndex = activeLyricIndex(timedRows, position);
    const active = timedRows[rowIndex];
    if (rowIndex !== activeRow) {
        const previous = timedRows[activeRow];
        previous?.row.classList.remove('active');
        previous?.row.removeAttribute('aria-current');
        previous?.words?.[activeWord]?.node.classList.remove('active-word');
        activeRow = rowIndex;
        activeWord = -1;
        active?.row.classList.add('active');
        active?.row.setAttribute('aria-current', 'true');
        recenter = true;
    }
    if (recenter && active) {
        const offset = active.row.getBoundingClientRect().top - lyricLines.getBoundingClientRect().top;
        lyricLines.scrollTo({
            top: lyricLines.scrollTop + offset - (lyricLines.clientHeight - active.row.offsetHeight) / 2,
            behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        });
    }
    const wordIndex = active?.words ? activeLyricIndex(active.words, position) : -1;
    if (wordIndex !== activeWord) {
        active?.words?.[activeWord]?.node.classList.remove('active-word');
        activeWord = wordIndex;
        active?.words?.[activeWord]?.node.classList.add('active-word');
    }
}

async function refreshMedia() {
    if (!mediaKey || loadingMedia || (media && !media.pending)) return;
    const key = mediaKey;
    const request = {};
    loadingMedia = request;
    try {
        const result = await api(`/api/media?track=${encodeURIComponent(key)}`);
        if (loadingMedia === request && result.trackKey === key && mediaKey === key) {
            showMedia(result);
            drawTimeline();
        }
    } catch {
        // The track may have changed during the lookup. Playback will refresh
        // the key before the next attempt.
    } finally {
        if (loadingMedia === request) loadingMedia = null;
    }
}

function render(snapshot) {
    playback = snapshot;
    receivedAt = performance.now();
    const track = snapshot?.track;
    status.textContent = snapshot?.device ?? (linked ? 'Waiting for Zeta' : 'Connect your player');
    element('title').textContent = track?.title ?? (linked ? 'Nothing playing' : 'Now playing');
    element('artist').textContent = track ? [track.artist, track.album].filter(Boolean).join(' · ')
        : linked ? 'Search for a song to start playback.' : 'Connect Zeta to see the current track.';
    if ((snapshot?.trackKey ?? null) !== mediaKey) {
        mediaKey = snapshot?.trackKey ?? null;
        loadingMedia = null;
        media = null;
    }
    showMedia(media);

    const progress = element('progress');
    progress.max = Math.max(1, snapshot?.duration ?? 0);
    element('duration').textContent = timestamp(snapshot?.duration);
    const playing = snapshot?.phase === 'playing';
    element('toggle').textContent = playing ? '⏸' : '▶';
    element('toggle').setAttribute('aria-label', playing ? 'Pause playback' : 'Resume playback');

    const tracks = snapshot?.queue ?? [];
    element('tracks').replaceChildren(...tracks.map((song) => {
        const row = document.createElement('li');
        const artist = document.createElement('span');
        artist.textContent = song.artist ?? '';
        row.append(song.title ?? '', artist);
        return row;
    }));
    element('empty').textContent = linked ? 'The queue is empty.' : 'Your Zeta queue will appear here.';
    element('empty').hidden = tracks.length > 0;
    setControls();
    drawTimeline();
    void refreshMedia();
}

art.addEventListener('load', () => { art.hidden = !art.getAttribute('src'); });
art.addEventListener('error', () => { art.hidden = true; });
element('lyrics-toggle').addEventListener('click', (event) => {
    lyricPanel.hidden = !lyricPanel.hidden;
    element('queue-panel').hidden = !lyricPanel.hidden;
    element('queue-heading').textContent = lyricPanel.hidden ? 'Up next' : 'Lyrics';
    event.currentTarget.textContent = lyricPanel.hidden ? 'Lyrics' : 'Up next';
    event.currentTarget.setAttribute('aria-expanded', String(!lyricPanel.hidden));
    drawTimeline(!lyricPanel.hidden);
});

async function refresh() {
    const current = revision;
    if (!ticket || document.hidden) return;
    try {
        if (!linked) {
            const result = await api('/api/link');
            if (current !== revision) return;
            linked = result.linked;
            if (result.code) {
                code.textContent = `/wayship activity-code:${result.code}`;
                code.hidden = false;
            }
            showConnection();
        }
        if (linked) {
            const snapshot = await api('/api/player');
            if (current === revision) {
                render(snapshot);
                inform('');
            }
        }
    } catch (error) {
        if (current !== revision) return;
        if (error.status === 401) {
            setTicket(null);
            linked = false;
            showConnection();
        }
        render(null);
        inform(error.message);
    }
}

async function poll() {
    clearTimeout(timer);
    await refresh();
    clearTimeout(timer);
    timer = setTimeout(poll, linked ? 7000 : 1700);
}

async function command(action, query) {
    if (sending || !playback) return;
    const current = revision;
    sending = true;
    setControls();
    try {
        const result = await api('/api/player', {
            method: 'POST', body: JSON.stringify({ action, query }),
        });
        if (current !== revision) return;
        inform(result.track ? `Sent ${result.track.title} to Zeta.` : '');
        void poll();
    } catch (error) {
        if (current === revision) inform(error.message);
    } finally {
        sending = false;
        setControls();
    }
}

linkButton.addEventListener('click', async () => {
    linkButton.disabled = true;
    try {
        const result = await api('/api/link', { method: 'POST' });
        setTicket(result.ticket);
        code.textContent = `/wayship activity-code:${result.code}`;
        code.hidden = false;
        inform('');
        showConnection();
        void poll();
    } catch (error) {
        inform(error.message);
    } finally {
        linkButton.disabled = false;
    }
});

element('unlink').addEventListener('click', async () => {
    try { await api('/api/link', { method: 'DELETE' }); } catch { /* Clear the local pairing too. */ }
    setTicket(null);
    linked = false;
    render(null);
    showConnection();
    inform('');
});

element('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!event.submitter || !linked) return;
    void command(event.submitter.value, element('song').value.trim());
});
for (const button of document.querySelectorAll('[data-command]')) {
    button.addEventListener('click', () => {
        const action = button.dataset.command === 'toggle' ? (playback?.phase === 'playing' ? 'pause' : 'unpause') : button.dataset.command;
        void command(action);
    });
}

if (new URLSearchParams(location.search).has('frame_id')) {
    api('/api/config').then(async ({ applicationId }) => {
        const sdk = new DiscordSDK(applicationId);
        await sdk.ready();
    }).catch(() => inform('Discord could not finish opening the embedded client.'));
}

showConnection();
void poll();
setInterval(() => { if (!document.hidden && playback) drawTimeline(); }, 100);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
