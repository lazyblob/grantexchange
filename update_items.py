#!/usr/bin/env python3
import json
import os
import requests
import time
from pathlib import Path
import pandas as pd
from urllib.parse import quote

# Directories (run this script from your repo root)
ITEMS_JSON_DIR = Path('./items-json')
IMAGES_DIR = Path('./images')
ITEMS_JSON_DIR.mkdir(exist_ok=True)
IMAGES_DIR.mkdir(exist_ok=True)

# Fetch latest GEIDs {name: id}
print("Step 1: Fetching latest GE IDs from wiki...")
geids_url = "https://oldschool.runescape.wiki/?title=Module:GEIDs/data.json&action=raw&ctype=application/json"
geids_resp = requests.get(geids_url)
geids = geids_resp.json()
if '%LAST_UPDATE%' in geids:
    del geids['%LAST_UPDATE%']  # Cleanup
if '%LAST_UPDATE_F%' in geids:
    del geids['%LAST_UPDATE_F%']
print(f"Loaded {len(geids)} items from GEIDs.")

# Fetch buy limits table
print("Step 2: Fetching latest buy limits from wiki...")
limits_url = "https://oldschool.runescape.wiki/w/Grand_Exchange/Buying_limits"
tables = pd.read_html(limits_url)
df = None
for table in tables:
    if len(table.columns) >= 2 and 'Item' in table.columns[0] and 'Limit' in table.columns[1]:
        df = table
        break
if df is None:
    print("Error: Could not find buy limits table. Using defaults for all.")
    buy_limits = {}
else:
    buy_limits = {}
    for _, row in df.iterrows():
        name = row[0].strip().lower()  # 'Item'
        try:
            limit_str = str(row[1]).replace(',', '').strip()  # 'Limit'
            limit = int(limit_str) if limit_str.isdigit() else 10000
            buy_limits[name] = limit
        except ValueError:
            print(f"Skipping invalid limit for {name}")
    print(f"Parsed {len(buy_limits)} buy limits.")

# Existing local IDs (to skip updates)
existing_ids = set()
for f in ITEMS_JSON_DIR.glob('*.json'):
    try:
        existing_ids.add(int(f.stem))
    except ValueError:
        pass
print(f"Found {len(existing_ids)} existing items-json files.")

# Create/update items-json for missing/new items
print("Step 3: Creating/updating items-json files...")
new_files = 0
for name, ge_id in geids.items():
    try:
        ge_id = int(ge_id)
    except ValueError:
        continue
    id_str = str(ge_id)
    file_path = ITEMS_JSON_DIR / f"{id_str}.json"
    if ge_id in existing_ids:
        print(f"Skipping existing {id_str} ({name})")
        continue

    limit = buy_limits.get(name.lower(), 10000)
    item_data = {
        "name": name,
        "ge_id": ge_id,
        "buy_limit": limit,
        "last_update": int(time.time())
    }
    with file_path.open('w') as f:
        json.dump(item_data, f, indent=2)
    new_files += 1
    if new_files % 100 == 0:
        print(f"Created {new_files} new items-json files so far...")

print(f"Created {new_files} new items-json files in total.")

# Download missing images with progress, delay, and correct URL
print("Step 4: Downloading missing images (this may take 20-60 mins; be patient)...")
new_images = 0
total_items = len(geids)
for idx, (name, ge_id) in enumerate(geids.items(), 1):
    try:
        ge_id = int(ge_id)
    except ValueError:
        continue
    id_str = str(ge_id)
    img_path = IMAGES_DIR / f"{id_str}.png"
    if img_path.exists():
        print(f"[{idx}/{total_items}] Skipping existing {id_str} ({name})")
        continue

    # Progress
    print(f"[{idx}/{total_items}] Downloading {id_str} ({name})...")

    # Correct wiki URL (no subfolder; direct name)
    wiki_name = quote(name.replace(' ', '_').replace("'", "%27").strip())
    icon_url = f"https://oldschool.runescape.wiki/images/{wiki_name}.png"

    try:
        resp = requests.get(icon_url, timeout=10)
        if resp.status_code == 200 and len(resp.content) > 100:  # Valid image check
            with open(img_path, 'wb') as f:
                f.write(resp.content)
            new_images += 1
            print("  ✅ Success!")
        else:
            # Fallback thumb (32px)
            thumb_url = f"https://oldschool.runescape.wiki/images/thumb/{wiki_name}/32px-{wiki_name}.png"
            resp = requests.get(thumb_url, timeout=10)
            if resp.status_code == 200 and len(resp.content) > 100:
                with open(img_path, 'wb') as f:
                    f.write(resp.content)
                new_images += 1
                print("  ✅ Thumb fallback success!")
            else:
                print(f"  ❌ Failed (status {resp.status_code}) - skipping.")
    except Exception as e:
        print(f"  ❌ Error: {e} - skipping.")

    # Delay to avoid rate limiting (essential for large batches)
    time.sleep(1)  # 1 sec; adjust to 2-3 if failures

print(f"Downloaded {new_images} new images in total.")

# Instructions
print("\nAll steps complete! Your folders are updated with latest wiki data.")
print("New instructions:")
print("1. Verify a few files: Open ./items-json/1.json (should have 'buy_limit' etc.).")
print("2. Check images: Open ./images/1.png in browser (should show item icon).")
print("3. Commit to Git: In Command Prompt (from repo root):")
print("   git add items-json/ images/")
print("   git commit -m 'Update items-json and images from wiki (Oct 2025)'")
print("   git push")
print("4. Refresh site: Hard reload grantexchange.net - new items like 'blue moon' should work.")
print("5. Run monthly: Save this script in repo, rerun when needed.")
print("If errors, rerun - it skips existing. Done! 🚀")