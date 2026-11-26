import Gio from 'gi://Gio';
import GnomeBluetooth from 'gi://GnomeBluetooth';

const BLUE = '#0a84ff';

// Announces Bluetooth devices connecting and disconnecting
export class BluetoothService {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        this._client = new GnomeBluetooth.Client();
        this._model = this._client.get_devices();
        this._watched = new Set();
        this._model.connectObject('items-changed', () => this._rescan(), this);
        this._rescan();
    }

    destroy() {
        for (const device of this._watched)
            device.disconnectObject(this);
        this._watched.clear();
        this._model.disconnectObject(this);
        this._model = null;
        this._client = null;
    }

    _rescan() {
        const now = new Set();
        for (let i = 0; i < this._model.get_n_items(); i++)
            now.add(this._model.get_item(i));
        for (const device of this._watched) {
            if (!now.has(device))
                device.disconnectObject(this);
        }
        for (const device of now) {
            if (!this._watched.has(device))
                device.connectObject('notify::connected', () => this._announce(device), this);
        }
        this._watched = now;
    }

    _announce(device) {
        if (!this._settings.get_boolean('show-bluetooth'))
            return;
        const battery = device.connected && device.battery_percentage > 0 ? Math.round(device.battery_percentage) : null;
        const names = device.icon ? [`${device.icon}-symbolic`, 'bluetooth-active-symbolic'] : ['bluetooth-active-symbolic'];
        this._island.notice({
            icon: Gio.ThemedIcon.new_from_names(names),
            title: device.alias || device.name || 'Bluetooth device',
            subtitle: device.connected ? (battery !== null ? `Connected · ${battery}%` : 'Connected') : 'Disconnected',
            color: device.connected ? BLUE : null,
            level: battery !== null ? battery / 100 : null,
        });
    }
}
