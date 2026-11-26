import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

// Downloads and file copies, from the LauncherEntry D-Bus API that apps use to show progress on dock icons
const LIMIT = 12;

export class ProgressService {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        this._jobs = new Map();
        this._updates = Gio.DBus.session.signal_subscribe(null, 'com.canonical.Unity.LauncherEntry', 'Update', null, null,
            Gio.DBusSignalFlags.NONE, (c, sender, p, i, s, params) => {
                const [uri, props] = params.deepUnpack();
                this._update(sender, uri, props);
            });
        // A crashed app never clears its progress
        this._owners = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE, (c, s, p, i, sig, params) => {
                const [name, , owner] = params.deepUnpack();
                if (!owner) {
                    for (const [uri, job] of this._jobs) {
                        if (job.sender === name)
                            this._drop(uri);
                    }
                }
            });
        settings.connectObject('changed::show-progress', () => {
            if (!settings.get_boolean('show-progress'))
                [...this._jobs.keys()].forEach(uri => this._drop(uri));
        }, this);
    }

    destroy() {
        Gio.DBus.session.signal_unsubscribe(this._updates);
        Gio.DBus.session.signal_unsubscribe(this._owners);
        this._settings.disconnectObject(this);
        [...this._jobs.keys()].forEach(uri => this._drop(uri));
    }

    _drop(uri) {
        this._jobs.delete(uri);
        this._island.setLive(`progress:${uri}`, null);
    }

    _update(sender, uri, props) {
        if (!this._settings.get_boolean('show-progress'))
            return;
        let job = this._jobs.get(uri);
        if (!job) {
            if (this._jobs.size >= LIMIT)
                return;
            job = {visible: false, value: 0};
            this._jobs.set(uri, job);
        }
        job.sender = sender;
        if (props['progress-visible'])
            job.visible = props['progress-visible'].unpack();
        if (props['progress'])
            job.value = props['progress'].unpack();
        if (!job.visible) {
            this._drop(uri);
            return;
        }
        const app = Shell.AppSystem.get_default().lookup_app(uri.replace(/^application:\/\//, ''));
        this._island.setLive(`progress:${uri}`, {
            icon: app?.get_icon() ?? 'folder-download-symbolic',
            text: `${Math.round(Math.max(0, Math.min(1, job.value)) * 100)}%`,
            ring: job.value,
        });
    }
}
