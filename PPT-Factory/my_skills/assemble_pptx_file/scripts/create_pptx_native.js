const PptxGenJS = require('pptxgenjs');
const fs = require('fs');
const path = require('path');
const { extractMetrics } = require('./html2pptx');

/**
 * 升级版渲染引擎：从提取的度量数据创建 PPTX 幻灯片
 */
async function addMeasuredSlide(pptx, metrics, slideTitle) {
    const slide = pptx.addSlide();

    // 设置背景
    if (metrics.background && metrics.background.value) {
        slide.background = { color: metrics.background.value };
    }

    // 绘制元素
    for (const el of metrics.elements) {
        try {
            if (el.type === 'shape') {
                slide.addShape(pptx.ShapeType.rect, {
                    x: el.x,
                    y: el.y,
                    w: el.w,
                    h: el.h,
                    fill: el.fill ? { color: el.fill } : null,
                    line: el.line ? { color: el.line.color, width: el.line.width } : null,
                    rectRadius: el.radius || 0
                });
            } else if (el.type === 'image') {
                let imgPath = el.src;
                if (imgPath && imgPath.startsWith('file://')) {
                    imgPath = imgPath.replace('file://', '');
                }
                if (imgPath) imgPath = decodeURIComponent(imgPath);

                // 智能裁剪逻辑
                const slideW = 13.333; // LAYOUT_WIDE
                const slideH = 7.5;

                let imgX = el.x;
                let imgY = el.y;
                let imgW = el.w;
                let imgH = el.h;

                // Safe Check
                if (typeof imgX !== 'number' || isNaN(imgX) ||
                    typeof imgY !== 'number' || isNaN(imgY) ||
                    typeof imgW !== 'number' || isNaN(imgW) || imgW <= 0 ||
                    typeof imgH !== 'number' || isNaN(imgH) || imgH <= 0) {
                    continue;
                }

                // Intersection Logic
                const visibleX1 = Math.max(0, imgX);
                const visibleY1 = Math.max(0, imgY);
                const visibleX2 = Math.min(slideW, imgX + imgW);
                const visibleY2 = Math.min(slideH, imgY + imgH);

                const visibleW = visibleX2 - visibleX1;
                const visibleH = visibleY2 - visibleY1;

                // If fully invisible, skip
                if (visibleW <= 0.05 || visibleH <= 0.05) continue;

                // Check for overflows with tolerance
                const isOverflowing = visibleW < (imgW - 0.05) || visibleH < (imgH - 0.05);

                if (isOverflowing) {
                    try {
                        const cropX_abs = visibleX1 - imgX;
                        const cropY_abs = visibleY1 - imgY;

                        let cropX_pct = (cropX_abs / imgW) * 100;
                        let cropY_pct = (cropY_abs / imgH) * 100;
                        let cropW_pct = (visibleW / imgW) * 100;
                        let cropH_pct = (visibleH / imgH) * 100;

                        // Clamp
                        const clamp = (val, max = 100) => {
                            const n = parseFloat(val);
                            if (isNaN(n)) return 0;
                            return Math.max(0, Math.min(max, n));
                        };

                        slide.addImage({
                            path: imgPath,
                            x: visibleX1,
                            y: visibleY1,
                            w: visibleW,
                            h: visibleH,
                            sizing: {
                                type: 'crop',
                                x: clamp(cropX_pct),
                                y: clamp(cropY_pct),
                                w: clamp(cropW_pct, 100),
                                h: clamp(cropH_pct, 100)
                            }
                        });
                    } catch (err) {
                        // Fallback
                        console.warn('Smart crop failed, falling back to full image:', err);
                        slide.addImage({ path: imgPath, x: imgX, y: imgY, w: imgW, h: imgH });
                    }
                } else {
                    slide.addImage({ path: imgPath, x: imgX, y: imgY, w: imgW, h: imgH });
                }
            } else if (el.type === 'text' || el.type === 'p' || el.type === 'h1' || el.type === 'span') {
                // Map properties from html2pptx metrics structure
                const style = el.style || {};
                const pos = el.position || {};

                const options = {
                    x: pos.x,
                    y: pos.y,
                    w: pos.w,
                    h: pos.h,
                    fontSize: style.fontSize || 12,
                    color: style.color || '000000',
                    bold: style.fontWeight === 'bold' || parseInt(style.fontWeight) >= 600,
                    italic: style.fontStyle === 'italic',
                    underline: style.textDecoration && style.textDecoration.includes('underline'),
                    fontFace: style.fontFace || 'Arial',
                    align: style.align || 'left',
                    valign: 'top',
                    margin: style.margin || 0
                };

                // Add transparency if present
                if (style.transparency !== undefined && style.transparency !== null) {
                    options.transparency = style.transparency;
                }

                slide.addText(el.text, options);
            }
        } catch (err) {
            console.error(`Error adding element of type ${el.type}:`, err);
        }
    }

    return slide;
}

/**
 * 主入口：根据渲染后的 HTML 文件生成 PPTX
 * 
 * @param {string[]} htmlFiles HTML 文件路径列表
 * @param {string} outputPath 输出路径
 */
async function generateFromHtml(htmlFiles, outputPath) {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 inches (matches 1280x720 @ 96DPI)

    console.log(`Starting conversion of ${htmlFiles.length} slides...`);

    for (const htmlPath of htmlFiles) {
        console.log(`Processing: ${htmlPath}`);
        try {
            const metrics = await extractMetrics(htmlPath);
            // DEBUG: Inspect Metrics
            console.log(`[Metrics-DEBUG] Extracted ${metrics.elements.length} elements.`);
            metrics.elements.forEach((el, i) => {
                if (el.type === 'image') {
                    console.log(`  [${i}] IMAGE src=${el.src ? el.src.substring(0, 50) + '...' : 'null'}`);
                }
            });
            await addMeasuredSlide(pptx, metrics, path.basename(htmlPath));
        } catch (err) {
            console.error(`Failed to process ${htmlPath}:`, err);
        }
    }

    await pptx.writeFile({ fileName: outputPath });
    console.log(`\n✅ PPTX 生成成功: ${outputPath}`);
}

// 保持 CLI 兼容性，但增加对 HTML 直接转换的支持
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error('用法: node create_pptx_native.js <output.pptx> <html_file1> [html_file2] ...');
        process.exit(1);
    }

    const outputPath = args[0];
    const htmlFiles = args.slice(1);

    generateFromHtml(htmlFiles, outputPath)
        .then(() => process.exit(0))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { generateFromHtml };
