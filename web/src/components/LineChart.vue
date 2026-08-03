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

Chart.register(observeWindowPlugin);

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
});

const canvas = ref(null);
let chart = null;

function build() {
  if (!canvas.value) return;
  if (chart) chart.destroy();

  const many = props.datasets.length > 12;
  const legendDisplay =
    props.showLegend !== undefined
      ? props.showLegend
      : props.overlay
        ? props.datasets.length > 1 && props.datasets.length <= 16
        : props.datasets.length > 1;

  const hasObserve =
    props.observeWindow &&
    props.observeWindow.startMs != null &&
    props.observeWindow.endMs != null &&
    props.pointTMs?.length > 0;

  chart = new Chart(canvas.value, {
    type: "line",
    data: {
      labels: props.labels,
      datasets: props.datasets.map((ds) => ({
        tension: 0.25,
        borderWidth: props.overlay ? 1.2 : 2,
        pointRadius: ds.pointRadius ?? (props.overlay ? 0 : 3),
        pointHoverRadius: ds.pointHoverRadius ?? 4,
        fill: ds.fill ?? false,
        ...ds,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: props.overlay && many ? false : undefined,
      interaction: {
        mode: props.overlay ? "nearest" : "index",
        intersect: false,
        axis: "x",
      },
      plugins: {
        legend: {
          display: legendDisplay,
          labels: {
            color: "#94a3b8",
            boxWidth: 10,
            font: { size: 10 },
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
        observeWindow: hasObserve
          ? {
              startMs: props.observeWindow.startMs,
              endMs: props.observeWindow.endMs,
              pointTMs: props.pointTMs,
              label: props.observeWindow.label || "Observe window",
              fillStyle: "rgba(167, 139, 250, 0.14)",
              borderColor: "rgba(167, 139, 250, 0.9)",
              borderDash: [5, 4],
              labelColor: "#c4b5fd",
            }
          : null,
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

  if (props.overlay && chart.options.plugins.tooltip) {
    chart.options.plugins.tooltip.limit = 8;
  }
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
  ],
  () => build(),
  { deep: true }
);

onMounted(build);
onBeforeUnmount(() => {
  if (chart) chart.destroy();
});
</script>

<template>
  <div class="chart-wrap" :style="{ height: height + 'px' }">
    <canvas ref="canvas" />
  </div>
</template>
