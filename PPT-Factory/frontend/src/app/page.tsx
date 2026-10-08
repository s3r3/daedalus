
'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Play, CheckCircle, AlertCircle, Loader2, ArrowRight, Edit, Save, RefreshCw, FolderOpen, ImagePlus } from 'lucide-react';
import ProjectList from '@/components/ProjectList';
import StepArtifactsViewer from '@/components/StepArtifactsViewer';

interface StepStatus {
  step: string;
  state: 'idle' | 'running' | 'success' | 'error';
  message: string;
  output: string | null;
}

interface ProjectImageAsset {
  fileName: string;
  size: number;
  updatedAt: string;
  width?: number | null;
  height?: number | null;
  aspectRatio?: number | null;
  orientation?: 'landscape' | 'portrait' | 'square' | 'unknown';
}

export default function Home() {
  const [pipelineState, setPipelineState] = useState<Record<string, StepStatus>>({
    dna: { step: 'dna', state: 'idle', message: '', output: null },
    assets: { step: 'assets', state: 'idle', message: '', output: null },
    layout: { step: 'layout', state: 'idle', message: '', output: null },
    metrics: { step: 'metrics', state: 'idle', message: '', output: null },
    assembly: { step: 'assembly', state: 'idle', message: '', output: null },
    qc: { step: 'qc', state: 'idle', message: '', output: null },
  });

  // ... (Draft/Brief state same)
  // Hallucinated code removal: Re-declaring existing state vars to keep context for replace tool
  // Draft State
  const [draftJson, setDraftJson] = useState('');
  const [isDraftLoading, setIsDraftLoading] = useState(false);
  const [draftMessage, setDraftMessage] = useState('');

  // Brief State
  const [userPrompt, setUserPrompt] = useState('');
  const [briefJson, setBriefJson] = useState<string>('');
  const [isBriefLoading, setIsBriefLoading] = useState(false);
  const [briefMessage, setBriefMessage] = useState('');

  // Pipeline Config State
  const [fromLog, setFromLog] = useState(false);
  const [fromLogLayout, setFromLogLayout] = useState(false);

  // Output Preview State
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [previewSequence, setPreviewSequence] = useState<string[]>([]);

  // Slide Selection State
  const [availableSlides, setAvailableSlides] = useState<{ id: string, title?: string, type?: string }[]>([]);
  const [selectedSlides, setSelectedSlides] = useState<Set<string>>(new Set());

  // Model Selection
  const [selectedModel, setSelectedModel] = useState<string>('gemini-3-flash-preview');

  // Project Management State
  const [projectName, setProjectName] = useState('');
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [showProjectList, setShowProjectList] = useState(false);
  const [refreshArtifacts, setRefreshArtifacts] = useState(0);
  const [projectRootInput, setProjectRootInput] = useState('');
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmBaseUrl, setLlmBaseUrl] = useState('');
  const [llmModel, setLlmModel] = useState('gemini-3-flash-preview');
  const [llmSettingsMessage, setLlmSettingsMessage] = useState('');
  const [isSavingLlmSettings, setIsSavingLlmSettings] = useState(false);
  const [projectImages, setProjectImages] = useState<ProjectImageAsset[]>([]);
  const [imageSemanticName, setImageSemanticName] = useState('');
  const [selectedImageFile, setSelectedImageFile] = useState<File | null>(null);
  const [imageUploadMessage, setImageUploadMessage] = useState('');
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isLoadingImages, setIsLoadingImages] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const isStorageReady = Boolean(projectRoot);
  const isLlmReady = Boolean(llmApiKey.trim() && llmModel.trim());

  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        if (!data.success) return;
        const configuredRoot = data.localSettings?.projectRoot || '';
        const suggestedRoot = data.suggestedProjectRoot || '';
        setProjectRoot(configuredRoot || null);
        setProjectRootInput(configuredRoot || suggestedRoot);
        setLlmApiKey(data.localSettings?.llm?.apiKey || data.effectiveLlmSettings?.apiKey || '');
        setLlmBaseUrl(data.localSettings?.llm?.baseUrl || data.effectiveLlmSettings?.baseUrl || '');
        const resolvedModel = data.localSettings?.llm?.model || data.effectiveLlmSettings?.model || 'gemini-3-flash-preview';
        setLlmModel(resolvedModel);
        setSelectedModel(resolvedModel);
      });
  }, []);

  useEffect(() => {
    if (!currentProjectId) {
      setProjectImages([]);
      return;
    }
    fetchProjectImages(currentProjectId);
  }, [currentProjectId]);

  // Parse Brief for Slides
  useEffect(() => {
    if (!briefJson) return;
    try {
      const data = JSON.parse(briefJson);
      const slides = data.required_layouts || data.presentation_flow || [];
      const slidesList = slides.map((s: any, index: number) => ({
        id: String(s.slide_id || s.id || (index + 1)),
        title: s.title || s.layout_intent || s.type || 'Untitled',
        type: s.type
      }));
      setAvailableSlides(slidesList);

      // Default: Select all if none selected
      if (slidesList.length > 0) {
        setSelectedSlides(new Set(slidesList.map((s: any) => s.id)));
      }
    } catch (e) {
      console.error("Failed to parse brief for slides", e);
    }
  }, [briefJson]);

  const toggleSlideSelection = (slideId: string) => {
    const newSelection = new Set(selectedSlides);
    if (newSelection.has(slideId)) {
      newSelection.delete(slideId);
    } else {
      newSelection.add(slideId);
    }
    setSelectedSlides(newSelection);
  };

  const selectAllSlides = () => {
    setSelectedSlides(new Set(availableSlides.map(s => s.id)));
  };

  const deselectAllSlides = () => {
    setSelectedSlides(new Set());
  };

  const saveProjectRoot = async () => {
    setIsSavingSettings(true);
    setSettingsMessage('');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRoot: projectRootInput }),
      });
      const data = await res.json();
      if (!data.success) {
        setSettingsMessage(data.error || 'Failed to save project folder.');
        return;
      }
      const savedRoot = data.localSettings?.projectRoot || null;
      setProjectRoot(savedRoot);
      setProjectRootInput(savedRoot || projectRootInput);
      setSettingsMessage('Project save folder is ready.');
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : 'Failed to save project folder.');
    } finally {
      setIsSavingSettings(false);
    }
  };

  const pickProjectRoot = async () => {
    setIsSavingSettings(true);
    setSettingsMessage('');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pickProjectRoot' }),
      });
      const data = await res.json();
      if (!data.success) {
        setSettingsMessage(data.error || 'Failed to choose project folder.');
        return;
      }
      const savedRoot = data.localSettings?.projectRoot || null;
      setProjectRoot(savedRoot);
      setProjectRootInput(savedRoot || '');
      setSettingsMessage(savedRoot ? 'Project save folder selected.' : 'No folder selected.');
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : 'Failed to choose project folder.');
    } finally {
      setIsSavingSettings(false);
    }
  };

  const saveLlmSettings = async () => {
    setIsSavingLlmSettings(true);
    setLlmSettingsMessage('');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          llm: {
            apiKey: llmApiKey,
            baseUrl: llmBaseUrl,
            model: llmModel,
          },
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setLlmSettingsMessage(data.error || 'Failed to save model settings.');
        return;
      }
      setLlmApiKey(data.localSettings?.llm?.apiKey || llmApiKey);
      setLlmBaseUrl(data.localSettings?.llm?.baseUrl || llmBaseUrl);
      setLlmModel(data.localSettings?.llm?.model || llmModel);
      setLlmSettingsMessage('Model settings saved.');
      if (data.localSettings?.llm?.model) {
        setSelectedModel(data.localSettings.llm.model);
      }
    } catch (error) {
      setLlmSettingsMessage(error instanceof Error ? error.message : 'Failed to save model settings.');
    } finally {
      setIsSavingLlmSettings(false);
    }
  };

  const fetchProjectImages = async (projectId: string) => {
    setIsLoadingImages(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/images`);
      const data = await res.json();
      if (!data.success) {
        setImageUploadMessage(data.error || 'Failed to load project images.');
        return;
      }
      setProjectImages(Array.isArray(data.files) ? data.files : []);
    } catch (error) {
      setImageUploadMessage(error instanceof Error ? error.message : 'Failed to load project images.');
    } finally {
      setIsLoadingImages(false);
    }
  };

  const fetchPipelineResults = async (projectId: string) => {
    console.log(`[Frontend] Fetching pipeline results for project: ${projectId}`);
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      const data = await res.json();
      if (!data.success) {
        console.error("Error fetching results:", data.error);
        return;
      }
      const results = data.project?.pipeline_results || [];
      if (results.length > 0) {
      console.log(`[Frontend] Found ${results.length} past executions.`);

      setPipelineState(prev => {
        const newState = { ...prev };
        results.forEach((row: any) => {
          if (newState[row.step_name]) {
            newState[row.step_name] = {
              step: row.step_name,
              state: row.status as any,
              message: row.message || '',
              output: row.output
            };
          }
        });
        return newState;
      });
      } else {
      // Reset if no results found for this project
      setPipelineState({
        dna: { step: 'dna', state: 'idle', message: '', output: null },
        assets: { step: 'assets', state: 'idle', message: '', output: null },
        layout: { step: 'layout', state: 'idle', message: '', output: null },
        metrics: { step: 'metrics', state: 'idle', message: '', output: null },
        assembly: { step: 'assembly', state: 'idle', message: '', output: null },
        qc: { step: 'qc', state: 'idle', message: '', output: null },
      });
      }
    } catch (error) {
      console.error("Error fetching results:", error);
    }
  }


  // Unified Project Saving Logic
  const upsertProject = async (overrides: Partial<{
    draft: any,
    brief: any,
    name: string,
    prompt: string,
    id: string
  }> = {}) => {
    try {
      // Use overrides or current state
      let draftToSave = overrides.draft;
      if (draftToSave === undefined) {
        try {
          draftToSave = draftJson ? JSON.parse(draftJson) : null;
        } catch (e) {
          return { success: false, error: "Invalid Draft JSON" };
        }
      }

      let briefToSave = overrides.brief;
      if (briefToSave === undefined) {
        try {
          briefToSave = briefJson ? JSON.parse(briefJson) : { project_name: projectName };
        } catch (e) {
          return { success: false, error: "Invalid Brief JSON" };
        }
      }

      const nameToSave = overrides.name || projectName || (briefToSave.project_name) || 'New Project';
      const promptToSave = overrides.prompt || userPrompt;
      const idToSave = overrides.id || currentProjectId;

      console.log("[Frontend] Upserting Project:", { id: idToSave, name: nameToSave });

      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: idToSave,
          project_name: nameToSave,
          user_prompt: promptToSave,
          brief_json: briefToSave,
          content_draft: draftToSave,
          model_used: selectedModel
        }),
      });

      const data = await res.json();
      if (data.success) {
        const pid = data.project.id;
        // UPDATE STATE IMMEDIATELY
        setCurrentProjectId(pid);
        setProjectName(data.project.project_name);

        // Return rich result
        return { success: true, pid, project: data.project };
      } else {
        return { success: false, error: data.error };
      }
    } catch (e: any) {
      console.error(e);
      return { success: false, error: e.message };
    }
  };

  const createProject = async () => {
    if (!isStorageReady) {
      setDraftMessage('Set Project Save Folder first.');
      return;
    }
    if (!isLlmReady) {
      setDraftMessage('Configure model settings first.');
      return;
    }

    const trimmedName = projectName.trim() || userPrompt.trim().slice(0, 30) || 'New Project';
    setDraftMessage('Creating project...');
    const result = await upsertProject({
      name: trimmedName,
      prompt: userPrompt,
    });

    if (result.success) {
      setDraftMessage(`Project created: ${trimmedName}`);
    } else {
      setDraftMessage(`Create project failed: ${result.error}`);
    }
  };

  const generateDraft = async () => {
    if (!currentProjectId) {
      setDraftMessage('Create a project first, then generate draft.');
      return;
    }
    setIsDraftLoading(true);
    setDraftMessage('Drafting content content...');
    try {
      const res = await fetch('/api/brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'draft',
          prompt: userPrompt,
          model: selectedModel,
          imageAssets: projectImages,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setDraftJson(JSON.stringify(data.draft, null, 2));
        setDraftMessage('Content Drafted! Auto-saving...');

        const result = await upsertProject({
          id: currentProjectId,
          draft: data.draft,
          prompt: userPrompt,
          name: projectName || userPrompt.substring(0, 20) || 'New Draft',
        });

        if (result.success) {
          setDraftMessage('Draft Generated & Saved.');
        } else {
          setDraftMessage('Draft Generated, but Auto-Save Failed: ' + result.error);
        }
      } else {
        setDraftMessage('Error: ' + data.error);
      }
    } catch (e: any) {
      setDraftMessage('Error: ' + e.message);
    } finally {
      setIsDraftLoading(false);
    }
  };

  const saveDraftManual = async () => {
    if (!currentProjectId) {
      setDraftMessage('Create a project first, then save draft.');
      return;
    }
    setDraftMessage('Saving draft...');
    try {
      let json;
      try {
        json = JSON.parse(draftJson);
      } catch (e) {
        setDraftMessage('Invalid JSON format.');
        return;
      }

      const result = await upsertProject({ id: currentProjectId, draft: json });
      if (result.success) {
        setDraftMessage('Draft Saved.');
      } else {
        setDraftMessage('Save Failed: ' + result.error);
      }
    } catch (e: any) {
      setDraftMessage('Error: ' + e.message);
    }
  };

  const generateBrief = async () => {
    if (!currentProjectId) {
      setBriefMessage('Create a project first, then generate brief.');
      return;
    }
    setIsBriefLoading(true);
    setBriefMessage('Consulting Creative Director Agent...');
    try {
      let draftData;
      try {
        draftData = JSON.parse(draftJson);
      } catch (e) {
        setBriefMessage("Error: Invalid Draft JSON. Fix before generating.");
        return;
      }

      const res = await fetch('/api/brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate', draftData: draftData, model: selectedModel }),
      });
      const data = await res.json();
      if (data.success) {
        setBriefJson(JSON.stringify(data.brief, null, 2));
        const newName = data.brief.project_name;
        if (newName) setProjectName(newName);

        setBriefMessage('Brief Generated! Auto-saving...');

        // Auto-Save Project with new Name and Brief
        const result = await upsertProject({
          id: currentProjectId,
          brief: data.brief,
          name: newName
        });

        if (result.success) {
          setBriefMessage('Visual DNA Brief Generated & Saved.');
        } else {
          setBriefMessage('Brief Generated but Save Failed: ' + result.error);
        }

      } else {
        setBriefMessage('Error: ' + data.error);
      }
    } catch (e: any) {
      setBriefMessage('Error: ' + e.message);
    } finally {
      setIsBriefLoading(false);
    }
  };

  const saveBrief = async () => {
    if (!currentProjectId) {
      setBriefMessage('Create a project first, then save brief.');
      return;
    }
    try {
      let brief;
      try {
        brief = JSON.parse(briefJson);
      } catch (e) {
        setBriefMessage('Invalid JSON format.');
        return;
      }

      setBriefMessage('Saving...');

      // 1. Save to Local Disk (for immediate API usage)
      const res = await fetch('/api/brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', brief }),
      });

      // 2. Save to project storage
      const result = await upsertProject({ id: currentProjectId, brief: brief });

      if (res.ok && result.success) {
        setBriefMessage('Brief saved to disk and project storage.');
      } else {
        setBriefMessage(`Save partial: Disk(${res.ok}), Storage(${result.success ? 'Y' : 'N'}).`);
      }
    } catch (e: any) {
      setBriefMessage('Error: ' + e.message);
    }
  };

  const uploadProjectImage = async () => {
    if (!isStorageReady) {
      setImageUploadMessage('Set Project Save Folder first, then upload images.');
      return;
    }
    if (!currentProjectId) {
      setImageUploadMessage('Create a project first, then upload images.');
      return;
    }
    if (!selectedImageFile) {
      setImageUploadMessage('Choose an image file first.');
      return;
    }
    if (!imageSemanticName.trim()) {
      setImageUploadMessage('Enter a semantic file name first.');
      return;
    }

    setIsUploadingImage(true);
    setImageUploadMessage('');

    try {
      const imageDimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const objectUrl = URL.createObjectURL(selectedImageFile);
        const image = new Image();
        image.onload = () => {
          resolve({ width: image.naturalWidth, height: image.naturalHeight });
          URL.revokeObjectURL(objectUrl);
        };
        image.onerror = () => {
          reject(new Error('Could not read image dimensions.'));
          URL.revokeObjectURL(objectUrl);
        };
        image.src = objectUrl;
      });

      const formData = new FormData();
      formData.append('file', selectedImageFile);
      formData.append('semanticName', imageSemanticName.trim());
      formData.append('width', String(imageDimensions.width));
      formData.append('height', String(imageDimensions.height));

      const res = await fetch(`/api/projects/${currentProjectId}/images`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error || 'Failed to upload image.');
      }

      await fetchProjectImages(currentProjectId);
      setImageUploadMessage(`Uploaded: ${data.file.fileName}`);
      setImageSemanticName('');
      setSelectedImageFile(null);
      if (imageInputRef.current) {
        imageInputRef.current.value = '';
      }
    } catch (error) {
      setImageUploadMessage(error instanceof Error ? error.message : 'Failed to upload image.');
    } finally {
      setIsUploadingImage(false);
    }
  };

  const loadProject = (project: any) => {
    setCurrentProjectId(project.id);
    setProjectName(project.project_name);
    setUserPrompt(project.user_prompt || '');
    setBriefJson(project.brief_json ? JSON.stringify(project.brief_json, null, 2) : '');
    setDraftJson(project.content_draft ? JSON.stringify(project.content_draft, null, 2) : '');
    setBriefMessage(`Loaded project: ${project.project_name}`);
    setShowProjectList(false);

    // FETCH RESULTS
    fetchPipelineResults(project.id);
  };

  const openPreview = (fileName: string, orderedFiles: string[]) => {
    setPreviewFile(fileName);
    setPreviewSequence(orderedFiles);
  };

  const closePreview = () => {
    setPreviewFile(null);
    setPreviewSequence([]);
  };

  const previewIndex = previewFile ? previewSequence.indexOf(previewFile) : -1;
  const canGoPrev = previewIndex > 0;
  const canGoNext = previewIndex >= 0 && previewIndex < previewSequence.length - 1;

  const goToPrevPreview = () => {
    if (!canGoPrev) return;
    setPreviewFile(previewSequence[previewIndex - 1]);
  };

  const goToNextPreview = () => {
    if (!canGoNext) return;
    setPreviewFile(previewSequence[previewIndex + 1]);
  };

  const runStep = async (stepKey: string) => {
    setPipelineState(prev => ({
      ...prev,
      [stepKey]: { ...prev[stepKey], state: 'running', message: 'Starting...', output: '' }
    }));

    console.log(`[Frontend] RunStep '${stepKey}': Sending request (Stream Mode)...`);
    try {
      const res = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          step: stepKey,
          fromLog: stepKey === 'assets' ? fromLog : (stepKey === 'layout' ? fromLogLayout : false),
          model: selectedModel,
          projectId: currentProjectId,
          filterSlides: (stepKey === 'layout' || stepKey === 'assembly') ? Array.from(selectedSlides) : undefined,
          // Enable generic streaming for supported steps
          useStream: ['assets', 'layout', 'assembly', 'dna', 'qc'].includes(stepKey)
        }),
      });

      console.log(`[Frontend] RunStep '${stepKey}': Response status ${res.status}`);

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Server Error ${res.status}`);
      }

      // Check if response is JSON (Legacy/Fallback) or Stream
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
      const data = await res.json();
      if (data.success) {
        setPipelineState(prev => ({
          ...prev,
          [stepKey]: { ...prev[stepKey], state: 'success', message: data.message, output: data.output }
          }));
        } else {
          throw new Error(data.error || 'Unknown error');
        }
        return;
      }

      // Handle Streaming Response
      if (!res.body) throw new Error("No response body for stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullOutput = '';
      let done = false;

      while (!done) {
        const { value, done: isDone } = await reader.read();
        done = isDone;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          fullOutput += chunk;

          // --- Real-time Status Parsing ---
          let statusUpdate = "";

          // 1. Assets / General: "⚪️ Started generating: [Name]"
          const startMatch = chunk.match(/Started generating: (.+?)(?:\.\.\.|$)/);
          if (startMatch) {
            statusUpdate = `Generating: ${startMatch[1].trim()}`;
          }

          // 2. Layout: "Processing Slide..." (Heuristic based on expected logs)
          if (chunk.includes('Generating slide')) {
            const slideMatch = chunk.match(/Generating slide[ _](.+?)(?:\.\.\.|$)/);
            if (slideMatch) statusUpdate = `Building Slide: ${slideMatch[1]}`;
            else statusUpdate = "Building Slides...";
          }

          // 3. Assembly: "Processing..." 
          if (chunk.includes('Processing html files')) statusUpdate = "Analyzing HTML...";
          if (chunk.includes('Generating PPTX')) statusUpdate = "Assembling PPTX...";

          setPipelineState(prev => ({
            ...prev,
            [stepKey]: {
              ...prev[stepKey],
              output: fullOutput,
              message: statusUpdate || prev[stepKey].message
            }
          }));
        }
      }

      console.log(`[Frontend] RunStep '${stepKey}': Stream completed.`);

      // Determine final success based on exit code in log (added by backend spawnCommand)
      // [Process completed successfully] vs [Process exited with code X]
      const isSuccess = fullOutput.includes('[Process completed successfully]');
      if (isSuccess) {
        setRefreshArtifacts(prev => prev + 1);
      }
      const finalMessage = isSuccess ? 'Completed' : 'Failed (Check logs)';
      const finalState = isSuccess ? 'success' : 'error';

      setPipelineState(prev => ({
        ...prev,
        [stepKey]: { ...prev[stepKey], state: finalState, message: finalMessage }
      }));

    } catch (error: any) {
      console.error(`[Frontend] RunStep '${stepKey}': Error`, error);
      setPipelineState(prev => ({
        ...prev,
        [stepKey]: { ...prev[stepKey], state: 'error', message: error.message, output: prev[stepKey].output || error.message }
      }));
    }
  };

  const PipelineNode = ({ title, stepKey, description, isAi = false, showPreview = false, showLogToggle = false, progressTotal, children }:
    { title: string, stepKey: string, description: string, isAi?: boolean, showPreview?: boolean, showLogToggle?: boolean, progressTotal?: number, children?: React.ReactNode }) => {

    // ... (status, isRunning, isSuccess, isError, outputLines logic remains same)
    const status = pipelineState[stepKey];
    const isRunning = status.state === 'running';
    const isSuccess = status.state === 'success';
    const isError = status.state === 'error';


    // --- Progress Simulation for Layout Step ---
    const [progressIndex, setProgressIndex] = useState(0);
    useEffect(() => {
      if (stepKey === 'layout' && isRunning) {
        setProgressIndex(0);
        const totalSlides = selectedSlides.size || 1;
        const estimatedTimePerSlide = 4000; // 4s per slide estimate

        const interval = setInterval(() => {
          setProgressIndex(prev => {
            if (prev < totalSlides - 1) return prev + 1;
            return prev;
          });
        }, estimatedTimePerSlide);

        return () => clearInterval(interval);
      } else if (!isRunning && isSuccess) {
        setProgressIndex(selectedSlides.size); // Jump to full on success
      }
    }, [isRunning, stepKey, isSuccess]);

    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col gap-4 relative overflow-hidden">
        {/* ... (AI badge remains same) */}
        {isAi && (
          <div className="absolute top-0 right-0 bg-gradient-to-bl from-indigo-500 to-purple-600 text-white text-[10px] px-3 py-1 font-bold rounded-bl-xl z-20 flex items-center gap-1">
            <span className="animate-pulse">✨</span> AI POWERED
          </div>
        )}

        <div className="flex justify-between items-start">
          <div>
            <h3 className="font-semibold text-lg text-slate-900">{title}</h3>
            <p className="text-slate-500 text-sm mt-1">{description}</p>
          </div>
          {/* ... (Status icons remain same) */}
          <div className="flex items-center gap-2">
            {isSuccess && <CheckCircle className="text-green-500 w-6 h-6" />}
            {isError && <AlertCircle className="text-red-500 w-6 h-6" />}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button
            onClick={() => runStep(stepKey)}
            disabled={isRunning || !currentProjectId || !isStorageReady || !isLlmReady}
            title={!currentProjectId ? "Create a project first" : (!isLlmReady ? "Configure model settings first" : "")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors
              ${isRunning || !currentProjectId || !isStorageReady || !isLlmReady
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}
          >
            {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {isRunning ? 'Running...' : 'Run ' + title.split('. ')[1]?.split(' ')[0]}
          </button>

          {showLogToggle && (
            <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={stepKey === 'assets' ? fromLog : fromLogLayout}
                onChange={(e) => stepKey === 'assets' ? setFromLog(e.target.checked) : setFromLogLayout(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              Test from Log (No AI)
            </label>
          )}

          {/* ... (Status message remains same) */}
          <div className="flex-1 text-sm">
            {status.message && (
              <span className={`px-2 py-1 rounded-full text-xs font-semibold
                  ${isSuccess ? 'bg-green-100 text-green-700' :
                  isError ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'}`}>
                {status.message}
              </span>
            )}
          </div>
        </div>

        {/* Progress Bar (Visible only when Running and progressTotal is set) */}
        {isRunning && progressTotal && progressTotal > 0 && (
          <div className="w-full bg-slate-100 rounded-full h-1.5 mb-3 overflow-hidden">
            <div
              className="bg-indigo-600 h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${(100 / progressTotal) * (progressIndex || 0)}%`, animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' }}
            />
            <div className="text-[10px] text-center text-slate-500 mt-1">
              Generating slide {progressIndex || 1} of {progressTotal}...
            </div>
          </div>
        )}

        {children}

        {/* --- Artifacts Viewer Integration --- */}
        {showPreview && currentProjectId && (
          <StepArtifactsViewer
            projectId={currentProjectId}
            stepKey={stepKey}
            refreshTrigger={refreshArtifacts}
            onPreview={openPreview}
          />
        )}

        {/* Logs Console */}
        {(status.output || isRunning) && (
          <div className="mt-2 bg-slate-50 rounded p-3 text-xs font-mono text-slate-700 overflow-x-auto max-h-40 whitespace-pre-wrap border border-slate-200">
            {status.output ? (typeof status.output === 'string' ? status.output : JSON.stringify(status.output, null, 2)) : <span className="text-slate-400 italic">Waiting for logs...</span>}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Project List Sidebar */}
      {showProjectList && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-start">
          <div className="bg-white w-80 h-full shadow-xl overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-slate-200 px-4 py-3 flex justify-between items-center">
              <h3 className="font-semibold text-slate-900">Project History</h3>
              <button onClick={() => setShowProjectList(false)} className="text-slate-400 hover:text-slate-600">×</button>
            </div>
            <div className="p-4">
              <ProjectList onSelectProject={loadProject} selectedProjectId={currentProjectId || undefined} />
            </div>
          </div>
        </div>
      )}
      <main className="min-h-screen bg-slate-50 p-8 font-sans pb-32 flex gap-8">
        {/* ... (Brief section remains same) */}
        <div className="flex-1 max-w-4xl mx-auto">
          <header className="mb-8 flex justify-between items-start">
            <div className="flex-1">
              <h1 className="text-3xl font-bold text-slate-900">PPT Factory Workflow</h1>
              <p className="text-slate-600 mt-2">End-to-End Presentation Generation Pipeline</p>
              <p className="text-xs text-slate-500 mt-1">
                Storage: Local Filesystem
              </p>
              {currentProjectId && (
                <div className="mt-2 text-sm text-indigo-600 font-medium">
                  Current Project: {projectName}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowProjectList(true)}
                className="flex items-center gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors">
                <FolderOpen className="w-4 h-4" />
                Project History
              </button>
              <div className="h-6 w-px bg-slate-300"></div>
              <label className="text-sm font-medium text-slate-700">Model:</label>
              <div className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-700 min-w-[220px]">
                {selectedModel || 'Not configured'}
              </div>
            </div>
          </header>

          {(
            <div className="mb-8 grid gap-4">
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900">Project Save Folder</h2>
                    <p className="text-sm text-slate-600 mt-1">
                      Choose the folder where every project workspace and exported PPT file should be saved.
                    </p>
                  </div>
                  {!isStorageReady && (
                    <span className="px-2 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
                      Setup Required
                    </span>
                  )}
                </div>
                <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                  This is required. Generation stays locked until a writable folder is saved here.
                </div>
                <div className="mt-4 flex flex-col gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Project save folder</label>
                    <div className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900">
                      {projectRoot || 'No folder selected yet.'}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={pickProjectRoot}
                      disabled={isSavingSettings}
                      className="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isSavingSettings ? 'Opening...' : 'Choose Folder'}
                    </button>
                    {projectRootInput.trim() && projectRootInput !== projectRoot && (
                      <button
                        onClick={saveProjectRoot}
                        disabled={isSavingSettings || !projectRootInput.trim()}
                        className="bg-white border border-slate-300 text-slate-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Save Typed Path
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-3 text-xs text-slate-500">
                  {projectRoot ? `Current folder: ${projectRoot}` : 'No project folder configured yet.'}
                </div>
                {settingsMessage && (
                  <div className={`mt-2 text-xs font-medium ${isStorageReady ? 'text-emerald-600' : 'text-amber-700'}`}>
                    {settingsMessage}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="mb-8 bg-white rounded-xl shadow-sm border border-slate-200 p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Model Settings</h2>
                <p className="text-sm text-slate-600 mt-1">
                  Configure the API credentials and model used for generation.
                </p>
              </div>
              {!isLlmReady && (
                <span className="px-2 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
                  API Required
                </span>
              )}
            </div>
            <div className="mt-4 grid gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">LLM API key</label>
                <input
                  type="password"
                  value={llmApiKey}
                  onChange={(e) => setLlmApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Base URL</label>
                <input
                  type="text"
                  value={llmBaseUrl}
                  onChange={(e) => setLlmBaseUrl(e.target.value)}
                  placeholder="Optional. Example: https://api.openai.com/v1"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Model name</label>
                <input
                  type="text"
                  value={llmModel}
                  onChange={(e) => {
                    setLlmModel(e.target.value);
                    setSelectedModel(e.target.value);
                  }}
                  placeholder="gpt-4o-mini / gemini-3-flash-preview / etc."
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
                />
              </div>
            </div>
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={saveLlmSettings}
                disabled={isSavingLlmSettings || !llmApiKey.trim() || !llmModel.trim()}
                className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSavingLlmSettings ? 'Saving...' : 'Save Model Settings'}
              </button>
              {llmSettingsMessage && (
                <span className={`text-xs font-medium ${isLlmReady ? 'text-emerald-600' : 'text-amber-700'}`}>
                  {llmSettingsMessage}
                </span>
              )}
            </div>
          </div>

          <div className="grid gap-8">

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col gap-4">
              <div>
                <h3 className="font-semibold text-lg text-slate-900">0.0 Project</h3>
                <p className="text-slate-500 text-sm mt-1">
                  Create the project explicitly before drafting content, uploading images, or running generation steps.
                </p>
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
                  placeholder="Project name..."
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                />
                <button
                  onClick={createProject}
                  disabled={!isStorageReady || !isLlmReady || Boolean(currentProjectId)}
                  title={currentProjectId ? 'Project already created' : ''}
                  className="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {currentProjectId ? 'Project Ready' : 'Create Project'}
                </button>
              </div>

              <div className="text-xs text-slate-500">
                {currentProjectId ? `Project ID: ${currentProjectId}` : 'No project created yet.'}
              </div>
            </div>

            <div className="flex justify-center -my-4 relative z-10">
              <div className="bg-slate-200 rounded-full p-2">
                <ArrowRight className="text-slate-400 w-5 h-5" />
              </div>
            </div>

            {/* STEP 0.1: CONTENT DRAFT */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col gap-4 relative overflow-hidden">
              <div className="absolute top-0 right-0 bg-gradient-to-bl from-blue-500 to-cyan-500 text-white text-[10px] px-3 py-1 font-bold rounded-bl-xl z-20 flex items-center gap-1">
                AI POWERED
              </div>
              <div>
                <h3 className="font-semibold text-lg text-slate-900">0.1 Content Draft</h3>
                <p className="text-slate-500 text-sm mt-1">
                  Expand one-liner into detailed content structure.
                </p>
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
                  placeholder="Describe your presentation..."
                  value={userPrompt}
                  onChange={(e) => setUserPrompt(e.target.value)}
                />
                <button
                  onClick={generateDraft}
                  disabled={!isStorageReady || !isLlmReady || isDraftLoading || !currentProjectId}
                  className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 flex items-center gap-2"
                >
                  {isDraftLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Edit className="w-4 h-4" />}
                  {isDraftLoading ? 'Drafting...' : 'Generate New Draft'}
                </button>
                <button
                  onClick={saveDraftManual}
                  disabled={!isStorageReady || !isLlmReady || !draftJson || !currentProjectId}
                  className="bg-white border border-slate-300 text-slate-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-slate-50 flex items-center gap-2"
                  title="Save current draft edits to project storage"
                >
                  <Save className="w-4 h-4" /> Save Draft
                </button>
              </div>

              {draftMessage && <span className="text-xs text-blue-600 font-medium">{draftMessage}</span>}

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-3">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900">Project Images</h4>
                    <p className="mt-1 text-xs text-slate-600">
                      Upload local images into this project before drafting. The draft step will only arrange images from this library and should write the exact file name into each `visual.image_file_name`.
                    </p>
                  </div>
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    Use semantic names like `factory-floor-team`, `customer-app-login`, or `regional-sales-map` so the content draft can place them reliably.
                  </div>
                  <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600">Semantic file name</label>
                      <input
                        type="text"
                        value={imageSemanticName}
                        onChange={(e) => setImageSemanticName(e.target.value)}
                        placeholder="factory-floor-team"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600">Local image file</label>
                      <input
                        ref={imageInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        onChange={(e) => setSelectedImageFile(e.target.files?.[0] || null)}
                        className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700"
                      />
                    </div>
                    <button
                      onClick={uploadProjectImage}
                      disabled={!isStorageReady || !currentProjectId || isUploadingImage || !selectedImageFile || !imageSemanticName.trim()}
                      title={!isStorageReady ? 'Save Project Folder first' : (!currentProjectId ? 'Create a project first' : (!selectedImageFile ? 'Choose an image file first' : (!imageSemanticName.trim() ? 'Enter a semantic file name first' : '')))}
                      className="self-end rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isUploadingImage ? 'Uploading...' : 'Upload Image'}
                    </button>
                  </div>
                  {!currentProjectId && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Create the project first. Uploaded images belong to a specific project workspace.
                    </div>
                  )}
                  {!isStorageReady && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Upload is disabled until `Project Save Folder` is configured above, because images are stored inside each local project folder.
                    </div>
                  )}
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-700">Uploaded images</span>
                      {isLoadingImages && <span className="text-[11px] text-slate-500">Loading...</span>}
                    </div>
                    {projectImages.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {projectImages.map((asset) => (
                          <span key={asset.fileName} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700">
                            <ImagePlus className="h-3 w-3" />
                            {asset.fileName}
                            {asset.orientation && asset.orientation !== 'unknown' ? ` · ${asset.orientation}` : ''}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500">
                        No project images yet. Upload images here if you want the draft to place real visuals by file name.
                      </p>
                    )}
                  </div>
                  {imageUploadMessage && (
                    <span className="text-xs font-medium text-indigo-600">{imageUploadMessage}</span>
                  )}
                </div>
              </div>

              <textarea
                className="w-full h-40 border border-slate-200 rounded-lg p-3 text-xs font-mono bg-slate-50 focus:bg-white transition-colors text-slate-900"
                value={draftJson}
                onChange={(e) => setDraftJson(e.target.value)}
                placeholder="Generated content draft will appear here..."
              />
            </div>

            <div className="flex justify-center -my-4 relative z-10">
              <div className="bg-slate-200 rounded-full p-2">
                <ArrowRight className="text-slate-400 w-5 h-5" />
              </div>
            </div>


            {/* STEP 0.2: DESIGN BRIEF (AI POWERED) */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col gap-4 relative overflow-hidden">
              <div className="absolute top-0 right-0 bg-gradient-to-bl from-indigo-500 to-purple-600 text-white text-[10px] px-3 py-1 font-bold rounded-bl-xl z-20 flex items-center gap-1">
                <span className="animate-pulse">✨</span> AI POWERED
              </div>

              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-semibold text-lg text-slate-900">0.2 Design Brief</h3>
                  <p className="text-slate-500 text-sm mt-1">
                    Translate content draft into Visual Design Specs.
                  </p>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={generateBrief}
                  disabled={!isStorageReady || !isLlmReady || isBriefLoading || !draftJson || !currentProjectId}
                  className="bg-purple-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-purple-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={!currentProjectId ? "Create a project first" : ""}
                >
                  {isBriefLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  Generate Visual DNA Brief
                </button>
              </div>

              <div className="flex gap-2">
                {/* Project Name Input Removed */}
                {projectName && (
                  <div className="flex-1 px-3 py-2 text-sm text-slate-700 font-medium">
                    Project: {projectName}
                  </div>
                )}
              </div>

              <div className="relative">
                <textarea
                  className="w-full h-40 border border-slate-200 rounded-lg p-3 text-xs font-mono bg-slate-50 focus:bg-white transition-colors text-slate-900"
                  value={briefJson}
                  onChange={(e) => setBriefJson(e.target.value)}
                  placeholder="Final Design Brief..."
                />
                <div className="absolute bottom-2 right-2 flex gap-2">
                  <button
                    onClick={saveBrief}
                    className="bg-white border border-slate-200 shadow-sm text-slate-700 px-3 py-1 rounded text-xs font-medium hover:bg-slate-50 flex items-center gap-1"
                  >
                    <Save className="w-3 h-3" /> Save Changes
                  </button>
                  {briefMessage && <span className="bg-indigo-100 text-indigo-700 px-2 py-1 rounded text-xs">{briefMessage}</span>}
                </div>
              </div>
            </div>

            {/* ... (Arrows) */}
            <div className="flex justify-center -my-4 relative z-10">
              <div className="bg-slate-200 rounded-full p-2">
                <ArrowRight className="text-slate-400 w-5 h-5" />
              </div>
            </div>

            <PipelineNode
              title="1. Visual DNA (Style Engine)"
              stepKey="dna"
              description="Generates CSS Theme (Visual DNA) from Brief using RAG + LLM."
              isAi={true}
            />

            <div className="flex justify-center -my-4 relative z-10">
              <div className="bg-slate-200 rounded-full p-2">
                <ArrowRight className="text-slate-400 w-5 h-5" />
              </div>
            </div>

            <PipelineNode
              title="1.5 Generate Assets (HTML Bricks)"
              stepKey="assets"
              description="Constructs Reusable HTML Components from Visual DNA"
              isAi={true}
              showPreview={true}
              showLogToggle={true}
            />

            <div className="flex justify-center -my-4 relative z-10">
              <div className="bg-slate-200 rounded-full p-2">
                <ArrowRight className="text-slate-400 w-5 h-5" />
              </div>
            </div>

            <PipelineNode
              title="2. Layout Architect"
              stepKey="layout"
              description="Assembles HTML Layouts using Visual DNA + Components + Layout Structure"
              isAi={true}
              showPreview={true}
              showLogToggle={true}
              progressTotal={selectedSlides.size}
            >
              {/* Slide Selection UI */}
              {availableSlides.length > 0 && (
                <div className="mt-2 border-t border-slate-100 pt-3">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-semibold text-slate-700">Select Slides to Generate: ({selectedSlides.size}/{availableSlides.length})</span>
                    <div className="flex gap-2">
                      <button onClick={selectAllSlides} className="text-[10px] text-indigo-600 hover:underline">All</button>
                      <button onClick={deselectAllSlides} className="text-[10px] text-slate-500 hover:underline">None</button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
                    {availableSlides.map(slide => (
                      <label key={slide.id} className={`
                        flex items-center gap-2 px-2 py-1 rounded text-xs border cursor-pointer select-none transition-colors
                        ${selectedSlides.has(slide.id) ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}
                      `}>
                        <input
                          type="checkbox"
                          className="w-3 h-3 rounded border-gray-300 text-indigo-600 focus:ring-offset-0 focus:ring-0"
                          checked={selectedSlides.has(slide.id)}
                          onChange={() => toggleSlideSelection(slide.id)}
                        />
                        <span className="font-mono">{slide.id}</span>
                        <span className="truncate max-w-[100px]" title={slide.title}>{slide.title}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </PipelineNode>

            <div className="flex justify-center -my-4 relative z-10">
              <div className="bg-slate-200 rounded-full p-2">
                <ArrowRight className="text-slate-400 w-5 h-5" />
              </div>
            </div>

            <PipelineNode
              title="3. Html Validation (Linter)"
              stepKey="metrics"
              description="Validates HTML against PPTX constraints using lint_ppt_html.py."
            />

            <div className="flex justify-center -my-4 relative z-10">
              <div className="bg-slate-200 rounded-full p-2">
                <ArrowRight className="text-slate-400 w-5 h-5" />
              </div>
            </div>

            <PipelineNode
              title="4. PPTX Assembly (Native)"
              stepKey="assembly"
              description="Generates native PPTX directly from HTML using html2pptx.js."
              showPreview={true}
            >
              {/* Slide Selection UI */}
              {availableSlides.length > 0 && (
                <div className="mt-2 border-t border-slate-100 pt-3">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-semibold text-slate-700">Select Slides to Assemble: ({selectedSlides.size}/{availableSlides.length})</span>
                    <div className="flex gap-2">
                      <button onClick={selectAllSlides} className="text-[10px] text-indigo-600 hover:underline">All</button>
                      <button onClick={deselectAllSlides} className="text-[10px] text-slate-500 hover:underline">None</button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
                    {availableSlides.map(slide => (
                      <label key={slide.id} className={`
                        flex items-center gap-2 px-2 py-1 rounded text-xs border cursor-pointer select-none transition-colors
                        ${selectedSlides.has(slide.id) ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}
                      `}>
                        <input
                          type="checkbox"
                          className="w-3 h-3 rounded border-gray-300 text-indigo-600 focus:ring-offset-0 focus:ring-0"
                          checked={selectedSlides.has(slide.id)}
                          onChange={() => toggleSlideSelection(slide.id)}
                        />
                        <span className="font-mono">{slide.id}</span>
                        <span className="truncate max-w-[100px]" title={slide.title}>{slide.title}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </PipelineNode>

            <div className="flex justify-center -my-4 relative z-10">
              <div className="bg-slate-200 rounded-full p-2">
                <ArrowRight className="text-slate-400 w-5 h-5" />
              </div>
            </div>

            <PipelineNode
              title="5. Quality Control"
              stepKey="qc"
              description="Inspects the generated PPTX for consistency."
            />
          </div>
        </div>

        {/* PREVIEW PANEL */}
        {/* FULL SCREEN MODAL PREVIEW */}
        {previewFile && (
          <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm">
            <div className="bg-white rounded-xl shadow-2xl flex flex-col w-full max-w-[1400px] h-[90vh] overflow-hidden">
              <div className="bg-slate-50 border-b border-slate-200 px-4 py-3 flex justify-between items-center shrink-0">
                <div className="flex items-center gap-4">
                  <h3 className="font-bold text-slate-800">Preview: {previewFile}</h3>
                  <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-1 rounded">
                    Native Resolution: 1280 x 720
                  </span>
                  {!previewFile.includes('components') && previewSequence.length > 1 && previewIndex >= 0 && (
                    <span className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded">
                      {previewIndex + 1} / {previewSequence.length}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {!previewFile.includes('components') && previewSequence.length > 1 && (
                    <>
                      <button
                        onClick={goToPrevPreview}
                        disabled={!canGoPrev}
                        className="bg-white hover:bg-slate-100 text-slate-600 px-3 py-1 rounded border border-slate-200 transition-colors text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Prev
                      </button>
                      <button
                        onClick={goToNextPreview}
                        disabled={!canGoNext}
                        className="bg-white hover:bg-slate-100 text-slate-600 px-3 py-1 rounded border border-slate-200 transition-colors text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Next
                      </button>
                    </>
                  )}
                  <button
                    onClick={closePreview}
                    className="bg-white hover:bg-slate-100 text-slate-500 hover:text-red-500 px-3 py-1 rounded border border-slate-200 transition-colors text-sm font-medium"
                  >
                    Close Preview (Esc)
                  </button>
                </div>
              </div>

              <div className={`flex-1 bg-slate-200 ${previewFile.includes('components') ? 'overflow-hidden' : 'overflow-auto'} flex ${previewFile.includes('components') ? 'items-start' : 'items-center'} justify-center`}>
                {previewFile.includes('components') ? (
                  /* Components: Scrollable Vertical Flow - Let the iframe handle the scroll */
                  <iframe
                    src={`/api/preview?file=${previewFile}${currentProjectId ? `&projectId=${currentProjectId}` : ''}`}
                    className="w-full h-full border-none block"
                    title="Components Preview"
                  />
                ) : (
                  /* Slide: Fixed 16:9 Presentation (1:1 Scale) */
                  <div className="bg-white shadow-[0_20px_50px_rgba(0,0,0,0.3)] shrink-0 p-8">
                    <div style={{ width: '1280px', height: '720px' }}>
                      {/*
                        Smart Preview Logic:
                        If we have inline content (Base64 images) from the API response, use srcDoc.
                        Otherwise, fallback to fetching by URL (which might fail for relative images).
                      */}
                      <iframe
                        srcDoc={
                          pipelineState.layout.output &&
                            (pipelineState.layout.output as any).preview_content &&
                            (pipelineState.layout.output as any).preview_content[previewFile]
                            ? (pipelineState.layout.output as any).preview_content[previewFile]
                            : undefined
                        }
                        src={
                          !pipelineState.layout.output ||
                            !(pipelineState.layout.output as any).preview_content ||
                            !(pipelineState.layout.output as any).preview_content[previewFile]
                            ? `/api/preview?file=${previewFile}${currentProjectId ? `&projectId=${currentProjectId}` : ''}`
                            : undefined
                        }
                        className="w-full h-full border-none"
                        title="Slide Preview"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
