#!/usr/bin/env python3
import requests
import time
from pathlib import Path
from urllib.parse import quote

# Directories
IMAGES_DIR = Path('./images')
IMAGES_DIR.mkdir(exist_ok=True)

# Fetch latest GEIDs {name: id}
print("Fetching latest GE IDs...")
geids_url = "https://oldschool.runescape.wiki/?title=Module:GEIDs/data.json&action=raw&ctype=application/json"
geids_resp = requests.get(geids_url)
geids = geids_resp.json()
if '%LAST_UPDATE%' in geids: del geids['%LAST_UPDATE%']
if '%LAST_UPDATE_F%' in geids: del geids['%LAST_UPDATE_F%']
print(f"Loaded {len(geids)} items.")

# Download larger images (overwrite existing to upgrade to larger)
print("Downloading larger images for ALL items (overwriting existing for upgrades)... This may take 1-2 hours.")
new_or_updated = 0
total_items = len(geids)
for idx, (name, ge_id) in enumerate(geids.items(), 1):
    try:
        ge_id = int(ge_id)
    except ValueError:
        continue
    id_str = str(ge_id)
    img_path = IMAGES_DIR / f"{id_str}.png"

    # Progress (no skip - always attempt to download larger)
    print(f"[{idx}/{total_items}] Processing {id_str} ({name})...")

    wiki_name = quote(name.replace(' ', '_').replace("'", "%27").strip())
    
    # Priority 1: Detailed larger image (~200-500px render)
    detail_url = f"https://oldschool.runescape.wiki/images/{wiki_name}_detail.png"
    resp = requests.get(detail_url, timeout=10)
    if resp.status_code == 200 and len(resp.content) > 1000:  # Valid larger image (size check to avoid tiny placeholders)
        with open(img_path, 'wb') as f:
            f.write(resp.content)
        new_or_updated += 1
        print("  ✅ Downloaded/Updated detailed large image!")
    else:
        # Priority 2: 100px thumb (larger than 32px, pixelated no blur)
        thumb_url = f"https://oldschool.runescape.wiki/images/thumb/{wiki_name}/100px-{wiki_name}.png?pixelated=true"
        resp = requests.get(thumb_url, timeout=10)
        if resp.status_code == 200 and len(resp.content) > 500:
            with open(img_path, 'wb') as f:
                f.write(resp.content)
            new_or_updated += 1
            print("  ✅ Downloaded/Updated 100px thumb (non-blurry)!")
        else:
            print(f"  ❌ No larger image found (status {resp.status_code}) - keeping existing or skipping.")

    time.sleep(1)  # 1-sec delay for safety

print(f"Downloaded/Updated {new_or_updated} larger images in total.")
print("\nDone! Commit: git add images/ && git commit -m 'Upgrade to larger wiki images (Oct 2025)' && git push")
print("New instructions: Run this from your repo root. It overwrites small images with larger ones where available.")
print("Test: Refresh site - images should be bigger/sharper (wiki has details for ~16k items).")