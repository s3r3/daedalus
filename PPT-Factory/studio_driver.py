
import os
import sys
import shutil
import subprocess
import argparse
import time

# --- Configuration ---
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
SKILLS_DIR = os.path.join(ROOT_DIR, 'my_skills')

# Script Paths
SCRIPT_GEN_BRIEF = os.path.join(SKILLS_DIR, 'create_design_brief', 'scripts', 'generate_brief.py')
SCRIPT_GEN_DNA = os.path.join(SKILLS_DIR, 'define_visual_dna', 'scripts', 'generate_dna.py')
SCRIPT_BUILD_SLIDES = os.path.join(SKILLS_DIR, 'architect_html_layouts', 'scripts', 'build_slides.py')
SCRIPT_ANALYZE_METRICS = os.path.join(SKILLS_DIR, 'analyze_html_metrics', 'scripts', 'analyze_metrics.py')
SCRIPT_CREATE_PPTX = os.path.join(SKILLS_DIR, 'assemble_pptx_file', 'scripts', 'create_pptx.py')

# Workspace Paths
WORK_DIR = os.path.join(ROOT_DIR, 'pipeline_work')
INPUT_DIR = os.path.join(ROOT_DIR, 'pipeline_input')
OUTPUT_DIR = os.path.join(ROOT_DIR, 'pipeline_output')

DIR_BRIEF = INPUT_DIR
DIR_DNA = os.path.join(WORK_DIR, '0_dna')
DIR_SLIDES = os.path.join(WORK_DIR, '1_html_slides')
DIR_METRICS = os.path.join(WORK_DIR, '2_metrics')
FINAL_PPTX = os.path.join(OUTPUT_DIR, 'Smart_Presentation.pptx')

# Python Interpreter (Use current)
PYTHON_EXE = sys.executable

def ensure_dirs():
    for d in [WORK_DIR, INPUT_DIR, OUTPUT_DIR]:
        if not os.path.exists(d):
            os.makedirs(d)
            
    # Clean work dirs
    for d in [DIR_DNA, DIR_SLIDES, DIR_METRICS]:
        if os.path.exists(d):
            shutil.rmtree(d)
        os.makedirs(d)

def run_step(step_name, command):
    print(f"\n>> [{step_name}] Starting...")
    start_time = time.time()
    
    try:
        result = subprocess.run(command, check=True, text=True, capture_output=True)
        print(result.stdout)
        duration = time.time() - start_time
        print(f">> [{step_name}] Completed in {duration:.2f}s")
        return True
    except subprocess.CalledProcessError as e:
        print(f"!! [{step_name}] FAILED with exit code {e.returncode}")
        print(e.stderr)
        print(e.stdout)
        return False

def orchestrate(user_prompt):
    print(f"=== PPT Design Studio Pipeline ===")
    print(f"Goal: {user_prompt}")
    
    ensure_dirs()
    
    # Paths
    brief_path = os.path.join(DIR_BRIEF, 'smart_brief.json')
    
    # 1. Creative Director
    if not run_step("Creative Director", [PYTHON_EXE, SCRIPT_GEN_BRIEF, user_prompt, brief_path]):
        return
        
    # 2. Visual System Lead
    if not run_step("Visual System Lead", [PYTHON_EXE, SCRIPT_GEN_DNA, brief_path, DIR_DNA]):
        return
        
    # 3. Layout Architect
    if not run_step("Layout Architect", [PYTHON_EXE, SCRIPT_BUILD_SLIDES, brief_path, DIR_DNA, DIR_SLIDES]):
        return
        
    # 4. Metrics Analyzer
    if not run_step("Metrics Analyzer", [PYTHON_EXE, SCRIPT_ANALYZE_METRICS, DIR_SLIDES, DIR_METRICS]):
        return
        
    # 5. Assembler
    if not run_step("Assembler", [PYTHON_EXE, SCRIPT_CREATE_PPTX, DIR_METRICS, FINAL_PPTX]):
        return
        
    print(f"\n=== SUCCESS ===")
    print(f"Final Presentation: {FINAL_PPTX}")

if __name__ == "__main__":
    if len(sys.argv) > 1:
        prompt = sys.argv[1]
    else:
        prompt = "Make a pitch deck for a futuristic AI company"
        
    orchestrate(prompt)
