/**
 * html2pptx - Convert HTML slide to pptxgenjs slide with positioned elements
 *
 * USAGE:
 *   const pptx = new pptxgen();
 *   pptx.layout = 'LAYOUT_16x9';  // Must match HTML body dimensions
 *
 *   const { slide, placeholders } = await html2pptx('slide.html', pptx);
 *   slide.addChart(pptx.charts.LINE, data, placeholders[0]);
 *
 *   await pptx.writeFile('output.pptx');
 *
 * FEATURES:
 *   - Converts HTML to PowerPoint with accurate positioning
 *   - Supports text, images, shapes, and bullet lists
 *   - Extracts placeholder elements (class="placeholder") with positions
 *   - Handles CSS gradients, borders, and margins
 *
 * VALIDATION:
 *   - Uses body width/height from HTML for viewport sizing
 *   - Throws error if HTML dimensions don't match presentation layout
 *   - Throws error if content overflows body (with overflow details)
 *
 * RETURNS:
 *   { slide, placeholders } where placeholders is an array of { id, x, y, w, h }
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PT_PER_PX = 0.75;
const PX_PER_IN = 96;
const EMU_PER_IN = 914400;

// Helper: Get body dimensions and check for overflow
async function getBodyDimensions(page) {
  const bodyDimensions = await page.evaluate(() => {
    const body = document.body;
    const masterLayout =
      document.querySelector('.ppt-master-layout') ||
      document.querySelector('[class*="master"]') ||
      body;
    const style = window.getComputedStyle(masterLayout);
    const rect = masterLayout.getBoundingClientRect();

    return {
      width: rect.width || parseFloat(style.width),
      height: rect.height || parseFloat(style.height),
      scrollWidth: body.scrollWidth,
      scrollHeight: body.scrollHeight
    };
  });

  const errors = [];
  const widthOverflowPx = Math.max(0, bodyDimensions.scrollWidth - bodyDimensions.width - 1);
  const heightOverflowPx = Math.max(0, bodyDimensions.scrollHeight - bodyDimensions.height - 1);

  const widthOverflowPt = widthOverflowPx * PT_PER_PX;
  const heightOverflowPt = heightOverflowPx * PT_PER_PX;

  if (widthOverflowPt > 0 || heightOverflowPt > 0) {
    // Downgrade overflow to warning
    const directions = [];
    if (widthOverflowPt > 0) directions.push(`${widthOverflowPt.toFixed(1)}pt horizontally`);
    if (heightOverflowPt > 0) directions.push(`${heightOverflowPt.toFixed(1)}pt vertically`);
    const reminder = heightOverflowPt > 0 ? ' (Remember: leave 0.5" margin at bottom of slide)' : '';
    console.warn(`[Warning] HTML content overflows body by ${directions.join(' and ')}${reminder}. Content may be clipped.`);
    // errors.push(`HTML content overflows body by ${directions.join(' and ')}${reminder}`);
  }

  return { ...bodyDimensions, errors };
}

// Helper: Validate dimensions match presentation layout
function validateDimensions(bodyDimensions, pres) {
  const errors = [];
  const widthInches = bodyDimensions.width / PX_PER_IN;
  const heightInches = bodyDimensions.height / PX_PER_IN;

  if (pres.presLayout) {
    const layoutWidth = pres.presLayout.width / EMU_PER_IN;
    const layoutHeight = pres.presLayout.height / EMU_PER_IN;

    if (Math.abs(layoutWidth - widthInches) > 0.1 || Math.abs(layoutHeight - heightInches) > 0.1) {
      errors.push(
        `HTML dimensions (${widthInches.toFixed(1)}" × ${heightInches.toFixed(1)}") ` +
        `don't match presentation layout (${layoutWidth.toFixed(1)}" × ${layoutHeight.toFixed(1)}")`
      );
    }
  }
  return errors;
}

function validateTextBoxPosition(slideData, bodyDimensions) {
  const errors = [];
  const slideHeightInches = bodyDimensions.height / PX_PER_IN;
  const minBottomMargin = 0.5; // 0.5 inches from bottom

  for (const el of slideData.elements) {
    // Check text elements (p, h1-h6, list)
    if (['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'list'].includes(el.type)) {
      const fontSize = el.style?.fontSize || 0;
      const bottomEdge = el.position.y + el.position.h;
      const distanceFromBottom = slideHeightInches - bottomEdge;

      if (fontSize > 12 && distanceFromBottom < minBottomMargin) {
        const getText = () => {
          if (typeof el.text === 'string') return el.text;
          if (Array.isArray(el.text)) return el.text.find(t => t.text)?.text || '';
          if (Array.isArray(el.items)) return el.items.find(item => item.text)?.text || '';
          return '';
        };
        const textPrefix = getText().substring(0, 50) + (getText().length > 50 ? '...' : '');

        errors.push(
          `Text box "${textPrefix}" ends too close to bottom edge ` +
          `(${distanceFromBottom.toFixed(2)}" from bottom, minimum ${minBottomMargin}" required)`
        );
      }
    }
  }

  return errors;
}

// Helper: Add background to slide
async function addBackground(slideData, targetSlide, tmpDir) {
  if (slideData.background.type === 'image' && slideData.background.path) {
    let imagePath = slideData.background.path.startsWith('file://')
      ? slideData.background.path.replace('file://', '')
      : slideData.background.path;
    imagePath = decodeURIComponent(imagePath);
    targetSlide.background = { path: imagePath };
  } else if (slideData.background.type === 'color' && slideData.background.value) {
    targetSlide.background = { color: slideData.background.value };
  }
}

// Helper: Add elements to slide
function addElements(slideData, targetSlide, pres) {
  for (const el of slideData.elements) {
    if (el.type === 'image') {
      let imagePath = el.src.startsWith('file://') ? el.src.replace('file://', '') : el.src;
      imagePath = decodeURIComponent(imagePath);

      const slideW = 13.333; // 1280px / 96
      const slideH = 7.5;    // 720px / 96

      // Original dimensions
      let imgX = el.position.x;
      let imgY = el.position.y;
      let imgW = el.position.w;
      let imgH = el.position.h;

      // Safe Check: Ensure dimensions are valid numbers
      if (typeof imgX !== 'number' || isNaN(imgX) ||
        typeof imgY !== 'number' || isNaN(imgY) ||
        typeof imgW !== 'number' || isNaN(imgW) || imgW <= 0 ||
        typeof imgH !== 'number' || isNaN(imgH) || imgH <= 0) {
        // Skip invalid images
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
      if (visibleW <= 0.01 || visibleH <= 0.01) {
        continue;
      }

      // Check for overflows with tolerance
      const isOverflowing = visibleW < (imgW - 0.05) || visibleH < (imgH - 0.05);

      if (isOverflowing) {
        try {
          // Calculate Crop Percentages
          const cropX_abs = visibleX1 - imgX;
          const cropY_abs = visibleY1 - imgY;

          // Protect against division by zero (though imgW > 0 checked above)
          let cropX_pct = (cropX_abs / imgW) * 100;
          let cropY_pct = (cropY_abs / imgH) * 100;
          let cropW_pct = (visibleW / imgW) * 100;
          let cropH_pct = (visibleH / imgH) * 100;

          // Clamp values to valid 0-100 range and ensure no NaNs
          cropX_pct = Math.max(0, Math.min(100, cropX_pct || 0));
          cropY_pct = Math.max(0, Math.min(100, cropY_pct || 0));
          cropW_pct = Math.max(0, Math.min(100, cropW_pct || 100));
          cropH_pct = Math.max(0, Math.min(100, cropH_pct || 100));

          targetSlide.addImage({
            path: imagePath,
            x: visibleX1,
            y: visibleY1,
            w: visibleW,
            h: visibleH,
            sizing: {
              type: 'crop',
              x: cropX_pct,
              y: cropY_pct,
              w: cropW_pct,
              h: cropH_pct
            }
          });
        } catch (err) {
          // Fallback to full image if calculation fails
          targetSlide.addImage({
            path: imagePath,
            x: imgX, y: imgY, w: imgW, h: imgH
          });
        }
      } else {
        // No cropping needed
        targetSlide.addImage({
          path: imagePath,
          x: imgX, y: imgY, w: imgW, h: imgH
        });
      }
    } else if (el.type === 'line') {
      const lineOptions = {
        x: el.x1,
        y: el.y1,
        w: el.x2 - el.x1,
        h: el.y2 - el.y1,
        line: {
          color: el.color,
          width: el.width
        }
      };

      // Apply transparency if available
      if (el.transparency != null && el.transparency > 0) {
        lineOptions.line.transparency = el.transparency;
      }

      targetSlide.addShape(pres.ShapeType.line, lineOptions);
    } else if (el.type === 'shape') {
      // Determine shape type: check if this should be a circle/ellipse
      const useEllipse = el.shape.rectRadius === null; // null signals a perfect circle

      const shapeOptions = {
        x: el.position.x,
        y: el.position.y,
        w: el.position.w,
        h: el.position.h,
        shape: useEllipse ? pres.ShapeType.ellipse :
          (el.shape.rectRadius > 0 ? pres.ShapeType.roundRect : pres.ShapeType.rect)
      };

      if (el.shape.fill) {
        shapeOptions.fill = { color: el.shape.fill };
        if (el.shape.transparency != null) shapeOptions.fill.transparency = el.shape.transparency;
      }
      if (el.shape.line) shapeOptions.line = el.shape.line;
      if (!useEllipse && el.shape.rectRadius > 0) shapeOptions.rectRadius = el.shape.rectRadius;
      if (el.shape.shadow) shapeOptions.shadow = el.shape.shadow;

      targetSlide.addText(el.text || '', shapeOptions);
    } else if (el.type === 'list') {
      const listOptions = {
        x: el.position.x,
        y: el.position.y,
        w: el.position.w,
        h: el.position.h,
        fontSize: el.style.fontSize,
        fontFace: el.style.fontFace,
        color: el.style.color,
        align: el.style.align,
        valign: 'top',
        lineSpacing: el.style.lineSpacing,
        paraSpaceBefore: el.style.paraSpaceBefore,
        paraSpaceAfter: el.style.paraSpaceAfter,
        margin: el.style.margin
      };
      if (el.style.margin) listOptions.margin = el.style.margin;
      targetSlide.addText(el.items, listOptions);
    } else {
      // Check if text is single-line (height suggests one line)
      const lineHeight = el.style.lineSpacing || el.style.fontSize * 1.2;
      const isSingleLine = el.position.h <= lineHeight * 1.5;

      let adjustedX = el.position.x;
      let adjustedW = el.position.w;

      // Make single-line text 2% wider to account for underestimate
      if (isSingleLine) {
        const widthIncrease = el.position.w * 0.02;
        const align = el.style.align;

        if (align === 'center') {
          // Center: expand both sides
          adjustedX = el.position.x - (widthIncrease / 2);
          adjustedW = el.position.w + widthIncrease;
        } else if (align === 'right') {
          // Right: expand to the left
          adjustedX = el.position.x - widthIncrease;
          adjustedW = el.position.w + widthIncrease;
        } else {
          // Left (default): expand to the right
          adjustedW = el.position.w + widthIncrease;
        }
      }

      const textOptions = {
        x: adjustedX,
        y: el.position.y,
        w: adjustedW,
        h: el.position.h,
        fontSize: el.style.fontSize,
        fontFace: el.style.fontFace,
        color: el.style.color,
        bold: el.style.bold,
        italic: el.style.italic,
        underline: el.style.underline,
        valign: 'top',
        lineSpacing: el.style.lineSpacing,
        paraSpaceBefore: el.style.paraSpaceBefore,
        paraSpaceAfter: el.style.paraSpaceAfter,
        inset: 0  // Remove default PowerPoint internal padding
      };

      if (el.style.align) textOptions.align = el.style.align;
      if (el.style.margin) textOptions.margin = el.style.margin;
      if (el.style.rotate !== undefined) textOptions.rotate = el.style.rotate;
      if (el.style.transparency !== null && el.style.transparency !== undefined) textOptions.transparency = el.style.transparency;

      targetSlide.addText(el.text, textOptions);
    }
  }
}

// Helper: Extract slide data from HTML page
async function extractSlideData(page) {
  // Disable all CSS animations and transitions to prevent duplicate elements
  // This ensures we capture only the final static state
  await page.addStyleTag({
    content: `
      * {
        animation: none !important;
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        animation-iteration-count: 0 !important;
        transition: none !important;
        transition-duration: 0s !important;
      }
      body {
        margin: 0 !important;
        padding: 0 !important;
      }
      *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
    `
  });

  // Wait for animations to fully stop and page to stabilize
  await page.waitForTimeout(100);

  return await page.evaluate(() => {
    const PT_PER_PX = 0.75;
    const PX_PER_IN = 96;

    // Fonts that are single-weight and should not have bold applied
    // (applying bold causes PowerPoint to use faux bold which makes text wider)
    const SINGLE_WEIGHT_FONTS = ['impact'];

    // Helper: Check if a font should skip bold formatting
    const shouldSkipBold = (fontFamily) => {
      if (!fontFamily) return false;
      const normalizedFont = fontFamily.toLowerCase().replace(/['"]/g, '').split(',')[0].trim();
      return SINGLE_WEIGHT_FONTS.includes(normalizedFont);
    };

    // Unit conversion helpers
    const pxToInch = (px) => px / PX_PER_IN;
    const pxToPoints = (pxStr) => parseFloat(pxStr) * PT_PER_PX;
    const rgbToHex = (rgbStr) => {
      // Handle transparent backgrounds by defaulting to white
      if (rgbStr === 'rgba(0, 0, 0, 0)' || rgbStr === 'transparent') return 'FFFFFF';

      const match = rgbStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!match) return 'FFFFFF';
      return match.slice(1).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
    };

    const extractAlpha = (rgbStr) => {
      const match = rgbStr.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
      if (!match || !match[4]) return null;
      const alpha = parseFloat(match[4]);
      return Math.round((1 - alpha) * 100);
    };

    const applyTextTransform = (text, textTransform) => {
      if (textTransform === 'uppercase') return text.toUpperCase();
      if (textTransform === 'lowercase') return text.toLowerCase();
      if (textTransform === 'capitalize') {
        return text.replace(/\b\w/g, c => c.toUpperCase());
      }
      return text;
    };

    // Extract rotation angle from CSS transform and writing-mode
    const getRotation = (transform, writingMode) => {
      let angle = 0;

      // Handle writing-mode first
      // PowerPoint: 90° = text rotated 90° clockwise (reads top to bottom, letters upright)
      // PowerPoint: 270° = text rotated 270° clockwise (reads bottom to top, letters upright)
      if (writingMode === 'vertical-rl') {
        // vertical-rl alone = text reads top to bottom = 90° in PowerPoint
        angle = 90;
      } else if (writingMode === 'vertical-lr') {
        // vertical-lr alone = text reads bottom to top = 270° in PowerPoint
        angle = 270;
      }

      // Then add any transform rotation
      if (transform && transform !== 'none') {
        // Try to match rotate() function
        const rotateMatch = transform.match(/rotate\((-?\d+(?:\.\d+)?)deg\)/);
        if (rotateMatch) {
          angle += parseFloat(rotateMatch[1]);
        } else {
          // Browser may compute as matrix - extract rotation from matrix
          const matrixMatch = transform.match(/matrix\(([^)]+)\)/);
          if (matrixMatch) {
            const values = matrixMatch[1].split(',').map(parseFloat);
            // matrix(a, b, c, d, e, f) where rotation = atan2(b, a)
            const matrixAngle = Math.atan2(values[1], values[0]) * (180 / Math.PI);
            angle += Math.round(matrixAngle);
          }
        }
      }

      // Normalize to 0-359 range
      angle = angle % 360;
      if (angle < 0) angle += 360;

      return angle === 0 ? null : angle;
    };

    // Get position/dimensions accounting for rotation
    const getPositionAndSize = (el, rect, rotation) => {
      if (rotation === null) {
        return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
      }

      // For 90° or 270° rotations, swap width and height
      // because PowerPoint applies rotation to the original (unrotated) box
      const isVertical = rotation === 90 || rotation === 270;

      if (isVertical) {
        // The browser shows us the rotated dimensions (tall box for vertical text)
        // But PowerPoint needs the pre-rotation dimensions (wide box that will be rotated)
        // So we swap: browser's height becomes PPT's width, browser's width becomes PPT's height
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        return {
          x: centerX - rect.height / 2,
          y: centerY - rect.width / 2,
          w: rect.height,
          h: rect.width
        };
      }

      // For other rotations, use element's offset dimensions
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      return {
        x: centerX - el.offsetWidth / 2,
        y: centerY - el.offsetHeight / 2,
        w: el.offsetWidth,
        h: el.offsetHeight
      };
    };

    // Parse CSS box-shadow into PptxGenJS shadow properties
    const parseBoxShadow = (boxShadow) => {
      if (!boxShadow || boxShadow === 'none') return null;

      // Browser computed style format: "rgba(0, 0, 0, 0.3) 2px 2px 8px 0px [inset]"
      // CSS format: "[inset] 2px 2px 8px 0px rgba(0, 0, 0, 0.3)"

      const insetMatch = boxShadow.match(/inset/);

      // IMPORTANT: PptxGenJS/PowerPoint doesn't properly support inset shadows
      // Only process outer shadows to avoid file corruption
      if (insetMatch) return null;

      // Extract color first (rgba or rgb at start)
      const colorMatch = boxShadow.match(/rgba?\([^)]+\)/);

      // Extract numeric values (handles both px and pt units)
      const parts = boxShadow.match(/([-\d.]+)(px|pt)/g);

      if (!parts || parts.length < 2) return null;

      const offsetX = parseFloat(parts[0]);
      const offsetY = parseFloat(parts[1]);
      const blur = parts.length > 2 ? parseFloat(parts[2]) : 0;

      // Calculate angle from offsets (in degrees, 0 = right, 90 = down)
      let angle = 0;
      if (offsetX !== 0 || offsetY !== 0) {
        angle = Math.atan2(offsetY, offsetX) * (180 / Math.PI);
        if (angle < 0) angle += 360;
      }

      // Calculate offset distance (hypotenuse)
      const offset = Math.sqrt(offsetX * offsetX + offsetY * offsetY) * PT_PER_PX;

      // Extract opacity from rgba
      let opacity = 0.5;
      if (colorMatch) {
        const opacityMatch = colorMatch[0].match(/[\d.]+\)$/);
        if (opacityMatch) {
          opacity = parseFloat(opacityMatch[0].replace(')', ''));
        }
      }

      return {
        type: 'outer',
        angle: Math.round(angle),
        blur: blur * 0.75, // Convert to points
        color: colorMatch ? rgbToHex(colorMatch[0]) : '000000',
        offset: offset,
        opacity
      };
    };

    // Parse inline formatting tags (<b>, <i>, <u>, <strong>, <em>, <span>) into text runs
    const parseInlineFormatting = (element, baseOptions = {}, runs = [], baseTextTransform = (x) => x) => {
      let prevNodeIsText = false;

      element.childNodes.forEach((node) => {
        let textTransform = baseTextTransform;

        const isText = node.nodeType === Node.TEXT_NODE || node.tagName === 'BR';
        if (isText) {
          const text = node.tagName === 'BR' ? '\n' : textTransform(node.textContent.replace(/\s+/g, ' '));
          const prevRun = runs[runs.length - 1];
          if (prevNodeIsText && prevRun) {
            prevRun.text += text;
          } else {
            runs.push({ text, options: { ...baseOptions } });
          }

        } else if (node.nodeType === Node.ELEMENT_NODE && node.textContent.trim()) {
          const options = { ...baseOptions };
          const computed = window.getComputedStyle(node);

          // Handle inline elements with computed styles
          if (node.tagName === 'SPAN' || node.tagName === 'B' || node.tagName === 'STRONG' || node.tagName === 'I' || node.tagName === 'EM' || node.tagName === 'U') {
            const isBold = computed.fontWeight === 'bold' || parseInt(computed.fontWeight) >= 600;
            if (isBold && !shouldSkipBold(computed.fontFamily)) options.bold = true;
            if (computed.fontStyle === 'italic') options.italic = true;
            if (computed.textDecoration && computed.textDecoration.includes('underline')) options.underline = true;
            if (computed.color && computed.color !== 'rgb(0, 0, 0)') {
              options.color = rgbToHex(computed.color);
              const transparency = extractAlpha(computed.color);
              if (transparency !== null) options.transparency = transparency;
            }
            if (computed.fontSize) options.fontSize = pxToPoints(computed.fontSize);

            // Apply text-transform on the span element itself
            if (computed.textTransform && computed.textTransform !== 'none') {
              const transformStr = computed.textTransform;
              textTransform = (text) => applyTextTransform(text, transformStr);
            }

            // Validate: Check for margins on inline elements
            if (computed.marginLeft && parseFloat(computed.marginLeft) > 0) {
              errors.push(`Inline element <${node.tagName.toLowerCase()}> has margin-left which is not supported in PowerPoint. Remove margin from inline elements.`);
            }
            if (computed.marginRight && parseFloat(computed.marginRight) > 0) {
              errors.push(`Inline element <${node.tagName.toLowerCase()}> has margin-right which is not supported in PowerPoint. Remove margin from inline elements.`);
            }
            if (computed.marginTop && parseFloat(computed.marginTop) > 0) {
              errors.push(`Inline element <${node.tagName.toLowerCase()}> has margin-top which is not supported in PowerPoint. Remove margin from inline elements.`);
            }
            if (computed.marginBottom && parseFloat(computed.marginBottom) > 0) {
              errors.push(`Inline element <${node.tagName.toLowerCase()}> has margin-bottom which is not supported in PowerPoint. Remove margin from inline elements.`);
            }

            // Recursively process the child node. This will flatten nested spans into multiple runs.
            parseInlineFormatting(node, options, runs, textTransform);
          }
        }

        prevNodeIsText = isText;
      });

      // Trim leading space from first run and trailing space from last run
      if (runs.length > 0) {
        runs[0].text = runs[0].text.replace(/^\s+/, '');
        runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '');
      }

      return runs.filter(r => r.text.length > 0);
    };

    // Extract background from body (image or color)
    // FIX: Prioritize '.ppt-master-layout' or similar container as the true slide background
    // (Body often has a grey wrapper background which we don't want in PPT)
    const masterLayout = document.querySelector('.ppt-master-layout') || document.querySelector('[class*="master"]') || document.body;
    const bgNode = masterLayout;

    // If master layout has no explicit background (transparent), fall back to body
    let bodyStyle = window.getComputedStyle(bgNode);
    if (bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)' && bgNode !== document.body) {
      bodyStyle = window.getComputedStyle(document.body);
    }

    const bgImage = bodyStyle.backgroundImage;
    const bgColor = bodyStyle.backgroundColor;

    // Collect validation errors
    const errors = [];

    // Validate: Check for CSS gradients
    if (bgImage && (bgImage.includes('linear-gradient') || bgImage.includes('radial-gradient'))) {
      errors.push(
        'CSS gradients are not supported. Use Sharp to rasterize gradients as PNG images first, ' +
        'then reference with background-image: url(\'gradient.png\')'
      );
    }

    let background;
    if (bgImage && bgImage !== 'none') {
      // Extract URL from url("...") or url(...)
      const urlMatch = bgImage.match(/url\(["']?([^"')]+)["']?\)/);
      if (urlMatch) {
        background = {
          type: 'image',
          path: urlMatch[1]
        };
      } else {
        background = {
          type: 'color',
          value: rgbToHex(bgColor)
        };
      }
    } else {
      background = {
        type: 'color',
        value: rgbToHex(bgColor)
      };
    }

    // Process all elements
    const elements = [];
    const placeholders = [];
    const textTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SPAN', 'UL', 'OL', 'LI'];
    const processed = new Set();
    let backgroundOverride = null;  // FIX: Declare variable to avoid ReferenceError

    document.querySelectorAll('*').forEach((el) => {
      if (processed.has(el)) return;

      const computed = window.getComputedStyle(el);

      // Validate text elements don't have backgrounds, borders, or shadows
      if (textTags.includes(el.tagName)) {
        const hasBg = computed.backgroundColor && computed.backgroundColor !== 'rgba(0, 0, 0, 0)';
        const hasBorder = (computed.borderWidth && parseFloat(computed.borderWidth) > 0) ||
          (computed.borderTopWidth && parseFloat(computed.borderTopWidth) > 0) ||
          (computed.borderRightWidth && parseFloat(computed.borderRightWidth) > 0) ||
          (computed.borderBottomWidth && parseFloat(computed.borderBottomWidth) > 0) ||
          (computed.borderLeftWidth && parseFloat(computed.borderLeftWidth) > 0);
        const hasShadow = computed.boxShadow && computed.boxShadow !== 'none';

        if (hasBg || hasBorder || hasShadow) {
          errors.push(
            `Text element <${el.tagName.toLowerCase()}> has ${hasBg ? 'background' : hasBorder ? 'border' : 'shadow'}. ` +
            'Backgrounds, borders, and shadows are only supported on <div> elements, not text elements.'
          );
          return;
        }
      }

      // --- 1. Handle Auto-Baked Elements (Treat as Image) ---
      // These are complex elements (gradients, glass) that were baked into screenshots.
      if (el.dataset.bakedSrc && el.tagName !== 'BODY') {
        console.log(`[Extract-DEBUG] Found baked element: ${el.tagName} src=${el.dataset.bakedSrc}`);
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const rotation = getRotation(computed.transform, computed.writingMode);
          const { x, y, w, h } = getPositionAndSize(el, rect, rotation);

          elements.push({
            type: 'image',
            src: el.dataset.bakedSrc,
            position: { x: pxToInch(x), y: pxToInch(y), w: pxToInch(w), h: pxToInch(h) },
            style: {
              rotate: rotation,
              rectRadius: 0,
              shadow: parseBoxShadow(computed.boxShadow) // Apply native shadow to image
            }
          });

          // Mark this element as processed, but DO NOT process its children as images/shapes
          // (their text/content will be processed separately if they were hidden during baking)
          processed.add(el);
          return;
        }
      }

      // Extract placeholder elements (for charts, etc.)
      if (el.classList && el.classList.contains('placeholder')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          errors.push(
            `Placeholder "${el.id || 'unnamed'}" has ${rect.width === 0 ? 'width: 0' : 'height: 0'}. Check the layout CSS.`
          );
        } else {
          placeholders.push({
            id: el.id || `placeholder-${placeholders.length}`,
            x: pxToInch(rect.left),
            y: pxToInch(rect.top),
            w: pxToInch(rect.width),
            h: pxToInch(rect.height)
          });
        }
        processed.add(el);
        return;
      }

      // Extract images
      if (el.tagName === 'IMG') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {

          // Check if this image is effectively the Full Screen Background
          // We rely on autoBake tagging it, OR fallback to dimension check for non-baked full images
          const isMarkerSet = el.dataset.pptxBackground === 'true';
          const isFullScreenDim = Math.abs(rect.width - parseFloat(bodyStyle.width)) < 2 &&
            Math.abs(rect.height - parseFloat(bodyStyle.height)) < 2;

          if (isMarkerSet || isFullScreenDim) {
            // It's a full-screen background (likely our injected baked background)
            let imgSrc = el.src;
            if (imgSrc.startsWith('file://')) {
              imgSrc = imgSrc.replace('file://', '');
            }
            imgSrc = decodeURIComponent(imgSrc);

            backgroundOverride = {
              type: 'image',
              path: imgSrc
            };
          } else {
            // Regular Image
            elements.push({
              type: 'image',
              src: el.src,
              position: {
                x: pxToInch(rect.left),
                y: pxToInch(rect.top),
                w: pxToInch(rect.width),
                h: pxToInch(rect.height)
              }
            });
          }

          processed.add(el);
          return;
        }
      }

      // Extract DIVs with backgrounds/borders as shapes
      const isContainer = el.tagName === 'DIV' && !textTags.includes(el.tagName);
      if (isContainer) {
        const hasBg = computed.backgroundColor && computed.backgroundColor !== 'rgba(0, 0, 0, 0)';

        // Validate: Check for unwrapped text content in DIV
        for (const node of el.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.trim();
            if (text) {
              errors.push(
                `DIV element contains unwrapped text "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}". ` +
                'All text must be wrapped in <p>, <h1>-<h6>, <ul>, or <ol> tags to appear in PowerPoint.'
              );
            }
          }
        }

        // Check for background images on shapes
        const bgImage = computed.backgroundImage;
        if (bgImage && bgImage !== 'none') {
          errors.push(
            'Background images on DIV elements are not supported. ' +
            'Use solid colors or borders for shapes, or use slide.addImage() in PptxGenJS to layer images.'
          );
          return;
        }

        // Check for borders - both uniform and partial
        const borderTop = computed.borderTopWidth;
        const borderRight = computed.borderRightWidth;
        const borderBottom = computed.borderBottomWidth;
        const borderLeft = computed.borderLeftWidth;
        const borders = [borderTop, borderRight, borderBottom, borderLeft].map(b => parseFloat(b) || 0);
        const hasBorder = borders.some(b => b > 0);
        const hasUniformBorder = hasBorder && borders.every(b => b === borders[0]);
        const borderLines = [];

        if (hasBorder && !hasUniformBorder) {
          const rect = el.getBoundingClientRect();
          const x = pxToInch(rect.left);
          const y = pxToInch(rect.top);
          const w = pxToInch(rect.width);
          const h = pxToInch(rect.height);

          // Collect lines to add after shape (inset by half the line width to center on edge)
          if (parseFloat(borderTop) > 0) {
            const widthPt = pxToPoints(borderTop);
            const inset = (widthPt / 72) / 2; // Convert points to inches, then half

            // Extract transparency from border color alpha and element opacity
            const borderAlpha = extractAlpha(computed.borderTopColor);
            const elemOpacity = parseFloat(computed.opacity);
            let transparency = null;
            if (borderAlpha !== null && elemOpacity < 1) {
              const finalAlpha = (1 - borderAlpha / 100) * elemOpacity;
              transparency = Math.round((1 - finalAlpha) * 100);
            } else if (borderAlpha !== null) {
              transparency = borderAlpha;
            } else if (elemOpacity < 1) {
              transparency = Math.round((1 - elemOpacity) * 100);
            }

            borderLines.push({
              type: 'line',
              x1: x, y1: y + inset, x2: x + w, y2: y + inset,
              width: widthPt,
              color: rgbToHex(computed.borderTopColor),
              transparency: transparency
            });
          }
          if (parseFloat(borderRight) > 0) {
            const widthPt = pxToPoints(borderRight);
            const inset = (widthPt / 72) / 2;

            const borderAlpha = extractAlpha(computed.borderRightColor);
            const elemOpacity = parseFloat(computed.opacity);
            let transparency = null;
            if (borderAlpha !== null && elemOpacity < 1) {
              const finalAlpha = (1 - borderAlpha / 100) * elemOpacity;
              transparency = Math.round((1 - finalAlpha) * 100);
            } else if (borderAlpha !== null) {
              transparency = borderAlpha;
            } else if (elemOpacity < 1) {
              transparency = Math.round((1 - elemOpacity) * 100);
            }

            borderLines.push({
              type: 'line',
              x1: x + w - inset, y1: y, x2: x + w - inset, y2: y + h,
              width: widthPt,
              color: rgbToHex(computed.borderRightColor),
              transparency: transparency
            });
          }
          if (parseFloat(borderBottom) > 0) {
            const widthPt = pxToPoints(borderBottom);
            const inset = (widthPt / 72) / 2;

            const borderAlpha = extractAlpha(computed.borderBottomColor);
            const elemOpacity = parseFloat(computed.opacity);
            let transparency = null;
            if (borderAlpha !== null && elemOpacity < 1) {
              const finalAlpha = (1 - borderAlpha / 100) * elemOpacity;
              transparency = Math.round((1 - finalAlpha) * 100);
            } else if (borderAlpha !== null) {
              transparency = borderAlpha;
            } else if (elemOpacity < 1) {
              transparency = Math.round((1 - elemOpacity) * 100);
            }

            borderLines.push({
              type: 'line',
              x1: x, y1: y + h - inset, x2: x + w, y2: y + h - inset,
              width: widthPt,
              color: rgbToHex(computed.borderBottomColor),
              transparency: transparency
            });
          }
          if (parseFloat(borderLeft) > 0) {
            const widthPt = pxToPoints(borderLeft);
            const inset = (widthPt / 72) / 2;

            const borderAlpha = extractAlpha(computed.borderLeftColor);
            const elemOpacity = parseFloat(computed.opacity);
            let transparency = null;
            if (borderAlpha !== null && elemOpacity < 1) {
              const finalAlpha = (1 - borderAlpha / 100) * elemOpacity;
              transparency = Math.round((1 - finalAlpha) * 100);
            } else if (borderAlpha !== null) {
              transparency = borderAlpha;
            } else if (elemOpacity < 1) {
              transparency = Math.round((1 - elemOpacity) * 100);
            }

            borderLines.push({
              type: 'line',
              x1: x + inset, y1: y, x2: x + inset, y2: y + h,
              width: widthPt,
              color: rgbToHex(computed.borderLeftColor),
              transparency: transparency
            });
          }
        }

        if (hasBg || hasBorder) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {

            // Check for Full Screen Background Shape (Solid Color Div)
            // This prevents "Double Background" where Body is baked but a wrapper Div adds a solid layer on top.
            const isFullScreenShape = Math.abs(rect.width - parseFloat(bodyStyle.width)) < 2 &&
              Math.abs(rect.height - parseFloat(bodyStyle.height)) < 2;

            if (isFullScreenShape) {
              // Scenario A: We already have a complex Background Image (e.g. Baked Body Gradient)
              // In this case, this solid color shape is likely just a wrapper/fallback. We should DROP it to let the gradient show.
              const hasExistingImageBg = background && background.type === 'image';
              const hasOverrideImage = backgroundOverride && backgroundOverride.type === 'image';

              if (hasExistingImageBg || hasOverrideImage) {
                processed.add(el);
                return; // SKIP adding this shape. Use the underlying image background.
              }

              // Scenario B: No complex background yet. 
              // Promote this shape's background color to satisfy the Master Background
              if (hasBg) {
                backgroundOverride = {
                  type: 'color',
                  value: rgbToHex(computed.backgroundColor)
                };
                processed.add(el);
                return; // SKIP adding this element. It is now the Master Background.
              }
            }

            const shadow = parseBoxShadow(computed.boxShadow);

            // Only add shape if there's background or uniform border
            if (hasBg || hasUniformBorder) {
              // Calculate border radius
              const radius = computed.borderRadius;
              const radiusValue = parseFloat(radius);
              let rectRadius = 0;

              if (radiusValue > 0) {
                if (radius.includes('%')) {
                  // Check if this is a circle (50%+ radius on square element)
                  if (radiusValue >= 50) {
                    const isSquare = Math.abs(rect.width - rect.height) < 2; // Allow 2px tolerance
                    if (isSquare) {
                      // Will be handled separately by using ellipse shape
                      rectRadius = null; // Signal to use ellipse
                    } else {
                      rectRadius = 1; // Regular rounded corners
                    }
                  } else {
                    // Calculate percentage of smaller dimension
                    const minDim = Math.min(rect.width, rect.height);
                    rectRadius = (radiusValue / 100) * pxToInch(minDim);
                  }
                } else if (radius.includes('pt')) {
                  rectRadius = radiusValue / 72;
                } else {
                  rectRadius = radiusValue / PX_PER_IN;
                }
              }

              // For rounded rectangles with uniform border, use double-rectangle approach
              // This ensures the border follows the rounded corners correctly
              const hasBorderAndRadius = hasUniformBorder && rectRadius > 0 && rectRadius !== null;

              if (hasBorderAndRadius) {
                // Double-rectangle approach for rounded borders
                const borderWidthPx = parseFloat(computed.borderWidth);
                const borderWidthIn = pxToInch(borderWidthPx);
                const borderColor = rgbToHex(computed.borderColor);

                // Layer 1 (bottom): Larger rectangle filled with border color
                elements.push({
                  type: 'shape',
                  text: '',
                  position: {
                    x: pxToInch(rect.left),
                    y: pxToInch(rect.top),
                    w: pxToInch(rect.width),
                    h: pxToInch(rect.height)
                  },
                  shape: {
                    fill: borderColor,
                    transparency: null,
                    line: null,
                    rectRadius: rectRadius,
                    shadow: shadow
                  }
                });

                // Layer 2 (top): Smaller rectangle filled with background color
                // Inset by border width on all sides
                const innerRectRadius = Math.max(0, rectRadius - borderWidthIn);
                elements.push({
                  type: 'shape',
                  text: '',
                  position: {
                    x: pxToInch(rect.left) + borderWidthIn,
                    y: pxToInch(rect.top) + borderWidthIn,
                    w: pxToInch(rect.width) - 2 * borderWidthIn,
                    h: pxToInch(rect.height) - 2 * borderWidthIn
                  },
                  shape: {
                    fill: hasBg ? rgbToHex(computed.backgroundColor) : 'FFFFFF',
                    transparency: (() => {
                      // Combine rgba alpha and CSS opacity
                      const rgbaAlpha = hasBg ? extractAlpha(computed.backgroundColor) : null;
                      const cssOpacity = parseFloat(computed.opacity);

                      if (rgbaAlpha !== null && cssOpacity < 1) {
                        // Both present: combine them
                        const rgbaTransparency = rgbaAlpha / 100; // Convert to 0-1
                        const finalAlpha = (1 - rgbaTransparency) * cssOpacity;
                        return Math.round((1 - finalAlpha) * 100);
                      }
                      if (rgbaAlpha !== null) return rgbaAlpha;
                      if (cssOpacity < 1) return Math.round((1 - cssOpacity) * 100);
                      return null;
                    })(),
                    line: null,
                    rectRadius: innerRectRadius,
                    shadow: null // Only outer shape has shadow
                  }
                });
              } else {
                // Original single-shape approach for non-rounded or no-border cases
                elements.push({
                  type: 'shape',
                  text: '',  // Shape only - child text elements render on top
                  position: {
                    x: pxToInch(rect.left),
                    y: pxToInch(rect.top),
                    w: pxToInch(rect.width),
                    h: pxToInch(rect.height)
                  },
                  shape: {
                    fill: hasBg ? rgbToHex(computed.backgroundColor) : null,
                    transparency: (() => {
                      // Combine rgba alpha and CSS opacity
                      const rgbaAlpha = hasBg ? extractAlpha(computed.backgroundColor) : null;
                      const cssOpacity = parseFloat(computed.opacity);

                      if (rgbaAlpha !== null && cssOpacity < 1) {
                        // Both present: combine them
                        const rgbaTransparency = rgbaAlpha / 100; // Convert to 0-1
                        const finalAlpha = (1 - rgbaTransparency) * cssOpacity;
                        return Math.round((1 - finalAlpha) * 100);
                      }
                      if (rgbaAlpha !== null) return rgbaAlpha;
                      if (cssOpacity < 1) return Math.round((1 - cssOpacity) * 100);
                      return null;
                    })(),
                    line: hasUniformBorder ? {
                      color: rgbToHex(computed.borderColor),
                      width: pxToPoints(computed.borderWidth)
                    } : null,
                    rectRadius: rectRadius,
                    shadow: shadow
                  }
                });
              }

              // Add partial border lines
              elements.push(...borderLines);

              processed.add(el);
              return;
            }
          }
        }
      }

      // Extract bullet lists as single text block
      if (el.tagName === 'UL' || el.tagName === 'OL') {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const liElements = Array.from(el.querySelectorAll('li'));
        const items = [];
        const ulComputed = window.getComputedStyle(el);
        const ulPaddingLeftPt = pxToPoints(ulComputed.paddingLeft);

        // Split: margin-left for bullet position, indent for text position
        // margin-left + indent = ul padding-left
        const marginLeft = ulPaddingLeftPt * 0.5;
        const textIndent = ulPaddingLeftPt * 0.5;

        liElements.forEach((li, idx) => {
          const isLast = idx === liElements.length - 1;
          const runs = parseInlineFormatting(li, { breakLine: false });
          // Clean manual bullets from first run
          if (runs.length > 0) {
            runs[0].text = runs[0].text.replace(/^[•\-\*▪▸]\s*/, '');
            runs[0].options.bullet = { indent: textIndent };
          }
          // Set breakLine on last run
          if (runs.length > 0 && !isLast) {
            runs[runs.length - 1].options.breakLine = true;
          }
          items.push(...runs);
        });

        const listItemComputed = window.getComputedStyle(liElements[0] || el);

        elements.push({
          type: 'list',
          items: items,
          position: {
            x: pxToInch(rect.left),
            y: pxToInch(rect.top),
            w: pxToInch(rect.width),
            h: pxToInch(rect.height)
          },
          style: {
            fontSize: pxToPoints(listItemComputed.fontSize),
            fontFace: listItemComputed.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
            color: rgbToHex(listItemComputed.color),
            transparency: extractAlpha(listItemComputed.color),
            align: listItemComputed.textAlign === 'start' ? 'left' : listItemComputed.textAlign,
            lineSpacing: listItemComputed.lineHeight && listItemComputed.lineHeight !== 'normal' ? pxToPoints(listItemComputed.lineHeight) : null,
            paraSpaceBefore: 0,
            paraSpaceAfter: pxToPoints(listItemComputed.marginBottom),
            // PptxGenJS margin array is [left, right, bottom, top]
            margin: [marginLeft, 0, 0, 0]
          }
        });

        liElements.forEach(li => processed.add(li));
        processed.add(el);
        return;
      }

      // Extract text elements (P, H1, H2, etc.)
      if (!textTags.includes(el.tagName)) return;

      const rect = el.getBoundingClientRect();
      const text = el.textContent.trim();
      if (rect.width === 0 || rect.height === 0 || !text) return;

      // Validate: Check for manual bullet symbols in text elements (not in lists)
      if (el.tagName !== 'LI' && /^[•\-\*▪▸○●◆◇■□]\s/.test(text.trimStart())) {
        errors.push(
          `Text element <${el.tagName.toLowerCase()}> starts with bullet symbol "${text.substring(0, 20)}...". ` +
          'Use <ul> or <ol> lists instead of manual bullet symbols.'
        );
        return;
      }

      const rotation = getRotation(computed.transform, computed.writingMode);
      let { x, y, w, h } = getPositionAndSize(el, rect, rotation);

      // Add safety buffer to width to prevent unexpected wrapping in PPT
      // (PowerPoint rendering often requires slightly more width than browser)
      w += 0.15;

      const baseStyle = {
        fontSize: pxToPoints(computed.fontSize),
        fontFace: computed.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
        color: rgbToHex(computed.color),
        color: rgbToHex(computed.color),
        align: (() => {
          // Smart Alignment: If explicit alignment is set, use it.
          if (computed.textAlign !== 'start' && computed.textAlign !== 'left') {
            return computed.textAlign;
          }

          // Heuristic: Check Flexbox parent (and grandparent) for inferred alignment
          const checkFlexAlign = (node) => {
            const parent = node.parentElement;
            if (!parent) return null;

            const parentComputed = window.getComputedStyle(parent);

            // 1. Flexbox Alignment
            if (parentComputed.display === 'flex') {
              const justify = parentComputed.justifyContent;
              if (justify === 'flex-end' || justify === 'right') return 'right';
              if (justify === 'center') return 'center';
              if (justify === 'space-between' && parent.childElementCount === 2) {
                if (node === parent.lastElementChild) return 'right';
              }
            }

            // 2. Button/Badge Heuristic (Center text in pill/rounded containers)
            // If parent has background & border-radius, it's likely a button/badge.
            const hasBg = parentComputed.backgroundColor !== 'rgba(0, 0, 0, 0)' && parentComputed.backgroundColor !== 'transparent';
            const radius = parseFloat(parentComputed.borderRadius);
            if (hasBg && radius > 0) {
              // Verify it's not a huge container (like a card)
              const parentRect = parent.getBoundingClientRect();
              if (parentRect.width < 300 && parentRect.height < 100) {
                return 'center';
              }
            }

            return null;
          };

          // Check direct parent
          let inferred = checkFlexAlign(el);
          if (inferred) return inferred;

          // Check grandparent (wrapper div scenario)
          if (el.parentElement) {
            inferred = checkFlexAlign(el.parentElement);
            if (inferred) return inferred;
          }

          return 'left'; // Default

          return 'left'; // Default
        })(),
        lineSpacing: pxToPoints(computed.lineHeight),
        paraSpaceBefore: pxToPoints(computed.marginTop),
        paraSpaceAfter: pxToPoints(computed.marginBottom),
        // PptxGenJS margin array is [left, right, bottom, top] (not [top, right, bottom, left] as documented)
        margin: [
          pxToPoints(computed.paddingLeft),
          pxToPoints(computed.paddingRight),
          pxToPoints(computed.paddingBottom),
          pxToPoints(computed.paddingTop)
        ]
      };

      // Mark all children as processed to prevent duplication (e.g. spans inside p)
      el.querySelectorAll('*').forEach(child => processed.add(child));

      // Calculate transparency combining Color Alpha and Element Opacity
      const colorTransparency = extractAlpha(computed.color); // 0-100 (0=Opaque) or null
      const elementOpacity = parseFloat(computed.opacity); // 0-1 (1=Opaque)

      let finalTransparency = null;

      if (!isNaN(elementOpacity) && elementOpacity < 1) {
        // We have element opacity
        let alphaFromColor = 1.0;
        if (colorTransparency !== null) {
          alphaFromColor = 1.0 - (colorTransparency / 100.0);
        }

        const combinedAlpha = elementOpacity * alphaFromColor;
        finalTransparency = Math.round((1.0 - combinedAlpha) * 100);
      } else {
        // Use color transparency directly if no element opacity
        finalTransparency = colorTransparency;
      }

      if (finalTransparency !== null) baseStyle.transparency = finalTransparency;

      if (rotation !== null) baseStyle.rotate = rotation;

      const hasFormatting = el.querySelector('b, i, u, strong, em, span, br');

      if (hasFormatting) {
        // Text with inline formatting
        const transformStr = computed.textTransform;
        const runs = parseInlineFormatting(el, {}, [], (str) => applyTextTransform(str, transformStr));

        // Adjust lineSpacing based on largest fontSize in runs
        const adjustedStyle = { ...baseStyle };
        if (adjustedStyle.lineSpacing) {
          const maxFontSize = Math.max(
            adjustedStyle.fontSize,
            ...runs.map(r => r.options?.fontSize || 0)
          );
          if (maxFontSize > adjustedStyle.fontSize) {
            const lineHeightMultiplier = adjustedStyle.lineSpacing / adjustedStyle.fontSize;
            adjustedStyle.lineSpacing = maxFontSize * lineHeightMultiplier;
          }
        }

        elements.push({
          type: el.tagName.toLowerCase(),
          text: runs,
          position: { x: pxToInch(x), y: pxToInch(y), w: pxToInch(w), h: pxToInch(h) },
          style: adjustedStyle
        });
      } else {
        // Plain text - inherit CSS formatting
        const textTransform = computed.textTransform;
        const transformedText = applyTextTransform(text, textTransform);

        const isBold = computed.fontWeight === 'bold' || parseInt(computed.fontWeight) >= 600;

        elements.push({
          type: el.tagName.toLowerCase(),
          text: transformedText,
          position: { x: pxToInch(x), y: pxToInch(y), w: pxToInch(w), h: pxToInch(h) },
          style: {
            ...baseStyle,
            bold: isBold && !shouldSkipBold(computed.fontFamily),
            italic: computed.fontStyle === 'italic',
            underline: computed.textDecoration.includes('underline')
          }
        });
      }

      processed.add(el);
    });

    return { background: backgroundOverride || background, elements, placeholders, errors };
  });
}

