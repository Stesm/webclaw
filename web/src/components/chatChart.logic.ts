import type { EChartsCoreOption } from 'echarts/core';

export type ChatChartType = 'line' | 'bar' | 'area' | 'pie';

export interface ChatChartSeries {
  key: string;
  name: string;
}

export interface ChatChartSpec {
  type: ChatChartType;
  title?: string;
  x: string;
  series: ChatChartSeries[];
  data: Array<Record<string, unknown>>;
}

export interface ChartColors {
  accent: string;
  border: string;
  text: string;
  textStrong: string;
  surface: string;
  tooltip: string;
}

const X_KEY = '__x';
const TYPES: ChatChartType[] = ['line', 'bar', 'area', 'pie'];
const SERIES_COLORS = ['#22d3ee', '#818cf8', '#f472b6', '#fbbf24', '#34d399', '#fb923c'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickType(value: unknown): ChatChartType {
  return TYPES.includes(value as ChatChartType) ? (value as ChatChartType) : 'line';
}

function seriesKey(value: unknown, index: number): string {
  return typeof value === 'string' && value ? value : `s${index}`;
}

function normalizeSeries(raw: unknown[]): ChatChartSeries[] {
  return raw
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry, index) => ({
      key: typeof entry.key === 'string' && entry.key ? entry.key : seriesKey(entry.name ?? entry.label, index),
      name: typeof entry.name === 'string' && entry.name
        ? entry.name
        : typeof entry.label === 'string' ? entry.label : '',
    }));
}

/**
 * Parse the ```chart block an agent renders in a reply.
 *
 * Two shapes are accepted. The canonical one is `{type, title, x, series,
 * data}`, where every `data` row carries the `x` field and one field per
 * `series[].key`. The legacy shape (`xAxis`/`labels` + `datasets`/`series`
 * with `data` arrays) is folded into rows here so the renderer only ever sees
 * the canonical form.
 */
export function normalizeChatChartSpec(value: unknown): ChatChartSpec | null {
  const spec = asRecord(value);
  if (!spec) return null;

  const title = typeof spec.title === 'string' && spec.title ? spec.title : undefined;
  const rawSeries = Array.isArray(spec.series)
    ? spec.series
    : Array.isArray(spec.datasets) ? spec.datasets : [];
  const series = normalizeSeries(rawSeries);

  if (Array.isArray(spec.data) && spec.data.length > 0) {
    const data = spec.data
      .map((row) => asRecord(row))
      .filter((row): row is Record<string, unknown> => row !== null);
    if (data.length === 0) return null;
    return {
      type: pickType(spec.type),
      title,
      x: typeof spec.x === 'string' && spec.x ? spec.x : 'name',
      series: series.length > 0 ? series : [{ key: 'value', name: '' }],
      data,
    };
  }

  const labels = Array.isArray(spec.xAxis)
    ? spec.xAxis
    : Array.isArray(spec.labels) ? spec.labels : null;
  const rawDatasets = rawSeries
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  if (!labels || labels.length === 0 || rawDatasets.length === 0) return null;

  const normalized = normalizeSeries(rawSeries);
  const data = labels.map((label, index) => {
    const row: Record<string, unknown> = { [X_KEY]: label };
    rawDatasets.forEach((dataset, datasetIndex) => {
      const values = Array.isArray(dataset.data) ? dataset.data : [];
      row[normalized[datasetIndex]!.key] = values[index];
    });
    return row;
  });

  return {
    type: pickType(spec.type),
    title,
    x: X_KEY,
    series: normalized,
    data,
  };
}

interface HastLike {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastLike[];
  value?: string;
}

function isChartFence(node: HastLike | undefined): boolean {
  if (!node || node.type !== 'element' || node.tagName !== 'code') return false;
  const className = node.properties?.className;
  return Array.isArray(className)
    ? className.includes('language-chart')
    : className === 'language-chart';
}

/**
 * Extract a ```chart block's source from the hast node ReactMarkdown hands to
 * the `pre` renderer, so the fence never reaches the code-block styling.
 */
export function chartSourceFromPre(node: unknown): string | null {
  const pre = node as HastLike | undefined;
  const code = pre?.children?.find(isChartFence);
  if (!code) return null;
  const text = code.children?.find((child) => child.type === 'text');
  return typeof text?.value === 'string' ? text.value : null;
}

export function chartPalette(accent: string): string[] {
  return [accent, ...SERIES_COLORS.filter((color) => color !== accent)];
}

