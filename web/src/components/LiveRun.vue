<script setup>
import { computed } from "vue";
import LineChart from "./LineChart.vue";
import { fmtMs, buildPerSessionOverlay } from "../api.js";

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
  return "burst";
});

const createChart = computed(() => {
  const pts = props.progress?.createLatencies || [];
  return {
    labels: pts.map((p) => (p.tMs / 1000).toFixed(1) + "s"),
    datasets: [
      {
        label: "Create latency (ms)",
        data: pts.map((p) => p.ms),
        borderColor: "#38bdf8",
        backgroundColor: "rgba(56,189,248,0.15)",
        pointRadius: 2,
      },
    ],
  };
});

const overlayChart = computed(() =>
  buildPerSessionOverlay(props.progress?.perSessionGaps)
);

const gapChart = computed(() => {
  const pts = props.progress?.updateGapBuckets || [];
  return {
    labels: pts.map((p) => (p.tMs / 1000).toFixed(0) + "s"),
    datasets: [
      {
        label: "Mean update gap (ms)",
        data: pts.map((p) => p.ms),
        borderColor: "#fbbf24",
        backgroundColor: "rgba(251,191,36,0.12)",
        fill: true,
        pointRadius: 2,
      },
    ],
  };
});

const rateChart = computed(() => {
  const pts = props.progress?.updateRateBuckets || [];
  return {
    labels: pts.map((p) => (p.tMs / 1000).toFixed(0) + "s"),
    datasets: [
      {
        label: "Updates / sec",
        data: pts.map((p) => p.rate),
        borderColor: "#a78bfa",
        backgroundColor: "rgba(167,139,250,0.12)",
        fill: true,
        pointRadius: 2,
      },
    ],
  };
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
            · max {{ runMeta.config.maxConcurrency }} · observe
            {{ fmtMs(runMeta.config.observeMs) }}
          </span>
        </p>
      </div>
      <span class="phase-badge" :class="phaseClass">{{ phase }}</span>
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

      <div class="charts">
        <LineChart
          v-if="overlayChart.sessionCount"
          :title="`All path_find update gaps overlaid (${overlayChart.sessionCount} sessions, 3s buckets)`"
          y-title="ms"
          x-title="time"
          :labels="overlayChart.labels"
          :datasets="overlayChart.datasets"
          :show-legend="overlayChart.showLegend"
          overlay
          :height="320"
        />
        <LineChart
          title="Create latency over burst"
          y-title="ms"
          x-title="time"
          :labels="createChart.labels"
          :datasets="createChart.datasets"
          :height="220"
        />
        <LineChart
          title="Mean update gap (all sessions)"
          y-title="ms"
          x-title="time"
          :labels="gapChart.labels"
          :datasets="gapChart.datasets"
          :height="220"
        />
        <LineChart
          title="Update throughput"
          y-title="upd/s"
          x-title="time"
          :labels="rateChart.labels"
          :datasets="rateChart.datasets"
          :height="200"
        />
      </div>
    </template>
  </section>
</template>