// Helper: Auto-Bake complex elements
async function autoBake(page, outputDir) {
  // 1. Identify candidates
  const candidates = await page.evaluate(() => {
    const findings = [];
    document.querySelectorAll('*').forEach((el, index) => {
      // Skip already processed or irrelevant
      if (el.tagName === 'HTML') return;
      // if (el.tagName === 'BODY') return; // Allow BODY baking
      if (el.dataset.bakeId) return;

      const style = window.getComputedStyle(el);
      const triggers = [];

      // Trigger 1: Gradients & Patterns
      const bgImage = style.backgroundImage;
      if (bgImage.includes('gradient')) {
        // Check for Dot Pattern (radial-gradient with small background-size)
        // Example: radial-gradient(rgb(139, 69, 19) 0.5px, transparent 0.5px)
        const bgSize = style.backgroundSize;
        const isPattern = bgSize && bgSize !== 'auto' && bgSize !== 'cover' && bgSize !== 'contain' && !bgSize.includes('%');

        if (isPattern && bgImage.includes('radial-gradient')) {
          el.dataset.bakeType = 'svg-pattern';
          triggers.push('pattern');
        } else {
          // Fallback to raster bake for complex gradients
          if (el.tagName === 'BODY') {
            el.dataset.bakeId = 'bake-body';
            findings.push('bake-body');
          } else {
            triggers.push('gradient');
          }
        }
      }

      // Trigger 2: Backdrop Filter (Glass) - REVERTED (User Request)
      // if (style.backdropFilter && style.backdropFilter !== 'none') triggers.push('glass');
      // if (style.webkitBackdropFilter && style.webkitBackdropFilter !== 'none') triggers.push('glass');

      // Trigger 3: Inset Shadows (Not supported by PPT)
      if (style.boxShadow.includes('inset')) triggers.push('inset-shadow');

      // Trigger 4: Advanced Shapes
      if (style.clipPath !== 'none' || style.maskImage !== 'none' || style.webkitMaskImage !== 'none') triggers.push('clip');

      // Trigger 5: Explicit Force
      if (el.classList.contains('force-bake')) triggers.push('forced');

      // Trigger 6: Inline SVG (New Support)
      // Capture all SVG graphics as images since we don't parse SVG paths to PPT shapes yet
      // Check both cases just to be safe
      if (el.tagName.toLowerCase() === 'svg') triggers.push('svg');

      /* REVERTED: Trigger 7: Complex Box Shadow (Spread Radius)
      // PPT shadows don't support "spread" (4th value). If present, bake it to preserve the 'glow' effect.
      // Format: "rgba(...) 0px 0px 0px 4px"
      if (style.boxShadow !== 'none') {
        const shadowParts = style.boxShadow.split(' ');
        // A simple heuristic: if we see 4 distinct pixel values, it likely has spread.
        // Or check if it creates a ring/glow effect.
        if (style.boxShadow.includes('rgba') && (style.boxShadow.match(/px/g) || []).length >= 4) {
          triggers.push('complex-shadow');
        }
      }
      */

      if (triggers.length > 0) {
        const id = `bake-${index}-${Math.random().toString(36).substr(2, 5)}`;
        el.dataset.bakeId = id;
        findings.push(id);
      }
    });
    return findings;
  });

  if (candidates.length === 0) return;

  console.log(`[Auto-Baking] Found ${candidates.length} elements to bake.`);

  // 2. Screenshot and Replace
  for (const id of candidates) {
    try {
      // --- BODY SPECIAL CASE ---
      if (id === 'bake-body') {
        console.log('[Auto-Baking] Baking Body Background...');
        const filename = `body_bg_${Math.random().toString(36).substr(2, 5)}.png`;
        const imagePath = path.join(outputDir, filename);

        // 1. Prepare Body: Hide children, hide scrollbars
        await page.evaluate(() => {
          document.body.dataset.originalOverflow = document.body.style.overflow;
          document.body.style.overflow = 'hidden';

          // Mark children hidden
          Array.from(document.body.children).forEach(c => {
            // Skip script tags or hidden inputs if any? No, just Visual elements.
            if (c.tagName === 'SCRIPT' || c.tagName === 'STYLE') return;
            c.dataset.originalDisplay = c.style.display || '';
            c.style.display = 'none';
          });
        });

        // 2. Screenshot Viewport (Body Background)
        // We use page.screenshot which captures viewport. 
        // Ensure viewport is clean.
        // FIX: Use omitBackground: false to capture Cream background if present
        await page.screenshot({ path: imagePath, fullPage: false, omitBackground: false });

        // 3. Restore Body & Apply Image
        await page.evaluate(({ imagePath }) => {
          // Restore children
          Array.from(document.body.children).forEach(c => {
            if (c.dataset.originalDisplay !== undefined) {
              c.style.display = c.dataset.originalDisplay;
              delete c.dataset.originalDisplay;
            }
          });
          document.body.style.overflow = document.body.dataset.originalOverflow || '';

          // Remove gradient/color and set Image
          // Important: html2pptx checks for 'gradient' string in backgroundImage.
          // So we must remove it.
          document.body.style.setProperty('background', 'none', 'important');
          document.body.style.setProperty('background-color', 'transparent', 'important');
          document.body.style.setProperty('background-image', `url('file://${imagePath}')`, 'important');
          document.body.style.setProperty('background-size', 'cover', 'important');
          document.body.dataset.baked = 'true';
        }, { imagePath });

      } else {
        /*
        // --- SVG PATTERN VECTORIZATION (DISABLED: PPT rendering issues) ---
        // Plan E: Use Vector SVG for micro-textures to avoid Aliasing/Greying issues completely.
        const isVectorized = await page.evaluate((id) => {
          const el = document.querySelector(`[data-bake-id="${id}"]`);
          if (!el || el.dataset.bakeType !== 'svg-pattern') return false;

          const style = window.getComputedStyle(el);
          const bgImage = style.backgroundImage;
          const bgSize = style.backgroundSize; // e.g. "20px 20px"
          const opacity = style.opacity || '1';

          // Extract Dot Color
          const colorMatch = bgImage.match(/rgb\(\d+,\s*\d+,\s*\d+\)|#[0-9a-fA-F]{3,6}/);
          const dotColor = colorMatch ? colorMatch[0] : '#000000';

          // Extract Master Background (Color Injection)
          // Ensure we capture the creamy slide background, not white/transparent
          const masterLayout = document.querySelector('.ppt-master-layout') || document.querySelector('[class*="master"]') || document.body;
          let bgColor = window.getComputedStyle(masterLayout).backgroundColor;
          if (bgColor === 'rgba(0, 0, 0, 0)') bgColor = '#FFFFFF';

          // Extract Tile Size
          const sizeMatch = bgSize.match(/(\d+)px/);
          const tileSize = sizeMatch ? sizeMatch[1] : '20';

          // Generate Full-Page SVG with Pattern
          const svgContent = `
            <svg width="1280" height="720" viewBox="0 0 1280 720" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <pattern id="p" width="${tileSize}" height="${tileSize}" patternUnits="userSpaceOnUse">
                        <circle cx="${tileSize / 2}" cy="${tileSize / 2}" r="0.5" fill="${dotColor}" />
                    </pattern>
                </defs>
                <rect width="100%" height="100%" fill="${bgColor}" />
                <rect width="100%" height="100%" fill="url(#p)" opacity="${opacity}" />
            </svg>`;

          const base64 = 'data:image/svg+xml;base64,' + btoa(svgContent);

          el.dataset.bakedSrc = base64;
          el.dataset.baked = 'true';

          // Hide original rendering
          el.style.backgroundImage = 'none';
          el.style.backgroundColor = 'transparent';

          return true;
        }, id);

        if (isVectorized) {
          console.log(`[Auto-Baking] Generated Vector Pattern for ${id}`);
          continue;
        }
        */

        // --- TEXTURE ENHANCER (Plan F) ---
        // Since 0.5px dots are lost in downsampling, we artificially boost them for the screenshot.
        await page.evaluate((id) => {
          const el = document.querySelector(`[data-bake-id="${id}"]`);
          if (!el) return;
          const style = window.getComputedStyle(el);
          if (style.backgroundImage.includes('radial-gradient') && el.dataset.bakeType === 'svg-pattern') {
            console.log('[Auto-Baking] Enhancing texture visibility for screenshot...');
            // Boost opacity: 0.3 -> 0.6
            if (style.opacity === '0.3') el.style.opacity = '0.6';

            // Boost dot size: 0.5px -> 1px
            // Regex replace: 0.5px -> 1.2px (simplified)
            let newBg = style.backgroundImage.replace(/0\.5px/g, '1.2px');
            el.style.backgroundImage = newBg;
          }
        }, id);

        // --- REGULAR ELEMENT BAKING with TEXT PRESERVATION ---
        const selector = `[data-bake-id="${id}"]`;
        const locator = page.locator(selector);

        const filename = `${id}.png`;
        const imagePath = path.join(outputDir, filename);

        try {
          // 2.0 Determine Baking Strategy
          // We treat everything as a transparent overlay now, relying on PPT Slide Background for base color.
          const isSVG = await page.evaluate((id) => {
            const el = document.querySelector(`[data-bake-id="${id}"]`);
            return el ? el.tagName.toLowerCase() === 'svg' : false;
          }, id);

          // 2a. PREPARE ISOLATION
          await page.evaluate(({ id, isSVG }) => {
            console.log(`[Auto-Bake-Browser] Starting Isolation for ${id}. isSVG=${isSVG}`);
            const container = document.querySelector(`[data-bake-id="${id}"]`);
            if (!container) throw new Error('Container not found');

            // Store global state
            window._bakeRestore = {
              bodyVisibility: document.body.style.visibility,
              targetVisibility: container.style.visibility,
              originalShadow: container.style.boxShadow, // Store inline shadow
              children: []
            };

            // 1. Hide EVERYTHING globally
            document.body.style.visibility = 'hidden';

            // 2. Show ONLY the target
            container.style.setProperty('visibility', 'visible', 'important');

            // 3. Hide Shadow (Prevent clipping in screenshot)
            container.style.setProperty('box-shadow', 'none', 'important');

            // 4. NO COLOR INJECTION (User requested "Raw" baking)
            // We rely on the element's own background (if any) or transparency.

            // 5. Hide INTERNAL Content (Prevent Double Rendering)
            // Hide content for Layout Divs (to capture background only).
            // Preserve content for SVGs (to capture graphics).
            if (!isSVG) {
              const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
              let node = walker.nextNode();
              while (node) {
                window._bakeRestore.children.push({
                  node: node,
                  opacity: node.style.opacity
                });
                node.style.setProperty('opacity', '0', 'important');
                node = walker.nextNode();
              }
            }
          }, { id, isSVG });

          // 2b. Screenshot (Always Transparent)
          // captures only the element's visual pixels.
          await locator.screenshot({ path: imagePath, omitBackground: true });

          // 2c. RESTORE STATE
          await page.evaluate(({ id }) => {
            console.log(`[Auto-Bake-Browser] Restoring state for ${id}`);
            if (window._bakeRestore) {
              document.body.style.visibility = window._bakeRestore.bodyVisibility;

              const container = document.querySelector(`[data-bake-id="${id}"]`);
              if (container) {
                container.style.visibility = window._bakeRestore.targetVisibility;

                // Restore Shadow
                if (window._bakeRestore.originalShadow) {
                  container.style.boxShadow = window._bakeRestore.originalShadow;
                } else {
                  container.style.removeProperty('box-shadow');
                }

                if (window._bakeRestore.originalBgColor) {
                  container.style.backgroundColor = window._bakeRestore.originalBgColor;
                } else {
                  container.style.removeProperty('background-color');
                }

                window._bakeRestore.children.forEach(item => {
                  if (item.opacity) item.node.style.opacity = item.opacity;
                  else item.node.style.removeProperty('opacity');
                });
              }
              delete window._bakeRestore;
            }
          }, { id });

          // 2d. Apply Baked Data
          await page.evaluate(({ id, imagePath }) => {
            console.log(`[Auto-Bake-Browser] Applying baked data to ${id}`);
            const el = document.querySelector(`[data-bake-id="${id}"]`);
            if (!el) return;

            // Neutralize CSS
            el.style.setProperty('background', 'none', 'important');
            el.style.setProperty('background-image', 'none', 'important');
            el.style.setProperty('background-color', 'transparent', 'important');
            el.style.setProperty('box-shadow', 'none', 'important');
            el.style.setProperty('backdrop-filter', 'none', 'important');

            // Apply Image
            el.dataset.baked = 'true';
            el.dataset.bakedSrc = `file://${imagePath}`;

            // For visual confirmation only
            el.style.backgroundImage = `url('file://${imagePath}')`;
            el.style.backgroundSize = 'contain';
            el.style.backgroundRepeat = 'no-repeat';
          }, { id, imagePath });

        } catch (err) {
          console.error(`Failed to bake element ${id}:`, err);
        }
      }
    } catch (err) {
      console.warn(`[Auto-Baking] Failed to bake ${id}: ${err.message}`);
    }
  }
}

