# Marketing screenshots

Two files, referenced by the "On a phone" section of `index.html`:

| file | what it should show |
|---|---|
| `phone-portrait.png` | the app on a phone held **upright** — target boxes, chart, favourites list below |
| `phone-landscape.png` | the app on a phone turned **sideways** — chart left, favourites and rating panels right |

Crop the browser chrome out (URL bar and the bottom toolbar). The page draws
the handset bezel around whatever it is given, so the shot should be the app
viewport only. Keeping the iOS status bar is fine.

Roughly 2x the display size is plenty — the portrait slot renders at 190px
wide and the landscape one at 460px, so ~800px and ~1400px wide respectively.

If either file is absent the page removes that figure on load rather than
showing a broken image, so it is safe to add them one at a time.
