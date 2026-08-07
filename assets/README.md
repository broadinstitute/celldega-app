# App icons

`icon.svg` is the source of truth. Everything else here is generated from it —
edit the SVG, regenerate, never hand-edit the rasters.

It is the Celldega logo mark on a **transparent** background, inset to roughly
80% of a 1024 canvas.

An earlier version sat on a white rounded plate for contrast against dark Docks.
Rendering the mark over both light and dark backgrounds showed the blue holds up
unaided, so the plate was dropped — a transparent icon sits better alongside
other macOS app icons. The artwork is scaled up to compensate, since an unplated
mark reads smaller than a plated one at the same size.

The mark comes from the official brand set, `Celldega_LOGO_Full Color_Logo
Mark.svg` — the "Full Color / Logo Mark" variant (mark only, no wordmark, which
is what an app icon needs). It is byte-identical to the copy vendored at
`docs/assets/img/Celldega_LOGO_Full_Color_Logo_Mark.svg` in the
[celldega](https://github.com/broadinstitute/celldega) repo. Its paths are
inlined into `icon.svg` so this repo has no external asset dependency.

## Why the app icon is not an SVG

macOS requires `.icns` and Windows requires `.ico` for bundle icons — neither OS
accepts vector. So the SVG is rasterised, but **every size is rendered directly
from the vector** rather than resampled from a single bitmap, which is what
keeps the 16px Finder icon sharp.

Inside the app UI, `src/renderer/celldega-logo.svg` is used as vector, since the
renderer is a browser and has no such restriction.

## Regenerating

Requires `librsvg` and `imagemagick` (`brew install librsvg imagemagick`).

```sh
cd assets
mkdir -p icon.iconset
for s in 16 32 128 256 512; do
  rsvg-convert -w $s   -h $s   icon.svg -o icon.iconset/icon_${s}x${s}.png
  rsvg-convert -w $((s*2)) -h $((s*2)) icon.svg -o icon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset

rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png
magick -background none icon.svg -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

Wired up in [`forge.config.js`](../forge.config.js): `packagerConfig.icon`
(extension-less — packager picks `.icns` / `.ico`), the DMG volume icon, and the
Squirrel installer icon.

## macOS icon caching

macOS aggressively caches bundle icons, so a rebuilt app may still show the old
one. Move the app to Trash and empty it before reinstalling, or run:

```sh
sudo rm -rf /Library/Caches/com.apple.iconservices.store
killall Dock Finder
```
