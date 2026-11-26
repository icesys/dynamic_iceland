import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {CavaEngine} from '../lib/cava.js';
import {fromHsv, toHsv} from '../lib/color.js';

// Audio levels shared by every visualizer on screen. Real levels come from cava; without it (or when switched
// to "simulated") a mix of slow sine waves stands in, which never repeats and needs no timer of its own.
export class AudioFeed {
    constructor(settings) {
        this._settings = settings;
        this._cava = new CavaEngine(values => this._onFrame(values));
        this._real = new Array(16).fill(0);
        this._lastFrame = 0;
        this._playing = false;
        this._users = new Set();
        this._seeds = Array.from({length: 16}, () => [Math.random() * 6.28, 1.3 + Math.random() * 2.2, 0.6 + Math.random()]);
        settings.connectObject('changed::visualizer-source', () => this._sync(), this);
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._cava.stop();
    }

    get mode() {
        return this._settings.get_string('visualizer-source');
    }

    set playing(playing) {
        this._playing = playing;
        this._sync();
    }

    get playing() {
        return this._playing;
    }

    use(visualizer, active) {
        if (active)
            this._users.add(visualizer);
        else
            this._users.delete(visualizer);
        this._sync();
    }

    _sync() {
        const want = this._playing && this._users.size > 0 && this.mode === 'cava';
        if (want && !this._cava.running)
            this._cava.start();
        else if (!want && this._cava.running)
            this._cava.stop();
    }

    _onFrame(values) {
        this._real = values;
        this._lastFrame = GLib.get_monotonic_time();
    }

    // n levels in 0..1 for the current moment
    levels(n) {
        const now = GLib.get_monotonic_time();
        if (!this._playing)
            return new Array(n).fill(0);
        if (this.mode === 'cava' && now - this._lastFrame < 400000) {
            const src = this._real;
            return Array.from({length: n}, (_, i) => {
                const from = Math.floor(i * src.length / n), to = Math.max(from + 1, Math.floor((i + 1) * src.length / n));
                let sum = 0;
                for (let j = from; j < to; j++)
                    sum += src[j];
                return sum / (to - from);
            });
        }
        const t = now / 1e6;
        return Array.from({length: n}, (_, i) => {
            const [phase, speed, amp] = this._seeds[i % 16];
            const v = 0.5 + 0.28 * Math.sin(t * speed * 2.1 + phase) * amp + 0.22 * Math.sin(t * speed * 5.3 + phase * 1.7);
            return Math.max(0.08, Math.min(1, v));
        });
    }
}

// Draws the feed in one of several styles, smoothing toward the feed so it looks fluid at any frame rate
export const Visualizer = GObject.registerClass(
class Visualizer extends St.DrawingArea {
    _init(feed, settings, {bars, width, height}) {
        super._init({width, height, y_align: Clutter.ActorAlign.CENTER});
        this._feed = feed;
        this._settings = settings;
        this._bars = bars;
        this._shown = new Array(bars).fill(0);
        this._colors = [[1, 1, 1], [1, 1, 1]];
        this._time = 0;
        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._frame(this._timeline.get_delta() / 1000));
        this.connect('notify::mapped', () => this._sync());
        this.connect('destroy', () => {
            this._timeline.stop();
            this._feed.use(this, false);
        });
    }

    setColor(rgb) {
        const [h, s, v] = toHsv(rgb);
        // Lighter, slightly shifted hue on top for a soft gradient
        this._colors = [fromHsv((h + 18) % 360, s * 0.75, Math.min(1, v + 0.15)), rgb];
        this.queue_repaint();
    }

    _sync() {
        this._feed.use(this, this.mapped);
        if (this.mapped)
            this._timeline.start();
        else
            this._timeline.stop();
    }

    _frame(dt) {
        const target = this._feed.levels(this._bars);
        const k = 1 - Math.exp(-dt * (this._feed.mode === 'cava' ? 26 : 9));
        let moving = this._feed.playing;
        this._shown = this._shown.map((v, i) => {
            const next = v + (target[i] - v) * k;
            moving ||= Math.abs(next - v) > 0.002;
            return next;
        });
        this._time += dt;
        if (moving)
            this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const gradient = new Cairo.LinearGradient(0, 0, 0, h);
        gradient.addColorStopRGB(0, ...this._colors[0]);
        gradient.addColorStopRGB(1, ...this._colors[1]);
        cr.setSource(gradient);
        const levels = this._shown;
        const n = levels.length;
        const smooth = x => {
            // Catmull-Rom-ish blend between neighbouring bars, x in 0..1
            const p = x * (n - 1), i = Math.floor(p), f = p - i;
            const a = levels[Math.max(0, i)], b = levels[Math.min(n - 1, i + 1)];
            return a + (b - a) * (3 * f * f - 2 * f * f * f);
        };

        switch (this._settings.get_string('visualizer-style')) {
        case 'wave': {
            cr.setLineWidth(Math.max(1.5, h / 10));
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            const mid = h / 2;
            for (let x = 1; x <= w - 1; x++) {
                const u = x / w;
                const env = Math.sin(Math.PI * u);
                const y = mid + Math.sin(u * 10 + this._time * 6) * smooth(u) * (h / 2 - 2) * env;
                if (x === 1)
                    cr.moveTo(x, y);
                else
                    cr.lineTo(x, y);
            }
            cr.stroke();
            break;
        }
        case 'dots': {
            const gap = w / n;
            const r = Math.min(gap / 2 - 0.5, 2.2);
            const rows = Math.max(2, Math.floor(h / (r * 2 + 1.5)));
            levels.forEach((v, i) => {
                const lit = Math.max(1, Math.round(v * rows));
                for (let j = 0; j < lit; j++) {
                    cr.arc(gap * (i + 0.5), h - r - j * (r * 2 + 1.5), r, 0, 2 * Math.PI);
                    cr.closePath();
                }
            });
            cr.fill();
            break;
        }
        case 'mirror': {
            const mid = h / 2;
            cr.moveTo(0, mid);
            for (let x = 0; x <= w; x++)
                cr.lineTo(x, mid - smooth(x / w) * (mid - 0.5) * Math.sin(Math.PI * x / w));
            for (let x = w; x >= 0; x--)
                cr.lineTo(x, mid + smooth(x / w) * (mid - 0.5) * Math.sin(Math.PI * x / w));
            cr.closePath();
            cr.fill();
            break;
        }
        case 'pulse': {
            const avg = levels.reduce((a, b) => a + b, 0) / n;
            const r = Math.min(w, h) / 2;
            cr.arc(w / 2, h / 2, r * (0.35 + 0.65 * avg), 0, 2 * Math.PI);
            cr.fill();
            cr.setLineWidth(1.2);
            cr.arc(w / 2, h / 2, r - 0.8, 0, 2 * Math.PI);
            cr.stroke();
            break;
        }
        default: {
            // Rounded bars growing from the centre line
            const slot = w / n;
            const bw = Math.max(2, slot * 0.58);
            levels.forEach((v, i) => {
                const bh = Math.max(bw, v * h);
                const x = slot * i + (slot - bw) / 2, y = (h - bh) / 2, r = bw / 2;
                cr.newSubPath();
                cr.arc(x + r, y + r, r, Math.PI, 0);
                cr.arc(x + r, y + bh - r, r, 0, Math.PI);
                cr.closePath();
            });
            cr.fill();
        }
        }
        cr.$dispose();
    }
});
