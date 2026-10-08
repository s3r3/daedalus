import {
  ResponsiveContainer,
  BarChart, Bar,
  LineChart, Line,
  AreaChart, Area,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend,
} from 'recharts';

function getChartColors(): string[] {
  if (typeof window === 'undefined') {
    return ['#8b5cf6', '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4'];
  }
  const style = getComputedStyle(document.documentElement);
  return [1, 2, 3, 4, 5, 6].map(
    (i) => style.getPropertyValue(`--sm-chart-${i}`).trim() || '#8b5cf6',
  );
}

function getThemeColor(varName: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || fallback;
}

function ThemedTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: getThemeColor('--sm-glass-bg', 'rgba(0,0,0,0.8)'),
        backdropFilter: 'blur(12px)',
        border: `1px solid ${getThemeColor('--sm-border', '#333')}`,
        borderRadius: getThemeColor('--sm-radius', '0.5rem'),
        padding: '8px 12px',
        fontSize: '0.75rem',
        color: getThemeColor('--sm-text', '#fff'),
      }}
    >
      {label && <div style={{ fontWeight: 600, marginBottom: '4px' }}>{label}</div>}
      {payload.map((entry: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: entry.color, flexShrink: 0 }} />
          <span style={{ color: getThemeColor('--sm-muted', '#aaa') }}>{entry.name}:</span>
          <span style={{ fontWeight: 600 }}>{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

interface ChartProps {
  type: 'bar' | 'line' | 'area' | 'pie';
  data: Record<string, string | number>[];
  xKey?: string;
  series?: string[];
  height?: number;
  showAxes?: boolean;
  showLegend?: boolean;
  stacked?: boolean;
  style?: React.CSSProperties;
}

export function Chart({
  type = 'bar',
  data = [],
  xKey = 'label',
  series: seriesProp,
  height = 260,
  showAxes = false,
  showLegend = false,
  stacked = false,
  style,
}: ChartProps) {
  const colors = getChartColors();

  const series = seriesProp || (data.length > 0
    ? Object.keys(data[0]).filter(k => k !== xKey && typeof data[0][k] === 'number')
    : []);

  const axisColor = getThemeColor('--sm-muted', '#666');
  const axisProps = {
    tick: { fill: axisColor, fontSize: 11 },
    axisLine: { stroke: axisColor, strokeOpacity: 0.3 },
    tickLine: false,
  };

  if (type === 'pie') {
    return (
      <div data-pptx-type="chart" data-pptx-chart-type="pie" style={style}>
        <ResponsiveContainer width="100%" height={height}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey={xKey}
              cx="50%"
              cy="50%"
              outerRadius="80%"
              strokeWidth={0}
              label={(props: any) => `${props.name} ${((props.percent ?? 0) * 100).toFixed(0)}%`}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={colors[i % colors.length]} />
              ))}
            </Pie>
            <RechartsTooltip content={<ThemedTooltip />} />
            {showLegend && <Legend />}
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  const ChartContainer = type === 'bar' ? BarChart : type === 'area' ? AreaChart : LineChart;

  return (
    <div data-pptx-type="chart" data-pptx-chart-type={type} style={style}>
      <ResponsiveContainer width="100%" height={height}>
        <ChartContainer data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
          {showAxes && <CartesianGrid strokeDasharray="3 3" stroke={axisColor} strokeOpacity={0.15} />}
          <XAxis dataKey={xKey} {...axisProps} hide={!showAxes} />
          <YAxis {...axisProps} hide={!showAxes} />
          <RechartsTooltip content={<ThemedTooltip />} />
          {showLegend && <Legend />}
          {series.map((key, i) => {
            const color = colors[i % colors.length];
            if (type === 'bar') {
              return (
                <Bar
                  key={key}
                  dataKey={key}
                  fill={color}
                  radius={[4, 4, 0, 0]}
                  stackId={stacked ? 'stack' : undefined}
                />
              );
            }
            if (type === 'area') {
              return (
                <Area
                  key={key}
                  type="monotone"
                  dataKey={key}
                  stroke={color}
                  fill={color}
                  fillOpacity={0.2}
                  strokeWidth={2}
                  stackId={stacked ? 'stack' : undefined}
                />
              );
            }
            return (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                stroke={color}
                strokeWidth={2}
                dot={{ r: 3, fill: color }}
                activeDot={{ r: 5 }}
              />
            );
          })}
        </ChartContainer>
      </ResponsiveContainer>
    </div>
  );
}
