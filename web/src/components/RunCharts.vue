<script setup>
import { computed } from "vue";
import LineChart from "./LineChart.vue";
import {
  fmtMs,
  fmtPct,
  buildPerSessionOverlay,
  buildObserveWindow,
  padSeriesForObserveWindow,
  buildPathFindOpenMarkers,
  padSeriesForTimeMarkers,
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

/** Vertical markers at every 10th path_find create (open). */
const pathFindOpenMarkers = computed(() =>
  buildPathFindOpenMarkers(props.summary?.series?.createOverTime || [], 10)
);

const gapChart = computed(() => {
  const pts = props.summary?.series?.updateGapBuckets || [];
  let padded = padSeriesForObserveWindow(
    {
      labels: pts.map((p) => (p.tMs / 1000).toFixed(0) + "s"),
      pointTMs: pts.map((p) => p.tMs),
      data: pts.map((p) => p.ms),
    },
    observeWindow.value
  );
  padded = padSeriesForTimeMarkers(padded, pathFindOpenMarkers.value);
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

const consensus = computed(
  () => props.summary?.consensus || props.summary?.stats?.consensus || null
);

const stateChart = computed(() => {
  const pts =
    props.summary?.series?.serverState || consensus.value?.series || [];
  if (!pts.length) return null;
  const padded = padSeriesForObserveWindow(
    {
      labels: pts.map((p) => (p.tMs / 1000).toFixed(0) + "s"),
      pointTMs: pts.map((p) => p.tMs),
      data: pts.map((p) => p.rank ?? p.stateRank),
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
        fill: true,
        backgroundColor: "rgba(52,211,153,0.1)",
        pointRadius: 2,
        spanGaps: true,
        stepped: true,
      },
    ],
  };
});

const loadChart = computed(() => {
  const pts =
    props.summary?.series?.serverState || consensus.value?.series || [];
  if (!pts.length || !pts.some((p) => p.loadFactor != null)) return null;
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
        fill: true,
        backgroundColor: "rgba(244,114,182,0.1)",
        pointRadius: 1,
        spanGaps: true,
      },
    ],
  };
});

const consensusBadge = computed(() => {
  const c = consensus.value;
  if (!c || c.broke == null) return null;
  if (c.broke) return { text: "CONSENSUS DEGRADED", cls: "err" };
  return { text: "CONSENSUS OK", cls: "done" };
});

const PATHFIND_KEYS = [
  { key: "PathRequest", color: "#38bdf8" },
  { key: "PathFindTrustLine", color: "#fbbf24" },
  { key: "STPath", color: "#a78bfa" },
  { key: "STPathElement", color: "#34d399" },
  { key: "STPathSet", color: "#f472b6" },
];

const pathfindChart = computed(() => {
  const pts =
    props.summary?.series?.serverState || consensus.value?.series || [];
  if (!pts.length) return null;
  const hasAny = PATHFIND_KEYS.some((k) =>
    pts.some((p) => p[k.key] != null || p.pathfind?.[k.key] != null)
  );
  if (!hasAny) return null;

  const labels = pts.map((p) => (p.tMs / 1000).toFixed(0) + "s");
  const pointTMs = pts.map((p) => p.tMs);
  const padBase = padSeriesForObserveWindow(
    {
      labels,
      pointTMs,
      data: pts.map((p) => p.PathRequest ?? p.pathfind?.PathRequest ?? null),
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

const pathfindSummary = computed(() => {
  const pf =
    consensus.value?.pathfindCounts ||
    props.summary?.stats?.consensus?.pathfindCounts ||
    null;
  if (!pf) return null;
  const rows = PATHFIND_KEYS.map(({ key }) => {
    const row = pf[key];
    if (!row) return null;
    if (row.first == null && row.last == null && row.max == null) return null;
    return { key, ...row };
  }).filter(Boolean);
  return rows.length ? rows : null;
});
</script>

<template>
  <section class="panel" v-if="summary">
    <header class="panel-head row-between">
      <div>
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
      </div>
      <span
        v-if="consensusBadge"
        class="phase-badge"
        :class="consensusBadge.cls"
        >{{ consensusBadge.text }}</span
      >
    </header>

    <div v-if="consensus?.verdict" class="consensus-detail">
      <p class="msg" :class="consensus.broke ? 'err' : 'done'">
        {{ consensus.broke ? "⚠ " : "✓ " }}{{ consensus.verdict }}
      </p>
      <p class="muted" v-if="consensus.statesSeen?.length">
        states seen:
        <code>{{ consensus.statesSeen.join(", ") }}</code>
        · changes: {{ consensus.stateChanges?.length ?? 0 }}
        <template v-if="consensus.ledgerAdvance != null">
          · ledger +{{ consensus.ledgerAdvance }} ({{
            consensus.minValidatedSeq
          }}→{{ consensus.maxValidatedSeq }})
        </template>
        <template v-if="consensus.maxLoadFactor != null">
          · max load_factor {{ consensus.maxLoadFactor }}
        </template>
        <template v-if="consensus.getCountsAvailable">
          · get_counts ok
        </template>
      </p>
      <ul
        v-if="consensus.stateChanges?.length"
        class="state-change-list muted"
      >
        <li v-for="(c, i) in consensus.stateChanges.slice(0, 20)" :key="i">
          @ {{ (c.tMs / 1000).toFixed(1) }}s
          <code>{{ c.from }}</code> → <code>{{ c.to }}</code>
          <span v-if="c.phase">({{ c.phase }})</span>
        </li>
      </ul>
      <div v-if="pathfindSummary" class="pathfind-counts muted">
        <strong>Pathfind get_counts</strong>
        <ul class="state-change-list">
          <li v-for="row in pathfindSummary" :key="row.key">
            <code>{{ row.key }}</code>
            {{ row.first ?? "?" }} → {{ row.last ?? "?" }}
            <span v-if="row.max != null"> · peak {{ row.max }}</span>
            <span v-if="row.delta != null">
              · Δ{{ row.delta >= 0 ? "+" : "" }}{{ row.delta }}
            </span>
          </li>
        </ul>
      </div>
    </div>

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
        title="Mean update gap over run — markers every +10 path_finds"
        y-title="ms"
        x-title="run time"
        :labels="gapChart.labels"
        :datasets="gapChart.datasets"
        :point-t-ms="gapChart.pointTMs"
        :observe-window="observeWindow"
        :time-markers="pathFindOpenMarkers"
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
      <LineChart
        v-if="stateChart"
        title="server_state over run (0=disconnected … 4=full 5=proposing)"
        y-title="state rank"
        x-title="run time"
        :labels="stateChart.labels"
        :datasets="stateChart.datasets"
        :point-t-ms="stateChart.pointTMs"
        :observe-window="observeWindow"
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
      />
    </div>
  </section>
</template>
