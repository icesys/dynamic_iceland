import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

import {Spring} from '../lib/spring.js';
import {accentFrom, backgroundFrom, parseHex, toCss, toHex} from '../lib/color.js';
import {loadArt} from './art.js';
import {Lyrics} from '../services/lyrics.js';
import {AudioFeed} from './visualizer.js';
import {CompactMusicView, ExpandedMusicView, HudView, IdleView, LiveView, NoticeView, NotificationView} from './views.js';

const BUBBLE_GAP = 6;

// The island: one rounded black shape at the top of the screen that morphs between views.
// Width, height and corner radius are springs; the visible view is centred inside and cross-fades on change.
export class Island {
    constructor(settings, openPrefs) {
        this.settings = settings;
        this._openPrefs = openPrefs;
        this.feed = new AudioFeed(settings);
        this._player = null;
        this._art = null;
        this._trackKey = null;
        this._artCancellable = null;
        this._live = new Map();
        this._temp = null;
        this._tempTimer = 0;
        this._hoverTimer = 0;
        this._expanded = false;
        this._scale = 100;
        this._view = null;
        this._visible = false;
        this._pressed = false;
        this._lastStyle = '';
        this._scrollSum = 0;
        this._lastTrackScroll = 0;
        this._clickTimer = 0;
        this._clickedInside = false;
        this._mouseSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.peripherals.mouse'});
        this._wasPlaying = null;
        this.lyrics = new Lyrics(settings);
        this.lyrics.connect('changed', () => this._onLyrics(false));
        this.lyrics.connect('line', () => this._onLyrics(true));

        this.actor = new St.Widget({
            style_class: 'iceland',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            visible: false,
            opacity: 0,
        });
        this._bubble = new St.Widget({
            style_class: 'iceland iceland-bubble',
            reactive: true,
            visible: false,
            opacity: 0,
            layout_manager: new Clutter.BinLayout(),
        });
        this._bubbleView = new LiveView(this, true);
        this._bubble.add_child(this._bubbleView.actor);

        this._views = {
            compact: new CompactMusicView(this),
            expanded: new ExpandedMusicView(this),
            hud: new HudView(this),
            notice: new NoticeView(this),
            notification: new NotificationView(this),
            live: new LiveView(this),
            idle: new IdleView(this),
        };
        for (const view of Object.values(this._views)) {
            view.actor.visible = false;
            view.actor.opacity = 0;
            this.actor.add_child(view.actor);
        }

        this._w = new Spring(40);
        this._h = new Spring(30);
        this._r = new Spring(15);
        // Size in percent, for the little squash when the island is clicked
        this._s = new Spring(100);
        this._timeline = new Clutter.Timeline({actor: this.actor, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._frame(this._timeline.get_delta() / 1000));

        // At shell shutdown the stage destroys the island before the extension is told; ignore late calls then
        this._gone = false;
        this.actor.connect('destroy', () => {
            this._gone = true;
        });
        Main.layoutManager.addTopChrome(this.actor);
        Main.layoutManager.addTopChrome(this._bubble);

        this.actor.connect('notify::hover', () => this._onHover());
        // Seen before any child handles the press, so clicks on the seek bar count too
        this.actor.connect('captured-event', (a, e) => this._onCaptured(e));
        this.actor.connect('button-release-event', (a, e) => this._onClick(e));
        this.actor.connect('scroll-event', (a, e) => this._onScroll(e));
        this._bubble.connect('button-release-event', (a, e) => {
            if (e.get_button() === Clutter.BUTTON_SECONDARY)
                this._openPrefs();
            return Clutter.EVENT_STOP;
        });
        Main.layoutManager.connectObject('monitors-changed', () => this._place(), this);
        global.display.connectObject('in-fullscreen-changed', () => this._update(), this);
        settings.connectObject('changed', () => this._restyle(), this);
        this._restyle();
    }

    destroy() {
        for (const id of [this._tempTimer, this._hoverTimer, this._clickTimer]) {
            if (id)
                GLib.source_remove(id);
        }
        this._artCancellable?.cancel();
        this._player?.disconnectObject(this);
        this.lyrics.destroy();
        this._timeline.stop();
        this.settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        this.feed.destroy();
        this.actor.destroy();
        this._bubble.destroy();
    }

    // ---- What services call

    setMedia(player) {
        if (this._gone) {
            this._player?.disconnectObject(this);
            this._player = null;
            return;
        }
        if (player === this._player)
            return;
        this._player?.disconnectObject(this);
        this._player = player;
        this._trackKey = null;
        player?.connectObject(
            'changed', () => this._syncMedia(),
            'seeked', () => {
                this._views.expanded.refresh();
                this.lyrics.resync();
            }, this);
        this._syncMedia();
    }

    canShowHud() {
        return true;
    }

    hud(opts) {
        this._views.hud.show(opts);
        this._showTemp('hud', this.settings.get_int('hud-duration'));
    }

    // Returns false when the island won't show it (fullscreen), so callers can let GNOME handle it
    notice(opts) {
        if (this._fullscreenHidden() && !opts.important)
            return false;
        this._views.notice.show(opts);
        this._showTemp('notice', opts.duration ?? this.settings.get_int('notice-duration'));
        return true;
    }

    // A notification as a card that grows out of the island, then gives way to whatever was there
    notification(opts) {
        if (this._fullscreenHidden())
            return false;
        const fresh = this._view !== this._views.notification;
        this._views.notification.show(opts);
        this._showTemp('notification', opts.duration ?? this.settings.get_int('notification-duration'));
        if (!fresh)
            this._bounce(true);
        return true;
    }

    setLive(key, item) {
        if (item)
            this._live.set(key, item);
        else if (!this._live.delete(key))
            return;
        this._views.live.show(this._live);
        this._bubbleView.show(this._live);
        if (this._view === this._views.live)
            this.relayout();
        this._update();
    }

    // A view's content changed size
    relayout() {
        if (this._view)
            this._retarget(this._view);
    }

    // ---- State

    _musicViews() {
        return [this._views.compact, this._views.expanded];
    }

    _hasMusic() {
        return !!this._player && !!this._player.title;
    }

    _fullscreenHidden() {
        return this.settings.get_boolean('hide-in-fullscreen') && !!Main.layoutManager.primaryMonitor?.inFullscreen;
    }

    _syncMedia() {
        if (this._gone)
            return;
        const p = this._player;
        this.feed.playing = !!p?.playing;
        if (p && this._hasMusic()) {
            const key = `${p.title}|${p.artist}|${p.artUrl}`;
            if (key !== this._trackKey) {
                const firstTrack = this._trackKey === null;
                this._trackKey = key;
                this._loadArt(p.artUrl);
                if (!firstTrack)
                    this._bounce();
                this._views.expanded.refresh();
                this.lyrics.load(p);
            }
            if (p.playing !== this._wasPlaying) {
                this._wasPlaying = p.playing;
                this.lyrics.resync();
            }
            for (const v of this._musicViews())
                v.update(p, this._art);
            if (this._musicViews().includes(this._view))
                this.relayout();
        } else {
            this.lyrics.load(null);
            this._trackKey = null;
            this._wasPlaying = null;
        }
        this._update();
    }

    _onLyrics(fade) {
        this._views.compact.syncLyrics(fade);
        const changed = this._views.expanded.syncLyrics(fade);
        if (this._view === this._views.compact || (changed && this._view === this._views.expanded))
            this.relayout();
    }

    _loadArt(url) {
        this._artCancellable?.cancel();
        const cancellable = this._artCancellable = new Gio.Cancellable();
        loadArt(url, cancellable, art => {
            if (cancellable.is_cancelled())
                return;
            this._art = art;
            if (this._player) {
                for (const v of this._musicViews())
                    v.update(this._player, art);
            }
            this._restyle();
        });
    }

    // A little squash when the song changes
    _bounce(always = false) {
        if (!this._visible || (!always && !this.settings.get_boolean('bounce-on-track-change')))
            return;
        this._w.velocity += 260;
        this._h.velocity -= 60;
        this._timeline.start();
    }

    _showTemp(kind, duration) {
        this._temp = kind;
        if (this._tempTimer)
            GLib.source_remove(this._tempTimer);
        this._tempTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration, () => {
            // A notification stays while the pointer rests on it
            if (this._temp === 'notification' && this.actor.hover && this.settings.get_boolean('notification-hold-on-hover'))
                return GLib.SOURCE_CONTINUE;
            this._tempTimer = 0;
            this._temp = null;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
        // Same view again (volume key held): only the size may change
        if (this._view === this._views[kind])
            this.relayout();
        this._update();
    }

    _pickView() {
        if (this._temp)
            return this._views[this._temp];
        if (this._fullscreenHidden())
            return null;
        if (this._hasMusic())
            return this._expanded ? this._views.expanded : this._views.compact;
        if (this._live.size)
            return this._views.live;
        if (this.settings.get_boolean('always-show'))
            return this._views.idle;
        return null;
    }

    _update() {
        if (this._gone)
            return;
        const view = this._pickView();
        if (view !== this._view)
            this._switchTo(view);
        this._syncBubble();
    }

    _switchTo(view) {
        const old = this._view;
        this._view = view;
        const speed = this.settings.get_int('animation-speed') / 100;
        if (old) {
            old.actor.remove_all_transitions();
            old.actor.ease({
                opacity: 0,
                duration: Math.round(110 / speed),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._view !== old)
                        old.actor.hide();
                },
            });
        }
        if (!view) {
            this._setVisible(false);
            return;
        }
        view.actor.remove_all_transitions();
        view.actor.show();
        view.actor.opacity = 0;
        view.actor.ease({
            opacity: 255,
            delay: Math.round((old ? 90 : 60) / speed),
            duration: Math.round(200 / speed),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._setVisible(true);
        this._retarget(view);
    }

    _setVisible(visible) {
        if (visible === this._visible) {
            if (!visible)
                this._retargetHidden();
            return;
        }
        this._visible = visible;
        this.actor.remove_transition('opacity');
        if (visible) {
            // Grows out of a small dot
            const h = this.settings.get_int('compact-art-size');
            this._w.jump(h * 0.8);
            this._h.jump(h * 0.6);
            this._r.jump(h * 0.3);
            this.actor.show();
            this.actor.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            this._retargetHidden();
            this.actor.ease({
                opacity: 0,
                duration: 260,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    if (!this._visible)
                        this.actor.hide();
                },
            });
        }
        this._timeline.start();
    }

    _retargetHidden() {
        const h = this.settings.get_int('compact-art-size') * 0.6;
        this._w.target = h * 1.3;
        this._h.target = h;
        this._r.target = h / 2;
        this._timeline.start();
    }

    // Measures the view and sends the springs toward its size
    _retarget(view) {
        const [top, right, bottom, left] = view.padding();
        // Forget the size set while animating, or the view would measure as that size
        view.actor.set_size(view.fixedWidth ?? -1, -1);
        const [, nw] = view.actor.get_preferred_width(-1);
        const [, nh] = view.actor.get_preferred_height(nw);
        let width = nw + left + right;
        const height = nh + top + bottom;
        if (view === this._views.compact)
            width = Math.max(width, this.settings.get_int('compact-min-width'));
        view._metrics = {nw, nh, top, left, width, height};
        this._w.target = width;
        this._h.target = height;
        this._r.target = view.radius ? view.radius(height) : view.expanded ? Math.min(this.settings.get_int('expanded-radius'), height / 2) : height / 2;
        this._timeline.start();
    }

    _frame(dt) {
        const springs = [this._w, this._h, this._r, this._s];
        springs.forEach(s => s.advance(dt));
        this._apply();
        if (springs.every(s => s.settled))
            this._timeline.stop();
    }

    _apply() {
        const W = Math.max(1, Math.round(this._w.value));
        const H = Math.max(1, Math.round(this._h.value));
        const R = Math.max(0, Math.min(Math.round(this._r.value), Math.floor(Math.min(W, H) / 2)));
        this.actor.set_size(W, H);
        const attach = this.settings.get_boolean('attach-to-top');
        const scale = Math.round(this._s.value * 10) / 1000;
        if (scale !== this._scale) {
            this._scale = scale;
            this.actor.set_pivot_point(0.5, attach ? 0 : 0.5);
            this.actor.set_scale(scale, scale);
        }
        const style = `border-radius: ${attach ? `0 0 ${R}px ${R}px` : `${R}px`};${this._surfaceStyle}`;
        if (style !== this._lastStyle) {
            this._lastStyle = style;
            this.actor.style = style;
        }
        for (const view of Object.values(this._views)) {
            const m = view._metrics;
            if (!view.actor.visible || !m)
                continue;
            view.actor.set_size(m.nw, m.nh);
            view.actor.set_position(Math.round((W - m.width) / 2 + m.left), Math.round((H - m.height) / 2 + m.top));
        }
        this._place();
    }

    _place() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const attach = this.settings.get_boolean('attach-to-top');
        const x = Math.round(monitor.x + (monitor.width - this.actor.width) / 2 + this.settings.get_int('horizontal-offset'));
        const y = monitor.y + (attach ? 0 : this.settings.get_int('top-offset'));
        this.actor.set_position(x, y);
        if (this._bubble.visible) {
            const [bw, bh] = this._bubble.get_size();
            this._bubble.set_position(x + this.actor.width + BUBBLE_GAP, Math.round(y + (this.actor.height - bh) / 2));
            this._bubble.style = `border-radius: ${Math.round(Math.min(bw, bh) / 2)}px;${this._surfaceStyle}`;
        }
    }

