import os
import subprocess
import shutil
import json
import time

# --- Configuration ---
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
SKILLS_DIR = os.path.join(ROOT_DIR, 'my_skills')

# Component Paths
BUILDER_SCRIPT = os.path.join(SKILLS_DIR, 'architect_html_layouts', 'scripts', 'builder.js')
METRICS_SCRIPT = os.path.join(SKILLS_DIR, 'analyze_html_metrics', 'scripts', 'extract_metrics.js')
ASSEMBLER_SCRIPT = os.path.join(SKILLS_DIR, 'assemble_pptx_file', 'scripts', 'assembler.py')
QC_SCRIPT = os.path.join(SKILLS_DIR, 'inspect_pptx_quality', 'scripts', 'qc_inspector.py')
MASTER_HTML = os.path.join(SKILLS_DIR, 'define_visual_dna', 'resources', 'ref_master_tech.html')
ASSEMBLER_VENV = os.path.join(SKILLS_DIR, 'assemble_pptx_file', 'venv', 'bin', 'python3')

# Inputs & Outputs
BRIEF_PATH = os.path.join(ROOT_DIR, 'pipeline_input', 'full_brief.json')
WORK_DIR = os.path.join(ROOT_DIR, 'pipeline_work')
HTML_DIR = os.path.join(WORK_DIR, '1_html_slides')
METRICS_DIR = os.path.join(WORK_DIR, '2_metrics')
FINAL_OUTPUT = os.path.join(ROOT_DIR, 'pipeline_output', 'Final_Presentation.pptx')

# --- Helper Functions ---

def run_node(script, args):
    cmd = ['node', script] + args
    print(f"Running Node: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error running {script}:\n{result.stderr}")
        return False
    print(result.stdout)
    return True

def run_python_venv(venv_python, script, args):
    cmd = [venv_python, script] + args
    print(f"Running Python: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error running {script}:\n{result.stderr}")
        return False
    print(result.stdout)
    return True

# --- Main Pipeline ---

def main():
    print("=== Starting PPT Factory Pipeline ===")
    
    # 0. Cleanup and Setup
    if os.path.exists(WORK_DIR):
        shutil.rmtree(WORK_DIR)
    os.makedirs(HTML_DIR) 
    
    if not os.path.exists(os.path.dirname(FINAL_OUTPUT)):
        os.makedirs(os.path.dirname(FINAL_OUTPUT))

    # 1. Layout Architect: Generate HTMLs
    print("\n--- Step 1: Layout Architect ---")
    if not run_node(BUILDER_SCRIPT, [BRIEF_PATH, MASTER_HTML, HTML_DIR]):
        print("Failed at Step 1")
        return

    # 2. Metrics Extractor: Process each HTML
    print("\n--- Step 2: Metrics Extractor ---")
    html_files = [f for f in os.listdir(HTML_DIR) if f.endswith('.html')]
    html_files.sort() # Ensure order
    
    processed_slides_dirs = []

    for html_file in html_files:
        input_path = os.path.join(HTML_DIR, html_file)
        # Create a specific folder for this slide's assets
        slide_name = os.path.splitext(html_file)[0]
        output_path = os.path.join(METRICS_DIR, slide_name)
        
        print(f"Processing {html_file}...")
        if not run_node(METRICS_SCRIPT, [input_path, output_path]):
            print(f"Failed to process {html_file}")
            return
        
        processed_slides_dirs.append(output_path)

    # 3. Assembly: Build PPTX
    print("\n--- Step 3: Template Assembly ---")
    
    if not run_python_venv(ASSEMBLER_VENV, ASSEMBLER_SCRIPT, [METRICS_DIR, FINAL_OUTPUT]):
        print("Failed at Step 3")
        return

    # 4. Quality Control
    print("\n--- Step 4: Quality Control ---")
    # Using the same venv as assembler since it has python-pptx
    if not run_python_venv(ASSEMBLER_VENV, QC_SCRIPT, [FINAL_OUTPUT, BRIEF_PATH]):
        print("Failed Quality Control")
        return

    print(f"\n=== Success! Output saved to: {FINAL_OUTPUT} ===")

if __name__ == "__main__":
    main()
