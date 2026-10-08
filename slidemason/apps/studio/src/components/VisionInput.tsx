interface VisionInputProps {
  value: string;
  onChange: (value: string) => void;
}

export function VisionInput({ value, onChange }: VisionInputProps) {
  return (
    <div>
      <p style={{
        color: '#888', fontSize: '0.7rem', lineHeight: 1.4, margin: '0 0 8px',
      }}>
        What are you thinking for this presentation? Key points, ideas, structure, anything the AI should know.
      </p>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="e.g. Start with the market opportunity, then show our traction metrics. Include an ROI slide. Skip competitor comparisons. End with a clear funding ask..."
        style={{
          width: '100%',
          minHeight: '120px',
          padding: '10px 12px',
          fontSize: '0.8rem',
          lineHeight: 1.5,
          backgroundColor: '#2a2a3e',
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '6px',
          outline: 'none',
          boxSizing: 'border-box',
          resize: 'vertical',
          fontFamily: 'inherit',
        }}
      />
    </div>
  );
}
