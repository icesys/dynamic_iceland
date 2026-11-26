import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// [value, label] pairs for the drop-downs
const CHOICES = {
    'expand-on': [['hover', 'Hover'], ['click', 'Click']],
    'click-action': [['open-player', 'Open the player app'], ['play-pause', 'Play / pause'], ['next', 'Next track'], ['none', 'Nothing']],
    'middle-click': [['play-pause', 'Play / pause'], ['next', 'Next track'], ['open-player', 'Open the player app'], ['none', 'Nothing']],
    'scroll-action': [['volume', 'Change volume'], ['track', 'Change track'], ['none', 'Nothing']],
    'visualizer-source': [['cava', 'Real audio (cava)'], ['simulated', 'Simulated'], ['off', 'Off']],
    'visualizer-style': [['bars', 'Bars'], ['wave', 'Wave'], ['dots', 'Dots'], ['mirror', 'Mirror'], ['pulse', 'Pulse']],
    'art-shape': [['rounded', 'Rounded'], ['circle', 'Circle'], ['square', 'Square']],
    'art-border': [['none', 'None'], ['subtle', 'Subtle'], ['accent', 'Accent colour']],
    'idle-content': [['empty', 'Nothing'], ['clock', 'Clock'], ['date', 'Date and time']],
};

export default class DynamicIceLandPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window._settings = s;
        window.search_enabled = true;
        window.set_default_size(700, 820);
        const b = new Builder(s);

        // Look
        let page = b.page(window, 'Look', 'applications-graphics-symbolic');
        let g = b.group(page, 'Colours');
        g.add(b.color('background-color', 'Background'));
        g.add(b.spin('background-opacity', 'Background opacity', '%', 0, 100, 5));
        g.add(b.toggle('background-from-art', 'Tint background from cover', 'A deep shade of the album colour'));
        g.add(b.color('text-color', 'Text and icons'));
        g.add(b.color('accent-color', 'Accent', 'Visualizer, seek bar, shuffle and repeat'));
        g.add(b.toggle('accent-from-art', 'Accent from cover', 'Picks the most vivid colour of the album art'));
        g.add(b.toggle('hud-use-accent', 'Accent-coloured volume bar'));
        g.add(b.toggle('outline', 'Outline', 'Thin light border, nice on dark wallpapers'));
        g = b.group(page, 'Shape and size');
        g.add(b.spin('compact-art-size', 'Resting height', 'Cover size in px, the island is a little taller', 16, 48, 1));
        g.add(b.spin('compact-text-width', 'Resting title width', 'px', 40, 600, 10));
        g.add(b.spin('compact-min-width', 'Resting minimum width', '0 fits the content', 0, 800, 10));
        g.add(b.spin('expanded-width', 'Expanded width', 'px', 280, 900, 10));
        g.add(b.spin('expanded-art-size', 'Expanded cover size', 'px', 40, 160, 2));
        g.add(b.spin('expanded-radius', 'Expanded corner radius', 'px', 0, 80, 1));
        g.add(b.spin('notice-text-width', 'Pop-up text width', 'Notifications, Bluetooth…', 80, 600, 10));
        g = b.group(page, 'Cover art');
        g.add(b.choice('art-shape', 'Expanded shape'));
        g.add(b.choice('art-border', 'Frame'));
        g.add(b.toggle('art-spin', 'Spin like a vinyl', 'Turns while music plays'));

        // Placement
        page = b.page(window, 'Placement', 'view-grid-symbolic');
        g = b.group(page, 'Position', 'The island sits at the top centre of the main screen');
        g.add(b.spin('top-offset', 'Distance from top', 'px', 0, 300, 1));
        g.add(b.spin('horizontal-offset', 'Horizontal shift', 'px, negative moves left', -2000, 2000, 5));
        g.add(b.toggle('attach-to-top', 'Notch style', 'Hangs from the top edge with square top corners'));
        g.add(b.toggle('hide-in-fullscreen', 'Hide in fullscreen', 'Volume and brightness still show'));
        g = b.group(page, 'When nothing is happening');
        g.add(b.toggle('always-show', 'Always show the island'));
        g.add(b.choice('idle-content', 'Show'));
        g.add(b.spin('idle-width', 'Idle width', 'px', 30, 600, 5));
        g = b.group(page, 'Side bubble');
        g.add(b.toggle('show-bubble', 'Show side bubble', 'Recording and downloads get their own little bubble while music shows'));

        // Music
        page = b.page(window, 'Music', 'audio-x-generic-symbolic');
        g = b.group(page, 'Resting island');
        g.add(b.toggle('compact-show-art', 'Cover art'));
        g.add(b.toggle('compact-show-title', 'Title'));
        g.add(b.toggle('compact-show-visualizer', 'Visualizer'));
        g.add(b.toggle('scroll-titles', 'Scroll long titles', 'Otherwise they end with …'));
        g = b.group(page, 'Expanded island');
        g.add(b.toggle('expanded-show-source', 'App name and icon'));
        g.add(b.toggle('expanded-show-visualizer', 'Visualizer'));
        g.add(b.toggle('show-seekbar', 'Seek bar', 'Click or drag to jump'));
        g.add(b.toggle('show-shuffle-repeat', 'Shuffle and repeat', 'For players that support them'));
        g = b.group(page, 'Visualizer', GLib.find_program_in_path('cava') ? '' : 'Install the "cava" package for real audio levels');
        g.add(b.choice('visualizer-source', 'Source'));
        g.add(b.choice('visualizer-style', 'Style'));
        g = b.group(page, 'Players');
        g.add(b.list('ignored-players', 'Ignore players', 'Comma separated, e.g. firefox, chromium'));

        // Behaviour
        page = b.page(window, 'Behaviour', 'input-mouse-symbolic');
        g = b.group(page, 'Expanding');
        g.add(b.choice('expand-on', 'Expand on'));
        g.add(b.spin('hover-open-delay', 'Hover delay', 'ms before expanding', 0, 3000, 10));
        g.add(b.spin('hover-close-delay', 'Close delay', 'ms before collapsing', 0, 5000, 10));
        g = b.group(page, 'Animation');
        g.add(b.spin('animation-speed', 'Speed', '%, 100 is normal', 25, 300, 5));
        g.add(b.spin('bounciness', 'Bounciness', '%, 0 is no overshoot', 0, 100, 5));
        g.add(b.toggle('bounce-on-track-change', 'Bounce when the song changes'));
        g = b.group(page, 'Mouse', 'Right click always opens these settings');
        g.add(b.choice('click-action', 'Left click'));
        g.add(b.choice('middle-click', 'Middle click'));
        g.add(b.choice('scroll-action', 'Scroll'));
        g.add(b.spin('volume-step', 'Volume step', '% per scroll', 1, 25, 1));

        // Features
        page = b.page(window, 'Features', 'preferences-system-notifications-symbolic');
        g = b.group(page, 'System');
        g.add(b.toggle('show-volume', 'Volume and brightness', 'Replaces the GNOME pop-up'));
        g.add(b.toggle('show-power', 'Charger', 'Plugged in, unplugged, fully charged'));
        g.add(b.toggle('show-low-battery', 'Low battery warning'));
        g.add(b.spin('low-battery-level', 'Warn at', '%, also at 10% and 5%', 5, 50, 1));
        g.add(b.toggle('show-bluetooth', 'Bluetooth devices', 'With their battery level'));
        g.add(b.toggle('show-caps-lock', 'Caps Lock'));
        g.add(b.toggle('show-recording', 'Screen recording timer', 'Click it to stop'));
        g.add(b.toggle('show-progress', 'Download and copy progress'));
        g = b.group(page, 'Notifications');
        g.add(b.toggle('show-notifications', 'Preview notifications', 'Click to open; respects Do Not Disturb'));
        g.add(b.toggle('hide-gnome-banners', 'Hide GNOME banners', 'They stay in the message list, marked as seen'));
        g = b.group(page, 'Durations');
        g.add(b.spin('hud-duration', 'Volume / brightness', 'ms', 300, 10000, 100));
        g.add(b.spin('notice-duration', 'Charger, Bluetooth, Caps Lock', 'ms', 500, 10000, 100));
        g.add(b.spin('notification-duration', 'Notifications', 'ms', 1000, 15000, 250));
        g = b.group(page, '');
        const reset = new Adw.ButtonRow({title: 'Reset everything to defaults'});
        reset.add_css_class('destructive-action');
        reset.connect('activated', () => s.list_keys().forEach(key => s.reset(key)));
        g.add(reset);
    }
}

