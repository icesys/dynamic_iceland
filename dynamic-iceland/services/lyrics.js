import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import * as Mpris from '../lib/mpris.js';

const CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'dynamic-iceland', 'lyrics']);
const API = 'https://lrclib.net/api';
const MISS_RETRY_US = 3 * 24 * 3600 * 1e6; // look again for lyrics that weren't there 3 days ago
const RESYNC_MS = 3000;
const MEMORY_LIMIT = 40;

// "[01:02.34]words" lines into [{time (ms), text}], sorted. Several stamps on one line, [offset:] and
// per-word <..> stamps are understood.
export function parseLrc(source) {
    const lines = [];
    let offset = 0;
    for (const raw of source.split(/\r?\n/)) {
        const off = raw.match(/^\[offset:\s*([+-]?\d+)\s*\]/i);
        if (off) {
            offset = Number(off[1]);
            continue;
        }
        const stamps = [];
        let rest = raw;
        let m;
        while ((m = rest.match(/^\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/))) {
            const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
            stamps.push(Number(m[1]) * 60000 + Number(m[2]) * 1000 + frac);
            rest = rest.slice(m[0].length);
        }
        if (!stamps.length)
            continue;
        const text = rest.replace(/<\d+:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim();
        for (const time of stamps)
            lines.push({time: Math.max(0, time - offset), text});
    }
    return lines.sort((a, b) => a.time - b.time);
}

// Video sites add noise to titles: "Song (Official Video) [HD]" → "Song"
function cleanTitle(title) {
    return title
        .replace(/[([](?:[^)\]]*?(?:official|video|lyric|audio|visuali[sz]er|hd|4k|mv|remaster(?:ed)?|explicit)[^)\]]*)[)\]]/gi, '')
        .replace(/\s+/g, ' ').trim();
}

function readFile(file, cancellable) {
    return new Promise(resolve => {
        file.load_contents_async(cancellable, (f, res) => {
            try {
                const [, bytes] = f.load_contents_finish(res);
                resolve(new TextDecoder().decode(bytes));
            } catch {
                resolve(null);
            }
        });
    });
}

function writeFile(path, text) {
    try {
        GLib.mkdir_with_parents(CACHE, 0o700);
        Gio.File.new_for_path(path).replace_contents_async(new TextEncoder().encode(text), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null, null);
    } catch (e) {
        console.debug(`Dynamic iceLand: lyrics cache: ${e.message}`);
    }
}

