
import asyncio
import argparse
from pathlib import Path
from playwright.async_api import async_playwright

async def capture_slide(page, html_path, output_path):
    file_uri = Path(html_path).absolute().as_uri()
    print(f"   -> Capturing: {html_path.name}")
    await page.goto(file_uri)
    
    # Wait for fonts and rendering
    await page.wait_for_timeout(1000)
    
    # HYBRID STRATEGY: Hide ALL text elements before screenshot
    # This prevents duplication when we add editable TextBoxes in PPTX
    await page.evaluate("""() => {
        // Hide all text-containing elements
        const selectors = [
            '.ppt-title',
            '.ppt-subtitle', 
            '.ppt-text-body',
            '.ppt-text-hero',
            '.ppt-list-item span',  // List item numbers and text
            '.ppt-card h3',          // Card headers
            'h1', 'h2', 'h3', 'p'    // Generic text elements
        ];
        
        selectors.forEach(selector => {
            const elements = document.querySelectorAll(selector);
            elements.forEach(el => {
                el.style.visibility = 'hidden';
            });
        });
        
        console.log('Text elements hidden for hybrid screenshot');
    }""")
    
    # Wait a bit for visibility changes to take effect
    await page.wait_for_timeout(200)
    
    # Take full-page screenshot
    await page.screenshot(path=output_path, full_page=False)
    print(f"      Saved to: {output_path}")

async def run_batch(input_dir, output_dir):
    async with async_playwright() as p:
        # Launch with 1920x1080 viewport to match PPTX dimensions
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1920, "height": 1080})
        
        input_path = Path(input_dir)
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
        
        html_files = sorted(list(input_path.glob("slide_*.html")))
        print(f"== Found {len(html_files)} slides to capture ==")
        print(f"   Strategy: HYBRID (hiding text for editable TextBoxes)")
        
        for html_file in html_files:
            png_name = html_file.stem + ".png"
            await capture_slide(page, html_file, output_path / png_name)
            
        await browser.close()
        print(f"\n✅ All screenshots saved to {output_dir}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input_dir", help="Directory containing HTML slides")
    parser.add_argument("output_dir", help="Directory to save PNG screenshots")
    args = parser.parse_args()
    
    asyncio.run(run_batch(args.input_dir, args.output_dir))
