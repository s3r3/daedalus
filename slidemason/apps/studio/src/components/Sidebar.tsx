import { useState, type ReactNode } from 'react';
import { SidebarToggle } from './SidebarToggle';

interface SidebarProps {
  children?: ReactNode;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function Sidebar({ children, onCollapsedChange }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    onCollapsedChange?.(next);
  };

  return (
    <aside
      style={{
        width: collapsed ? 48 : 320,
        minWidth: collapsed ? 48 : 320,
        transition: 'width 0.2s ease, min-width 0.2s ease',
        backgroundColor: '#1a1a2e',
        borderRight: '1px solid rgba(255,255,255,0.1)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div style={{
        padding: '12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'space-between',
      }}>
        {!collapsed && (
          <span style={{ fontWeight: 700, fontSize: '1.1rem', color: '#fff' }}>Slidemason</span>
        )}
        <SidebarToggle collapsed={collapsed} onToggle={toggle} />
      </div>
      {!collapsed && (
        <div className="sidebar-scroll" style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
          {children}
        </div>
      )}
    </aside>
  );
}
