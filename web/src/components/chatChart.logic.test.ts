import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChartOption,
  chartSourceFromPre,
  normalizeChatChartSpec,
  type ChartColors,
} from "./chatChart.logic.ts";

test("normalizeChatChartSpec reads the canonical chart block", () => {
  const spec = normalizeChatChartSpec({
    type: "area",
    title: "Visibility",
    x: "date",
    series: [{ key: "visibility", name: "Visibility" }],
    data: [
      { date: "01.09", visibility: 42 },
      { date: "01.10", visibility: 47 },
    ],
  });

  assert.deepEqual(spec, {
    type: "area",
    title: "Visibility",
    x: "date",
    series: [{ key: "visibility", name: "Visibility" }],
    data: [
      { date: "01.09", visibility: 42 },
      { date: "01.10", visibility: 47 },
    ],
  });
});

test("normalizeChatChartSpec folds legacy labels/datasets into data rows", () => {
  const spec = normalizeChatChartSpec({
    type: "bar",
    labels: ["a", "b"],
    datasets: [
      { label: "Clicks", data: [1, 2] },
      { name: "Shows", data: [3, 4] },
    ],
  });

  assert.ok(spec);
  assert.equal(spec.x, "__x");
  assert.deepEqual(
    spec.series.map((s) => [s.key, s.name]),
    [
      ["Clicks", "Clicks"],
      ["Shows", "Shows"],
    ],
  );
  assert.deepEqual(spec.data, [
    { __x: "a", Clicks: 1, Shows: 3 },
    { __x: "b", Clicks: 2, Shows: 4 },
  ]);
});

test("normalizeChatChartSpec defaults the type and the value series", () => {
  const spec = normalizeChatChartSpec({ data: [{ name: "x", value: 1 }] });

  assert.ok(spec);
  assert.equal(spec.type, "line");
  assert.equal(spec.x, "name");
  assert.deepEqual(spec.series, [{ key: "value", name: "" }]);
});

test("normalizeChatChartSpec rejects specs it cannot plot", () => {
  assert.equal(normalizeChatChartSpec(null), null);
  assert.equal(normalizeChatChartSpec("line"), null);
  assert.equal(normalizeChatChartSpec([]), null);
  assert.equal(normalizeChatChartSpec({ type: "line" }), null);
  assert.equal(normalizeChatChartSpec({ type: "line", data: [] }), null);
  assert.equal(normalizeChatChartSpec({ labels: ["a"], datasets: [] }), null);
});

test("chartSourceFromPre returns the source of a ```chart fence", () => {
  const source = '{"type":"line","x":"d","data":[{"d":"1","v":2}]}';
  const node = {
    type: "element",
    tagName: "pre",
    children: [
      {
        type: "element",
        tagName: "code",
        properties: { className: ["language-chart"] },
        children: [{ type: "text", value: source }],
      },
    ],
  };

  assert.equal(chartSourceFromPre(node), source);
});

test("chartSourceFromPre ignores regular code blocks", () => {
  const node = {
    type: "element",
    tagName: "pre",
    children: [
      {
        type: "element",
        tagName: "code",
        properties: { className: ["language-ts"] },
        children: [{ type: "text", value: "const a = 1;" }],
      },
    ],
  };

  assert.equal(chartSourceFromPre(node), null);
  assert.equal(chartSourceFromPre(undefined), null);
  assert.equal(chartSourceFromPre({ type: "element", tagName: "span" }), null);
});

const COLORS: ChartColors = {
  accent: "#22d3ee",
  border: "rgba(255, 255, 255, 0.08)",
  text: "#a1a1aa",
  textStrong: "#d4d4d8",
  surface: "#27272a",
  tooltip: "#27272a",
};

function optionFor(spec: ReturnType<typeof normalizeChatChartSpec>) {
  assert.ok(spec);
  return buildChartOption(spec, COLORS) as Record<string, any>;
}

test("line charts render smooth curves without per-point markers", () => {
  const option = optionFor(normalizeChatChartSpec({
    type: "line",
    x: "d",
    series: [{ key: "v", name: "Value" }],
    data: [{ d: "1", v: 2 }, { d: "2", v: 5 }],
  }));

  assert.equal(option.xAxis.data.join(","), "1,2");
  assert.equal(option.series[0].type, "line");
  assert.equal(option.series[0].smooth, 0.35);
  assert.equal(option.series[0].showSymbol, false);
  assert.equal(option.series[0].data.join(","), "2,5");
  assert.equal(option.series[0].areaStyle, undefined);
});

test("area charts fill the smooth curve with a gradient", () => {
  const option = optionFor(normalizeChatChartSpec({
    type: "area",
    x: "d",
    series: [{ key: "v", name: "Value" }],
    data: [{ d: "1", v: 2 }],
  }));

  const areaStyle = option.series[0].areaStyle;
  assert.equal(areaStyle.color.type, "linear");
  assert.equal(areaStyle.color.colorStops.length, 2);
});

test("bar charts round their columns and keep gaps between groups", () => {
  const option = optionFor(normalizeChatChartSpec({
    type: "bar",
    x: "d",
    series: [{ key: "v", name: "Value" }],
    data: [{ d: "1", v: 2 }],
  }));

  assert.equal(option.xAxis.boundaryGap, true);
  assert.deepEqual(option.series[0].itemStyle.borderRadius, [6, 6, 0, 0]);
});

test("pie charts map rows to named slices", () => {
  const option = optionFor(normalizeChatChartSpec({
    type: "pie",
    x: "name",
    series: [{ key: "value", name: "Share" }],
    data: [{ name: "a", value: 3 }, { name: "b", value: "7" }],
  }));

  assert.deepEqual(option.series[0].data, [
    { name: "a", value: 3 },
    { name: "b", value: 7 },
  ]);
});

test("missing values stay gaps instead of turning into zeroes", () => {
  const option = optionFor(normalizeChatChartSpec({
    type: "line",
    x: "d",
    series: [{ key: "v", name: "Value" }],
    data: [{ d: "1", v: 2 }, { d: "2" }],
  }));

  assert.deepEqual(option.series[0].data, [2, null]);
});
