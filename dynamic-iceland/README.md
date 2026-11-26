# Dynamic iceLand

A Dynamic Island for GNOME Shell 49–51. It sits at the top centre of the screen and springs open when you hover it.

## Features

- **Music** from any MPRIS player (Spotify, browsers, Rhythmbox…): cover art, scrolling titles, real-time audio visualizer
  (uses `cava` if installed, otherwise a simulated one), a seek bar you can click or drag, shuffle and repeat
- **Album-art colours**: the accent (and optionally the background) follow the cover
- **Volume and brightness** pop-ups in place of GNOME's
- **Charger**, **low battery** warnings, **Bluetooth** devices (with battery), **Caps Lock**
- **Notification previews**, optionally replacing GNOME's banners
- **Screen recording** timer (click to stop) and **download progress**, with a side bubble while music plays
- **Idle mode**: an empty pill or a clock
- **Notch style**: hang from the top edge of the screen
- Spring animations with adjustable speed and bounciness
- Scroll for volume or tracks, middle-click to play/pause, right-click for settings
- More than 60 settings

## Install from source

    git clone https://github.com/icesys/dynamic_iceland.git
    cp -r dynamic_iceland/dynamic-iceland ~/.local/share/gnome-shell/extensions/dynamic-iceland@ice
    glib-compile-schemas ~/.local/share/gnome-shell/extensions/dynamic-iceland@ice/schemas
    # log out and back in (Wayland), then:
    gnome-extensions enable dynamic-iceland@ice

Optional: install `cava` for the real audio visualizer.

## Build the upload zip for extensions.gnome.org

From the `dynamic-iceland` folder:

    gnome-extensions pack --force --extra-source=lib --extra-source=ui --extra-source=services --extra-source=LICENSE .

## License

Copyright (C) 2026 ice

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
version. See LICENSE.

Thanks to the Dynamic Island and Dynamic Music Pill extensions for the inspiration.
