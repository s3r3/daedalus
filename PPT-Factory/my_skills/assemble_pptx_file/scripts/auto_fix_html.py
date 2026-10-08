#!/usr/bin/env python3
"""
自动修复 HTML 文件中的 PPTX 兼容性问题
- 自动包装 DIV 中的裸文本
- 检测并报告文本框位置问题
"""

import sys
import argparse
import re
from pathlib import Path
from bs4 import BeautifulSoup, NavigableString, Comment

def fix_unwrapped_text_in_divs(soup):
    """自动将 DIV 中的裸文本包装在 <span> 标签中"""
    fixes_made = []
    
    for div in soup.find_all('div'):
        style = div.get('style', '').lower()
        has_styling = any(prop in style for prop in ['background', 'border', 'padding', 'font-size'])
        
        # Remove check for has_styling. We want to wrap text in ALL divs to be safe for html2pptx.
        # This is because html2pptx.js validator checks ALL container divs.
        if True:
            # 检查直接子节点中的文本节点
            for child in list(div.children):
                # 跳过注释节点
                if isinstance(child, Comment):
                    continue
                    
                if isinstance(child, NavigableString):
                    text = child.strip()
                    if text:  # 非空文本
                        # 创建 span 标签包装文本
                        span = soup.new_tag('span')
                        span.string = str(child)
                        child.replace_with(span)
                        fixes_made.append(f"包装了 DIV 中的文本: '{text[:30]}...'")
    
    return fixes_made

def fix_styled_text_tags(soup):
    """
    修复带有盒模型样式（背景/边框/阴影）的文本标签
    通过创建一个父级 DIV 来承载样式，文本标签只负责文本
    """
    fixes_made = []
    text_tags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'li']
    box_styles = ['background', 'border', 'box-shadow']
    
    for tag_name in text_tags:
        for el in soup.find_all(tag_name):
            style = el.get('style', '').lower()
            if not style:
                continue
                
            # 检查是否有盒模型样式
            has_box_style = any(s in style for s in box_styles)
            
            if has_box_style:
                # 提取样式
                styles = [s.strip() for s in style.split(';') if s.strip()]
                box_styles_found = []
                text_styles = []
                
                # 分离样式
                for s in styles:
                    is_box = any(bs in s for bs in box_styles)
                    # padding 也要移到 DIV 上，否则文本框会有内边距，PPTX 处理可能不一致
                    # 但 html2pptx.js 支持文本框 padding? 
                    # html2pptx.js line 1018 handles padding -> margin for text.
                    # 最好还是分离。
                    if is_box or 'padding' in s:
                        box_styles_found.append(s)
                    else:
                        text_styles.append(s)
                
                if box_styles_found:
                    # 创建 wrapper div
                    wrapper = soup.new_tag('div')
                    # 应用盒模型样式
                    wrapper['style'] = '; '.join(box_styles_found)
                    # 保持原始类名（如果是布局相关的类，可能要在 wrapper 上？）
                    # 暂时不移动 class，假设 class 主要是为了选中，样式都在 inline style 里
                    
                    # 在 DOM 中插入 wrapper
                    el.wrap(wrapper)
                    
                    # 更新文本标签样式（只保留文本样式）
                    el['style'] = '; '.join(text_styles)
                    
                    fixes_made.append(f"修复了带样式的 <{tag_name}>: 移除了 {len(box_styles_found)} 个样式属性到父级 DIV")

    return fixes_made

def fix_body_padding(soup):
    """
    强制重置 body 的 margin 和 padding 为 0
    防止因为 padding 导致的全屏容器错位
    """
    fixes_made = []
    body = soup.find('body')
    if body:
        current_style = body.get('style', '')
        
        # 简单粗暴：追加 !important 样式
        # 检查是否已经有了
        if 'margin: 0 !important' not in current_style or 'padding: 0 !important' not in current_style:
            new_style = current_style + '; margin: 0 !important; padding: 0 !important;'
            body['style'] = new_style.strip('; ')
            fixes_made.append("强制重置 body margin/padding 为 0")
            
    return fixes_made

def main():
    parser = argparse.ArgumentParser(description="自动修复 HTML 的 PPTX 兼容性问题")
    parser.add_argument("input_file", help="要修复的 HTML 文件路径")
    parser.add_argument("--dry-run", action="store_true", help="仅检查不修改文件")
    args = parser.parse_args()
    
    path = Path(args.input_file)
    if not path.exists():
        print(f"❌ 错误: 文件不存在: {path}")
        sys.exit(1)
    
    # 读取文件
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
        soup = BeautifulSoup(content, 'html.parser')
    
    print(f"🔍 检查文件: {path.name}")
    
    # 应用修复
    fixes = []
    fixes.extend(fix_body_padding(soup))
    fixes.extend(fix_unwrapped_text_in_divs(soup))
    fixes.extend(fix_styled_text_tags(soup))
    
    if not fixes:
        print("✅ 未发现需要修复的问题")
        sys.exit(0)
    
    print(f"\n📝 发现 {len(fixes)} 处问题:")
    for fix in fixes:
        print(f"  - {fix}")
    
    if args.dry_run:
        print("\n🔍 试运行模式: 不会修改文件")
        sys.exit(0)
    
    # 保存修复后的文件
    with open(path, 'w', encoding='utf-8') as f:
        f.write(str(soup.prettify()))
    
    print(f"\n✅ 已修复并保存: {path}")
    print(f"   共修复了 {len(fixes)} 处问题")

if __name__ == "__main__":
    main()