    _syncBubble() {
        const want = this.settings.get_boolean('show-bubble') && this._live.size > 0 && !!this._view &&
            this._view !== this._views.live;
        if (want === this._bubble.visible && (!want || this._bubble.opacity === 255))
            return;
        this._bubble.remove_all_transitions();
        if (want) {
            this._bubble.show();
            this._bubble.set_pivot_point(0, 0.5);
            this._bubble.set({scale_x: 0.3, scale_y: 0.3, opacity: 0});
            this._bubble.ease({scale_x: 1, scale_y: 1, opacity: 255, duration: 380, mode: Clutter.AnimationMode.EASE_OUT_BACK});
            this._place();
        } else {
            this._bubble.ease({scale_x: 0.3, scale_y: 0.3, opacity: 0, duration: 180, mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => this._bubble.hide()});
        }
    }

    // Colours, sizes and every view's look from the settings (and the cover's palette)
    _restyle() {
        const s = this.settings;
        const palette = this._art?.palette;
        const vivid = palette?.vivid;
        const accent = vivid && s.get_boolean('accent-from-art') ? accentFrom(vivid) : parseHex(s.get_string('accent-color'));
        const bgBase = vivid && s.get_boolean('background-from-art') ? backgroundFrom(vivid) : parseHex(s.get_string('background-color'), [0, 0, 0]);
        const text = parseHex(s.get_string('text-color'));
        const alpha = s.get_int('background-opacity') / 100;
        const outline = s.get_boolean('outline') ? ` border: 1px solid ${toCss(text, 0.16)};` : '';
        this._surfaceStyle = ` background-color: ${toCss(bgBase, alpha)}; color: ${toHex(text)};${outline}`;
        this._lastStyle = '';
        const speed = s.get_int('animation-speed') / 100, bounce = s.get_int('bounciness') / 100;
        [this._w, this._h, this._r].forEach(sp => sp.configure(speed, bounce));
        // The click squash is quicker and springier than the shape, so it reads as a bounce
        this._s.configure(speed * 1.6, 1);
        this._s.damping = 2 * Math.sqrt(this._s.stiffness) * Math.max(0.2, 0.55 - 0.35 * bounce);
        const colors = {accent, text, background: bgBase};
        for (const view of Object.values(this._views))
            view.restyle(colors);
        this._bubbleView.restyle(colors);
        this._update();
        if (this._view)
            this._retarget(this._view);
        else
            this._apply();
    }

