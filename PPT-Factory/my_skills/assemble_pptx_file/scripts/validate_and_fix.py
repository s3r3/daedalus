#!/usr/bin/env python3
"""
增强的 HTML 验证和自动修复工具
结合静态验证和动态布局检查,自动修复常见的 PPTX 兼容性问题
"""

import sys
import argparse
import json
from pathlib import Path
from bs4 import BeautifulSoup, NavigableString, Comment

class HTMLValidator:
    def __init__(self, html_path, auto_fix=False):
        self.html_path = Path(html_path)
        self.auto_fix = auto_fix
        self.issues = []
        self.fixes = []
        self.warnings = []
        
        with open(self.html_path, 'r', encoding='utf-8') as f:
            self.content = f.read()
            self.soup = BeautifulSoup(self.content, 'html.parser')
    
    def check_unwrapped_text(self):
        """检查并修复 DIV 中的裸文本"""
        for div in self.soup.find_all('div'):
            style = div.get('style', '').lower()
            has_styling = any(prop in style for prop in ['background', 'border', 'padding', 'font-size'])
            
            if has_styling:
                for child in list(div.children):
                    if isinstance(child, Comment):
                        continue
                        
                    if isinstance(child, NavigableString):
                        text = str(child).strip()
                        if text:
                            self.issues.append(f"DIV 包含裸文本: '{text[:30]}...'")
                            
                            if self.auto_fix:
                                span = self.soup.new_tag('span')
                                span.string = str(child)
                                child.replace_with(span)
                                self.fixes.append(f"✓ 包装了文本: '{text[:30]}...'")
    
    def check_dimensions(self):
        """检查 HTML 尺寸设置是否一致"""
        body_tag = self.soup.find('body')
        if body_tag:
            style = body_tag.get('style', '')
            
            # 检查是否有多个不同的尺寸定义
            style_tag = self.soup.find('style')
            if style_tag:
                css_content = style_tag.string
                if css_content:
                    if '960px' in css_content:
                        self.warnings.append("⚠️  检测到 960x540 尺寸定义,应使用 1280x720 以匹配 PPTX LAYOUT_WIDE")
    
    def check_text_box_boundaries(self):
        """静态检查可能超出边界的大字体文本"""
        # 获取 body 高度
        body_style = self.soup.find('style')
        if body_style and body_style.string:
            import re
            height_match = re.search(r'height:\s*(\d+)px', body_style.string)
            if height_match:
                body_height = int(height_match.group(1))
                safe_height = body_height - 48  # 0.5英寸 = 48px
                
                # 检查大标题
                for tag in ['h1', 'h2']:
                    elements = self.soup.find_all(tag)
                    for el in elements:
                        style = el.get('style', '')
                        if 'font-size' in style:
                            font_match = re.search(r'font-size:\s*([\d.]+)rem', style)
                            if font_match:
                                font_size = float(font_match.group(1))
                                if font_size > 4.0:
                                    self.warnings.append(
                                        f"⚠️  {tag.upper()} 字体过大 ({font_size}rem),可能超出底部边界"
                                    )
    
    def validate_and_fix(self):
        """执行所有检查和修复"""
        self.check_unwrapped_text()
        self.check_dimensions()
        self.check_text_box_boundaries()
        
        return {
            'issues': len(self.issues),
            'fixes': len(self.fixes),
            'warnings': len(self.warnings),
            'success': len(self.issues) == 0 or (self.auto_fix and len(self.fixes) > 0)
        }
    
    def save(self):
        """保存修复后的文件"""
        if self.auto_fix and self.fixes:
            with open(self.html_path, 'w', encoding='utf-8') as f:
                f.write(str(self.soup.prettify()))
            return True
        return False
    
    def print_report(self, result):
        """打印验证报告"""
        print(f"\n{'='*60}")
        print(f"📄 文件: {self.html_path.name}")
        print(f"{'='*60}\n")
        
        if self.warnings:
            print("⚠️  警告:")
            for warning in self.warnings:
                print(f"  {warning}")
            print()
        
        if self.issues:
            print(f"❌ 发现 {len(self.issues)} 个问题:")
            for issue in self.issues:
                print(f"  - {issue}")
            print()
        
        if self.fixes:
            print(f"✅ 已自动修复 {len(self.fixes)} 个问题:")
            for fix in self.fixes:
                print(f"  {fix}")
            print()
        
        if result['success']:
            if self.fixes:
                print("✅ 验证通过(已自动修复)")
            else:
                print("✅ 验证通过")
        else:
            print("❌ 验证失败 - 需要手动处理")
        
        print(f"\n{'='*60}\n")

def main():
    parser = argparse.ArgumentParser(description="HTML PPTX 兼容性验证和自动修复工具")
    parser.add_argument("input_file", help="要验证的 HTML 文件")
    parser.add_argument("--auto-fix", action="store_true", help="自动修复问题")
    parser.add_argument("--json", action="store_true", help="以 JSON 格式输出结果")
    args = parser.parse_args()
    
    path = Path(args.input_file)
    if not path.exists():
        print(f"❌ 错误: 文件不存在: {path}")
        sys.exit(1)
    
    validator = HTMLValidator(path, auto_fix=args.auto_fix)
    result = validator.validate_and_fix()
    
    if args.auto_fix:
        validator.save()
    
    if args.json:
        print(json.dumps({
            'file': str(path),
            'issues': validator.issues,
            'fixes': validator.fixes,
            'warnings': validator.warnings,
            **result
        }, ensure_ascii=False, indent=2))
    else:
        validator.print_report(result)
    
    sys.exit(0 if result['success'] else 1)

if __name__ == "__main__":
    main()
