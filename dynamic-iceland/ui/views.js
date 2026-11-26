import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Mpris from '../lib/mpris.js';
import {toCss, toHex} from '../lib/color.js';
import {Marquee} from './marquee.js';
import {Visualizer} from './visualizer.js';

const gicon = icon => typeof icon === 'string' ? new Gio.ThemedIcon({name: icon}) : icon;

const clockText = us => {
    const total = Math.max(0, Math.floor(us / 1e6));
    const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
    const two = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
};

function vbox(props = {}) {
    const box = new St.BoxLayout(props);
    box.layout_manager.orientation = Clutter.Orientation.VERTICAL;
    return box;
}

// Rounded cover art. The image is a small PNG from the cache (see art.js).
class Cover {
    constructor(styleClass) {
        this.actor = new St.Bin({style_class: `iceland-cover ${styleClass}`, y_align: Clutter.ActorAlign.CENTER});
        this._uri = null;
        this._size = 0;
        this._radius = 0;
        this._border = '';
        this._placeholder = new St.Icon({icon_name: 'audio-x-generic-symbolic', style_class: 'iceland-cover-placeholder'});
        this.actor.set_child(this._placeholder);
    }

    configure(size, shape, border) {
        this._size = size;
        this._radius = {circle: size / 2, square: Math.round(size * 0.08), rounded: Math.round(size * 0.24)}[shape] ?? size / 4;
        this._border = border;
        this._placeholder.icon_size = Math.round(size * 0.45);
        this._restyle();
    }

    set uri(uri) {
        this._uri = uri;
        this._placeholder.visible = !uri;
        this._restyle();
    }

    _restyle() {
        this.actor.set_size(this._size, this._size);
        this.actor.style = `border-radius: ${this._radius}px;${this._border}` +
            (this._uri ? ` background-image: url("${this._uri}"); background-size: cover;` : '');
    }

    // Vinyl mode: keeps turning while music plays
    spin(on) {
        const running = !!this.actor.get_transition('iceland-spin');
        if (on === running)
            return;
        if (!on) {
            this.actor.remove_transition('iceland-spin');
            return;
        }
        this.actor.set_pivot_point(0.5, 0.5);
        const start = this.actor.rotation_angle_z % 360;
        const t = new Clutter.PropertyTransition({property_name: 'rotation-angle-z', duration: 7000, repeat_count: -1,
            progress_mode: Clutter.AnimationMode.LINEAR});
        t.set_from(start);
        t.set_to(start + 360);
        this.actor.add_transition('iceland-spin', t);
    }

    unspin() {
        this.actor.remove_transition('iceland-spin');
        this.actor.rotation_angle_z = 0;
    }
}

function coverBorder(settings, accent) {
    switch (settings.get_string('art-border')) {
    case 'subtle':
        return ' border: 1px solid rgba(255,255,255,0.25);';
    case 'accent':
        return ` border: 2px solid ${toHex(accent)};`;
    default:
        return '';
    }
}

