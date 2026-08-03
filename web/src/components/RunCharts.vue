<script setup>
import { computed } from "vue";
import LineChart from "./LineChart.vue";
import { fmtMs, fmtPct, buildPerSessionOverlay } from "../api.js";

const props = defineProps({
  summary: { type: Object, default: null },
});

const createChart = computed(() => {
  const pts = props.summary?.series?.createOverTime || [];
  return {
    labels: pts.map((p) => (p.tMs / 1000).toFixed(1) + "s"),
    datasets: [
      {
        label: "Create ms",
        data: pts.map((p) => p.ms),
        borderColor: "#38bdf8",
        pointRadius: 2,
      },
    ],
  };
});

const overlayChart = computed(() =>
  buildPerSessionOverlay(props.summary?.series?.perSessionGaps)
);

const gapChart = computed(() => {
  const pts = props.summary?.series?.updateGapBuckets || [];
  return {
    labels: pts.map((p) => (p.tMs / 1000).toFixed(0) + "s"),
    datasets: [
      {
        label: "Gap ms",
        data: pts.map((p) => p.ms),
        borderColor: "#fbbf24",
        fill: true,
        backgroundColor: "rgba(251,191,36,0.1)",
        pointRadius: 2,
      },
    ],
  };
});

const rateChart = computed(() => {
  const pts = props.summary?.series?.updateRateBuckets || [];
  return {
    labels: pts.map((p) => (p.tMs / 1000).toFixed(0) + "s"),
    datasets: [
      {
        label: "upd/s",
        data: pts.map((p) => p.rate),
        borderColor: "#a78bfa",
        fill: true,
        backgroundColor: "rgba(167,139,250,0.1)",
        pointRadius: 2,
      },
    ],
  };
});
</script>

<template>
  <section class="panel" v-if="summary">
    <header class="panel-head">
      <h2>Run detail — {{ summary.label }}</h2>
      <p class="muted">
        max {{ summary.config.maxConcurrency }} · observe
        {{ fmtMs(summary.config.observeMs) }} · success
        {{ fmtPct(summary.stats.successRate) }} · create p95
        {{ fmtMs(summary.stats.create.p95) }} · gap p50
        {{ fmtMs(summary.stats.updateGap.p50) }}
      </p>
    </header>
    <div class="charts">
      <LineChart
        v-if="overlayChart.sessionCount"
        :title="`All path_find response times overlaid (${overlayChart.sessionCount} sessions)`"
        y-title="update gap ms"
        x-title="observe time"
        :labels="overlayChart.labels"
        :datasets="overlayChart.datasets"
        :show-legend="overlayChart.showLegend"
        overlay
        :height="340"
      />
      <LineChart
        title="Create latency over time"
        y-title="ms"
        :labels="createChart.labels"
        :datasets="createChart.datasets"
      />
      <LineChart
        title="Mean update gap over observe window"
        y-title="ms"
        :labels="gapChart.labels"
        :datasets="gapChart.datasets"
      />
      <LineChart
        title="Throughput (updates/sec)"
        y-title="upd/s"
        :labels="rateChart.labels"
        :datasets="rateChart.datasets"
      />
    </div>
  </section>
</template>
