<script setup>
import { ref, nextTick } from "vue";
import { fmtMs, fmtPct } from "../api.js";

const props = defineProps({
  runs: { type: Array, default: () => [] },
  selected: { type: Array, default: () => [] },
  activeId: { type: String, default: null },
  detailId: { type: String, default: null },
  busy: { type: Boolean, default: false },
  /** Fallback endpoint when a run has none stored */
  defaultEndpoint: { type: String, default: "" },
});

const emit = defineEmits(["toggle", "select-detail", "rerun"]);

/** @type {import('vue').Ref<object|null>} */
const rerunTarget = ref(null);
const rerunEndpoint = ref("");
const endpointInput = ref(null);

function isChecked(id, selected) {
  return selected.includes(id);
}

function canRerun(r) {
  if (!r || r.status !== "done") return false;
  if (r.canRerun) return true;
  if (r.summary?.canRerun) return true;
  if ((r.requestPlanCount || r.summary?.requestPlanCount || 0) > 0) return true;
  // Older runs: try disk lookup via API (server will error if no plan)
  return Boolean(r.resultsPath || r.summary);
}

/** Full WebSocket URL for a run (config → summary → empty). */
function runEndpoint(r) {
  return (
    r?.config?.endpoint ||
    r?.summary?.config?.endpoint ||
    ""
  );
}

/**
 * Compact host:port for the table; full URL stays in the title tooltip.
 * e.g. ws://192.168.12.238:6006 → 192.168.12.238:6006
 */
function shortEndpoint(url) {
  if (!url) return "—";
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url.replace(/^wss?:\/\//i, "");
  }
}

function openRerun(r) {
  rerunTarget.value = r;
  rerunEndpoint.value =
    runEndpoint(r) || props.defaultEndpoint || "";
  nextTick(() => {
    endpointInput.value?.focus();
    endpointInput.value?.select();
  });
}

function cancelRerun() {
  rerunTarget.value = null;
  rerunEndpoint.value = "";
}

function confirmRerun() {
  const r = rerunTarget.value;
  if (!r) return;
  const endpoint = rerunEndpoint.value.trim();
  emit("rerun", {
    id: r.id,
    endpoint: endpoint || undefined,
  });
  cancelRerun();
}
</script>

<template>
  <section class="panel history-panel">
    <header class="panel-head">
      <h2>Run history</h2>
      <p class="muted">
        Select 2+ completed runs to compare fall-offs. Click a row for detail
        charts. <strong>Rerun</strong> repeats the same path_find requests in
        order — you can change the WebSocket endpoint before replaying.
      </p>
    </header>

    <div v-if="rerunTarget" class="rerun-panel" @click.stop>
      <div class="rerun-panel-head">
        <div>
          <strong>Rerun</strong>
          <span class="muted">
            · same path_finds as
            <code>{{ rerunTarget.label || rerunTarget.id }}</code>
            ({{ rerunTarget.requestPlanCount || rerunTarget.summary?.requestPlanCount || "?" }}
            requests)
          </span>
        </div>
        <button type="button" class="btn ghost sm" @click="cancelRerun">
          Cancel
        </button>
      </div>
      <div class="field">
        <label>WebSocket endpoint</label>
        <input
          ref="endpointInput"
          v-model="rerunEndpoint"
          type="text"
          class="mono"
          spellcheck="false"
          placeholder="ws://host:port"
          @keydown.enter.prevent="confirmRerun"
          @keydown.escape.prevent="cancelRerun"
        />
        <p
          v-if="runEndpoint(rerunTarget) && rerunEndpoint.trim() !== runEndpoint(rerunTarget)"
          class="hint"
        >
          Original: <code>{{ runEndpoint(rerunTarget) }}</code>
        </p>
      </div>
      <div class="form-footer">
        <p class="hint">
          Mode, observe window, and request order stay the same; only the
          target node URL changes if you edit it.
        </p>
        <button
          type="button"
          class="btn primary"
          :disabled="busy || !rerunEndpoint.trim()"
          @click="confirmRerun"
        >
          Start rerun
        </button>
      </div>
    </div>

    <div v-if="!runs.length" class="empty">No runs yet.</div>

    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Label</th>
            <th>Endpoint</th>
            <th>Mode</th>
            <th>Max</th>
            <th>Observe</th>
            <th>Opened</th>
            <th>Failed</th>
            <th>Create p50</th>
            <th>Create p95</th>
            <th>Upd gap p50</th>
            <th>Success</th>
            <th>When</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in runs"
            :key="r.id"
            :class="{
              active: r.id === activeId,
              detail: r.id === detailId,
              err: r.status === 'error',
              'rerun-source': rerunTarget?.id === r.id,
            }"
            @click="emit('select-detail', r.id)"
          >
            <td @click.stop>
              <input
                type="checkbox"
                :disabled="r.status !== 'done' || !r.summary"
                :checked="isChecked(r.id, selected)"
                @change="emit('toggle', r.id)"
              />
            </td>
            <td class="label-cell">
              <strong>{{ r.label }}</strong>
              <span class="status-tag" :class="r.status">{{ r.status }}</span>
              <span
                v-if="r.replayOf || r.summary?.replayOf || r.summary?.isReplay"
                class="status-tag replay"
                :title="`Replay of ${r.replayOf || r.summary?.replayOf || '?'}`"
              >
                replay
              </span>
            </td>
            <td
              class="muted mono endpoint-cell"
              :title="runEndpoint(r) || undefined"
            >
              {{ shortEndpoint(runEndpoint(r)) }}
            </td>
            <td class="muted">
              <template v-if="r.config?.mode === 'ramp'">
                ramp
                <span v-if="r.config?.addIntervalMs">
                  /{{ fmtMs(r.config.addIntervalMs) }}
                </span>
              </template>
              <template v-else>burst</template>
            </td>
            <td>{{ r.config?.maxConcurrency ?? "—" }}</td>
            <td>{{ fmtMs(r.config?.observeMs) }}</td>
            <td>{{ r.summary?.stats?.opened ?? "—" }}</td>
            <td>{{ r.summary?.stats?.failed ?? "—" }}</td>
            <td>{{ fmtMs(r.summary?.stats?.create?.p50) }}</td>
            <td>{{ fmtMs(r.summary?.stats?.create?.p95) }}</td>
            <td>{{ fmtMs(r.summary?.stats?.updateGap?.p50) }}</td>
            <td>{{ fmtPct(r.summary?.stats?.successRate) }}</td>
            <td class="muted mono">
              {{ r.startedAt ? new Date(r.startedAt).toLocaleString() : "—" }}
            </td>
            <td class="actions-cell" @click.stop>
              <button
                type="button"
                class="btn ghost sm"
                :disabled="busy || !canRerun(r)"
                title="Repeat this run; optionally change WebSocket endpoint"
                @click="openRerun(r)"
              >
                Rerun
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
