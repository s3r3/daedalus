/**
 * Example: Create PowerPoint presentation from HTML using html2pptx
 * 
 * This example demonstrates:
 * 1. Converting HTML slides to PowerPoint
 * 2. Using placeholders for dynamic content
 * 3. Adding charts to placeholder areas
 * 4. Saving the final presentation
 */

const pptxgen = require('pptxgenjs');
const html2pptx = require('../scripts/html2pptx');
const path = require('path');

async function createPresentation() {
    console.log('Creating PowerPoint presentation from HTML...');

    // Initialize presentation
    const pptx = new pptxgen();
    pptx.layout = 'LAYOUT_16x9';  // Must match HTML body dimensions (720pt × 405pt)
    pptx.author = 'PPT Design Studio';
    pptx.title = 'HTML to PPTX Test';

    // Convert HTML slide to PowerPoint
    const htmlPath = path.join(__dirname, 'test_slide.html');
    const { slide, placeholders } = await html2pptx(htmlPath, pptx);

    console.log(`Found ${placeholders.length} placeholder(s)`);

    // Add chart to the placeholder area
    if (placeholders.length > 0) {
        const chartPlaceholder = placeholders.find(p => p.id === 'chart-area');

        if (chartPlaceholder) {
            console.log('Adding chart to placeholder...');

            // Sample chart data
            const chartData = [{
                name: 'Sample Data',
                labels: ['Q1', 'Q2', 'Q3', 'Q4'],
                values: [65, 75, 85, 90]
            }];

            // Add bar chart
            slide.addChart(pptx.ChartType.bar, chartData, {
                x: chartPlaceholder.x,
                y: chartPlaceholder.y,
                w: chartPlaceholder.w,
                h: chartPlaceholder.h,
                barDir: 'col',
                showTitle: true,
                title: 'Quarterly Performance',
                showLegend: false,
                showCatAxisTitle: true,
                catAxisTitle: 'Quarter',
                showValAxisTitle: true,
                valAxisTitle: 'Score',
                chartColors: ['4299E1'],
                valAxisMaxVal: 100,
                valAxisMinVal: 0
            });
        }
    }

    // Save presentation
    const outputPath = path.join(__dirname, 'output.pptx');
    await pptx.writeFile({ fileName: outputPath });

    console.log(`✓ Presentation created successfully: ${outputPath}`);
}

// Run the example
createPresentation().catch(err => {
    console.error('Error creating presentation:', err);
    process.exit(1);
});
