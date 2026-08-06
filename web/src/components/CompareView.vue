<script setup>
import { computed } from "vue";
import LineChart from "./LineChart.vue";
import { fmtMs, fmtPct, RUN_COLORS } from "../api.js";

const props = defineProps({
  compare: { type: Object, default: null },
});

const falloff = computed(() => props.compare?.falloff || []);
const runs = computed(() => props.compare?.runs || []);

const createFalloff = computed(() => {
  const f = falloff.value;
  return {
    labels: f.map((p) => String(p.maxConcurrency)),
    datasets: [
      {
        label: "Create mean",
        data: f.map((p) => p.createMean),
        borderColor: RUN_COLORS[0],
        backgroundColor: RUN_COLORS[0],
      },
      {
        label: "Create p50",
        data: f.map((p) => p.createP50),
        borderColor: RUN_COLORS[1],
        backgroundColor: RUN_COLORS[1],
      },
      {
        label: "Create p95",
        data: f.map((p) => p.createP95),
        borderColor: RUN_COLORS[2],
        backgroundColor: RUN_COLORS[2],
      },
    ],
  };
});

const gapFalloff = computed(() => {
  const f = falloff.value;
  return {
    labels: f.map((p) => String(p.maxConcurrency)),
    datasets: [
      {
        label: "Update gap mean",
        data: f.map((p) => p.updateGapMean),
        borderColor: RUN_COLORS[3],
      },
      {
        label: "Update gap p50",
        data: f.map((p) => p.updateGapP50),
        borderColor: RUN_COLORS[4],
      },
      {
        label: "Update gap p95",
        data: f.map((p) => p.updateGapP95),
        borderColor: RUN_COLORS[5],
      },
    ],
  };
});

const successFalloff = computed(() => {
  const f = falloff.value;
  return {
    labels: f.map((p) => String(p.maxConcurrency)),
    datasets: [
      {
        label: "Success rate %",
        data: f.map((p) => (p.successRate != null ? p.successRate * 100 : null)),
        borderColor: RUN_COLORS[6],
        backgroundColor: "rgba(45,212,191,0.12)",
        fill: true,
      },
    ],
  };
});

/** Match server-side UPDATE_BUCKET_MS — gap series only emit non-empty buckets. */
const OVERLAY_BUCKET_MS = 3_000;

const overlayGap = computed(() => {
  // Align by run-relative wall time (tMs), NOT array index.
  // bucketTimeSeries only stores buckets that have samples, so a slow server
  // (large update gaps) has fewer points spanning the same duration as a fast
  // one. Index-alignment compresses the sparse series on the X axis.
  const seriesList = runs.value;
  if (!seriesList.length) return { labels: [], datasets: [] };

  let maxT = 0;
  for (const r of seriesList) {
    for (const p of r.series?.updateGapBuckets || []) {
      if (p?.tMs != null && p.tMs > maxT) maxT = p.tMs;
    }
  }
  if (maxT <= 0) return { labels: [], datasets: [] };

  const grid = [];
  for (let t = 0; t <= maxT; t += OVERLAY_BUCKET_MS) grid.push(t);
  if (!grid.length) grid.push(0);
  // Ensure last real sample can land on the axis
  if (grid[grid.length - 1] < maxT) grid.push(grid[grid.length - 1] + OVERLAY_BUCKET_MS);

  const labels = grid.map((t) => (t / 1000).toFixed(0) + "s");

  return {
    labels,
    datasets: seriesList.map((r, i) => {
      const pts = r.series?.updateGapBuckets || [];
      // Accumulate samples per grid slot (sparse → dense shared axis)
      const acc = grid.map(() => []);
      for (const p of pts) {
        if (p?.tMs == null || p.ms == null || !Number.isFinite(p.ms)) continue;
        let idx = Math.round(p.tMs / OVERLAY_BUCKET_MS);
        if (idx < 0) idx = 0;
        if (idx >= acc.length) idx = acc.length - 1;
        acc[idx].push(p.ms);
      }
      const data = acc.map((vals) =>
        vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
      );
      return {
        label: `${r.label} (max ${r.config.maxConcurrency})`,
        data,
        borderColor: RUN_COLORS[i % RUN_COLORS.length],
        pointRadius: 2,
        spanGaps: true,
      };
    }),
  };
});

