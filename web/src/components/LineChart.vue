<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Title,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Title,
  Tooltip,
  Legend,
  Filler
);

/**
 * Shade [startMs, endMs] on a category X axis using parallel pointTMs (ms).
 * Draws a band + vertical edges + "Observe" label.
 */
const observeWindowPlugin = {
  id: "observeWindow",
  beforeDatasetsDraw(chart) {
    const cfg = chart.options.plugins?.observeWindow;
    if (!cfg || cfg.startMs == null || cfg.endMs == null) return;
    const pointTMs = cfg.pointTMs;
    if (!Array.isArray(pointTMs) || pointTMs.length === 0) return;

    const { startMs, endMs } = cfg;
    if (!(endMs > startMs)) return;

    const xScale = chart.scales.x;
    const yScale = chart.scales.y;
    if (!xScale || !yScale) return;

    // Map run-ms → fractional category index via surrounding points
    const tToIndex = (t) => {
      if (t <= pointTMs[0]) return 0;
      if (t >= pointTMs[pointTMs.length - 1]) return pointTMs.length - 1;
      for (let i = 0; i < pointTMs.length - 1; i++) {
        const a = pointTMs[i];
        const b = pointTMs[i + 1];
        if (t >= a && t <= b) {
          if (b === a) return i;
          return i + (t - a) / (b - a);
        }
      }
      return pointTMs.length - 1;
    };

    // If the whole series is outside the window, still try edges via clamp
    const i0 = tToIndex(startMs);
    const i1 = tToIndex(endMs);
    // When data hasn't reached observe yet, skip drawing a zero-width band
    if (
      pointTMs[pointTMs.length - 1] < startMs &&
      pointTMs[0] < startMs
    ) {
      // series entirely before observe — nothing to shade yet
      // but if last point is before start, band would be at the right edge only
    }

    const x0 = xScale.getPixelForValue(i0);
    const x1 = xScale.getPixelForValue(i1);
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return;
    if (right - left < 1) return;

    const top = yScale.top;
    const bottom = yScale.bottom;
    const ctx = chart.ctx;
    ctx.save();

    // Band fill
    ctx.fillStyle = cfg.fillStyle || "rgba(167, 139, 250, 0.12)";
    ctx.fillRect(left, top, right - left, bottom - top);

    // Edge lines
    ctx.strokeStyle = cfg.borderColor || "rgba(167, 139, 250, 0.85)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash(cfg.borderDash || [4, 3]);
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left, bottom);
    ctx.moveTo(right, top);
    ctx.lineTo(right, bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label
    const label = cfg.label || "Observe";
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.fillStyle = cfg.labelColor || "#c4b5fd";
    ctx.textBaseline = "top";
    const textW = ctx.measureText(label).width;
    const pad = 6;
    const labelX = Math.min(
      Math.max(left + pad, xScale.left + 2),
      right - textW - pad
    );
    // Soft pill behind text
    const pillH = 16;
    const pillW = textW + 10;
    ctx.fillStyle = "rgba(15, 23, 42, 0.75)";
    ctx.fillRect(labelX - 5, top + 4, pillW, pillH);
    ctx.fillStyle = cfg.labelColor || "#c4b5fd";
    ctx.fillText(label, labelX, top + 6);

    ctx.restore();
  },
};

/**
 * Draw vertical markers at run-relative times (e.g. every 10 path_find opens).
 * Config: { pointTMs, markers: [{ tMs, label? }], color?, labelColor? }
 */
