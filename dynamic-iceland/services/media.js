import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const PREFIX = 'org.mpris.MediaPlayer2.';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const ROOT_IFACE = 'org.mpris.MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

// One MPRIS player on the session bus, read through plain D-Bus proxies.
// Emits 'changed' whenever anything the island shows may have changed.
export class Player extends EventEmitter {
    constructor(busName, cancellable) {
        super();
        this.busName = busName;
        this.lastActive = 0;
        this.ready = false;
        this._player = null;
        this._root = null;
        this._app = undefined;
        const make = (iface, done) => Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
            busName, OBJECT_PATH, iface, cancellable, (o, res) => {
                try {
                    done(Gio.DBusProxy.new_for_bus_finish(res));
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.debug(`Dynamic iceLand: ${busName}: ${e.message}`);
                }
            });
        make(ROOT_IFACE, proxy => {
            this._root = proxy;
            this._app = undefined;
            this.emit('changed');
        });
        make(PLAYER_IFACE, proxy => {
            this._player = proxy;
            this.ready = true;
            this._touch();
            proxy.connectObject('g-properties-changed', (p, changed) => {
                const keys = Object.keys(changed.deepUnpack());
                if (keys.includes('PlaybackStatus') || keys.includes('Metadata'))
                    this._touch();
                this.emit('changed');
            }, 'g-signal', (p, sender, signal) => {
                if (signal === 'Seeked')
                    this.emit('seeked');
            }, this);
            this.emit('changed');
        });
    }

    destroy() {
        this._player?.disconnectObject(this);
        this._player = null;
        this._root = null;
        this.disconnectAll();
    }

    _touch() {
        if (this.status === 'Playing')
            this.lastActive = GLib.get_monotonic_time();
    }

    _prop(proxy, name) {
        return proxy?.get_cached_property(name)?.recursiveUnpack();
    }

    get _meta() {
        return this._prop(this._player, 'Metadata') ?? {};
    }

    get status() {
        return this._prop(this._player, 'PlaybackStatus') ?? 'Stopped';
    }

    get playing() {
        return this.status === 'Playing';
    }

    get title() {
        const t = this._meta['xesam:title'];
        return typeof t === 'string' ? t.trim() : '';
    }

    get artist() {
        const a = this._meta['xesam:artist'];
        if (Array.isArray(a))
            return a.filter(x => typeof x === 'string').join(', ');
        return typeof a === 'string' ? a : '';
    }

    get album() {
        const a = this._meta['xesam:album'];
        return typeof a === 'string' ? a : '';
    }

    get artUrl() {
        const u = this._meta['mpris:artUrl'];
        return typeof u === 'string' ? u : '';
    }

    get url() {
        const u = this._meta['xesam:url'];
        return typeof u === 'string' ? u : '';
    }

    // Track length in microseconds, 0 when unknown
    get length() {
        const l = Number(this._meta['mpris:length'] ?? 0);
        return Number.isFinite(l) && l > 0 ? l : 0;
    }

    get identity() {
        return this._prop(this._root, 'Identity') ?? this.busName.slice(PREFIX.length).split('.')[0];
    }

    get canNext() {
        return this._prop(this._player, 'CanGoNext') !== false;
    }

    get canPrevious() {
        return this._prop(this._player, 'CanGoPrevious') !== false;
    }

    // The desktop app behind the player, found from DesktopEntry or, for browsers, by name
    get app() {
        if (this._app !== undefined)
            return this._app;
        const system = Shell.AppSystem.get_default();
        const entry = this._prop(this._root, 'DesktopEntry');
        let app = entry ? system.lookup_app(`${entry}.desktop`) : null;
        if (!app) {
            const hit = Shell.AppSystem.search(this.identity)?.[0]?.[0];
            app = hit ? system.lookup_app(hit) : null;
        }
        if (this._root)
            this._app = app;
        return app;
    }

    get sourceName() {
        if (/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//.test(this.url))
            return 'YouTube';
        return this.app?.get_name() ?? this.identity;
    }

    get sourceIcon() {
        return this.app?.get_icon() ?? new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
    }

    _call(method, params = null) {
        this._player?.call(method, params, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    playPause() {
        this._call('PlayPause');
    }

    next() {
        this._call('Next');
    }

    previous() {
        this._call('Previous');
    }

    // Brings the player window up; falls back to the app
    raise() {
        const app = this.app;
        if (app) {
            app.activate();
            return;
        }
        if (this._prop(this._root, 'CanRaise'))
            this._root.call('Raise', null, Gio.DBusCallFlags.NONE, -1, null, null);
    }
}

// Watches the bus for media players and tells the island which one to show
export class MediaService {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        this._players = new Map();
        this._current = null;
        this._cancellable = new Gio.Cancellable();

        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                let names = [];
                try {
                    [names] = conn.call_finish(res).deepUnpack();
                } catch {
                    return;
                }
                names.filter(n => n.startsWith(PREFIX)).forEach(n => this._add(n));
            });
        this._watch = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
            'NameOwnerChanged', '/org/freedesktop/DBus', 'org.mpris.MediaPlayer2',
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE, (c, s, p, i, sig, params) => {
                const [name, before, after] = params.deepUnpack();
                if (before)
                    this._remove(name);
                if (after)
                    this._add(name);
            });
        settings.connectObject('changed::ignored-players', () => this._choose(), this);
    }

    destroy() {
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._watch);
        this._settings.disconnectObject(this);
        this._island.setMedia(null);
        this._island = null;
        for (const player of this._players.values())
            player.destroy();
        this._players.clear();
    }

    _add(busName) {
        if (this._players.has(busName) || this._cancellable.is_cancelled())
            return;
        const player = new Player(busName, this._cancellable);
        player.connect('changed', () => this._choose());
        this._players.set(busName, player);
    }

    _remove(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;
        this._players.delete(busName);
        player.destroy();
        if (player === this._current)
            this._current = null;
        this._choose();
    }

    _ignored(player) {
        const list = this._settings.get_strv('ignored-players').map(s => s.trim().toLowerCase()).filter(Boolean);
        const names = `${player.busName} ${player.identity}`.toLowerCase();
        return list.some(word => names.includes(word));
    }

    // Playing beats paused; among equals the one that played most recently wins.
    // Players without a title (notification sounds, idle browser tabs) never show.
    _choose() {
        const score = p => {
            if (!p.ready || !p.title || this._ignored(p))
                return 0;
            return p.status === 'Playing' ? 2 : p.status === 'Paused' ? 1 : 0;
        };
        let best = null;
        for (const p of this._players.values()) {
            const s = score(p);
            if (!s)
                continue;
            if (!best || s > score(best) || (s === score(best) && p.lastActive > best.lastActive))
                best = p;
        }
        if (best !== this._current) {
            this._current = best;
            this._island.setMedia(best);
        }
    }
}
