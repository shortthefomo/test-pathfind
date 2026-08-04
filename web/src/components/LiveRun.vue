<script setup>
import { computed } from "vue";
import LineChart from "./LineChart.vue";
import {
  fmtMs,
  buildPerSessionOverlay,
  buildObserveWindow,
  padSeriesForObserveWindow,
  buildPathFindOpenMarkers,
  padSeriesForTimeMarkers,
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

/** Vertical markers at every 10th path_find create (open). */
const pathFindOpenMarkers = computed(() =>
  buildPathFindOpenMarkers(props.progress?.createLatencies || [], 10)
);

const gapChart = computed(() => {
  const pts = props.progress?.updateGapBuckets || [];
  let padded = padSeriesForObserveWindow(
    {
      labels: pts.map((p) => (p.tMs / 1000).toFixed(0) + "s"),
      pointTMs: pts.map((p) => p.tMs),
      data: pts.map((p) => p.ms),
    },
    observeWindow.value
  );
  // Keep +10 / +20 / … open markers on-axis even during ramp-up
  padded = padSeriesForTimeMarkers(padded, pathFindOpenMarkers.value);
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

const consensus = computed(() => props.progress?.consensus || null);
const consensusLatest = computed(() => consensus.value?.latest || null);
const consensusClass = computed(() => {
  const c = consensus.value;
  if (!c?.available) return "muted";
  if (c.broke) return "err";
  return "done";
});

const stateChart = computed(() => {
  const pts = consensus.value?.series || [];
  if (!pts.length) return null;
  const padded = padSeriesForObserveWindow(
    {
      labels: pts.map((p) => (p.tMs / 1000).toFixed(0) + "s"),
      pointTMs: pts.map((p) => p.tMs),
      data: pts.map((p) => p.stateRank),
    },
    observeWindow.value
  );
  return {
    labels: padded.labels,
    pointTMs: padded.pointTMs,
    datasets: [
      {
        label: "server_state rank",
        data: padded.data,
        borderColor: "#34d399",
        backgroundColor: "rgba(52,211,153,0.12)",
        fill: true,
        pointRadius: 2,
        spanGaps: true,
        stepped: true,
      },
    ],
  };
});

const loadChart = computed(() => {
  const pts = consensus.value?.series || [];
  if (!pts.length) return null;
  const hasLoad = pts.some((p) => p.loadFactor != null);
  if (!hasLoad) return null;
  const padded = padSeriesForObserveWindow(
    {
      labels: pts.map((p) => (p.tMs / 1000).toFixed(0) + "s"),
      pointTMs: pts.map((p) => p.tMs),
      data: pts.map((p) => p.loadFactor),
    },
    observeWindow.value
  );
  return {
    labels: padded.labels,
    pointTMs: padded.pointTMs,
    datasets: [
      {
        label: "load_factor",
        data: padded.data,
        borderColor: "#f472b6",
        backgroundColor: "rgba(244,114,182,0.1)",
        fill: true,
        pointRadius: 1,
        spanGaps: true,
      },
    ],
  };
});

const PATHFIND_KEYS = [
  { key: "PathRequest", color: "#38bdf8" },
  { key: "PathFindTrustLine", color: "#fbbf24" },
  { key: "STPath", color: "#a78bfa" },
  { key: "STPathElement", color: "#34d399" },
  { key: "STPathSet", color: "#f472b6" },
];

const pathfindChart = computed(() => {
  const pts = consensus.value?.series || [];
  if (!pts.length) return null;
  const hasAny = PATHFIND_KEYS.some((k) =>
    pts.some((p) => p[k.key] != null || p.pathfind?.[k.key] != null)
  );
  if (!hasAny) return null;

  const labels = pts.map((p) => (p.tMs / 1000).toFixed(0) + "s");
  const pointTMs = pts.map((p) => p.tMs);
  // Pad axis once using first series
  const padBase = padSeriesForObserveWindow(
    {
      labels,
      pointTMs,
      data: pts.map(
        (p) => p.PathRequest ?? p.pathfind?.PathRequest ?? null
      ),
    },
    observeWindow.value
  );
  const pre =
    padBase.pointTMs.length > pointTMs.length &&
    padBase.pointTMs[0] < pointTMs[0]
      ? 1
      : 0;
  const extra = padBase.pointTMs.length - pointTMs.length;

  const datasets = PATHFIND_KEYS.map(({ key, color }) => {
    let data = pts.map((p) => p[key] ?? p.pathfind?.[key] ?? null);
    if (pre) data = [null, ...data];
    for (let i = 0; i < extra - pre; i++) data.push(null);
    return {
      label: key,
      data,
      borderColor: color,
      backgroundColor: "transparent",
      pointRadius: 1,
      spanGaps: true,
      borderWidth: 1.5,
    };
  });

  return {
    labels: padBase.labels,
    pointTMs: padBase.pointTMs,
    datasets,
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
        <div class="stat" v-if="consensusLatest">
          <span class="stat-label">server_state</span>
          <span class="stat-val" :class="consensusLatest.healthy ? '' : 'danger'">
            {{ (consensusLatest.server_state || "?").toUpperCase() }}
          </span>
        </div>
        <div class="stat" v-if="consensusLatest?.validatedSeq != null">
          <span class="stat-label">Ledger</span>
          <span class="stat-val">
            {{ consensusLatest.validatedSeq }}
            <small v-if="consensusLatest.ledgerAge != null"
              >age {{ consensusLatest.ledgerAge }}s</small
            >
          </span>
        </div>
        <div class="stat" v-if="consensusLatest?.loadFactor != null">
          <span class="stat-label">load_factor</span>
          <span class="stat-val">{{ consensusLatest.loadFactor }}</span>
        </div>
        <div class="stat" v-if="consensus?.stateChanges?.length">
          <span class="stat-label">State changes</span>
          <span class="stat-val" :class="consensus.broke ? 'danger' : ''">
            {{ consensus.stateChanges.length }}
          </span>
        </div>
        <div class="stat" v-if="consensusLatest?.PathRequest != null">
          <span class="stat-label">PathRequest</span>
          <span class="stat-val">{{ consensusLatest.PathRequest }}</span>
        </div>
        <div class="stat" v-if="consensusLatest?.STPath != null">
          <span class="stat-label">STPath</span>
          <span class="stat-val">{{ consensusLatest.STPath }}</span>
        </div>
        <div class="stat" v-if="consensusLatest?.STPathElement != null">
          <span class="stat-label">STPathElement</span>
          <span class="stat-val">{{ consensusLatest.STPathElement }}</span>
        </div>
        <div class="stat" v-if="consensusLatest?.STPathSet != null">
          <span class="stat-label">STPathSet</span>
          <span class="stat-val">{{ consensusLatest.STPathSet }}</span>
        </div>
        <div class="stat" v-if="consensusLatest?.PathFindTrustLine != null">
          <span class="stat-label">PathFindTrustLine</span>
          <span class="stat-val">{{ consensusLatest.PathFindTrustLine }}</span>
        </div>
      </div>
      <p v-if="progress.message" class="msg">{{ progress.message }}</p>
      <p
        v-if="consensus?.verdict"
        class="msg consensus-verdict"
        :class="consensusClass"
      >
        {{ consensus.broke ? "⚠ " : "✓ " }}{{ consensus.verdict }}
      </p>

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
          title="Mean update gap (all sessions) — markers every +10 path_finds"
          y-title="ms"
          x-title="run time"
          :labels="gapChart.labels"
          :datasets="gapChart.datasets"
          :point-t-ms="gapChart.pointTMs"
          :observe-window="observeWindow"
          :time-markers="pathFindOpenMarkers"
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
        <LineChart
          v-if="stateChart"
          title="server_state over run (0=disconnected … 4=full 5=proposing)"
          y-title="state rank"
          x-title="run time"
          :labels="stateChart.labels"
          :datasets="stateChart.datasets"
          :point-t-ms="stateChart.pointTMs"
          :observe-window="observeWindow"
          :height="180"
        />
        <LineChart
          v-if="loadChart"
          title="load_factor over run (server_info)"
          y-title="load"
          x-title="run time"
          :labels="loadChart.labels"
          :datasets="loadChart.datasets"
          :point-t-ms="loadChart.pointTMs"
          :observe-window="observeWindow"
          :height="160"
        />
        <LineChart
          v-if="pathfindChart"
          title="Pathfind object counts (get_counts)"
          y-title="in-memory"
          x-title="run time"
          :labels="pathfindChart.labels"
          :datasets="pathfindChart.datasets"
          :point-t-ms="pathfindChart.pointTMs"
          :observe-window="observeWindow"
          :height="220"
        />
      </div>
    </template>
  </section>
</template>