const timeMarkersPlugin = {
  id: "timeMarkers",
  afterDatasetsDraw(chart) {
    const cfg = chart.options.plugins?.timeMarkers;
    if (!cfg?.markers?.length || !cfg.pointTMs?.length) return;

    const pointTMs = cfg.pointTMs;
    const xScale = chart.scales.x;
    const yScale = chart.scales.y;
    if (!xScale || !yScale) return;

    const tToIndex = (t) => {
      if (t <= pointTMs[0]) return 0;
      if (t >= pointTMs[pointTMs.length - 1]) return pointTMs.length - 1;
      for (let i = 0; i < pointTMs.length - 1; i++) {
        const a = pointTMs[i];
        const b = pointTMs[i + 1];
        if (t >= a && t <= b) {
          if (b === a) return i;
          return i + (t - a) / (b - a);
        }
      }
      return pointTMs.length - 1;
    };

    const ctx = chart.ctx;
    const top = yScale.top;
    const bottom = yScale.bottom;
    const color = cfg.color || "rgba(56, 189, 248, 0.75)";
    const labelColor = cfg.labelColor || "#7dd3fc";
    const dash = cfg.borderDash || [3, 3];

    ctx.save();
    for (const m of cfg.markers) {
      if (m?.tMs == null || !Number.isFinite(m.tMs)) continue;
      // Skip markers completely outside the plotted time range (with small pad)
      const minT = pointTMs[0];
      const maxT = pointTMs[pointTMs.length - 1];
      if (m.tMs < minT - 1 || m.tMs > maxT + 1) continue;

      const x = xScale.getPixelForValue(tToIndex(m.tMs));
      if (!Number.isFinite(x)) continue;

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      const label = m.label != null ? String(m.label) : "";
      if (label) {
        ctx.font = "600 10px system-ui, sans-serif";
        ctx.fillStyle = labelColor;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const textW = ctx.measureText(label).width;
        const pillW = textW + 8;
        const pillH = 14;
        const px = x;
        const py = top + 4;
        ctx.fillStyle = "rgba(15, 23, 42, 0.8)";
        ctx.fillRect(px - pillW / 2, py, pillW, pillH);
        ctx.fillStyle = labelColor;
        ctx.fillText(label, px, py + 2);
      }
    }
    ctx.restore();
  },
};

Chart.register(observeWindowPlugin);
Chart.register(timeMarkersPlugin);

const props = defineProps({
  title: { type: String, default: "" },
  labels: { type: Array, default: () => [] },
  datasets: { type: Array, default: () => [] },
  yTitle: { type: String, default: "" },
  xTitle: { type: String, default: "" },
  height: { type: Number, default: 260 },
  /** Hide legend / thinner multi-line mode for per-session overlays */
  overlay: { type: Boolean, default: false },
  showLegend: { type: Boolean, default: undefined },
  /**
   * Parallel run-relative timestamps (ms) for each label index.
   * Required to place the observe window band.
   */
  pointTMs: { type: Array, default: () => [] },
  /**
   * Observe / hold window in run-relative ms.
   * @type {{ startMs: number, endMs: number, label?: string } | null}
   */
  observeWindow: { type: Object, default: null },
  /**
   * Vertical markers at run-relative times (e.g. every 10 path_find opens).
   * @type {Array<{ tMs: number, label?: string, n?: number }>}
   */
  timeMarkers: { type: Array, default: () => [] },
});

const canvas = ref(null);
let chart = null;
/** Labels the user toggled off via legend — survives chart rebuilds. */
const hiddenLabels = new Set();

function datasetKey(ds, index) {
  return ds?.label != null ? String(ds.label) : `__idx_${index}`;
}

function syncHiddenFromChart() {
  if (!chart) return;
  chart.data.datasets.forEach((ds, i) => {
    const key = datasetKey(ds, i);
    if (chart.isDatasetVisible(i)) hiddenLabels.delete(key);
    else hiddenLabels.add(key);
  });
}

function legendDisplayFor(datasets) {
  if (props.showLegend !== undefined) return props.showLegend;
  if (props.overlay) return datasets.length > 1 && datasets.length <= 16;
  return datasets.length > 1;
}

