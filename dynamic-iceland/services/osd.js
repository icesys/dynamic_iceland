import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Sends volume / brightness / keyboard-brightness pop-ups to the island instead of GNOME's OSD window.
// Wraps osdWindowManager.show/showAll only while the feature is on; anything unexpected goes to the original.
export class OsdService {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        this._originals = null;
        settings.connectObject('changed::show-volume', () => this._apply(), this);
        this._apply();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._unwrap();
    }

    _apply() {
        if (this._settings.get_boolean('show-volume'))
            this._wrap();
        else
            this._unwrap();
    }

    _wrap() {
        if (this._originals)
            return;
        const manager = Main.osdWindowManager;
        this._originals = {};
        // GNOME 49+: show(icon, label, {monitorIndex: {level, maxLevel}}) and showAll(icon, label, level, maxLevel)
        const handlers = {
            show: (icon, label, levels) => {
                const first = levels && Object.values(levels).find(Boolean);
                return [icon, label, first?.level, first?.maxLevel];
            },
            showAll: (icon, label, level, maxLevel) => [icon, label, level, maxLevel],
        };
        for (const [name, read] of Object.entries(handlers)) {
            const original = manager[name];
            if (typeof original !== 'function')
                continue;
            this._originals[name] = {original, own: Object.hasOwn(manager, name)};
            manager[name] = (...args) => {
                if (!this._island.canShowHud()) {
                    original.apply(manager, args);
                    return;
                }
                try {
                    const [icon, label, level, maxLevel] = read(...args);
                    const max = maxLevel > 0 ? maxLevel : 1;
                    this._island.hud({
                        icon,
                        level: Number.isFinite(level) ? level / max : null,
                        overdrive: Number.isFinite(level) && level > 1,
                        label: typeof label === 'string' ? label : '',
                    });
                } catch (e) {
                    console.warn(`Dynamic iceLand: OSD hand-off failed: ${e}`);
                    original.apply(manager, args);
                }
            };
        }
    }

    _unwrap() {
        if (!this._originals)
            return;
        const manager = Main.osdWindowManager;
        for (const [name, {original, own}] of Object.entries(this._originals)) {
            if (own)
                manager[name] = original;
            else
                delete manager[name];
        }
        this._originals = null;
    }
}