    // ---- Pointer

    _clearHoverTimer() {
        if (this._hoverTimer)
            GLib.source_remove(this._hoverTimer);
        this._hoverTimer = 0;
    }

    _hoverAfter(delay, callback) {
        this._clearHoverTimer();
        this._hoverTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, delay), () => {
            this._hoverTimer = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Hover opens the full view; leaving closes it
    _onHover() {
        this._clearHoverTimer();
        // A click only counts until the pointer leaves the island
        this._clickedInside = false;
        if (!this.actor.hover) {
            this._squash(false);
            this._hoverAfter(this.settings.get_int('hover-close-delay'), () => this._setExpanded(false));
            return;
        }
        this._syncScale();
        this._scheduleExpand();
    }

    _scheduleExpand() {
        if (this._expanded || this.settings.get_string('expand-on') === 'click')
            return;
        this._hoverAfter(this.settings.get_int('hover-open-delay'), () => {
            if (!this._clickedInside)
                this._setExpanded(true);
        });
    }

    // Clicking means the pointer is there to act, not to look: hold off hover-expanding until it leaves
    _onCaptured(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS) {
            if (!this._expanded) {
                this._clickedInside = true;
                if (this.actor.hover)
                    this._clearHoverTimer();
            }
            if (!this._onControl(event))
                this._squash(true);
        } else if (type === Clutter.EventType.BUTTON_RELEASE) {
            this._squash(false);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // True when the press is on a button or the seek bar inside the island, which have their own feedback
    _onControl(event) {
        let actor = global.stage.get_event_actor(event);
        while (actor && actor !== this.actor) {
            if (actor.reactive)
                return true;
            actor = actor.get_parent();
        }
        return false;
    }

    // Pressed: shrinks a touch. Released: springs back with a little overshoot
    // Size the island settles at: a little smaller (or bigger) while the pointer rests on the closed island
    _restScale() {
        if (this._expanded || !this.actor.hover)
            return 100;
        return 100 + this.settings.get_int('hover-scale');
    }

    _syncScale() {
        const rest = this._restScale();
        if (!this._visible || this._s.target === rest || this._pressed)
            return;
        this._s.target = rest;
        this._timeline.start();
    }

    _squash(down) {
        this._pressed = down && this.settings.get_boolean('click-bounce');
        if (!this._visible)
            return;
        if (this._pressed) {
            this._s.target = this._restScale() - 6;
            this._s.velocity -= 90;
            this._timeline.start();
        } else {
            this._syncScale();
        }
    }

    _setExpanded(expanded) {
        if (expanded === this._expanded) {
            this._update();
            return;
        }
        this._expanded = expanded;
        this._update();
        this._syncScale();
    }

    _onClick(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this._runAction(this.settings.get_string('right-click'));
            return Clutter.EVENT_STOP;
        }
        if (button === Clutter.BUTTON_MIDDLE) {
            this._runAction(this.settings.get_string('middle-click'));
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        for (const kind of ['notice', 'notification']) {
            if (this._view === this._views[kind] && this._views[kind].onClick) {
                this._views[kind].onClick();
                this._dismissTemp();
                return Clutter.EVENT_STOP;
            }
        }
        if (!this._musicViews().includes(this._view))
            return Clutter.EVENT_STOP;
        const double = this.settings.get_string('double-click');
        if (double === 'none') {
            this._singleClick();
            return Clutter.EVENT_STOP;
        }
        // Wait a moment: a second click turns it into a double click
        if (this._clickTimer) {
            GLib.source_remove(this._clickTimer);
            this._clickTimer = 0;
            this._runAction(double);
            return Clutter.EVENT_STOP;
        }
        const interval = this._mouseSettings.get_int('double-click') || 400;
        this._clickTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this._clickTimer = 0;
            this._singleClick();
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_STOP;
    }

    _singleClick() {
        const resting = this._view === this._views.compact;
        if (resting && this.settings.get_string('expand-on') !== 'hover')
            this._setExpanded(true);
        else if (this._musicViews().includes(this._view))
            this._runAction(this.settings.get_string('click-action'));
    }

    _dismissTemp() {
        if (this._tempTimer)
            GLib.source_remove(this._tempTimer);
        this._tempTimer = 0;
        this._temp = null;
        this._update();
    }

    _runAction(action) {
        const p = this._player;
        switch (action) {
        case 'play-pause':
            p?.playPause();
            break;
        case 'next':
            p?.next();
            break;
        case 'previous':
            p?.previous();
            break;
        case 'open-player':
            p?.raise();
            break;
        case 'expand':
            if (this._hasMusic())
                this._setExpanded(!this._expanded);
            break;
        case 'settings':
            this._openPrefs();
            break;
        }
    }

    _onScroll(event) {
        const action = this.settings.get_string('scroll-action');
        if (action === 'none')
            return Clutter.EVENT_PROPAGATE;
        let step = 0;
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP)
            step = 1;
        else if (direction === Clutter.ScrollDirection.DOWN)
            step = -1;
        else if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = event.get_scroll_delta();
            this._scrollSum -= dy;
            if (Math.abs(this._scrollSum) >= 1) {
                step = Math.sign(this._scrollSum);
                this._scrollSum = 0;
            }
        }
        if (!step)
            return Clutter.EVENT_STOP;
        if (action === 'volume') {
            this._nudgeVolume(step);
        } else if (action === 'track' && this._player) {
            const now = GLib.get_monotonic_time();
            if (now - this._lastTrackScroll > 450000) {
                this._lastTrackScroll = now;
                if (step > 0)
                    this._player.previous();
                else
                    this._player.next();
            }
        }
        return Clutter.EVENT_STOP;
    }

    _nudgeVolume(step) {
        const control = Volume.getMixerControl();
        const sink = control?.get_default_sink();
        if (!sink)
            return;
        const max = control.get_vol_max_norm();
        const value = Math.max(0, Math.min(max, sink.volume + step * max * this.settings.get_int('volume-step') / 100));
        sink.volume = value;
        sink.push_volume();
        if (sink.is_muted && value > 0)
            sink.change_is_muted(false);
        const level = value / max;
        const icon = level === 0 ? 'audio-volume-muted-symbolic'
            : level < 0.34 ? 'audio-volume-low-symbolic'
                : level < 0.67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic';
        this.hud({icon, level});
    }
}
