"""
Vector Asset Manager for PPT Generation System

Provides functions to search and retrieve SVG vector assets (icons, illustrations, patterns).
"""

import json
import re
from pathlib import Path
from typing import Optional, List, Dict

class VectorAssetManager:
    def __init__(self, index_path: str = None):
        """Initialize with vector index JSON"""
        if index_path is None:
            base_dir = Path(__file__).parent.parent
            index_path = base_dir / "resources" / "vectors" / "vector_index.json"
        
        self.index_path = Path(index_path)
        self.base_dir = self.index_path.parent
        
        with open(self.index_path, 'r') as f:
            self.index = json.load(f)
    
    def search(self, query: str, category: str = None, limit: int = 5) -> List[Dict]:
        """
        Search for vector assets by keywords
        
        Args:
            query: Search keywords (e.g., "chart", "team meeting")
            category: Filter by category ("icons", "illustrations", "patterns")
            limit: Maximum number of results
        
        Returns:
            List of matching assets with metadata
        """
        query_lower = query.lower()
        keywords = query_lower.split()
        
        results = []
        categories_to_search = [category] if category else self.index['categories'].keys()
        
        for cat in categories_to_search:
            if cat not in self.index['categories']:
                continue
                
            for item in self.index['categories'][cat]['items']:
                # Score based on keyword matches
                score = 0
                for keyword in keywords:
                    if keyword in item['id']:
                        score += 3
                    if keyword in item['name'].lower():
                        score += 2
                    if any(keyword in tag for tag in item['tags']):
                        score += 1
                
                if score > 0:
                    results.append({
                        **item,
                        'category': cat,
                        'score': score
                    })
        
        # Sort by score and return top results
        results.sort(key=lambda x: x['score'], reverse=True)
        return results[:limit]
    
    def get_svg(self, asset_id: str, category: str = None) -> Optional[str]:
        """
        Get SVG content by asset ID
        
        Args:
            asset_id: The asset ID (e.g., "chart-line")
            category: Optional category to search in
        
        Returns:
            SVG content as string, or None if not found
        """
        categories_to_search = [category] if category else self.index['categories'].keys()
        
        for cat in categories_to_search:
            if cat not in self.index['categories']:
                continue
                
            for item in self.index['categories'][cat]['items']:
                if item['id'] == asset_id:
                    svg_path = self.base_dir / item['path']
                    if svg_path.exists():
                        with open(svg_path, 'r') as f:
                            return f.read()
        
        return None
    
    def get_svg_with_color(self, asset_id: str, color: str, opacity: float = 1.0) -> Optional[str]:
        """
        Get SVG with custom color applied
        
        Args:
            asset_id: The asset ID
            color: CSS color value (e.g., "#007AFF" or "var(--ppt-color-accent)")
            opacity: Opacity value (0.0 to 1.0)
        
        Returns:
            Modified SVG content
        """
        svg_content = self.get_svg(asset_id)
        if not svg_content:
            return None
        
        # Add style attribute to SVG tag
        # Replace <svg> with <svg style="fill: {color}; opacity: {opacity};">
        svg_content = re.sub(
            r'<svg\s+',
            f'<svg style="fill: {color}; opacity: {opacity};" ',
            svg_content,
            count=1
        )
        
        return svg_content
    
    def list_all(self, category: str = None) -> List[Dict]:
        """List all available assets, optionally filtered by category"""
        results = []
        categories_to_list = [category] if category else self.index['categories'].keys()
        
        for cat in categories_to_list:
            if cat in self.index['categories']:
                for item in self.index['categories'][cat]['items']:
                    results.append({**item, 'category': cat})
        
        return results


# Helper functions for quick access
def search_vector(query: str, category: str = None) -> Optional[str]:
    """Quick function to search and return first matching SVG"""
    manager = VectorAssetManager()
    results = manager.search(query, category, limit=1)
    if results:
        return manager.get_svg(results[0]['id'], results[0]['category'])
    return None


def get_icon(icon_id: str, color: str = "currentColor", size: int = 48) -> str:
    """Get icon with specified color and size"""
    manager = VectorAssetManager()
    svg_content = manager.get_svg(icon_id, category="icons")
    
    if svg_content:
        # Set width, height, and color
        svg_content = re.sub(r'viewBox="([^"]+)"', f'viewBox="\\1" width="{size}" height="{size}"', svg_content)
        svg_content = re.sub(r'fill="currentColor"', f'fill="{color}"', svg_content)
        return svg_content
    
    return ""


if __name__ == "__main__":
    # Example usage
    manager = VectorAssetManager()
    
    # Search for chart icons
    results = manager.search("chart")
    print(f"Found {len(results)} results for 'chart':")
    for r in results:
        print(f"  - {r['name']} ({r['id']}) in {r['category']}")
    
    # Get specific icon
    svg = manager.get_svg_with_color("chart-line", "var(--ppt-color-accent)", 0.8)
    if svg:
        print(f"\nRetrieved chart-line icon ({len(svg)} bytes)")
