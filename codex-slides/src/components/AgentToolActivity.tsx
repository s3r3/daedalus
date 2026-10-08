"use client";

import {
  CaretDown,
  CaretRight,
  CheckCircle,
  Circle,
  CircleNotch,
  FileText,
  Files,
  ListChecks,
  MagnifyingGlass,
  PencilSimple,
  TerminalWindow,
  Wrench,
  XCircle,
} from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { DesignFileReferenceList } from "@/components/DesignFileReferenceList";
import type { AgentToolCall, AgentToolKind } from "@/lib/agentActivity";
import { useI18n } from "@/i18n/I18nProvider";

interface AgentToolActivityProps {
  tool: AgentToolCall;
  onOpenDesignFile?: (relativePath: string) => void;
}

function resolvedKind(tool: AgentToolCall): AgentToolKind {
  if (tool.kind) return tool.kind;
  const name = tool.name.toLowerCase();
  if (/todo|task/.test(name)) return "todo";
  if (/bash|shell|terminal|command/.test(name)) return "bash";
  if (/read|load|open_file/.test(name)) return "read";
  if (/write|create_file/.test(name)) return "write";
  if (/edit|patch|regenerate|mark/.test(name)) return "edit";
  if (/search|find|grep/.test(name)) return "search";
  if (/files?|artifact/.test(name)) return "files";
  return "tool";
}

function toolIcon(kind: AgentToolKind): ReactNode {
  if (kind === "read") return <FileText size={13} />;
  if (kind === "write" || kind === "edit") return <PencilSimple size={13} />;
  if (kind === "bash") return <TerminalWindow size={13} />;
  if (kind === "todo") return <ListChecks size={13} />;
  if (kind === "files") return <Files size={13} />;
  if (kind === "search") return <MagnifyingGlass size={13} />;
  return <Wrench size={13} />;
}

function statusIcon(tool: AgentToolCall) {
  if (tool.state === "running") return <CircleNotch size={14} className="spin" />;
  if (tool.state === "complete") return <CheckCircle size={14} weight="fill" />;
  if (tool.state === "error") return <XCircle size={14} weight="fill" />;
  return <Circle size={14} />;
}

export function AgentToolActivity({ tool, onOpenDesignFile }: AgentToolActivityProps) {
  const { t } = useI18n();
  const kind = resolvedKind(tool);
  const hasDetails = Boolean(tool.path || tool.command || tool.output || tool.todos?.length || tool.files?.length);
  const [open, setOpen] = useState(tool.state === "running" || kind === "todo");
  const status = tool.state === "running"
    ? t("chat.toolRunning")
    : tool.state === "complete"
      ? t("chat.toolDone")
      : tool.state === "error"
        ? t("chat.toolFailed")
        : t("chat.toolWaiting");

  const header = (
    <>
      <span className="agent-tool-icon" aria-hidden="true">{statusIcon(tool)}</span>
      <span className="agent-tool-copy">
        <span>{toolIcon(kind)}<code>{tool.name}</code></span>
        <strong>{tool.label}</strong>
        {tool.detail ? <small>{tool.detail}</small> : null}
      </span>
      <span className="agent-tool-status">{status}</span>
      {hasDetails ? <span className="agent-tool-chevron" aria-hidden="true">{open ? <CaretDown size={12} /> : <CaretRight size={12} />}</span> : null}
    </>
  );

  return (
    <div className={`agent-tool ${tool.state} kind-${kind}`}>
      {hasDetails ? (
        <button
          type="button"
          className="agent-tool-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {header}
        </button>
      ) : <div className="agent-tool-toggle static">{header}</div>}
      {hasDetails && open ? (
        <div className="agent-tool-details">
          {tool.path ? (
            <div className="agent-tool-path-row">
              <code title={tool.path}>{tool.path}</code>
              {tool.relativePath && onOpenDesignFile ? (
                <button type="button" onClick={() => onOpenDesignFile(tool.relativePath!)}>
                  {t("chat.openFile")}
                </button>
              ) : null}
            </div>
          ) : null}
          {tool.command ? <pre className="agent-tool-command"><code>$ {tool.command}</code></pre> : null}
          {tool.output ? <pre className="agent-tool-output"><code>{tool.output}</code></pre> : null}
          {tool.todos?.length ? (
            <ul className="agent-tool-todos">
              {tool.todos.map((todo) => (
                <li className={todo.status} key={todo.id}>
                  <span aria-hidden="true">
                    {todo.status === "complete" ? <CheckCircle size={14} weight="fill" /> : todo.status === "in_progress" ? <CircleNotch size={14} className="spin" /> : todo.status === "error" ? <XCircle size={14} weight="fill" /> : <Circle size={14} />}
                  </span>
                  <span>{todo.content}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {tool.files?.length ? (
            <DesignFileReferenceList files={tool.files} compact onOpen={onOpenDesignFile} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
