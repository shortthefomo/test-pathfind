<script setup>
import { computed } from "vue";
import LineChart from "./LineChart.vue";
import {
  fmtMs,
  buildPerSessionOverlay,
  buildObserveWindow,
  padSeriesForObserveWindow,
} from "../api.js";

const props = defineProps({
  progress: { type: Object, default: null },
  runMeta: { type: Object, default: null },
});

const phase = computed(() => props.progress?.phase || "—");
const phaseClass = computed(() => {
  const p = phase.value;
  if (p === "done") return "done";
  if (p === "error") return "err";
  if (p === "observe") return "obs";
  if (p === "ready") return "rdy";
  if (p === "ramp_down") return "ramp-down";
  if (p === "ramp_up" || p === "ramp") return "ramp";
  if (p === "closing") return "closing";
  return "burst";
});

const phaseDisplay = computed(() => {
  const p = phase.value;
  if (p === "ramp_up" || p === "ramp") return "ramp up";
  if (p === "ramp_down") return "ramp down";
  return p;
});

const modeLabel = computed(() => {
  const cfg = props.runMeta?.config;
  const mode = props.progress?.mode || cfg?.mode || "burst";
  if (mode === "ramp") {
    const ms = props.progress?.addIntervalMs ?? cfg?.addIntervalMs;
    if (ms != null && ms > 0) return `ramp ±${fmtMs(ms)}`;
    return "ramp";
  }
  return "burst";
});

const observeWindow = computed(() => {
  const p = props.progress;
  if (!p) return null;
  // Prefer live progress bounds; fall back to config duration once start is known
  return buildObserveWindow({
    observeStartT: p.observeStartT,
    observeEndT: p.observeEndT,
    observeMs: p.observeMs ?? props.runMeta?.config?.observeMs,
  });
});

const createChart = computed(() => {
  const pts = props.progress?.createLatencies || [];
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
        label: "Create latency (ms)",
        data: padded.data,
        borderColor: "#38bdf8",
        backgroundColor: "rgba(56,189,248,0.15)",
        pointRadius: 2,
        spanGaps: true,
      },
    ],
  };
});

const overlayChart = computed(() => {
  const base = buildPerSessionOverlay(props.progress?.perSessionGaps);
  if (!base.sessionCount || !observeWindow.value) return base;
  // Pad time axis so observe band is visible after last update bucket
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
  const pts = props.progress?.updateGapBuckets || [];
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
        label: "Mean update gap (ms)",
        data: padded.data,
        borderColor: "#fbbf24",
        backgroundColor: "rgba(251,191,36,0.12)",
        fill: true,
        pointRadius: 2,
        spanGaps: true,
      },
    ],
  };
});

const rateChart = computed(() => {
  const pts = props.progress?.updateRateBuckets || [];
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
        label: "Updates / sec",
        data: padded.data,
        borderColor: "#a78bfa",
        backgroundColor: "rgba(167,139,250,0.12)",
        fill: true,
        pointRadius: 2,
        spanGaps: true,
      },
    ],
  };
});

const observeLegend = computed(() => {
  const w = observeWindow.value;
  if (!w) return null;
  return `${(w.startMs / 1000).toFixed(0)}s → ${(w.endMs / 1000).toFixed(0)}s`;
});
</script>

<template>
  <section class="panel live-panel">
    <header class="panel-head row-between">
      <div>
        <h2>Live run</h2>
        <p class="muted" v-if="runMeta">
          {{ runMeta.label || runMeta.id }}
          <span v-if="runMeta.config">
            · {{ modeLabel }} · max {{ runMeta.config.maxConcurrency }} · observe
            {{ fmtMs(runMeta.config.observeMs) }}
          </span>
        </p>
      </div>
      <span class="phase-badge" :class="phaseClass">{{ phaseDisplay }}</span>
    </header>

    <div v-if="!progress" class="empty">
      Start a test round to stream live metrics.
    </div>

    <template v-else>
      <div class="stat-grid">
        <div class="stat">
          <span class="stat-label">Opened</span>
          <span class="stat-val">
            {{ progress.opened ?? 0 }}
            <small>/ {{ progress.maxConcurrency }}</small>
          </span>
        </div>
        <div class="stat">
          <span class="stat-label">Updating</span>
          <span class="stat-val">{{ progress.ready ?? 0 }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Failed</span>
          <span class="stat-val danger">{{ progress.failed ?? 0 }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Elapsed</span>
          <span class="stat-val">{{ fmtMs(progress.elapsedMs) }}</span>
        </div>
        <div class="stat" v-if="progress.observeRemainMs != null">
          <span class="stat-label">Observe left</span>
          <span class="stat-val">{{ fmtMs(progress.observeRemainMs) }}</span>
        </div>
      </div>
      <p v-if="progress.message" class="msg">{{ progress.message }}</p>

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
          :title="`All path_find update gaps overlaid (${overlayChart.sessionCount} sessions, 3s buckets)`"
          y-title="ms"
          x-title="run time"
          :labels="overlayChart.labels"
          :datasets="overlayChart.datasets"
          :show-legend="overlayChart.showLegend"
          :point-t-ms="overlayChart.pointTMs"
          :observe-window="observeWindow"
          overlay
          :height="320"
        />
        <LineChart
          :title="
            (progress?.mode || runMeta?.config?.mode) === 'ramp'
              ? 'Create latency over ramp-up'
              : 'Create latency over burst'
          "
          y-title="ms"
          x-title="run time"
          :labels="createChart.labels"
          :datasets="createChart.datasets"
          :point-t-ms="createChart.pointTMs"
          :observe-window="observeWindow"
          :height="220"
        />
        <LineChart
          title="Mean update gap (all sessions)"
          y-title="ms"
          x-title="run time"
          :labels="gapChart.labels"
          :datasets="gapChart.datasets"
          :point-t-ms="gapChart.pointTMs"
          :observe-window="observeWindow"
          :height="220"
        />
        <LineChart
          title="Update throughput"
          y-title="upd/s"
          x-title="run time"
          :labels="rateChart.labels"
          :datasets="rateChart.datasets"
          :point-t-ms="rateChart.pointTMs"
          :observe-window="observeWindow"
          :height="200"
        />
      </div>
    </template>
  </section>
</template>
