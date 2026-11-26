import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const RED = '#ff3b30';

// Live red timer while the screen is being recorded; clicking it stops the recording
export class RecordingService {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        this._timer = 0;
        Main.screenshotUI.connectObject('notify::screencast-in-progress', () => this._sync(), this);
        settings.connectObject('changed::show-recording', () => this._sync(), this);
        this._sync();
    }

    destroy() {
        Main.screenshotUI.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._stop();
        this._island.setLive('recording', null);
    }

    _stop() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    _sync() {
        this._stop();
        if (!Main.screenshotUI.screencast_in_progress || !this._settings.get_boolean('show-recording')) {
            this._island.setLive('recording', null);
            return;
        }
        const started = GLib.get_monotonic_time();
        const tick = () => {
            const total = Math.floor((GLib.get_monotonic_time() - started) / 1e6);
            const text = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
            this._island.setLive('recording', {
                icon: 'media-record-symbolic',
                color: RED,
                text,
                pulse: true,
                onClick: () => Main.screenshotUI.stopScreencast(),
            });
            return GLib.SOURCE_CONTINUE;
        };
        tick();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, tick);
    }
}
