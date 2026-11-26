// Colour helpers. Colours are [r, g, b] arrays with components in 0..1.

export function parseHex(hex, fallback = [1, 1, 1]) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    if (!m)
        return fallback;
    const n = parseInt(m[1], 16);
    return [n >> 16, (n >> 8) & 0xff, n & 0xff].map(c => c / 255);
}

export function toHex(rgb) {
    return `#${rgb.map(c => Math.round(clamp(c) * 255).toString(16).padStart(2, '0')).join('')}`;
}

export function toCss(rgb, alpha = 1) {
    const [r, g, b] = rgb.map(c => Math.round(clamp(c) * 255));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const clamp = v => Math.max(0, Math.min(1, v));

// Hue 0..360, saturation and value 0..1
export function toHsv([r, g, b]) {
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    let hue = 0;
    if (delta > 0) {
        if (max === r)
            hue = 60 * (((g - b) / delta + 6) % 6);
        else if (max === g)
            hue = 60 * ((b - r) / delta + 2);
        else
            hue = 60 * ((r - g) / delta + 4);
    }
    return [hue, max ? delta / max : 0, max];
}

export function fromHsv(h, s, v) {
    const f = n => {
        const k = (n + h / 60) % 6;
        return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
}

export function luminance([r, g, b]) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Picks the most colourful hue bucket of a small RGB(A) image, so a cover with a red logo on grey gives red.
export function paletteFromPixels(pixels, width, height, rowstride, channels) {
    const buckets = new Array(12).fill(null).map(() => ({weight: 0, r: 0, g: 0, b: 0}));
    let greyWeight = 0, grey = [0, 0, 0];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const o = y * rowstride + x * channels;
            const rgb = [pixels[o] / 255, pixels[o + 1] / 255, pixels[o + 2] / 255];
            const [h, s, v] = toHsv(rgb);
            if (s < 0.18 || v < 0.15) {
                greyWeight += 1;
                grey = grey.map((c, i) => c + rgb[i]);
                continue;
            }
            const bucket = buckets[Math.floor(h / 30) % 12];
            const w = s * v;
            bucket.weight += w;
            bucket.r += rgb[0] * w;
            bucket.g += rgb[1] * w;
            bucket.b += rgb[2] * w;
        }
    }
    const best = buckets.reduce((a, b) => b.weight > a.weight ? b : a);
    // Mostly black-and-white covers keep a neutral palette
    if (best.weight < 0.6)
        return greyWeight ? {vivid: null, average: grey.map(c => c / greyWeight)} : null;
    return {vivid: [best.r, best.g, best.b].map(c => c / best.weight)};
}

// Accent that reads well on a dark island
export function accentFrom(rgb) {
    const [h, s] = toHsv(rgb);
    return fromHsv(h, Math.min(1, Math.max(0.45, s)), 0.95);
}

// Deep tint of a colour for the island background
export function backgroundFrom(rgb) {
    const [h, s] = toHsv(rgb);
    return fromHsv(h, Math.min(0.75, s), 0.16);
}
