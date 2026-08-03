<script setup>
import { computed } from "vue";
import LineChart from "./LineChart.vue";
import {
  fmtMs,
  fmtPct,
  buildPerSessionOverlay,
  buildObserveWindow,
  padSeriesForObserveWindow,
} from "../api.js";

const props = defineProps({
  summary: { type: Object, default: null },
});

const observeWindow = computed(() => buildObserveWindow(props.summary));

const observeLegend = computed(() => {
  const w = observeWindow.value;
  if (!w) return null;
  return `${(w.startMs / 1000).toFixed(0)}s → ${(w.endMs / 1000).toFixed(0)}s`;
});

const createChart = computed(() => {
  const pts = props.summary?.series?.createOverTime || [];
  const padded = padSeriesForObserveWindow(
    {
      labels: pts.map((p) => (p.tMs / 1000).toFixed(1) + "s"),
      pointTMs: pts.map((p) => p.tMs),
      data: pts.map((p) => p.ms),
    },
    observeWindow.value
  );
  return {
    labels: padded.labels,
    pointTMs: padded.pointTMs,
    datasets: [
      {
        label: "Create ms",
        data: padded.data,
        borderColor: "#38bdf8",
        pointRadius: 2,
        spanGaps: true,
      },
    ],
  };
});

const overlayChart = computed(() => {
  const base = buildPerSessionOverlay(props.summary?.series?.perSessionGaps);
  if (!base.sessionCount || !observeWindow.value) return base;
  const pad = padSeriesForObserveWindow(
    {
      labels: base.labels,
      pointTMs: base.pointTMs,
      data: base.datasets[0]?.data || [],
    },
    observeWindow.value
  );
  if (pad.pointTMs.length === base.pointTMs.length) return base;
  const extra = pad.pointTMs.length - base.pointTMs.length;
  const pre = pad.pointTMs[0] < base.pointTMs[0] ? 1 : 0;
  const datasets = base.datasets.map((ds) => {
    let data = [...ds.data];
    if (pre) data = [null, ...data];
    for (let i = 0; i < extra - pre; i++) data.push(null);
    return { ...ds, data, spanGaps: true };
  });
  return {
    ...base,
    labels: pad.labels,
    pointTMs: pad.pointTMs,
    datasets,
  };
});

const gapChart = computed(() => {
  const pts = props.summary?.series?.updateGapBuckets || [];
  const padded = padSeriesForObserveWindow(
    {
      labels: pts.map((p) => (p.tMs / 1000).toFixed(0) + "s"),
      pointTMs: pts.map((p) => p.tMs),
      data: pts.map((p) => p.ms),
    },
    observeWindow.value
  );
  return {
    labels: padded.labels,
    pointTMs: padded.pointTMs,
    datasets: [
      {
        label: "Gap ms",
        data: padded.data,
        borderColor: "#fbbf24",
        fill: true,
        backgroundColor: "rgba(251,191,36,0.1)",
        pointRadius: 2,
        spanGaps: true,
      },
    ],
  };
});

const rateChart = computed(() => {
  const pts = props.summary?.series?.updateRateBuckets || [];
  const padded = padSeriesForObserveWindow(
    {
      labels: pts.map((p) => (p.tMs / 1000).toFixed(0) + "s"),
      pointTMs: pts.map((p) => p.tMs),
      data: pts.map((p) => p.rate),
    },
    observeWindow.value
  );
  return {
    labels: padded.labels,
    pointTMs: padded.pointTMs,
    datasets: [
      {
        label: "upd/s",
        data: padded.data,
        borderColor: "#a78bfa",
        fill: true,
        backgroundColor: "rgba(167,139,250,0.1)",
        pointRadius: 2,
        spanGaps: true,
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
        {{ summary.config.mode === "ramp" ? "ramp" : "burst"
        }}{{
          summary.config.mode === "ramp" && summary.config.addIntervalMs
            ? ` /${fmtMs(summary.config.addIntervalMs)}`
            : ""
        }}
        · max {{ summary.config.maxConcurrency }} · observe
        {{ fmtMs(summary.config.observeMs) }} · success
        {{ fmtPct(summary.stats.successRate) }} · create p95
        {{ fmtMs(summary.stats.create.p95) }} · gap p50
        {{ fmtMs(summary.stats.updateGap.p50) }}
      </p>
    </header>

    <div v-if="observeWindow" class="chart-legend-note">
      <span class="obs-swatch" />
      <span>
        <strong>Observe window</strong>
        <span class="muted"> · {{ observeLegend }} (shaded on charts)</span>
      </span>
    </div>

    <div class="charts">
      <LineChart
        v-if="overlayChart.sessionCount"
        :title="`All path_find response times overlaid (${overlayChart.sessionCount} sessions)`"
        y-title="update gap ms"
        x-title="run time"
        :labels="overlayChart.labels"
        :datasets="overlayChart.datasets"
        :show-legend="overlayChart.showLegend"
        :point-t-ms="overlayChart.pointTMs"
        :observe-window="observeWindow"
        overlay
        :height="340"
      />
      <LineChart
        title="Create latency over time"
        y-title="ms"
        x-title="run time"
        :labels="createChart.labels"
        :datasets="createChart.datasets"
        :point-t-ms="createChart.pointTMs"
        :observe-window="observeWindow"
      />
      <LineChart
        title="Mean update gap over run"
        y-title="ms"
        x-title="run time"
        :labels="gapChart.labels"
        :datasets="gapChart.datasets"
        :point-t-ms="gapChart.pointTMs"
        :observe-window="observeWindow"
      />
      <LineChart
        title="Throughput (updates/sec)"
        y-title="upd/s"
        x-title="run time"
        :labels="rateChart.labels"
        :datasets="rateChart.datasets"
        :point-t-ms="rateChart.pointTMs"
        :observe-window="observeWindow"
      />
    </div>
  </section>
</template>
