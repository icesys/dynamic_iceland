import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// Notification text can contain a little markup; the island shows plain text
function plain(text) {
    if (!text)
        return '';
    return text.replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Previews new notifications in the island, optionally instead of GNOME's banner
export class NotificationService {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        this._sources = new Set();
        Main.messageTray.connectObject('source-added', (tray, source) => this._watch(source), this);
        Main.messageTray.getSources().forEach(source => this._watch(source));
    }

    destroy() {
        Main.messageTray.disconnectObject(this);
        for (const source of this._sources)
            source.disconnectObject(this);
        this._sources.clear();
    }

    _watch(source) {
        if (this._sources.has(source))
            return;
        this._sources.add(source);
        source.connectObject(
            'notification-added', (s, notification) => this._show(source, notification),
            'destroy', () => {
                source.disconnectObject(this);
                this._sources.delete(source);
            }, this);
    }

    _show(source, notification) {
        if (!this._settings.get_boolean('show-notifications'))
            return;
        // Respects Do Not Disturb and per-app "show banners" settings
        if (source.policy && !source.policy.showBanners)
            return;
        if (notification.urgency === MessageTray.Urgency.LOW)
            return;
        const app = plain(source.title);
        const title = plain(notification.title);
        const body = plain(notification.body).replace(/\s+/g, ' ').trim();
        const onClick = () => {
            try {
                notification.activate();
            } catch (e) {
                console.debug(`Dynamic iceLand: ${e}`);
            }
        };
        let shown;
        if (this._settings.get_string('notification-style') === 'card') {
            // Chat apps put the sender in the title and the message in the body
            const message = body || title || app;
            let from = body ? title : '';
            if (this._settings.get_boolean('notification-show-app') && app && app !== from)
                from = from ? `${from} · ${app}` : app;
            const useSender = this._settings.get_string('notification-icon') === 'sender';
            const icon = (useSender ? notification.gicon ?? source.icon : source.icon ?? notification.gicon) ??
                'preferences-system-notifications-symbolic';
            shown = this._island.notification({icon, message, from, onClick});
        } else {
            shown = this._island.notice({
                icon: notification.gicon ?? source.icon ?? 'preferences-system-notifications-symbolic',
                title: title || app,
                subtitle: body,
                fullColor: true,
                duration: this._settings.get_int('notification-duration'),
                onClick,
            });
        }
        // Marking it read keeps it in the message list but stops GNOME's own banner (critical ones still get one)
        if (shown && this._settings.get_boolean('hide-gnome-banners') &&
            notification.urgency !== MessageTray.Urgency.CRITICAL)
            notification.acknowledged = true;
    }
}