const insights = computed(() => {
  const f = [...falloff.value].sort((a, b) => a.maxConcurrency - b.maxConcurrency);
  if (f.length < 2) return [];
  const out = [];
  for (let i = 1; i < f.length; i++) {
    const a = f[i - 1];
    const b = f[i];
    if (a.createP95 != null && b.createP95 != null && a.createP95 > 0) {
      const ratio = b.createP95 / a.createP95;
      if (ratio >= 1.5) {
        out.push(
          `Create p95 jumps ${fmtMs(a.createP95)} → ${fmtMs(b.createP95)} (${ratio.toFixed(1)}×) from max ${a.maxConcurrency} → ${b.maxConcurrency}`
        );
      }
    }
    if (a.updateGapP50 != null && b.updateGapP50 != null && a.updateGapP50 > 0) {
      const ratio = b.updateGapP50 / a.updateGapP50;
      if (ratio >= 1.4) {
        out.push(
          `Update gap p50 rises ${fmtMs(a.updateGapP50)} → ${fmtMs(b.updateGapP50)} (${ratio.toFixed(1)}×) at max ${b.maxConcurrency}`
        );
      }
    }
    if (b.successRate != null && b.successRate < 0.95) {
      out.push(
        `Success rate drops to ${fmtPct(b.successRate)} at max ${b.maxConcurrency} (opened ${b.opened}, failed ${b.failed})`
      );
    }
  }
  if (!out.length) {
    out.push(
      "No sharp fall-off thresholds detected between selected runs (create p95 / gap p50 growth &lt; ~1.5×, success ≥ 95%)."
    );
  }
  return out;
});
</script>

<template>
  <section class="panel compare-panel">
    <header class="panel-head">
      <h2>Compare — fall-offs</h2>
      <p class="muted">
        Metrics vs concurrency across selected runs. Spot where latency and
        success degrade.
      </p>
    </header>

    <div v-if="falloff.length < 2" class="empty">
      Select at least two completed runs in history to compare.
    </div>

    <template v-else>
      <ul class="insights">
        <li v-for="(t, i) in insights" :key="i" v-html="t" />
      </ul>

      <div class="charts">
        <LineChart
          title="Create latency fall-off vs max concurrency"
          y-title="ms"
          x-title="max open path_finds"
          :labels="createFalloff.labels"
          :datasets="createFalloff.datasets"
          :height="280"
        />
        <LineChart
          title="Update gap fall-off vs max concurrency"
          y-title="ms"
          x-title="max open path_finds"
          :labels="gapFalloff.labels"
          :datasets="gapFalloff.datasets"
          :height="280"
        />
        <LineChart
          title="Success rate vs max concurrency"
          y-title="%"
          x-title="max open path_finds"
          :labels="successFalloff.labels"
          :datasets="successFalloff.datasets"
          :height="240"
        />
        <LineChart
          title="Update gap over time (overlay by run)"
          y-title="ms"
          x-title="run time"
          :labels="overlayGap.labels"
          :datasets="overlayGap.datasets"
          :height="280"
        />
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Max</th>
              <th>Create mean</th>
              <th>Create p95</th>
              <th>Gap p50</th>
              <th>Success</th>
              <th>Failed</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(p, i) in falloff" :key="p.id">
              <td>
                <span
                  class="swatch"
                  :style="{ background: RUN_COLORS[i % RUN_COLORS.length] }"
                />
                {{ p.label }}
              </td>
              <td>{{ p.maxConcurrency }}</td>
              <td>{{ fmtMs(p.createMean) }}</td>
              <td>{{ fmtMs(p.createP95) }}</td>
              <td>{{ fmtMs(p.updateGapP50) }}</td>
              <td>{{ fmtPct(p.successRate) }}</td>
              <td>{{ p.failed }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
