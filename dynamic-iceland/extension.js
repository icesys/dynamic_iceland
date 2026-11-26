import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Island} from './ui/island.js';
import {BluetoothService} from './services/bluetooth.js';
import {KeyboardService} from './services/keyboard.js';
import {MediaService} from './services/media.js';
import {NotificationService} from './services/notifications.js';
import {OsdService} from './services/osd.js';
import {PowerService} from './services/power.js';
import {ProgressService} from './services/progress.js';
import {RecordingService} from './services/recording.js';

const SERVICES = [MediaService, OsdService, PowerService, BluetoothService, RecordingService, ProgressService,
    NotificationService, KeyboardService];

export default class DynamicIceLand extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._island = new Island(this._settings, () => this.openPreferences());
        this._services = [];
        for (const Service of SERVICES) {
            // One broken integration (say, no Bluetooth library) shouldn't take the whole island down
            try {
                this._services.push(new Service(this._island, this._settings));
            } catch (e) {
                console.warn(`Dynamic iceLand: ${Service.name} unavailable: ${e.message}`);
            }
        }
    }

    disable() {
        // Services first: they hand state back (OSD) and clear what they put on the island
        this._services?.reverse().forEach(service => {
            try {
                service.destroy();
            } catch (e) {
                console.warn(`Dynamic iceLand: ${e.message}`);
            }
        });
        this._services = null;
        this._island?.destroy();
        this._island = null;
        this._settings = null;
    }
}
