// Caps Lock on / off
export class KeyboardService {
    constructor(island, settings) {
        this._island = island;
        this._settings = settings;
        this._keymap = global.stage.get_context().get_backend().get_default_seat().get_keymap();
        this._caps = this._keymap.get_caps_lock_state();
        this._keymap.connectObject('state-changed', () => this._changed(), this);
    }

    destroy() {
        this._keymap.disconnectObject(this);
        this._keymap = null;
    }

    _changed() {
        const caps = this._keymap.get_caps_lock_state();
        if (caps === this._caps)
            return;
        this._caps = caps;
        if (!this._settings.get_boolean('show-caps-lock'))
            return;
        this._island.notice({
            icon: 'input-keyboard-symbolic',
            title: caps ? 'Caps Lock on' : 'Caps Lock off',
            color: caps ? '#ffd60a' : null,
            duration: 1200,
        });
    }
}