function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  if (!hex.startsWith('#')) return color;
  const raw = hex.slice(1);
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (full.length !== 6) return color;
  const value = Number.parseInt(full, 16);
  if (Number.isNaN(value)) return color;
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function verticalGradient(color: string, from: number, to: number) {
  return {
    type: 'linear',
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: withAlpha(color, from) },
      { offset: 1, color: withAlpha(color, to) },
    ],
  };
}

function buildCartesianOption(spec: ChatChartSpec, colors: ChartColors): EChartsCoreOption {
  const palette = chartPalette(colors.accent);
  const hasLegend = spec.series.length > 1;

  const axisLabel = { color: colors.text, fontSize: 11, hideOverlap: true };
  const splitLine = { lineStyle: { color: colors.border, type: [4, 4] as number[] } };

  return {
    animationDuration: 650,
    animationEasing: 'cubicOut',
    color: palette,
    grid: {
      left: 4,
      right: 12,
      top: 12,
      bottom: hasLegend ? 30 : 4,
      containLabel: true,
    },
    legend: hasLegend
      ? {
          bottom: 0,
          icon: 'roundRect',
          itemWidth: 9,
          itemHeight: 9,
          itemGap: 14,
          textStyle: { color: colors.text, fontSize: 11 },
        }
      : undefined,
    tooltip: {
      trigger: 'axis',
      backgroundColor: colors.tooltip,
      borderColor: colors.border,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: colors.textStrong, fontSize: 12 },
      axisPointer: {
        type: spec.type === 'bar' ? 'shadow' : 'line',
        lineStyle: { color: colors.accent, type: 'dashed' },
        shadowStyle: { color: withAlpha(colors.accent, 0.08) },
      },
    },
    xAxis: {
      type: 'category',
      boundaryGap: spec.type === 'bar',
      data: spec.data.map((row) => String(row[spec.x] ?? '')),
      axisLine: { lineStyle: { color: colors.border } },
      axisTick: { show: false },
      axisLabel,
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine,
      axisLabel,
    },
    series: spec.series.map((ser, index) => {
      const color = palette[index % palette.length]!;
      if (spec.type === 'bar') {
        return {
          type: 'bar',
          name: ser.name || ser.key,
          data: spec.data.map((row) => row[ser.key] ?? null),
          barMaxWidth: 34,
          itemStyle: {
            borderRadius: [6, 6, 0, 0],
            color: verticalGradient(color, 1, 0.55),
          },
          emphasis: { focus: 'series' },
        };
      }
      return {
        type: 'line',
        name: ser.name || ser.key,
        data: spec.data.map((row) => row[ser.key] ?? null),
        smooth: 0.35,
        smoothMonotone: 'x',
        showSymbol: false,
        symbol: 'circle',
        symbolSize: 7,
        lineStyle: { width: 2.5, cap: 'round' },
        itemStyle: { color, borderColor: colors.surface, borderWidth: 2 },
        emphasis: { focus: 'series', scale: 1.4 },
        areaStyle: spec.type === 'area'
          ? { color: verticalGradient(color, 0.35, 0.02) }
          : undefined,
      };
    }),
  };
}

function buildPieOption(spec: ChatChartSpec, colors: ChartColors): EChartsCoreOption {
  const palette = chartPalette(colors.accent);
  const valueKey = spec.series[0]?.key ?? 'value';

  return {
    animationDuration: 650,
    animationEasing: 'cubicOut',
    color: palette,
    legend: {
      bottom: 0,
      icon: 'circle',
      itemWidth: 9,
      itemHeight: 9,
      itemGap: 14,
      textStyle: { color: colors.text, fontSize: 11 },
    },
    tooltip: {
      trigger: 'item',
      backgroundColor: colors.tooltip,
      borderColor: colors.border,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: colors.textStrong, fontSize: 12 },
      formatter: '{b}: {c} ({d}%)',
    },
    series: [
      {
        type: 'pie',
        radius: ['44%', '70%'],
        center: ['50%', '44%'],
        padAngle: 2,
        avoidLabelOverlap: true,
        itemStyle: {
          borderRadius: 6,
          borderColor: colors.surface,
          borderWidth: 2,
        },
        label: {
          color: colors.text,
          fontSize: 11,
          formatter: '{b}\n{d}%',
        },
        labelLine: { lineStyle: { color: colors.border } },
        emphasis: {
          scale: true,
          scaleSize: 6,
          label: { color: colors.textStrong, fontWeight: 600 },
        },
        data: spec.data.map((row) => ({
          name: String(row[spec.x] ?? ''),
          value: Number(row[valueKey] ?? 0),
        })),
      },
    ],
  };
}

export function buildChartOption(spec: ChatChartSpec, colors: ChartColors): EChartsCoreOption {
  return spec.type === 'pie' ? buildPieOption(spec, colors) : buildCartesianOption(spec, colors);
}
