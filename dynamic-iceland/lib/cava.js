import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BARS = 16;

// Real audio levels from cava (raw 16-bit output on stdout). onFrame gets BARS values in 0..1.
export class CavaEngine {
    constructor(onFrame) {
        this._onFrame = onFrame;
        this._process = null;
        this._configPath = null;
        this._peak = 2000;
    }

    static available() {
        return !!GLib.find_program_in_path('cava');
    }

    get running() {
        return !!this._process;
    }

    start() {
        if (this._process || !CavaEngine.available())
            return;
        const config = '[general]\n' +
            `bars = ${BARS}\nframerate = 60\nautosens = 1\nlower_cutoff_freq = 50\nhigher_cutoff_freq = 10000\n` +
            '[input]\nmethod = pulse\nsource = auto\n' +
            '[output]\nmethod = raw\nraw_target = /dev/stdout\nbit_format = 16bit\nchannels = mono\n' +
            '[smoothing]\nnoise_reduction = 55\nmonstercat = 1\n';
        const [fd, path] = GLib.file_open_tmp('iceland-cava-XXXXXX');
        GLib.close(fd);
        GLib.file_set_contents(path, new TextEncoder().encode(config));
        this._configPath = path;
        try {
            const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE});
            // Keeps cava out of the GNOME sound settings app list
            launcher.setenv('PULSE_PROP', 'application.id=org.PulseAudio.pavucontrol', true);
            this._process = launcher.spawnv(['cava', '-p', path]);
        } catch (e) {
            console.warn(`Dynamic iceLand: could not start cava: ${e.message}`);
            this._cleanup();
            return;
        }
        this._cancellable = new Gio.Cancellable();
        this._stdout = this._process.get_stdout_pipe();
        this._pending = new Uint8Array(0);
        this._read();
    }

    _read() {
        const cancellable = this._cancellable;
        this._stdout.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, cancellable, (stream, res) => {
            let bytes;
            try {
                bytes = stream.read_bytes_finish(res);
            } catch {
                return;
            }
            if (cancellable.is_cancelled())
                return;
            const chunk = bytes.get_data();
            if (!chunk || chunk.length === 0) {
                // cava exited (no audio server?)
                this.stop();
                return;
            }
            const data = new Uint8Array(this._pending.length + chunk.length);
            data.set(this._pending);
            data.set(chunk, this._pending.length);
            const frame = BARS * 2;
            const frames = Math.floor(data.length / frame);
            if (frames > 0) {
                const view = new DataView(data.buffer, (frames - 1) * frame, frame);
                const values = [];
                let max = 0;
                for (let i = 0; i < BARS; i++) {
                    const v = view.getUint16(i * 2, true);
                    values.push(v);
                    max = Math.max(max, v);
                }
                // Rolling peak so quiet music still moves the bars
                this._peak = Math.max(max, this._peak * 0.985 + max * 0.015, 4000);
                this._onFrame(values.map(v => Math.min(1, v / this._peak)));
            }
            this._pending = data.slice(frames * frame);
            this._read();
        });
    }

    _cleanup() {
        if (this._configPath)
            GLib.unlink(this._configPath);
        this._configPath = null;
    }

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._process?.force_exit();
        this._process = null;
        this._stdout = null;
        this._cleanup();
    }
}
