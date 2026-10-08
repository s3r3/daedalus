"""
Download common vector assets from Iconify API and other sources
"""

import urllib.request
import json
from pathlib import Path
import time

# Base directory
VECTORS_DIR = Path(__file__).parent.parent / "resources" / "vectors"

# Iconify API base URL
ICONIFY_API = "https://api.iconify.design"

# Common icons to download (from Material Design Icons)
COMMON_ICONS = {
    # Chart & Data
    "chart-line": "mdi:chart-line",
    "chart-bar": "mdi:chart-bar",
    "chart-pie": "mdi:chart-pie",
    "chart-donut": "mdi:chart-donut",
    "trending-up": "mdi:trending-up",
    "trending-down": "mdi:trending-down",
    
    # Business & Office
    "briefcase": "mdi:briefcase",
    "calendar": "mdi:calendar",
    "clock": "mdi:clock-outline",
    "email": "mdi:email-outline",
    "phone": "mdi:phone",
    
    # People & Team
    "account": "mdi:account",
    "account-group": "mdi:account-group",
    "account-circle": "mdi:account-circle",
    
    # Actions & UI
    "check": "mdi:check",
    "close": "mdi:close",
    "arrow-right": "mdi:arrow-right",
    "arrow-left": "mdi:arrow-left",
    "arrow-up": "mdi:arrow-up",
    "arrow-down": "mdi:arrow-down",
    
    # Ideas & Innovation
    "lightbulb": "mdi:lightbulb-outline",
    "rocket": "mdi:rocket-launch",
    "target": "mdi:target",
    "star": "mdi:star",
    
    # Technology
    "laptop": "mdi:laptop",
    "cellphone": "mdi:cellphone",
    "cloud": "mdi:cloud-outline",
    "database": "mdi:database",
    
    # Location & Navigation
    "map-marker": "mdi:map-marker",
    "home": "mdi:home",
    "office-building": "mdi:office-building",
    
    # File & Document
    "file-document": "mdi:file-document-outline",
    "folder": "mdi:folder-outline",
    "download": "mdi:download",
    "upload": "mdi:upload",
}

def download_icon_from_iconify(icon_full_name: str, output_path: Path):
    """
    Download SVG icon from Iconify API
    
    Args:
        icon_full_name: Full icon name (e.g., "mdi:chart-line")
        output_path: Path to save the SVG file
    """
    # Iconify API endpoint
    url = f"{ICONIFY_API}/{icon_full_name}.svg"
    
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            if response.status == 200:
                # Save SVG content
                svg_content = response.read().decode('utf-8')
                with open(output_path, 'w') as f:
                    f.write(svg_content)
                print(f"  ✓ Downloaded: {output_path.name}")
                return True
            else:
                print(f"  ✗ Failed to download {icon_full_name}: HTTP {response.status}")
                return False
    except Exception as e:
        print(f"  ✗ Error downloading {icon_full_name}: {e}")
        return False

def download_all_icons():
    """Download all common icons"""
    icons_dir = VECTORS_DIR / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)
    
    print(f"📥 Downloading {len(COMMON_ICONS)} icons from Iconify...")
    print(f"   Target: {icons_dir}\n")
    
    success_count = 0
    for icon_id, icon_full_name in COMMON_ICONS.items():
        output_path = icons_dir / f"{icon_id}.svg"
        
        if download_icon_from_iconify(icon_full_name, output_path):
            success_count += 1
        
        # Be nice to the API - add small delay
        time.sleep(0.1)
    
    print(f"\n✅ Successfully downloaded {success_count}/{len(COMMON_ICONS)} icons")
    return success_count

def update_index():
    """Update vector_index.json with downloaded icons"""
    index_path = VECTORS_DIR / "vector_index.json"
    
    # Read existing index
    with open(index_path, 'r') as f:
        index = json.load(f)
    
    # Update icons list
    icons_items = []
    for icon_id, icon_full_name in COMMON_ICONS.items():
        # Extract tags from icon name
        tags = icon_id.replace('-', ' ').split()
        
        icons_items.append({
            "id": icon_id,
            "name": icon_id.replace('-', ' ').title(),
            "tags": tags,
            "source": "iconify",
            "path": f"icons/{icon_id}.svg",
            "color_customizable": True
        })
    
    index['categories']['icons']['items'] = icons_items
    
    # Save updated index
    with open(index_path, 'w') as f:
        json.dump(index, f, indent=2, ensure_ascii=False)
    
    print(f"✅ Updated vector_index.json with {len(icons_items)} icons")

if __name__ == "__main__":
    print("=" * 60)
    print("Vector Asset Downloader")
    print("=" * 60)
    
    # Download icons
    success_count = download_all_icons()
    
    if success_count > 0:
        # Update index
        print("\n📝 Updating index...")
        update_index()
    
    print("\n🎉 Done! You can now use these icons in your layouts.")
    print("   Example: <!--VECTOR:chart-line-->")