class Builder {
    constructor(settings) {
        this.s = settings;
    }

    page(window, title, icon) {
        const page = new Adw.PreferencesPage({title, icon_name: icon});
        window.add(page);
        return page;
    }

    group(page, title, description = '') {
        const group = new Adw.PreferencesGroup({title, description});
        page.add(group);
        return group;
    }

    toggle(key, title, subtitle = '') {
        const row = new Adw.SwitchRow({title, subtitle});
        this.s.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    spin(key, title, subtitle, lower, upper, step) {
        const row = new Adw.SpinRow({title, subtitle,
            adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10})});
        this.s.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    choice(key, title, subtitle = '') {
        const choices = CHOICES[key];
        const index = () => Math.max(0, choices.findIndex(([v]) => v === this.s.get_string(key)));
        const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(choices.map(([, l]) => l)), selected: index()});
        row.connect('notify::selected', () => {
            if (choices[row.selected][0] !== this.s.get_string(key))
                this.s.set_string(key, choices[row.selected][0]);
        });
        this.s.connect(`changed::${key}`, () => {
            if (row.selected !== index())
                row.selected = index();
        });
        return row;
    }

    list(key, title) {
        const row = new Adw.EntryRow({title, show_apply_button: true, text: this.s.get_strv(key).join(', ')});
        row.connect('apply', () => this.s.set_strv(key, row.text.split(',').map(x => x.trim()).filter(Boolean)));
        return row;
    }

    color(key, title, subtitle = '') {
        const rgba = () => {
            const c = new Gdk.RGBA();
            c.parse(this.s.get_string(key));
            return c;
        };
        const button = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({with_alpha: false}), rgba: rgba(), valign: Gtk.Align.CENTER});
        button.connect('notify::rgba', () => {
            const {red, green, blue} = button.rgba;
            const hex = `#${[red, green, blue].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
            if (hex !== this.s.get_string(key))
                this.s.set_string(key, hex);
        });
        this.s.connect(`changed::${key}`, () => {
            if (!button.rgba.equal(rgba()))
                button.rgba = rgba();
        });
        const undo = new Gtk.Button({icon_name: 'edit-undo-symbolic', tooltip_text: 'Default', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        undo.connect('clicked', () => this.s.reset(key));
        const row = new Adw.ActionRow({title, subtitle});
        row.add_suffix(undo);
        row.add_suffix(button);
        return row;
    }
}
