import Gio from 'gi://Gio';

const GREEN = '#34c759';
const ORANGE = '#ff9f0a';
const RED = '#ff3b30';
// UPower.DeviceState
const CHARGING = 1, DISCHARGING = 2, FULL = 4, PENDING_CHARGE = 5;
const onMains = state => state === CHARGING || state === FULL || state === PENDING_CHARGE;

// Charger plugged / unplugged / full, and low battery warnings
export class PowerService {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        this._cancellable = new Gio.Cancellable();
        this._warned = Infinity;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice', 'org.freedesktop.UPower.Device', this._cancellable,
            (o, res) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch {
                    return;
                }
                this._state = this._get('State');
                this._proxy.connectObject('g-properties-changed', () => this._changed(), this);
            });
    }

    destroy() {
        this._cancellable.cancel();
        this._proxy?.disconnectObject(this);
        this._proxy = null;
    }

    _get(name) {
        return this._proxy.get_cached_property(name)?.unpack();
    }

    _changed() {
        const state = this._get('State');
        const percent = Math.round(this._get('Percentage') ?? 0);
        const isPresent = this._get('IsPresent');
        const before = this._state;
        this._state = state;
        if (!isPresent || !state)
            return;
        const icon = this._get('IconName') || 'battery-symbolic';

        if (state !== before && this._settings.get_boolean('show-power')) {
            if (state === FULL && before === CHARGING) {
                this._island.notice({icon, title: 'Fully charged', subtitle: `${percent}%`, color: GREEN});
            } else if (onMains(state) !== onMains(before)) {
                this._island.notice({
                    icon,
                    title: onMains(state) ? 'Charging' : 'On battery',
                    subtitle: `${percent}%`,
                    color: onMains(state) ? GREEN : null,
                    level: percent / 100,
                });
            }
        }
        if (onMains(state))
            this._warned = Infinity;

        // One warning per threshold while discharging: the setting, then 10% and 5%
        if (state === DISCHARGING && this._settings.get_boolean('show-low-battery')) {
            const thresholds = [this._settings.get_int('low-battery-level'), 10, 5].filter(t => t < this._warned);
            const hit = thresholds.filter(t => percent <= t).sort((a, b) => a - b)[0];
            if (hit !== undefined) {
                this._warned = hit;
                this._island.notice({
                    icon: 'battery-caution-symbolic',
                    title: 'Low battery',
                    subtitle: `${percent}% remaining`,
                    color: percent <= 10 ? RED : ORANGE,
                    level: percent / 100,
                    duration: 5000,
                });
            }
        }
    }
}
