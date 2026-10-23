import { useId } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line,
  Pie, PieChart, PolarAngleAxis, RadialBar, RadialBarChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

export interface PulseDatum {
  label: string;
  outputs: number;
  ideas: number;
  total: number;
}

export interface FunnelDatum {
  label: string;
  value: number;
  color: string;
}

export interface MixDatum {
  label: string;
  value: number;
  color: string;
}

const tooltipStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  boxShadow: 'var(--shadow-md)',
  color: 'var(--text)',
  fontSize: 11,
  padding: '7px 10px',
};

const tooltipLabelStyle = {
  color: 'var(--text-secondary)',
  fontSize: 10,
  marginBottom: 3,
};

const tooltipItemStyle = {
  fontSize: 11,
  padding: 0,
};

export function PulseChart({ data }: { data: PulseDatum[] }) {
  const uid = useId().replace(/:/g, '');
  const tickInterval = data.length > 20 ? 4 : data.length > 10 ? 1 : 0;
  const barSize = data.length > 20 ? 6 : data.length > 10 ? 8 : 12;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -20 }}>
        <defs>
          <linearGradient id={`output-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#d98661" stopOpacity={0.95} />
            <stop offset="100%" stopColor="#e9b092" stopOpacity={0.55} />
          </linearGradient>
          <linearGradient id={`idea-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4059a8" stopOpacity={0.8} />
            <stop offset="100%" stopColor="#8b9ed6" stopOpacity={0.35} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 8" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          interval={tickInterval}
          tick={{ fill: 'var(--text-tertiary)', fontSize: 10 }}
          dy={8}
        />
        <YAxis
          allowDecimals={false}
          width={38}
          tickLine={false}
          axisLine={false}
          tick={{ fill: 'var(--text-tertiary)', fontSize: 10 }}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          labelStyle={tooltipLabelStyle}
          itemStyle={tooltipItemStyle}
          cursor={{ fill: 'var(--surface-hover)', opacity: 0.65 }}
        />
        <Bar dataKey="outputs" name="产物" stackId="flow" fill={`url(#output-${uid})`} barSize={barSize} radius={[3, 3, 0, 0]} activeBar={{ fill: '#d98661' }} animationDuration={450} />
        <Bar dataKey="ideas" name="选题" stackId="flow" fill={`url(#idea-${uid})`} barSize={barSize} radius={[3, 3, 0, 0]} activeBar={{ fill: '#4059a8' }} animationDuration={450} />
        <Line
          type="linear"
          dataKey="total"
          name="总动态"
          stroke="var(--accent-start)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, fill: 'var(--surface)' }}
          animationDuration={450}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function FunnelChart({ data }: { data: FunnelDatum[] }) {
  const max = Math.max(1, ...data.map((item) => item.value));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart layout="vertical" data={data} margin={{ top: 2, right: 24, bottom: 0, left: 0 }} barCategoryGap={13}>
        <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="2 8" />
        <XAxis type="number" domain={[0, max]} hide />
        <YAxis
          type="category"
          dataKey="label"
          width={42}
          tickLine={false}
          axisLine={false}
          tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          labelStyle={tooltipLabelStyle}
          itemStyle={tooltipItemStyle}
          cursor={{ fill: 'var(--surface-hover)', opacity: 0.65 }}
          formatter={(value) => [`${value} 条`, '内容']}
        />
        <Bar dataKey="value" barSize={16} radius={[0, 8, 8, 0]} background={{ fill: 'var(--surface-2)', radius: 8 }} animationDuration={450}>
          {data.map((item) => <Cell key={item.label} fill={item.color} />)}
          <LabelList
            dataKey="value"
            position="right"
            offset={8}
            style={{ fill: 'var(--text-secondary)', fontSize: 11, fontWeight: 650 }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function MixChart({ data, total }: { data: MixDatum[]; total: number }) {
  const chartData = data.length > 0 ? data : [{ label: '暂无', value: 1, color: 'var(--surface-2)' }];

  return (
    <div className="db-donut-wrap">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          {data.length > 0 && (
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={tooltipLabelStyle}
              itemStyle={tooltipItemStyle}
              formatter={(value, name) => [`${value} 个`, name]}
            />
          )}
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="label"
            innerRadius="62%"
            outerRadius="92%"
            paddingAngle={data.length > 1 ? 4 : 0}
            cornerRadius={6}
            stroke="none"
            startAngle={90}
            endAngle={-270}
            animationDuration={450}
          >
            {chartData.map((item) => <Cell key={item.label} fill={item.color} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="db-donut-center">
        <strong>{total}</strong>
        <span>项目</span>
      </div>
    </div>
  );
}

export function CoverageGauge({ count, total }: { count: number; total: number }) {
  const percent = total > 0 ? Math.round((count / total) * 100) : 0;

  return (
    <div className="db-gauge-wrap">
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          data={[{ name: '覆盖', value: percent }]}
          innerRadius="76%"
          outerRadius="100%"
          startAngle={90}
          endAngle={-270}
          barSize={10}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar
            dataKey="value"
            fill="var(--db-teal)"
            background={{ fill: 'rgba(255,255,255,.09)' }}
            cornerRadius={20}
            animationDuration={450}
          />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="db-gauge-center">
        <strong>{count}</strong>
        <span>/ {total}</span>
        <small>{percent}% 覆盖</small>
      </div>
    </div>
  );
}
