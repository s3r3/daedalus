/**
 * Simple test runner for the html2pptx skill
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('=== Running HTML to PPTX Test ===\n');

try {
    // Check if html2pptx.js exists
    const html2pptxPath = path.join(__dirname, '../scripts/html2pptx.js');
    if (!fs.existsSync(html2pptxPath)) {
        throw new Error('html2pptx.js not found. Please copy it from the reference implementation.');
    }
    console.log('✓ html2pptx.js found');

    // Check if test HTML exists
    const testHtmlPath = path.join(__dirname, 'test_slide.html');
    if (!fs.existsSync(testHtmlPath)) {
        throw new Error('test_slide.html not found');
    }
    console.log('✓ test_slide.html found');

    // Run the create_presentation example
    console.log('\nRunning create_presentation.js...\n');
    execSync('node create_presentation.js', {
        cwd: __dirname,
        stdio: 'inherit'
    });

    // Check if output file was created
    const outputPath = path.join(__dirname, 'output.pptx');
    if (fs.existsSync(outputPath)) {
        const stats = fs.statSync(outputPath);
        console.log(`\n✓ Output file created: ${outputPath}`);
        console.log(`  File size: ${(stats.size / 1024).toFixed(2)} KB`);
    } else {
        throw new Error('Output file was not created');
    }

    console.log('\n=== All tests passed ===');

} catch (err) {
    console.error('\n✗ Test failed:', err.message);
    process.exit(1);
}
