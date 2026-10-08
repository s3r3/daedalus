#!/usr/bin/env python3
"""批量修复所有HTML文件中DIV的裸文本"""
import sys
from pathlib import Path
from bs4 import BeautifulSoup, NavigableString, Comment

def fix_file(file_path):
    with open(file_path, 'r', encoding='utf-8') as f:
        soup = BeautifulSoup(f, 'html.parser')
    
    fixes = 0
    for div in soup.find_all('div'):
        for child in list(div.children):
            if isinstance(child, Comment):
                continue
            if isinstance(child, NavigableString):
                text = str(child).strip()
                if text:
                    span = soup.new_tag('span')
                    span.string = str(child)
                    child.replace_with(span)
                    fixes += 1
    
    if fixes > 0:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(str(soup.prettify()))
        print(f"✓ {file_path.name}: {fixes} fixes")
    else:
        print(f"- {file_path.name}: no issues")
    
    return fixes

if __name__ == "__main__":
    html_dir = Path(sys.argv[1])
    total = 0
    for file in sorted(html_dir.glob("slide_*.html")):
        total += fix_file(file)
    print(f"\n✅ Total fixes: {total}")
