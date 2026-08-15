# Marketing screenshots

Two files, referenced by the "On a phone" section of `index.html`:

| file | what it shows |
|---|---|
| `pocketge_portrait_framed.png` | the app on a phone held **upright** — target boxes, chart, favourites list below |
| `pocketge_landscape_framed.png` | the app on a phone turned **sideways** — chart left, favourites and rating panels right |

These are pre-framed: the handset bezel and rounded corners are baked into the
PNG, and the area outside the bezel is transparent (RGBA). The page therefore
draws **no** frame of its own — it only adds a `drop-shadow` filter, which
follows the alpha silhouette so the shadow hugs the rounded corners.

If you replace them, keep that contract: bezel included, transparent outside,
browser chrome (URL bar, bottom toolbar) cropped away. Also update the `width`
and `height` attributes on the `<img>` tags to the new pixel dimensions — they
reserve the layout box so the section doesn't jump while the images load.

The portrait slot renders at 210px wide and the landscape one at 500px, so
roughly 2x that is plenty. Current files are 498x827 and 1048x424.

If either file is absent the page removes that figure on load rather than
showing a broken image, so it is safe to add them one at a time.
