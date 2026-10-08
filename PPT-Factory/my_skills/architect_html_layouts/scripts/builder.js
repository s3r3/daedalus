const fs = require('fs');
const path = require('path');

// 1. Layout Registry (In a full system, these would be separate files)
const LAYOUT_TEMPLATES = {
    'cover_branding': (data) => `
        <div class="layout-cover" style="
            display: flex; flex-direction: column; justify-content: center; align-items: flex-start;
            height: 100%; padding-left: 100px;
        ">
            <h1 data-pptx-placeholder="title" style="
                font-size: var(--ppt-fs-title); color: var(--ppt-text-main); margin-bottom: 20px;
                max-width: 800px;
            ">${data.title}</h1>
            <h2 data-pptx-placeholder="subtitle" style="
                font-size: var(--ppt-fs-subtitle); color: var(--ppt-text-accent); margin: 0;
            ">${data.subtitle}</h2>
        </div>
    `,
    'grid_4_feature': (data) => `
        <div class="layout-grid-4" style="
            display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; 
            gap: 40px; padding: 150px 100px 100px 100px; height: 100%;
            box-sizing: border-box;
        ">
            ${data.features.map((f, i) => `
                <div class="card" style="border: 1px solid #333; padding: 30px; border-radius: 8px;">
                    <div data-pptx-placeholder="title" data-idx="${i}" style="
                        font-family: var(--ppt-font-family-primary); 
                        font-size: 24px; color: var(--ppt-text-accent); margin-bottom: 10px;
                    ">${f}</div>
                    <div data-pptx-placeholder="body" data-idx="${i + 10}" style="
                        font-family: var(--ppt-font-family-primary);
                        font-size: 16px; color: var(--ppt-text-muted);
                    ">Description for ${f}</div>
                </div>
            `).join('')}
        </div>
    `,
    'agenda_list': (data) => `
        <div class="layout-agenda" style="
            display: flex; flex-direction: column; justify-content: center;
            padding: 150px 100px; height: 100%; box-sizing: border-box;
        ">
            <h2 style="font-size: var(--ppt-fs-title); color: var(--ppt-text-accent); margin-bottom: 40px;">AGENDA</h2>
            <div style="display: flex; flex-direction: column; gap: 20px;">
                ${data.items.map((item, i) => `
                    <div class="agenda-item" style="display: flex; align-items: center; gap: 20px;">
                        <div style="
                            width: 40px; height: 40px; border-radius: 50%; background: var(--ppt-text-accent);
                            color: #000; display: flex; align-items: center; justify-content: center;
                            font-weight: bold; font-family: var(--ppt-font-family-code);
                        ">${i + 1}</div>
                        <div data-pptx-placeholder="body" data-idx="${i}" style="
                            font-size: 32px; color: var(--ppt-text-main); font-family: var(--ppt-font-family-primary);
                        ">${item}</div>
                    </div>
                `).join('')}
            </div>
        </div>
    `
};

async function buildSlides(briefPath, masterPath, outputDir) {
    const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
    const masterHtml = fs.readFileSync(masterPath, 'utf8');

    // Ensure output dir exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log(`Building project: ${brief.project_name}`);

    // Generate each slide
    brief.required_layouts.forEach((layout, index) => {
        const layoutGen = LAYOUT_TEMPLATES[layout.type];
        if (!layoutGen) {
            console.warn(`Unknown layout type: ${layout.type}`);
            return;
        }

        const innerContent = layoutGen(layout);

        // Inject into Master
        // We assume the master has a <!-- CONTENT_INJECTION_POINT --> or we append to end of .slide-master
        // For this MVP, we'll append to the end of .slide-master, but before the closing div.
        // A better way is to use specific injection markers.

        let finalHtml = masterHtml;
        if (finalHtml.includes('<!-- CONTENT -->')) {
            finalHtml = finalHtml.replace('<!-- CONTENT -->', innerContent);
        } else {
            // Fallback: simple append inside body or wrapper.
            // This is a simplification for the prototype.
            // Let's wrap innerContent in a content-layer div
            const contentLayer = `<div class="content-layer" style="position:absolute; top:0; left:0; width:100%; height:100%; z-index:10;">${innerContent}</div>`;
            finalHtml = finalHtml.replace('</div>\n</div>', `${contentLayer}</div>\n</div>`); // Try to close before final divs
        }

        // Inject Theme Link
        // Current file structure:
        // WORK_DIR/1_html_slides/slide.html
        // WORK_DIR is sibling to my_skills if WORK_DIR is in ROOT
        // correct path: ../../my_skills/define_visual_dna/resources/ref_theme_tech.css

        const cssPath = '../../my_skills/define_visual_dna/resources/ref_theme_tech.css';

        const head = `<head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=1920, height=1080">
            <link rel="stylesheet" href="${cssPath}">
            <style>body { margin: 0; overflow: hidden; width: 1920px; height: 1080px; }</style>
        </head>`;

        const fullDoc = `<!DOCTYPE html><html lang="en">${head}<body><div class="slide">${finalHtml}</div></body></html>`;

        const filename = `slide_${index + 1}_${layout.type}.html`;
        fs.writeFileSync(path.join(outputDir, filename), fullDoc);
        console.log(`Generated: ${filename}`);
    });
}

const [briefPath, masterPath, outputDir] = process.argv.slice(2);
buildSlides(briefPath, masterPath, outputDir);