// Finds synced lyrics for the playing song and follows its position.
// Emits 'changed' when the song's lyrics arrive or go away, and 'line' when the current line moves.
export class Lyrics extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._session = null;
        this._memory = new Map();
        this._player = null;
        this._key = null;
        this._cancellable = null;
        this.lines = [];
        this.index = -1;
        this._position = 0; // ms at _sampled
        this._sampled = 0;
        this._lineTimer = 0;
        this._resyncTimer = 0;
        settings.connectObject(
            'changed::lyrics-enabled', () => this._reload(),
            'changed::lyrics-online', () => this._reload(),
            'changed::lyrics-folder', () => this._reload(),
            'changed::lyrics-offset', () => this._schedule(),
            'changed::lyrics-cache-revision', () => {
                this._memory.clear();
                this._reload();
            }, this);
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._cancellable?.cancel();
        this._stopTimers();
        this._session?.abort();
        this._session = null;
        this.disconnectAll();
    }

    get available() {
        return this.lines.length > 0;
    }

    // The line being sung, or null before the first one / without lyrics
    get current() {
        return this.lines[this.index] ?? null;
    }

    // A new song (or player): look up its lyrics
    load(player) {
        const key = player ? `${player.busName}|${player.artist}|${player.title}` : null;
        if (key === this._key)
            return;
        this._key = key;
        this._player = player;
        this._reload();
    }

    // Play state changed or the player seeked
    resync() {
        if (!this.available || !this._player)
            return;
        const player = this._player;
        Mpris.getState(player.busName, this._cancellable, state => {
            if (player !== this._player)
                return;
            this._position = state.position / 1000;
            this._sampled = GLib.get_monotonic_time();
            this._schedule();
        });
    }

    _reload() {
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        this._stopTimers();
        const hadLines = this.available;
        this.lines = [];
        this.index = -1;
        if (hadLines)
            this.emit('changed');
        const player = this._player;
        if (!player?.title || !this._settings.get_boolean('lyrics-enabled'))
            return;
        const cancellable = this._cancellable;
        this._find(player, cancellable).then(lines => {
            if (cancellable.is_cancelled() || player !== this._player || !lines?.length)
                return;
            this.lines = lines;
            this.index = -1;
            this.emit('changed');
            this._position = 0;
            this._sampled = GLib.get_monotonic_time();
            this.resync();
        }).catch(e => console.debug(`Dynamic iceLand: lyrics: ${e.message}`));
    }

    async _find(player, cancellable) {
        const artist = player.artist.trim();
        const title = player.title.trim();
        const id = `${artist.toLowerCase()}|${title.toLowerCase()}`;
        if (this._memory.has(id))
            return this._memory.get(id);

        let text = await this._fromFolder(player, cancellable);
        const cachePath = GLib.build_filenamev([CACHE, `${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, id, -1)}.lrc`]);
        if (!text)
            text = await this._fromCache(cachePath, cancellable);
        if (text === null && this._settings.get_boolean('lyrics-online')) {
            text = await this._fromLrclib(artist, title, player.album, player.length, cancellable);
            if (text !== null && !cancellable.is_cancelled())
                writeFile(cachePath, text); // '' remembers "no lyrics" for a while
        }
        if (cancellable.is_cancelled())
            return null;
        const lines = text ? parseLrc(text) : [];
        if (text !== null) // a failed lookup is tried again next time
            this._memory.set(id, lines);
        if (this._memory.size > MEMORY_LIMIT)
            this._memory.delete(this._memory.keys().next().value);
        return lines;
    }

    // An .lrc next to the music file, or "Artist - Title.lrc" / "Title.lrc" in the chosen folder
    async _fromFolder(player, cancellable) {
        const candidates = [];
        if (player.url.startsWith('file://')) {
            const path = Gio.File.new_for_uri(player.url).get_path();
            if (path)
                candidates.push(path.replace(/\.[^./]+$/, '.lrc'));
        }
        const folder = this._settings.get_string('lyrics-folder').trim().replace(/^~(?=\/|$)/, GLib.get_home_dir());
        if (folder) {
            const safe = s => s.replace(/[/\\]/g, '_');
            if (player.artist)
                candidates.push(GLib.build_filenamev([folder, `${safe(player.artist)} - ${safe(player.title)}.lrc`]));
            candidates.push(GLib.build_filenamev([folder, `${safe(player.title)}.lrc`]));
        }
        for (const path of candidates) {
            // eslint-disable-next-line no-await-in-loop
            const text = await readFile(Gio.File.new_for_path(path), cancellable);
            if (text)
                return text;
        }
        return null;
    }

    // Returns the cached text ('' = known to have none) or null when there's no usable entry
    async _fromCache(path, cancellable) {
        const file = Gio.File.new_for_path(path);
        let info;
        try {
            info = file.query_info('time::modified,standard::size', Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            return null;
        }
        if (info.get_size() === 0) {
            const age = GLib.get_real_time() - info.get_attribute_uint64('time::modified') * 1e6;
            return age < MISS_RETRY_US ? '' : null;
        }
        return readFile(file, cancellable);
    }

    async _fromLrclib(artist, title, album, lengthUs, cancellable) {
        const seconds = Math.round(lengthUs / 1e6);
        const clean = cleanTitle(title);
        if (artist) {
            const exact = await this._get('get', {track_name: clean, artist_name: artist, album_name: album,
                duration: seconds || undefined}, cancellable);
            if (exact?.syncedLyrics)
                return exact.syncedLyrics;
        }
        if (cancellable.is_cancelled())
            return null;
        const query = artist ? {track_name: clean, artist_name: artist} : {q: clean};
        const found = await this._get('search', query, cancellable);
        if (found === null)
            return null; // network trouble: try again next time
        const synced = (Array.isArray(found) ? found : []).filter(r => r.syncedLyrics);
        if (seconds)
            synced.sort((a, b) => Math.abs((a.duration ?? 0) - seconds) - Math.abs((b.duration ?? 0) - seconds));
        return synced[0]?.syncedLyrics ?? '';
    }

    // JSON from lrclib, {} for "not found", null when the request failed
    _get(endpoint, params, cancellable) {
        if (!this._session) {
            this._session = new Soup.Session({timeout: 12,
                user_agent: 'Dynamic iceLand GNOME extension (https://github.com/icesys/dynamic_iceland)'});
        }
        const query = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => `${k}=${GLib.Uri.escape_string(String(v), null, false)}`).join('&');
        const message = Soup.Message.new('GET', `${API}/${endpoint}?${query}`);
        return new Promise(resolve => {
            this._session.send_and_read_async(message, GLib.PRIORITY_LOW, cancellable, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    const status = message.get_status();
                    if (status === 404) {
                        resolve({});
                        return;
                    }
                    if (status !== 200) {
                        resolve(null);
                        return;
                    }
                    resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
                } catch {
                    resolve(null);
                }
            });
        });
    }

    // ---- Following the song

    _now() {
        let ms = this._position + this._settings.get_int('lyrics-offset');
        if (this._player?.playing)
            ms += (GLib.get_monotonic_time() - this._sampled) / 1000;
        return ms;
    }

    _stopTimers() {
        if (this._lineTimer)
            GLib.source_remove(this._lineTimer);
        if (this._resyncTimer)
            GLib.source_remove(this._resyncTimer);
        this._lineTimer = this._resyncTimer = 0;
    }

    // Moves to the right line now, then sleeps until the next one starts
    _schedule() {
        this._stopTimers();
        if (!this.available)
            return;
        const now = this._now();
        let index = -1;
        for (let i = 0; i < this.lines.length && this.lines[i].time <= now; i++)
            index = i;
        if (index !== this.index) {
            this.index = index;
            this.emit('line');
        }
        if (!this._player?.playing)
            return;
        const next = this.lines[index + 1];
        if (next) {
            this._lineTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(16, Math.ceil(next.time - now)), () => {
                this._lineTimer = 0;
                this._schedule();
                return GLib.SOURCE_REMOVE;
            });
        }
        // Players drift and some never send Seeked: check the real position every few seconds
        this._resyncTimer = GLib.timeout_add(GLib.PRIORITY_LOW, RESYNC_MS, () => {
            this._resyncTimer = 0;
            this.resync();
            return GLib.SOURCE_REMOVE;
        });
    }
}
