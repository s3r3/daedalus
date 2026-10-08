#!/usr/bin/env python3
"""
HTML Linter for PPTX Compatibility
Analyzes HTML files to detect structures that will fail or render incorrectly during html2pptx conversion.
"""

import sys
import argparse
import re
from pathlib import Path
from bs4 import BeautifulSoup, Comment, Tag

def lint_html(file_path):
    issues = []
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            soup = BeautifulSoup(f, 'html.parser')
    except Exception as e:
        return [f"Fatal: Could not parse HTML file: {str(e)}"]

    # Rule 1: Separation of Structure (Div) and Content (Text)
    # DIVs should not have both styling (bg/border) AND direct text content
    for div in soup.find_all('div'):
        style = div.get('style', '').lower()
        has_skin = 'background' in style or 'border' in style
        
        direct_text = ''.join([
            str(t) for t in div.find_all(string=True, recursive=False) 
            if t.strip() and not isinstance(t, Comment)
        ])
        
        if has_skin and direct_text:
            msg = f"[Structure Error] Styled DIV contains direct text: <div style='...'>{direct_text[:20]}...</div>. Use a child <p> tag for text."
            issues.append(msg)

    # Rule 2: Text Tags should not be Styled Boxes
    # P, H1-H6, SPAN should not have background, border, or shadow
    text_tags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'li']
    box_styles = ['background', 'border', 'box-shadow']
    
    for tag in text_tags:
        for el in soup.find_all(tag):
            style = el.get('style', '').lower()
            found_styles = [s for s in box_styles if s in style]
            
            if found_styles:
                issues.append(f"[Style Error] Text tag <{tag}> has unsupported box styling ({', '.join(found_styles)}). Use a parent DIV for the box.")

    # Rule 3: Unsupported CSS Properties (Blacklist)
    # Scan all style attributes
    blacklist = {
        'pseudo-elements': '::before/::after are invisible',
    }
    
    auto_bake_list = {
        'linear-gradient': 'Will be Auto-Baked to Image',
        'radial-gradient': 'Will be Auto-Baked to Image', 
        'clip-path': 'Will be Auto-Baked to Image',
        'mask-image': 'Will be Auto-Baked to Image',
        'backdrop-filter': 'Will be Auto-Baked to Image',
        'transform': 'Will be Auto-Baked to Image',
        'box-shadow': 'Will be Auto-Baked if Inset',
        'filter': 'Will be Auto-Baked', 
    }
    
    warnings = []
    
    for el in soup.find_all(True):  # All tags
        style = el.get('style', '').lower()
        for prop, reason in blacklist.items():
            if prop in style:
                warnings.append(f"[CSS Warning] Unsupported property '{prop}' detected in <{el.name}>. Reason: {reason}")
        
        for prop, note in auto_bake_list.items():
            if prop in style:
                 # This is just INFO now, not a warning that fails the pipeline (if warnings fail, but usually only errors fail)
                 # But we can list it as info.
                 pass
    
    return issues, warnings

def main():
    parser = argparse.ArgumentParser(description="Lint HTML for PPTX compatibility")
    parser.add_argument("input_file", help="Path to HTML file")
    args = parser.parse_args()
    
    path = Path(args.input_file)
    if not path.exists():
        print(f"Error: File not found: {path}")
        sys.exit(1)
        
    print(f"Linting {path}...")
    errors, warnings = lint_html(path)
    
    if warnings:
        print("\n⚠️  Warnings (Non-Fatal):")
        for warn in warnings:
            print(f"  - {warn}")

    if errors:
        print("\n❌ Found Critical Errors:")
        for issue in errors:
            print(f"  - {issue}")
        print("\nPlease fix these issues before conversion.")
        sys.exit(1)
    else:
        print("✅ HTML structure is valid for PPTX conversion.")
        sys.exit(0)

if __name__ == "__main__":
    main()