function observePluginConfig() {
  const hasObserve =
    props.observeWindow &&
    props.observeWindow.startMs != null &&
    props.observeWindow.endMs != null &&
    props.pointTMs?.length > 0;
  if (!hasObserve) return null;
  return {
    startMs: props.observeWindow.startMs,
    endMs: props.observeWindow.endMs,
    pointTMs: props.pointTMs,
    label: props.observeWindow.label || "Observe window",
    fillStyle: "rgba(167, 139, 250, 0.14)",
    borderColor: "rgba(167, 139, 250, 0.9)",
    borderDash: [5, 4],
    labelColor: "#c4b5fd",
  };
}

function timeMarkersPluginConfig() {
  if (!props.timeMarkers?.length || !props.pointTMs?.length) return null;
  return {
    pointTMs: props.pointTMs,
    markers: props.timeMarkers,
    color: "rgba(56, 189, 248, 0.7)",
    labelColor: "#7dd3fc",
    borderDash: [3, 3],
  };
}

function mapDataset(ds, i) {
  const key = datasetKey(ds, i);
  return {
    tension: 0.25,
    borderWidth: props.overlay ? 1.2 : 2,
    pointRadius: ds.pointRadius ?? (props.overlay ? 0 : 3),
    pointHoverRadius: ds.pointHoverRadius ?? 4,
    fill: ds.fill ?? false,
    ...ds,
    // Restore click-to-hide across live rebuilds
    hidden: hiddenLabels.has(key) || Boolean(ds.hidden),
  };
}

/** True when structure changed enough that destroy/create is safer than mutate. */
function needsFullRebuild() {
  if (!chart) return true;
  if (chart.data.datasets.length !== props.datasets.length) return true;
  // Overlay ↔ normal interaction modes differ; recreate if mode flips
  const wasOverlay = Boolean(chart.$isOverlay);
  if (wasOverlay !== Boolean(props.overlay)) return true;
  // Session labels can reshuffle as new path_finds open — rebuild if keys drift
  for (let i = 0; i < props.datasets.length; i++) {
    const prev = chart.data.datasets[i]?.label;
    const next = props.datasets[i]?.label;
    if (String(prev ?? "") !== String(next ?? "")) return true;
  }
  return false;
}

function build() {
  if (!canvas.value) return;
  // Capture toggle state before destroy (in case it drifted)
  syncHiddenFromChart();
  if (chart) {
    chart.destroy();
    chart = null;
  }

  const legendDisplay = legendDisplayFor(props.datasets);

  chart = new Chart(canvas.value, {
    type: "line",
    data: {
      labels: props.labels,
      datasets: props.datasets.map(mapDataset),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Live runs update often; animation stalls the main thread with many series
      animation: false,
      animations: false,
      interaction: {
        mode: props.overlay ? "nearest" : "index",
        intersect: false,
        axis: "x",
      },
      plugins: {
        legend: {
          display: legendDisplay,
          onClick(_e, legendItem, legend) {
            // Toggle series visibility; remember so live rebuilds keep it
            const index = legendItem.datasetIndex;
            const ci = legend.chart;
            if (index == null || !ci) return;
            const ds = ci.data.datasets[index];
            const key = datasetKey(ds, index);
            if (ci.isDatasetVisible(index)) {
              ci.hide(index);
              legendItem.hidden = true;
              hiddenLabels.add(key);
            } else {
              ci.show(index);
              legendItem.hidden = false;
              hiddenLabels.delete(key);
            }
          },
          onHover(e) {
            const el = e?.native?.target;
            if (el?.style) el.style.cursor = "pointer";
          },
          onLeave(e) {
            const el = e?.native?.target;
            if (el?.style) el.style.cursor = "default";
          },
          labels: {
            color: "#94a3b8",
            boxWidth: 10,
            font: { size: 10 },
            usePointStyle: false,
            filter: () => {
              if (!props.overlay) return true;
              return props.datasets.length <= 16;
            },
          },
        },
        title: {
          display: Boolean(props.title),
          text: props.title,
          color: "#e2e8f0",
          font: { size: 13, weight: "600" },
          padding: { bottom: 12 },
        },
        tooltip: {
          backgroundColor: "#0f172a",
          borderColor: "#334155",
          borderWidth: 1,
          titleColor: "#f1f5f9",
          bodyColor: "#cbd5e1",
          filter: props.overlay
            ? (item) => item.parsed?.y != null
            : undefined,
          itemSort: (a, b) => (b.parsed?.y ?? 0) - (a.parsed?.y ?? 0),
          callbacks: props.overlay
            ? {
                afterBody(items) {
                  if (items.length > 8) {
                    return `… +${items.length - 8} more sessions`;
                  }
                  return [];
                },
              }
            : undefined,
        },
        observeWindow: observePluginConfig(),
        timeMarkers: timeMarkersPluginConfig(),
      },
      scales: {
        x: {
          title: {
            display: Boolean(props.xTitle),
            text: props.xTitle,
            color: "#64748b",
          },
          ticks: {
            color: "#64748b",
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 10,
          },
          grid: { color: "rgba(51,65,85,0.5)" },
        },
        y: {
          beginAtZero: true,
          title: {
            display: Boolean(props.yTitle),
            text: props.yTitle,
            color: "#64748b",
          },
          ticks: { color: "#64748b" },
          grid: { color: "rgba(51,65,85,0.5)" },
        },
      },
    },
  });

  chart.$isOverlay = Boolean(props.overlay);
  if (props.overlay && chart.options.plugins.tooltip) {
    chart.options.plugins.tooltip.limit = 8;
  }
}

