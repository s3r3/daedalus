import { FileText, Eye, ChevronDown, ChevronRight, RefreshCw, Monitor, Download } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

interface GeneratedFile {
    id: string;
    file_name: string;
    file_type: string;
    file_size: number | null;
    created_at: string;
    version: number;
    is_current: boolean | null;
    storage_path: string;
}

interface StepArtifactsViewerProps {
    projectId: string;
    stepKey: string;
    refreshTrigger?: number;
    onPreview: (fileName: string, orderedFiles: string[]) => void;
}

export default function StepArtifactsViewer({ projectId, stepKey, refreshTrigger, onPreview }: StepArtifactsViewerProps) {
    const [files, setFiles] = useState<GeneratedFile[]>([]);
    const [groupedFiles, setGroupedFiles] = useState<Record<string, GeneratedFile[]>>({});
    const [loading, setLoading] = useState(false);
    const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

    const groupFiles = (fileList: GeneratedFile[]) => {
        const groups: Record<string, GeneratedFile[]> = {};
        fileList.forEach(f => {
            if (!groups[f.file_name]) {
                groups[f.file_name] = [];
            }
            groups[f.file_name].push(f);
        });
        setGroupedFiles(groups);
    };

    const fetchFiles = useCallback(async () => {
        setLoading(true);
        try {
            const pathPrefix = `${projectId}/${stepKey}/`;
            const res = await fetch(`/api/projects/${projectId}`);
            const payload = await res.json();

            if (!payload.success) {
                console.error(`Error fetching artifacts for ${stepKey}:`, payload.error);
            } else {
                const data = (payload.project?.generated_files || []).filter((file: GeneratedFile) =>
                    file.storage_path.startsWith(pathPrefix)
                ).filter((file: GeneratedFile) => file.file_name !== 'index.html');
                setFiles(data);
                groupFiles(data);
            }
        } catch (error) {
            console.error(`Error fetching artifacts for ${stepKey}:`, error);
        }
        setLoading(false);
    }, [projectId, stepKey]);

    useEffect(() => {
        if (projectId && stepKey) {
            const timer = window.setTimeout(() => {
                void fetchFiles();
            }, 0);
            return () => window.clearTimeout(timer);
        }
    }, [projectId, stepKey, refreshTrigger, fetchFiles]);

    const toggleExpand = (fileName: string) => {
        const newSet = new Set(expandedFiles);
        if (newSet.has(fileName)) {
            newSet.delete(fileName);
        } else {
            newSet.add(fileName);
        }
        setExpandedFiles(newSet);
    };

    const orderedHtmlFiles = Object.keys(groupedFiles)
        .filter((fileName) => fileName.endsWith('.html'))
        .sort();

    if (loading && files.length === 0) {
        return <div className="text-xs text-slate-500 animate-pulse mt-2">Loading artifacts...</div>;
    }

    if (Object.keys(groupedFiles).length === 0) {
        return null; // Don't show anything if no files (cleaner UI)
    }

    return (
        <div className="mt-4 border-t border-slate-100 pt-3">
            <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                    <FileText className="w-3 h-3" /> Result Artifacts
                </span>
                <button
                    onClick={fetchFiles}
                    className="text-[10px] text-slate-400 hover:text-indigo-600 transition-colors flex items-center gap-1"
                    title="Refresh List"
                >
                    <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            <div className="grid grid-cols-1 gap-2 max-h-60 overflow-y-auto pr-1 custom-scrollbar">
                {Object.entries(groupedFiles).map(([fileName, versions]) => {
                    const latest = versions.find(v => v.is_current) || versions[0];
                    const isExpanded = expandedFiles.has(fileName);
                    const history = versions.filter(v => v.version !== latest.version);
                    const isHtml = fileName.endsWith('.html');

                    return (
                        <div key={fileName} className="group border border-slate-200 rounded bg-white hover:border-indigo-200 transition-colors">
                            <div className="flex justify-between items-center p-2">
                                <div className="flex items-center gap-2 overflow-hidden">
                                    {/* Icon based on type */}
                                    {isHtml ? <Monitor className="w-3 h-3 text-indigo-500 shrink-0" /> : <FileText className="w-3 h-3 text-slate-400 shrink-0" />}

                                    <div className="flex flex-col min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span
                                                className="text-xs text-slate-700 font-medium truncate cursor-pointer hover:text-indigo-600"
                                                onClick={() => isHtml ? onPreview(latest.file_name, orderedHtmlFiles) : window.open(`/api/preview?file=${latest.file_name}&projectId=${projectId}&download=true`, '_blank')}
                                                title={fileName}
                                            >
                                                {fileName}
                                            </span>
                                            {latest.version > 1 && (
                                                <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 rounded-full">v{latest.version}</span>
                                            )}
                                        </div>
                                        <span className="text-[10px] text-slate-400">
                                            {latest.file_size ? `${(latest.file_size / 1024).toFixed(1)} KB` : '0 KB'} • {new Date(latest.created_at).toLocaleTimeString()}
                                        </span>
                                    </div>
                                </div>

                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                        onClick={() => isHtml ? onPreview(latest.file_name, orderedHtmlFiles) : window.open(`/api/preview?file=${latest.file_name}&projectId=${projectId}&download=true`, '_blank')}
                                        className="p-1 hover:bg-slate-100 rounded text-slate-500 hover:text-indigo-600 transition-colors"
                                        title={isHtml ? "Preview" : "Download"}
                                    >
                                        {isHtml ? <Eye className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5" />}
                                    </button>

                                    {history.length > 0 && (
                                        <button
                                            onClick={() => toggleExpand(fileName)}
                                            className="p-1 hover:bg-slate-100 rounded text-slate-400 transition-colors"
                                        >
                                            {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* History Expansion */}
                            {isExpanded && history.length > 0 && (
                                <div className="bg-slate-50 border-t border-slate-100 p-2 space-y-1">
                                    {history.map(ver => (
                                        <div key={ver.id} className="flex justify-between items-center text-[10px] text-slate-500 pl-6 relative">
                                            <div className="absolute left-2 top-1/2 -mt-px w-3 h-px bg-slate-300"></div>
                                            <span>v{ver.version} - {new Date(ver.created_at).toLocaleString()}</span>
                                            <span className="italic text-slate-400">Archived</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
