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
            // avoid huge legends when many sessions
            filter: (item) => {
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
          // for overlay, show only the nearest few items
          filter: props.overlay
            ? (item) => item.parsed?.y != null
            : undefined,
          itemSort: (a, b) => (b.parsed?.y ?? 0) - (a.parsed?.y ?? 0),
          callbacks: props.overlay
            ? {
                // limit tooltip rows when hovering dense overlays
                afterBody(items) {
                  if (items.length > 8) {
                    return `… +${items.length - 8} more sessions`;
                  }
                  return [];
                },
              }
            : undefined,
        },
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

  // Cap tooltip items for dense overlays
  if (props.overlay && chart.options.plugins.tooltip) {
    chart.options.plugins.tooltip.limit = 8;
  }
}

watch(
  () => [props.labels, props.datasets, props.title, props.overlay, props.showLegend],
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
