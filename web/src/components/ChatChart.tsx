import { useEffect, useMemo, useRef } from 'react';
import { useTheme } from '@/hooks/useTheme';
import { t } from '@/lib/i18n';
import {
  buildChartOption,
  normalizeChatChartSpec,
  type ChartColors,
} from './chatChart.logic';

type EChartsCore = typeof import('echarts/core');

// ECharts (with zrender) is a heavy, DOM-dependent bundle. Load it the first
// time a chart actually appears so chat pages without charts never pay for it,
// and so non-browser importers (unit tests, SSR) never evaluate it.
let echartsLoader: Promise<EChartsCore> | null = null;

function loadEcharts(): Promise<EChartsCore> {
  if (!echartsLoader) {
    echartsLoader = Promise.all([
      import('echarts/core'),
      import('echarts/charts'),
      import('echarts/components'),
      import('echarts/renderers'),
    ]).then(([core, charts, components, renderers]) => {
      core.use([
        charts.LineChart,
        charts.BarChart,
        charts.PieChart,
        components.GridComponent,
        components.TooltipComponent,
        components.LegendComponent,
        renderers.CanvasRenderer,
      ]);
      return core;
    });
  }
  return echartsLoader;
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function chartColors(): ChartColors {
  return {
    accent: cssVar('--pc-accent', '#22d3ee'),
    border: cssVar('--pc-border', 'rgba(255, 255, 255, 0.08)'),
    text: cssVar('--pc-text-secondary', '#a1a1aa'),
    textStrong: cssVar('--pc-text-primary', '#d4d4d8'),
    surface: cssVar('--pc-bg-elevated', '#27272a'),
    tooltip: cssVar('--pc-bg-elevated', '#27272a'),
  };
}

/**
 * Render an agent's ```chart fence.
 *
 * The option comes from `buildChartOption`, so the visual contract is unit
 * tested without a canvas. This component only owns the ECharts lifecycle:
 * init on mount, resize with its bubble, dispose on unmount.
 */
export default function ChatChart({ source }: { source: string }) {
  const { resolvedTheme } = useTheme();
  const spec = useMemo(() => {
    try {
      return normalizeChatChartSpec(JSON.parse(source));
    } catch {
      return null;
    }
  }, [source]);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !spec) return;

    let disposed = false;
    let teardown: (() => void) | null = null;

    void loadEcharts().then((echarts) => {
      if (disposed) return;
      const chart = echarts.init(host, undefined, { renderer: 'canvas' });
      chart.setOption(buildChartOption(spec, chartColors()));

      const resize = () => chart.resize();
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
      observer?.observe(host);
      window.addEventListener('resize', resize);

      teardown = () => {
        observer?.disconnect();
        window.removeEventListener('resize', resize);
        chart.dispose();
      };
    });

    return () => {
      disposed = true;
      teardown?.();
    };
  }, [spec, resolvedTheme]);

  if (!spec) {
    return <pre className="chat-chart-invalid">{t('agent.chart_invalid')}</pre>;
  }

  return (
    <div className="chat-chart">
      {spec.title && <div className="chat-chart-title">{spec.title}</div>}
      <div ref={hostRef} className="chat-chart-body" />
    </div>
  );
}
