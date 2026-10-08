
const { html2pptx } = require('./html2pptx');
const PptxGenJS = require('pptxgenjs');
const fs = require('fs');
const path = require('path');

async function batchConvert(htmlDir, outputPath, filterFiles = null) {
    console.log(`Starting Batch Conversion: ${htmlDir} -> ${outputPath}`);

    // 1. Find HTML files (exclude index.html)
    let files = fs.readdirSync(htmlDir).filter(f => f.endsWith('.html') && f !== 'index.html').sort();

    if (filterFiles && filterFiles.length > 0) {
        console.log(`Filtering for specific files: ${filterFiles.join(', ')}`);
        files = files.filter(f => {
            // 1. Exact match (full filename or stem)
            if (filterFiles.includes(f)) return true;
            const stem = f.replace('.html', '');
            if (filterFiles.includes(stem)) return true;

            // 2. Prefix match (e.g., "slide_06" matches "slide_06_grid.html")
            for (const filterItem of filterFiles) {
                // If filter matches the start and is followed by an underscore or dot
                if (f.startsWith(filterItem + '_') || f.startsWith(filterItem + '.')) return true;

                // Special case: if user just provides "06", match "slide_06"
                if (/^\d+$/.test(filterItem)) {
                    const padded = filterItem.padStart(2, '0');
                    if (f.startsWith(`slide_${padded}_`) || f.startsWith(`slide_${padded}.`)) return true;
                }

                // Most robust case: match by slide ordinal only, regardless of trailing layout name.
                // Example: "slide_02_agenda" should match "slide_02_grid_4_feature.html".
                const slideNumMatch = String(filterItem).match(/^slide_(\d+)/);
                if (slideNumMatch) {
                    const padded = slideNumMatch[1].padStart(2, '0');
                    if (f.startsWith(`slide_${padded}_`) || f.startsWith(`slide_${padded}.`)) return true;
                }
            }
            return false;
        });
    }

    if (files.length === 0) {
        console.error('No HTML files found in directory.');
        process.exit(1);
    }

    console.log(`Found ${files.length} slides:`, files);

    // 2. Initialize Presentation
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE'; // Use 16:9 Wide (13.33 x 7.5 inches)

    // 3. Process each slide
    for (const file of files) {
        console.log(`Processing ${file}...`);
        const fullPath = path.join(htmlDir, file);
        try {
            await html2pptx(fullPath, pptx);
        } catch (err) {
            console.error(`Error processing ${file}:`, err.message);
            // We might want to continue or exit depending on strictness. 
            // For now, let's log and rethrow to fail the build.
            process.exit(1);
        }
    }

    // 4. Save
    try {
        await pptx.writeFile({ fileName: outputPath });
        console.log(`Successfully saved to ${outputPath}`);
        console.log('Generated: output.pptx');
    } catch (err) {
        console.error('Error saving PPTX:', err);
        process.exit(1);
    }
}

// CLI
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error('Usage: node batch_convert.js <html_dir> <output_pptx> [--slides slide1,slide2]');
        process.exit(1);
    }

    const htmlDir = args[0];
    const outputPath = args[1];
    let filterFiles = null;

    // Basic arg parsing for --slides
    const slidesIndex = args.indexOf('--slides');
    if (slidesIndex !== -1 && args[slidesIndex + 1]) {
        filterFiles = args[slidesIndex + 1].split(',');
    }

    batchConvert(htmlDir, outputPath, filterFiles);
}
