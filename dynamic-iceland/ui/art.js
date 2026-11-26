import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {paletteFromPixels} from '../lib/color.js';

const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const SIZE = 256;
const CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'dynamic-iceland']);
const CACHE_LIMIT = 300;

// Turns a cover URL (file:// or http(s)://) into a small PNG in the cache plus its colour palette.
// The cover is always decoded off the main thread at a bounded size, so a huge or broken image
// from a player can't stall the compositor. Calls back with {uri, palette} or null.
export function loadArt(url, cancellable, callback) {
    if (!url) {
        callback(null);
        return;
    }
    GLib.mkdir_with_parents(CACHE, 0o700);
    const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
    const cached = Gio.File.new_for_path(GLib.build_filenamev([CACHE, `${key}.png`]));
    if (cached.query_exists(null)) {
        decode(cached, cancellable, callback, null);
        return;
    }
    if (url.startsWith('file://')) {
        decode(Gio.File.new_for_uri(url), cancellable, callback, cached);
        return;
    }
    if (!/^https?:\/\//.test(url)) {
        callback(null);
        return;
    }
    const part = Gio.File.new_for_path(`${cached.get_path()}.download`);
    Gio.File.new_for_uri(url).copy_async(part, Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_LOW, cancellable,
        (current, total) => {
            if (current > MAX_SOURCE_BYTES)
                cancellable.cancel();
        }, (file, res) => {
            try {
                file.copy_finish(res);
            } catch {
                part.delete_async(GLib.PRIORITY_LOW, null, null);
                if (!cancellable.is_cancelled())
                    callback(null);
                return;
            }
            decode(part, cancellable, (result) => {
                part.delete_async(GLib.PRIORITY_LOW, null, null);
                callback(result);
            }, cached);
        });
}

function decode(file, cancellable, callback, saveTo) {
    file.query_info_async('standard::type,standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable, (f, res) => {
        let info;
        try {
            info = f.query_info_finish(res);
        } catch {
            if (!cancellable.is_cancelled())
                callback(null);
            return;
        }
        if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > MAX_SOURCE_BYTES) {
            callback(null);
            return;
        }
        f.read_async(GLib.PRIORITY_LOW, cancellable, (ff, r) => {
            let stream;
            try {
                stream = ff.read_finish(r);
            } catch {
                if (!cancellable.is_cancelled())
                    callback(null);
                return;
            }
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, SIZE, SIZE, true, cancellable, (s, rr) => {
                let pixbuf = null;
                try {
                    pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(rr);
                } catch {}
                stream.close_async(GLib.PRIORITY_LOW, null, null);
                if (cancellable.is_cancelled())
                    return;
                if (!pixbuf) {
                    callback(null);
                    return;
                }
                let target = f;
                if (saveTo) {
                    try {
                        pixbuf.savev(saveTo.get_path(), 'png', [], []);
                        target = saveTo;
                        trimCache();
                    } catch {
                        target = null;
                    }
                }
                if (!target) {
                    callback(null);
                    return;
                }
                const small = pixbuf.scale_simple(24, 24, GdkPixbuf.InterpType.BILINEAR);
                const palette = paletteFromPixels(small.get_pixels(), 24, 24, small.get_rowstride(), small.get_n_channels());
                callback({uri: target.get_uri(), palette});
            });
        });
    });
}

let trimmedAt = 0;
// Keeps the cache from growing forever: drops the oldest covers past the limit, at most once a minute
function trimCache() {
    const now = GLib.get_monotonic_time();
    if (now - trimmedAt < 60e6)
        return;
    trimmedAt = now;
    const dir = Gio.File.new_for_path(CACHE);
    dir.enumerate_children_async('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null, (d, res) => {
        let files = [];
        try {
            const e = d.enumerate_children_finish(res);
            let info;
            while ((info = e.next_file(null)))
                files.push([info.get_name(), info.get_attribute_uint64('time::modified')]);
        } catch {
            return;
        }
        files = files.filter(([n]) => n.endsWith('.png')).sort((a, b) => b[1] - a[1]);
        for (const [name] of files.slice(CACHE_LIMIT))
            dir.get_child(name).delete_async(GLib.PRIORITY_LOW, null, null);
    });
}
