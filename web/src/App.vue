<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import RunForm from "./components/RunForm.vue";
import LiveRun from "./components/LiveRun.vue";
import RunHistory from "./components/RunHistory.vue";
import RunCharts from "./components/RunCharts.vue";
import CompareView from "./components/CompareView.vue";
import {
  getHealth,
  listRuns,
  startRun,
  watchRun,
  compareRuns,
  getRun,
} from "./api.js";

const health = ref(null);
const runs = ref([]);
const activeRunId = ref(null);
const liveProgress = ref(null);
const liveMeta = ref(null);
const selectedIds = ref([]);
const detailId = ref(null);
const detailSummary = ref(null);
const compare = ref(null);
const error = ref(null);
const busy = computed(
  () =>
    Boolean(activeRunId.value) ||
    runs.value.some((r) => r.status === "running" || r.status === "queued")
);

let unwatch = null;
let pollTimer = null;

async function refreshHealth() {
  try {
    health.value = await getHealth();
    if (health.value.activeRunId) {
      activeRunId.value = health.value.activeRunId;
    }
  } catch (e) {
    error.value = e.message;
  }
}

async function refreshRuns() {
  try {
    const data = await listRuns();
    runs.value = data.runs || [];
    activeRunId.value = data.activeRunId || null;
  } catch (e) {
    error.value = e.message;
  }
}

function attachWatch(id) {
  if (unwatch) unwatch();
  unwatch = watchRun(id, (payload) => {
    if (payload.type === "progress") {
      liveProgress.value = payload.data;
    } else if (payload.type === "done") {
      liveProgress.value = {
        ...(liveProgress.value || {}),
        phase: "done",
        message: "Run complete",
      };
      activeRunId.value = null;
      refreshRuns().then(() => {
        if (payload.data) {
          detailId.value = payload.data.id;
          detailSummary.value = payload.data;
        }
        refreshCompare();
      });
    } else if (payload.type === "error") {
      error.value = payload.data?.message || "Run failed";
      activeRunId.value = null;
      liveProgress.value = {
        ...(liveProgress.value || {}),
        phase: "error",
        message: error.value,
      };
      refreshRuns();
    }
  });
}

async function onStart(opts) {
  error.value = null;
  try {
    const started = await startRun(opts);
    activeRunId.value = started.id;
    liveMeta.value = started;
    const startMode = started.config?.mode === "ramp" ? "ramp" : "burst";
    liveProgress.value = {
      phase: startMode === "ramp" ? "ramp_up" : "burst",
      mode: startMode,
      addIntervalMs: started.config?.addIntervalMs ?? 0,
      maxConcurrency: started.config.maxConcurrency,
      observeMs: started.config.observeMs,
      opened: 0,
      failed: 0,
      ready: 0,
      createLatencies: [],
      updateGapBuckets: [],
      updateRateBuckets: [],
      message: "Starting…",
    };
    attachWatch(started.id);
    await refreshRuns();
  } catch (e) {
    error.value = e.message;
  }
}

function onToggle(id) {
  const set = new Set(selectedIds.value);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  selectedIds.value = [...set];
}

async function onSelectDetail(id) {
  detailId.value = id;
  try {
    const r = await getRun(id);
    detailSummary.value = r.summary || null;
  } catch {
    detailSummary.value = null;
  }
}

async function refreshCompare() {
  if (selectedIds.value.length < 2) {
    compare.value = null;
    return;
  }
  try {
    compare.value = await compareRuns(selectedIds.value);
  } catch (e) {
    error.value = e.message;
  }
}

watch(selectedIds, () => refreshCompare(), { deep: true });

onMounted(async () => {
  await refreshHealth();
  await refreshRuns();
  if (activeRunId.value) {
    const r = runs.value.find((x) => x.id === activeRunId.value);
    liveMeta.value = r || { id: activeRunId.value };
    attachWatch(activeRunId.value);
  }
  // Auto-select last 2–4 done runs for comparison convenience
  const done = runs.value.filter((r) => r.status === "done" && r.summary);
  if (done.length >= 2) {
    selectedIds.value = done.slice(0, Math.min(4, done.length)).map((r) => r.id);
  }
  pollTimer = setInterval(() => {
    refreshHealth();
    if (busy.value) refreshRuns();
  }, 8000);
});

onBeforeUnmount(() => {
  if (unwatch) unwatch();
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div>
        <h1>XRPL <span>path_find</span> load test</h1>
        <p class="muted">
          Burst → ready → observe · multi-run comparison
          <template v-if="health">
            · endpoint
            <code>{{ health.endpoint }}</code>
          </template>
        </p>
      </div>
      <button type="button" class="btn ghost" @click="refreshRuns(); refreshHealth()">
        Refresh
      </button>
    </header>

    <div v-if="error" class="banner error" @click="error = null">
      {{ error }}
      <span class="dismiss">dismiss</span>
    </div>

    <div class="layout-top">
      <RunForm :health="health" :busy="busy" @start="onStart" />
      <LiveRun :progress="liveProgress" :run-meta="liveMeta" />
    </div>

    <RunHistory
      :runs="runs"
      :selected="selectedIds"
      :active-id="activeRunId"
      :detail-id="detailId"
      @toggle="onToggle"
      @select-detail="onSelectDetail"
    />

    <CompareView :compare="compare" />

    <RunCharts :summary="detailSummary" />
  </div>
</template>