// New lyric lines appear softly
function fadeIn(actor, settings, enabled) {
    actor.remove_transition('opacity');
    const duration = settings.get_boolean('lyrics-fade') ? settings.get_int('lyrics-fade-duration') : 0;
    if (!enabled || duration <= 0) {
        actor.opacity = 255;
        return;
    }
    actor.opacity = 0;
    actor.ease({opacity: 255, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
}

function wrapLabel(styleClass) {
    const label = new St.Label({style_class: styleClass});
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

// Resting music view: cover, title, visualizer
export class CompactMusicView {
    constructor(island) {
        this.island = island;
        this.expanded = false;
        this.actor = new St.BoxLayout({style_class: 'iceland-compact'});
        this.cover = new Cover('iceland-cover-small');
        this.text = vbox({style_class: 'iceland-compact-text', y_align: Clutter.ActorAlign.CENTER});
        this.title = new Marquee('iceland-compact-title');
        this.artist = new Marquee('iceland-compact-artist');
        this.lyric = new Marquee('iceland-compact-lyric');
        this.text.add_child(this.title);
        this.text.add_child(this.artist);
        this.text.add_child(this.lyric);
        this.lyrics = island.lyrics;
        this.visualizer = new Visualizer(island.feed, island.settings, {bars: 5, width: 26, height: 16});
        this.actor.add_child(this.cover.actor);
        this.actor.add_child(this.text);
        this.actor.add_child(this.visualizer);
    }

    padding() {
        const s = this.island.settings;
        const h = s.get_int('compact-art-size');
        const v = Math.max(4, Math.round(h * 0.16));
        return [v, 14, v, this.cover.actor.visible ? v : 14];
    }

    restyle(colors) {
        const s = this.island.settings;
        this.cover.configure(s.get_int('compact-art-size'), s.get_string('art-shape') === 'square' ? 'rounded' : 'circle',
            coverBorder(s, colors.accent));
        this.cover.actor.visible = s.get_boolean('compact-show-art');
        this.title.visible = s.get_boolean('compact-show-title');
        this.title.configure(s.get_int('compact-text-width'), s.get_boolean('scroll-titles'));
        this.artist.configure(s.get_int('compact-text-width'), s.get_boolean('scroll-titles'));
        this.lyric.configure(s.get_int('compact-text-width') + s.get_int('lyrics-extra-width'), s.get_boolean('scroll-titles'));
        this._accent = colors.accent;
        this.syncLyrics(false);
        this.visualizer.visible = s.get_boolean('compact-show-visualizer') && s.get_string('visualizer-source') !== 'off';
        this.visualizer.setColor(colors.accent);
        this.actor.style = `spacing: ${s.get_int('compact-art-size') > 30 ? 12 : 10}px;`;
    }

    // Shows the line being sung under the title (instead of the artist), or alone in place of both
    syncLyrics(fade = true) {
        const s = this.island.settings;
        const mode = s.get_boolean('lyrics-enabled') ? s.get_string('lyrics-compact') : 'off';
        const line = mode !== 'off' ? this.lyrics.current : null;
        const sung = line ? line.text || '♪' : null;
        const solo = mode === 'only' && sung !== null;
        this.title.visible = s.get_boolean('compact-show-title') && !solo;
        this.artist.visible = s.get_boolean('compact-show-artist') && !!this.artist.text && sung === null;
        this.lyric.visible = sung !== null;
        this.lyric.style = (solo ? 'font-size: 9.5pt; font-weight: 600;' : 'font-size: 8.5pt;') +
            (s.get_boolean('lyrics-accent') && this._accent ? ` color: ${toHex(this._accent)};` : '');
        if (sung !== null && sung !== this.lyric.text) {
            this.lyric.text = sung;
            fadeIn(this.lyric, s, fade);
        }
        this.text.visible = this.title.visible || this.artist.visible || this.lyric.visible;
    }

    update(player, art) {
        this.title.text = player.title;
        this.artist.text = player.artist || '';
        this.syncLyrics(false);
        this.cover.uri = art?.uri ?? null;
        if (this.island.settings.get_boolean('art-spin'))
            this.cover.spin(player.playing);
        else
            this.cover.unspin();
    }
}

// Seek bar with a draggable feel: click or drag anywhere on it
class SeekBar {
    constructor(onSeek) {
        this.actor = new St.BoxLayout({style_class: 'iceland-seek-row'});
        this._elapsed = new St.Label({style_class: 'iceland-time', y_align: Clutter.ActorAlign.CENTER});
        this._remaining = new St.Label({style_class: 'iceland-time', y_align: Clutter.ActorAlign.CENTER});
        this._track = new St.Widget({style_class: 'iceland-seek', reactive: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._fill = new St.Widget({style_class: 'iceland-seek-fill'});
        this._track.add_child(this._fill);
        this.actor.add_child(this._elapsed);
        this.actor.add_child(this._track);
        this.actor.add_child(this._remaining);
        this._fraction = 0;
        this._length = 0;
        this._dragging = false;
        this._onSeek = onSeek;
        this._track.connect('notify::width', () => this._paint());
        this._track.connect('button-press-event', (a, e) => {
            this._dragging = true;
            this._preview(e);
            return Clutter.EVENT_STOP;
        });
        this._track.connect('motion-event', (a, e) => {
            if (this._dragging)
                this._preview(e);
            return Clutter.EVENT_PROPAGATE;
        });
        this._track.connect('button-release-event', (a, e) => {
            if (this._dragging) {
                this._dragging = false;
                this._preview(e);
                this._onSeek(this._fraction * this._length);
            }
            return Clutter.EVENT_STOP;
        });
        this._track.connect('leave-event', () => {
            if (this._dragging) {
                this._dragging = false;
                this._onSeek(this._fraction * this._length);
            }
        });
    }

    _preview(event) {
        const [x] = event.get_coords();
        const [ok, local] = this._track.transform_stage_point(x, 0);
        if (!ok || this._track.width <= 0)
            return;
        this._fraction = Math.max(0, Math.min(1, local / this._track.width));
        this._paint();
    }

    set(position, length) {
        if (this._dragging)
            return;
        this._length = length;
        this._fraction = length > 0 ? Math.max(0, Math.min(1, position / length)) : 0;
        this._paint();
    }

    _paint() {
        const position = this._fraction * this._length;
        this._elapsed.text = clockText(position);
        this._remaining.text = `-${clockText(this._length - position)}`;
        this._fill.set_size(Math.round(this._track.width * this._fraction), this._track.height);
    }

    setColor(rgb) {
        this._fill.style = `background-color: ${toHex(rgb)};`;
    }
}

// Details view shown on hover: big cover, app, title, artist, seek bar, controls
export class ExpandedMusicView {
    constructor(island) {
        this.island = island;
        this.expanded = true;
        this.player = null;
        this.state = null;
        this._poll = 0;
        this._cancellable = new Gio.Cancellable();

        this.actor = vbox({style_class: 'iceland-expanded'});
        const top = new St.BoxLayout({style_class: 'iceland-expanded-top'});
        this.cover = new Cover('iceland-cover-big');
        const info = vbox({style_class: 'iceland-info', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._sourceRow = new St.BoxLayout({style_class: 'iceland-source'});
        this._sourceIcon = new St.Icon({style_class: 'iceland-source-icon'});
        this._sourceName = new St.Label({style_class: 'iceland-source-name', y_align: Clutter.ActorAlign.CENTER});
        this._sourceName.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._sourceRow.add_child(this._sourceIcon);
        this._sourceRow.add_child(this._sourceName);
        this.title = new Marquee('iceland-title');
        this.artist = new Marquee('iceland-artist');
        info.add_child(this._sourceRow);
        info.add_child(this.title);
        info.add_child(this.artist);
        this.visualizer = new Visualizer(island.feed, island.settings, {bars: 6, width: 34, height: 26});
        top.add_child(this.cover.actor);
        top.add_child(info);
        top.add_child(this.visualizer);
        this.actor.add_child(top);

        this.lyrics = island.lyrics;
        this._lyricsBox = vbox({style_class: 'iceland-lyrics'});
        this._lyricPrev = wrapLabel('iceland-lyric iceland-lyric-near');
        this._lyricNow = wrapLabel('iceland-lyric iceland-lyric-now');
        this._lyricNext = wrapLabel('iceland-lyric iceland-lyric-near');
        [this._lyricPrev, this._lyricNow, this._lyricNext].forEach(l => this._lyricsBox.add_child(l));
        this.actor.add_child(this._lyricsBox);

        this.seek = new SeekBar(us => {
            if (this.player && this.state?.trackId && this.state.canSeek) {
                Mpris.setPosition(this.player.busName, this.state.trackId, us);
                this.state.position = us;
                this.state.sampled = GLib.get_monotonic_time();
            }
        });
        this.actor.add_child(this.seek.actor);

        const controls = new St.BoxLayout({style_class: 'iceland-controls', x_align: Clutter.ActorAlign.CENTER});
        const button = (icon, cls, cb) => {
            const b = new St.Button({style_class: `iceland-button ${cls}`, can_focus: true,
                child: new St.Icon({icon_name: icon})});
            b.connect('clicked', cb);
            controls.add_child(b);
            return b;
        };
        this._shuffle = button('media-playlist-shuffle-symbolic', 'iceland-toggle', () => this._toggleShuffle());
        this._prev = button('media-skip-backward-symbolic', '', () => this.player?.previous());
        this._play = button('media-playback-start-symbolic', 'iceland-play', () => this.player?.playPause());
        this._next = button('media-skip-forward-symbolic', '', () => this.player?.next());
        this._repeat = button('media-playlist-repeat-symbolic', 'iceland-toggle', () => this._cycleRepeat());
        this.actor.add_child(controls);

        this.actor.connect('notify::mapped', () => this._syncPolling());
        this.actor.connect('destroy', () => {
            this._cancellable.cancel();
            if (this._poll)
                GLib.source_remove(this._poll);
            this._poll = 0;
        });
    }

    padding() {
        return [16, 18, 14, 16];
    }

    restyle(colors) {
        const s = this.island.settings;
        const art = s.get_int('expanded-art-size');
        this.cover.configure(art, s.get_string('art-shape'), coverBorder(s, colors.accent));
        const pad = this.padding();
        const width = s.get_int('expanded-width') - pad[1] - pad[3];
        this.fixedWidth = width;
        this.actor.width = width;
        const showVis = s.get_boolean('expanded-show-visualizer') && s.get_string('visualizer-source') !== 'off';
        this.visualizer.visible = showVis;
        const textWidth = Math.max(60, width - art - 14 - (showVis ? 34 + 14 : 0));
        this.title.configure(textWidth, s.get_boolean('scroll-titles'));
        this.artist.configure(textWidth, s.get_boolean('scroll-titles'));
        this._sourceRow.visible = s.get_boolean('expanded-show-source');
        this.visualizer.setColor(colors.accent);
        this.seek.setColor(colors.accent);
        this._accent = colors.accent;
        this._syncToggles();
        this._syncVisibility();
        this.syncLyrics(false);
    }

    // Previous, current and next line; returns true when the size may have changed
    syncLyrics(fade = true) {
        const s = this.island.settings;
        const mode = s.get_boolean('lyrics-enabled') ? s.get_string('lyrics-expanded') : 'off';
        const was = `${this._lyricsBox.visible}|${this._lyricPrev.text}|${this._lyricNow.text}|${this._lyricNext.text}`;
        this._lyricsBox.visible = mode !== 'off' && this.lyrics.available;
        if (this._lyricsBox.visible) {
            const {lines, index} = this.lyrics;
            const context = mode === 'context';
            const text = i => i < 0 ? '' : i < lines.length ? lines[i].text || '♪' : '';
            const now = index < 0 ? '♪' : text(index);
            this._lyricPrev.text = context ? text(index - 1) : '';
            this._lyricNext.text = context ? text(index + 1) : '';
            this._lyricPrev.visible = !!this._lyricPrev.text;
            this._lyricNext.visible = !!this._lyricNext.text;
            this._lyricNow.style = s.get_boolean('lyrics-accent') && this._accent ? `color: ${toHex(this._accent)};` : null;
            if (now !== this._lyricNow.text) {
                this._lyricNow.text = now;
                fadeIn(this._lyricNow, s, fade);
            }
        }
        return was !== `${this._lyricsBox.visible}|${this._lyricPrev.text}|${this._lyricNow.text}|${this._lyricNext.text}`;
    }

    update(player, art) {
        const changed = player !== this.player;
        this.player = player;
        if (changed)
            this.state = null;
        this.title.text = player.title;
        this.artist.text = player.artist || player.album;
        this.artist.visible = !!this.artist.text;
        this._sourceIcon.gicon = player.sourceIcon;
        this._sourceName.text = player.sourceName;
        this.cover.uri = art?.uri ?? null;
        this._play.child.icon_name = player.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._prev.reactive = player.canPrevious;
        this._prev.opacity = player.canPrevious ? 255 : 90;
        this._next.reactive = player.canNext;
        this._next.opacity = player.canNext ? 255 : 90;
        if (this.island.settings.get_boolean('art-spin'))
            this.cover.spin(player.playing);
        else
            this.cover.unspin();
        if (changed && this.actor.mapped)
            this._fetch();
    }

    // Called when the player reports a seek or a new track
    refresh() {
        if (this.actor.mapped)
            this._fetch();
    }

    _syncPolling() {
        if (this.actor.mapped && !this._poll) {
            this._fetch();
            this._poll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!this.actor.mapped && this._poll) {
            GLib.source_remove(this._poll);
            this._poll = 0;
        }
    }

    // Asks the player every few seconds and extrapolates in between, so the bar moves smoothly without spamming D-Bus
    _tick() {
        this._ticks = (this._ticks ?? 0) + 1;
        if (this._ticks % 6 === 0)
            this._fetch();
        this._paintPosition();
    }

    _fetch() {
        const player = this.player;
        if (!player)
            return;
        Mpris.getState(player.busName, this._cancellable, state => {
            if (player !== this.player)
                return;
            state.sampled = GLib.get_monotonic_time();
            const hadLength = !!this.state?.length;
            this.state = state;
            this._paintPosition();
            this._syncToggles();
            if (hadLength !== !!state.length || this._togglesShape !== this._shape())
                this._syncVisibility();
        });
    }

    _paintPosition() {
        const st = this.state;
        if (!st?.length)
            return;
        let position = st.position;
        if (this.player?.playing)
            position += GLib.get_monotonic_time() - st.sampled;
        this.seek.set(Math.min(position, st.length), st.length);
    }

    _shape() {
        return `${this.state?.shuffle !== undefined}${this.state?.loop !== undefined}`;
    }

    _syncVisibility() {
        const s = this.island.settings;
        const was = [this.seek.actor.visible, this._shuffle.visible, this._repeat.visible].join();
        this.seek.actor.visible = s.get_boolean('show-seekbar') && !!this.state?.length;
        const toggles = s.get_boolean('show-shuffle-repeat');
        this._shuffle.visible = toggles && this.state?.shuffle !== undefined && this.state !== null;
        this._repeat.visible = toggles && this.state?.loop !== undefined && this.state !== null;
        this._togglesShape = this._shape();
        if (was !== [this.seek.actor.visible, this._shuffle.visible, this._repeat.visible].join())
            this.island.relayout();
    }

    _syncToggles() {
        const st = this.state;
        if (!st)
            return;
        const on = `color: ${toHex(this._accent ?? [1, 1, 1])};`;
        this._shuffle.child.style = st.shuffle ? on : null;
        this._shuffle.opacity = st.shuffle ? 255 : 120;
        const loop = st.loop ?? 'None';
        this._repeat.child.icon_name = loop === 'Track' ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
        this._repeat.child.style = loop !== 'None' ? on : null;
        this._repeat.opacity = loop !== 'None' ? 255 : 120;
    }

    _toggleShuffle() {
        if (!this.player || this.state?.shuffle === undefined)
            return;
        this.state.shuffle = !this.state.shuffle;
        Mpris.setProperty(this.player.busName, 'Shuffle', GLib.Variant.new_boolean(this.state.shuffle));
        this._syncToggles();
    }

    _cycleRepeat() {
        if (!this.player || this.state?.loop === undefined)
            return;
        const order = ['None', 'Playlist', 'Track'];
        this.state.loop = order[(order.indexOf(this.state.loop) + 1) % 3];
        Mpris.setProperty(this.player.busName, 'LoopStatus', GLib.Variant.new_string(this.state.loop));
        this._syncToggles();
    }
}

// A notification as a small card: app icon, the message, and who sent it underneath
export class NotificationView {
    constructor(island) {
        this.island = island;
        this.expanded = true;
        this.actor = new St.BoxLayout({style_class: 'iceland-notification'});
        this._icon = new St.Icon({style_class: 'iceland-notification-icon', y_align: Clutter.ActorAlign.CENTER});
        this._text = vbox({style_class: 'iceland-notification-text', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._message = wrapLabel('iceland-notification-message');
        this._message.clip_to_allocation = true;
        this._from = new St.Label({style_class: 'iceland-notification-from'});
        this._from.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._text.add_child(this._message);
        this._text.add_child(this._from);
        this.actor.add_child(this._icon);
        this.actor.add_child(this._text);
        this.onClick = null;
    }

    padding() {
        return [12, 20, 12, 14];
    }

    restyle() {
        const s = this.island.settings;
        this._icon.icon_size = s.get_int('notification-icon-size');
        this._maxText = Math.max(120, s.get_int('notification-width') - this.padding()[1] - this.padding()[3] -
            this._icon.icon_size - 12);
        this._text.style = `max-width: ${this._maxText}px; min-width: ${Math.min(140, this._maxText)}px;`;
    }

    show({icon, message, from, onClick}) {
        const s = this.island.settings;
        this._icon.gicon = gicon(icon);
        this._from.text = from ?? '';
        this._from.visible = !!from && s.get_boolean('notification-show-sender');
        // Keep long messages to a few lines; a rough cut first so Pango has little to lay out
        const lines = s.get_int('notification-lines');
        this._message.text = 'Ag';
        const lineHeight = this._message.get_preferred_height(-1)[1] || 18;
        let text = message ?? '';
        const budget = Math.floor(lines * this._maxText / 6.5);
        if (text.length > budget)
            text = `${text.slice(0, budget).replace(/\s+\S*$/, '')}…`;
        this._message.text = text;
        this._message.style = `max-height: ${Math.ceil(lineHeight * lines)}px;`;
        this.onClick = onClick ?? null;
    }
}

// Volume / brightness: icon, level bar, percentage
export class HudView {
    constructor(island) {
        this.island = island;
        this.expanded = false;
        this.actor = new St.BoxLayout({style_class: 'iceland-hud'});
        this._icon = new St.Icon({style_class: 'iceland-hud-icon', y_align: Clutter.ActorAlign.CENTER});
        this._bar = new St.Widget({style_class: 'iceland-hud-bar', y_align: Clutter.ActorAlign.CENTER});
        this._fill = new St.Widget({style_class: 'iceland-hud-fill'});
        this._bar.add_child(this._fill);
        this._value = new St.Label({style_class: 'iceland-hud-value', y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({style_class: 'iceland-hud-label', y_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._icon);
        this.actor.add_child(this._bar);
        this.actor.add_child(this._label);
        this.actor.add_child(this._value);
        this._level = 0;
    }

    padding() {
        return [8, 16, 8, 14];
    }

    restyle(colors) {
        this._accent = colors.accent;
        this._paintFill(false);
    }

    show({icon, level, label, overdrive}) {
        this._icon.gicon = gicon(icon);
        const hasLevel = level !== null && level !== undefined;
        this._bar.visible = hasLevel;
        this._value.visible = hasLevel;
        this._label.text = label ?? '';
        this._label.visible = !hasLevel && !!label;
        this._overdrive = overdrive;
        if (hasLevel) {
            this._level = Math.max(0, level);
            this._value.text = `${Math.round(this._level * 100)}%`;
            this._paintFill(true);
        }
    }

    _paintFill(animate) {
        const width = Math.round(Math.min(1, this._level) * this._bar.width);
        const color = this._overdrive || this._level > 1 ? '#ff9f0a' : this.island.settings.get_boolean('hud-use-accent') ? toHex(this._accent ?? [1, 1, 1]) : null;
        this._fill.style = color ? `background-color: ${color};` : null;
        this._fill.height = this._bar.height || 6;
        if (animate)
            this._fill.ease({width, duration: 110, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else
            this._fill.width = width;
    }
}

// Short message: icon, title, subtitle, optional level
export class NoticeView {
    constructor(island) {
        this.island = island;
        this.expanded = false;
        this.actor = new St.BoxLayout({style_class: 'iceland-notice'});
        this._icon = new St.Icon({style_class: 'iceland-notice-icon', y_align: Clutter.ActorAlign.CENTER});
        const text = vbox({y_align: Clutter.ActorAlign.CENTER, style_class: 'iceland-notice-text'});
        this._title = new Marquee('iceland-notice-title');
        this._subtitle = new Marquee('iceland-notice-subtitle');
        text.add_child(this._title);
        text.add_child(this._subtitle);
        this._bar = new St.Widget({style_class: 'iceland-notice-bar', y_align: Clutter.ActorAlign.CENTER});
        this._fill = new St.Widget({style_class: 'iceland-notice-fill'});
        this._bar.add_child(this._fill);
        this.actor.add_child(this._icon);
        this.actor.add_child(text);
        this.actor.add_child(this._bar);
        this.onClick = null;
    }

    padding() {
        return [8, 16, 8, 10];
    }

    restyle() {
        const w = this.island.settings.get_int('notice-text-width');
        this._title.configure(w, true);
        this._subtitle.configure(w, this.island.settings.get_boolean('scroll-titles'));
    }

    show({icon, title, subtitle, color, level, fullColor, onClick}) {
        this._icon.gicon = gicon(icon);
        this._icon.style = color ? `color: ${color};` : null;
        this._icon.icon_size = fullColor ? 30 : 24;
        this._title.text = title ?? '';
        this._subtitle.text = subtitle ?? '';
        this._subtitle.visible = !!subtitle;
        const hasLevel = Number.isFinite(level);
        this._bar.visible = hasLevel;
        if (hasLevel) {
            this._fill.style = `background-color: ${color ?? '#ffffff'};`;
            this._fill.set_size(Math.round(46 * Math.max(0, Math.min(1, level))), 6);
        }
        this.onClick = onClick ?? null;
    }
}

// Small ring that fills up, for download progress
function ring(fraction, rgb) {
    const area = new St.DrawingArea({width: 20, height: 20, y_align: Clutter.ActorAlign.CENTER});
    area._fraction = fraction;
    area._rgb = rgb;
    area.connect('repaint', a => {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        const r = Math.min(w, h) / 2 - 2;
        cr.setLineWidth(2.5);
        cr.setSourceRGBA(1, 1, 1, 0.22);
        cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI);
        cr.stroke();
        cr.setSourceRGB(...a._rgb);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.max(0.01, a._fraction));
        cr.stroke();
        cr.$dispose();
    });
    return area;
}

// Ongoing activities (recording, downloads) as small chips
export class LiveView {
    constructor(island, compact = false) {
        this.island = island;
        this.expanded = false;
        this.compact = compact;
        this.actor = new St.BoxLayout({style_class: compact ? 'iceland-live iceland-live-compact' : 'iceland-live'});
    }

    padding() {
        return this.compact ? [6, 8, 6, 8] : [6, 12, 6, 12];
    }

    restyle(colors) {
        this._accent = colors.accent;
    }

    show(items) {
        this.actor.destroy_all_children();
        for (const [, item] of items) {
            const chip = new St.Button({style_class: 'iceland-chip', reactive: !!item.onClick, can_focus: false});
            const box = new St.BoxLayout({style_class: 'iceland-chip-box'});
            const icon = new St.Icon({gicon: gicon(item.icon), style_class: 'iceland-chip-icon', y_align: Clutter.ActorAlign.CENTER});
            if (item.color)
                icon.style = `color: ${item.color};`;
            if (item.ring !== undefined) {
                const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
                holder.add_child(ring(item.ring, this._accent ?? [1, 1, 1]));
                icon.icon_size = 12;
                icon.x_align = icon.y_align = Clutter.ActorAlign.CENTER;
                holder.add_child(icon);
                box.add_child(holder);
            } else {
                box.add_child(icon);
            }
            if (item.pulse) {
                const t = new Clutter.PropertyTransition({property_name: 'opacity', duration: 900, repeat_count: -1,
                    auto_reverse: true, progress_mode: Clutter.AnimationMode.EASE_IN_OUT_SINE});
                t.set_from(255);
                t.set_to(90);
                icon.add_transition('iceland-pulse', t);
            }
            if (item.text && !this.compact)
                box.add_child(new St.Label({text: item.text, style_class: 'iceland-chip-label', y_align: Clutter.ActorAlign.CENTER}));
            chip.set_child(box);
            if (item.onClick)
                chip.connect('clicked', () => item.onClick());
            this.actor.add_child(chip);
        }
    }
}

// Nothing happening: an empty pill, or the time
export class IdleView {
    constructor(island) {
        this.island = island;
        this.expanded = false;
        this.actor = new St.BoxLayout({style_class: 'iceland-idle'});
        this._label = new St.Label({style_class: 'iceland-idle-clock', y_align: Clutter.ActorAlign.CENTER, x_expand: true,
            x_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._label);
        this._clock = new GnomeDesktop.WallClock({time_only: true});
        this._clock.connectObject('notify::clock', () => this._sync(), this);
        this.actor.connect('destroy', () => {
            this._clock.disconnectObject(this);
            this._clock = null;
        });
    }

    padding() {
        const h = this.island.settings.get_int('compact-art-size');
        const v = Math.max(4, Math.round(h * 0.16));
        return [v, 14, v, 14];
    }

    restyle() {
        const s = this.island.settings;
        const h = s.get_int('compact-art-size');
        this.actor.style = `min-width: ${Math.max(0, s.get_int('idle-width') - 28)}px; min-height: ${h}px;`;
        this._sync();
    }

    _sync() {
        const content = this.island.settings.get_string('idle-content');
        this._label.visible = content !== 'empty';
        if (content === 'clock')
            this._label.text = this._clock.clock;
        else if (content === 'date')
            this._label.text = GLib.DateTime.new_now_local().format('%a %e %b · ') + this._clock.clock;
    }
}

export {toCss};