async function html2pptx(htmlFile, pres, options = {}) {
  const {
    tmpDir = process.env.TMPDIR || '/tmp',
    slide = null
  } = options;

  try {
    // Use Chrome on macOS, default Chromium on Unix
    const launchOptions = { env: { TMPDIR: tmpDir } };
    if (process.platform === 'darwin') {
      launchOptions.channel = 'chrome';
    }

    const browser = await chromium.launch(launchOptions);

    let bodyDimensions;
    let slideData;

    const filePath = path.isAbsolute(htmlFile) ? htmlFile : path.join(process.cwd(), htmlFile);
    const validationErrors = [];

    try {
      const page = await browser.newPage();
      page.on('console', (msg) => {
        // Log the message text to your test runner's console
        console.log(`Browser console: ${msg.text()}`);
      });

      await page.goto(`file://${filePath}`);

      bodyDimensions = await getBodyDimensions(page);

      await page.setViewportSize({
        width: Math.round(bodyDimensions.width),
        height: Math.round(bodyDimensions.height)
      });

      // --- AUTO-BAKING START ---
      await autoBake(page, tmpDir);
      // --- AUTO-BAKING END ---

      // CRITICAL: Reset scroll position after baking.
      // Auto-bake's screenshots may have scrolled the page to capture off-screen elements,
      // creating a coordinate offset for subsequent getBoundingClientRect() calls.
      await page.evaluate(() => window.scrollTo(0, 0));

      slideData = await extractSlideData(page);
    } finally {
      await browser.close();
    }

    // Collect all validation errors
    if (bodyDimensions.errors && bodyDimensions.errors.length > 0) {
      validationErrors.push(...bodyDimensions.errors);
    }

    const dimensionErrors = validateDimensions(bodyDimensions, pres);
    if (dimensionErrors.length > 0) {
      validationErrors.push(...dimensionErrors);
    }

    const textBoxPositionErrors = validateTextBoxPosition(slideData, bodyDimensions);
    if (textBoxPositionErrors.length > 0) {
      validationErrors.push(...textBoxPositionErrors);
    }

    if (slideData.errors && slideData.errors.length > 0) {
      validationErrors.push(...slideData.errors);
    }

    // Throw all errors at once if any exist
    if (validationErrors.length > 0) {
      const errorMessage = validationErrors.length === 1
        ? validationErrors[0]
        : `Multiple validation errors found:\n${validationErrors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')}`;
      throw new Error(errorMessage);
    }

    const targetSlide = slide || pres.addSlide();

    await addBackground(slideData, targetSlide, tmpDir);
    addElements(slideData, targetSlide, pres);

    return { slide: targetSlide, placeholders: slideData.placeholders };
  } catch (error) {
    if (!error.message.startsWith(htmlFile)) {
      throw new Error(`${htmlFile}: ${error.message}`);
    }
    throw error;
  }
}

