import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Extra MPRIS calls the shell's MprisPlayer doesn't offer: position, seeking, shuffle and repeat
const IFACE = 'org.mpris.MediaPlayer2.Player';
const PATH = '/org/mpris/MediaPlayer2';

function call(busName, iface, method, params, replyType, cancellable, callback) {
    Gio.DBus.session.call(busName, PATH, iface, method, params, replyType ? new GLib.VariantType(replyType) : null,
        Gio.DBusCallFlags.NONE, 1000, cancellable, (connection, res) => {
            let reply = null;
            try {
                reply = connection.call_finish(res);
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
            }
            callback?.(reply);
        });
}

// Calls back with {position, length, trackId, canSeek, shuffle, loop}; shuffle/loop are undefined when unsupported
export function getState(busName, cancellable, callback) {
    call(busName, 'org.freedesktop.DBus.Properties', 'GetAll', new GLib.Variant('(s)', [IFACE]), '(a{sv})',
        cancellable, reply => {
            if (!reply)
                return;
            const [props] = reply.recursiveUnpack();
            const meta = props.Metadata ?? {};
            callback({
                position: Number(props.Position ?? 0),
                length: Number(meta['mpris:length'] ?? 0),
                trackId: typeof meta['mpris:trackid'] === 'string' ? meta['mpris:trackid'] : null,
                canSeek: !!props.CanSeek,
                shuffle: props.Shuffle,
                loop: props.LoopStatus,
            });
        });
}

export function setProperty(busName, name, variant) {
    call(busName, 'org.freedesktop.DBus.Properties', 'Set', new GLib.Variant('(ssv)', [IFACE, name, variant]), null, null, null);
}

export function setPosition(busName, trackId, positionUs) {
    if (!trackId || !GLib.Variant.is_object_path(trackId))
        return;
    call(busName, IFACE, 'SetPosition', new GLib.Variant('(ox)', [trackId, Math.round(positionUs)]), null, null, null);
}