/**
 * Mutate an existing Chart.js instance instead of destroy/create.
 * Critical during live observe: 7 charts × full rebuild freezes the tab.
 */
function applyUpdate() {
  if (!canvas.value) return;
  if (needsFullRebuild()) {
    build();
    return;
  }

  chart.data.labels = props.labels;
  for (let i = 0; i < props.datasets.length; i++) {
    const ds = props.datasets[i];
    const target = chart.data.datasets[i];
    const key = datasetKey(ds, i);
    target.data = ds.data;
    target.label = ds.label;
    if (ds.borderColor != null) target.borderColor = ds.borderColor;
    if (ds.backgroundColor != null) target.backgroundColor = ds.backgroundColor;
    if (ds.borderWidth != null) target.borderWidth = ds.borderWidth;
    if (ds.pointRadius != null) target.pointRadius = ds.pointRadius;
    if (ds.fill != null) target.fill = ds.fill;
    if (ds.spanGaps != null) target.spanGaps = ds.spanGaps;
    if (ds.stepped != null) target.stepped = ds.stepped;
    target.hidden = hiddenLabels.has(key) || Boolean(ds.hidden);
  }

  if (chart.options.plugins) {
    chart.options.plugins.observeWindow = observePluginConfig();
    chart.options.plugins.timeMarkers = timeMarkersPluginConfig();
  }
  if (chart.options.plugins?.title) {
    chart.options.plugins.title.display = Boolean(props.title);
    chart.options.plugins.title.text = props.title;
  }
  if (chart.options.plugins?.legend) {
    chart.options.plugins.legend.display = legendDisplayFor(props.datasets);
  }
  if (chart.options.scales?.x?.title) {
    chart.options.scales.x.title.display = Boolean(props.xTitle);
    chart.options.scales.x.title.text = props.xTitle;
  }
  if (chart.options.scales?.y?.title) {
    chart.options.scales.y.title.display = Boolean(props.yTitle);
    chart.options.scales.y.title.text = props.yTitle;
  }

  chart.update("none");
}

watch(
  () => [
    props.labels,
    props.datasets,
    props.title,
    props.overlay,
    props.showLegend,
    props.pointTMs,
    props.observeWindow,
    props.timeMarkers,
  ],
  () => applyUpdate(),
  { deep: true }
);

onMounted(build);
onBeforeUnmount(() => {
  if (chart) {
    chart.destroy();
    chart = null;
  }
});
</script>

<template>
  <div class="chart-wrap" :style="{ height: height + 'px' }">
    <canvas ref="canvas" />
  </div>
</template>