// --- REFACTORED EXPORT API ---

/**
 * Extract metrics from an HTML file using the full-featured engine.
 * This is the unified entry point for external scripts (like create_pptx_native.js).
 * It handles browser launch, viewport setting, auto-baking, and data extraction.
 */
async function extractMetrics(htmlPath) {
  const browser = await chromium.launch();
  // Use deviceScaleFactor: 3 for Ultra-High-Res texture capture (prevents aliasing of 0.5px dots)
  const context = await browser.newContext({ deviceScaleFactor: 3 });
  const page = await context.newPage();

  // Force 1280x720 viewport (matches Layout Wide) to prevent layout shifts
  // Note: With DPR=2, actual pixels will be 2560x1440, but CSS pixels remain 1280x720
  await page.setViewportSize({ width: 1280, height: 720 });

  const absolutePath = path.isAbsolute(htmlPath) ? htmlPath : path.resolve(htmlPath);
  await page.goto(`file://${absolutePath}`);
  await page.waitForTimeout(100); // Wait for render

  // Use a temp directory for baked assets if needed
  const tmpDir = path.join(path.dirname(htmlPath), '.tmp_bake');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  let metrics = null;
  try {
    // Run Auto-Bake (fixes gradients, glassmorphism, etc.)
    await autoBake(page, tmpDir);

    // IMPORTANT: Reset scroll after baking to fix coordinate offsets
    await page.evaluate(() => window.scrollTo(0, 0));

    // Extract Data using the robust logic
    const slideData = await extractSlideData(page);

    // Normalize structure to match what create_pptx_native expects
    // (Our internal extractSlideData returns { background, elements, placeholders, errors })
    metrics = {
      background: slideData.background,
      elements: slideData.elements,
      placeholders: slideData.placeholders,
      errors: slideData.errors
    };

    // Clean body background style if it was baked
    // (We don't need to revert page state since we are closing browser)

  } catch (err) {
    console.error(`Error extracting metrics from ${htmlPath}:`, err);
    throw err;
  } finally {
    await browser.close();
    // Verify if we should clean up tmpDir? For now keep it as assets might be referenced.
  }

  return metrics;
}

module.exports = {
  html2pptx,
  extractMetrics // <--- The new unified API
};
