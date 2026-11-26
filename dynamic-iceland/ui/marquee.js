import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

const PAUSE = 1400;
const PX_PER_SECOND = 32;

// A one-line label that is at most maxWidth wide. Longer text either glides back and forth (scroll) or ends in "…".
export const Marquee = GObject.registerClass(
class Marquee extends St.Widget {
    _init(styleClass) {
        super._init({clip_to_allocation: true, y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({style_class: styleClass});
        this._label.clutter_text.single_line_mode = true;
        this.add_child(this._label);
        this._max = 200;
        this._scroll = true;
        this._overflow = 0;
        this._idle = 0;
        this.connect('notify::mapped', () => this._queue());
        this.connect('destroy', () => {
            if (this._idle)
                GLib.source_remove(this._idle);
            this._idle = 0;
            this._timeline?.stop();
            this._timeline = null;
        });
    }

    set text(text) {
        if (this._label.text === text)
            return;
        this._label.text = text ?? '';
        this.queue_relayout();
    }

    get text() {
        return this._label.text;
    }

    configure(maxWidth, scroll) {
        if (this._max === maxWidth && this._scroll === scroll)
            return;
        this._max = maxWidth;
        this._scroll = scroll;
        this._label.clutter_text.ellipsize = scroll ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
        this.queue_relayout();
    }

    vfunc_get_preferred_width(forHeight) {
        const [, natural] = this._label.get_preferred_width(forHeight);
        const width = Math.min(natural, this._max);
        return [width, width];
    }

    vfunc_get_preferred_height(forWidth) {
        return this._label.get_preferred_height(-1);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const width = box.get_width(), height = box.get_height();
        const [, natural] = this._label.get_preferred_width(height);
        const labelBox = new Clutter.ActorBox();
        labelBox.set_origin(0, 0);
        labelBox.set_size(this._scroll ? natural : width, height);
        this._label.allocate(labelBox);
        const overflow = this._scroll ? Math.max(0, Math.round(natural - width)) : 0;
        if (overflow !== this._overflow) {
            this._overflow = overflow;
            this._queue();
        }
    }

    // Transitions can't be changed during allocation, and the island resizes every frame while it springs
    _queue() {
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._idle = 0;
            this._restart();
            return GLib.SOURCE_REMOVE;
        });
    }

    _restart() {
        this._timeline?.stop();
        this._timeline = null;
        this._label.translation_x = 0;
        if (this._overflow < 3 || !this.mapped)
            return;
        // Pause, glide out, pause, glide back, driven by one looping timeline
        const overflow = this._overflow;
        const travel = overflow / PX_PER_SECOND * 1000;
        const total = 2 * travel + 2 * PAUSE;
        const ease = p => (1 - Math.cos(Math.PI * p)) / 2;
        this._timeline = new Clutter.Timeline({actor: this, duration: Math.round(total), repeat_count: -1});
        this._timeline.connect('new-frame', (t, ms) => {
            let x = 0;
            if (ms < PAUSE)
                x = 0;
            else if (ms < PAUSE + travel)
                x = -overflow * ease((ms - PAUSE) / travel);
            else if (ms < 2 * PAUSE + travel)
                x = -overflow;
            else
                x = -overflow * (1 - ease((ms - 2 * PAUSE - travel) / travel));
            this._label.translation_x = Math.round(x);
        });
        this._timeline.start();
    }
});
