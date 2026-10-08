interface SidebarToggleProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function SidebarToggle({ collapsed, onToggle }: SidebarToggleProps) {
  return (
    <button
      onClick={onToggle}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      className="p-2 rounded cursor-pointer"
      style={{ color: 'rgba(255,255,255,0.6)', backgroundColor: 'transparent', border: 'none' }}
    >
      {collapsed ? '\u2630' : '\u2715'}
    </button>
  );
}
