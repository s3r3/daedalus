'use client';

import React from 'react';
import { Clock, FileText, CheckCircle, AlertCircle, Loader } from 'lucide-react';

interface Project {
    id: string;
    created_at: string;
    project_name: string;
    status: 'draft' | 'processing' | 'completed' | 'error';
    brief_json: any;
}

interface ProjectListProps {
    onSelectProject: (project: Project) => void;
    selectedProjectId?: string;
}

export default function ProjectList({ onSelectProject, selectedProjectId }: ProjectListProps) {
    const [projects, setProjects] = React.useState<Project[]>([]);
    const [loading, setLoading] = React.useState(true);
    const locale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';

    React.useEffect(() => {
        fetchProjects();
    }, []);

    const fetchProjects = async () => {
        try {
            const res = await fetch('/api/projects');
            const data = await res.json();
            if (data.success) {
                setProjects(data.projects);
            }
        } catch (error) {
            console.error('Failed to fetch projects:', error);
        } finally {
            setLoading(false);
        }
    };

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'completed':
                return <CheckCircle className="w-4 h-4 text-green-500" />;
            case 'error':
                return <AlertCircle className="w-4 h-4 text-red-500" />;
            case 'processing':
                return <Loader className="w-4 h-4 text-blue-500 animate-spin" />;
            default:
                return <FileText className="w-4 h-4 text-slate-400" />;
        }
    };

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        return new Intl.DateTimeFormat(locale, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }).format(date);
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-32">
                <Loader className="w-6 h-6 animate-spin text-slate-400" />
            </div>
        );
    }

    if (projects.length === 0) {
        return (
            <div className="text-center text-slate-400 text-sm py-8">
                No projects yet.<br />Create your first project to get started.
            </div>
        );
    }

    return (
        <div className="space-y-2">
            {projects.map((project) => (
                <button
                    key={project.id}
                    onClick={() => onSelectProject(project)}
                    className={`w-full text-left p-3 rounded-lg border transition-all ${selectedProjectId === project.id
                            ? 'bg-indigo-50 border-indigo-300'
                            : 'bg-white border-slate-200 hover:border-indigo-200 hover:bg-slate-50'
                        }`}
                >
                    <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                            <h4 className="font-medium text-sm text-slate-900 truncate">
                                {project.project_name}
                            </h4>
                            <div className="flex items-center gap-1 mt-1 text-xs text-slate-500">
                                <Clock className="w-3 h-3" />
                                {formatDate(project.created_at)}
                            </div>
                        </div>
                        {getStatusIcon(project.status)}
                    </div>
                </button>
            ))}
        </div>
    );
}
