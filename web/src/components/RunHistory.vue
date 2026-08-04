<script setup>
import { fmtMs, fmtPct } from "../api.js";

defineProps({
  runs: { type: Array, default: () => [] },
  selected: { type: Array, default: () => [] },
  activeId: { type: String, default: null },
  detailId: { type: String, default: null },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits(["toggle", "select-detail", "rerun"]);

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
</script>

<template>
  <section class="panel history-panel">
    <header class="panel-head">
      <h2>Run history</h2>
      <p class="muted">
        Select 2+ completed runs to compare fall-offs. Click a row for detail
        charts. <strong>Rerun</strong> repeats the same path_find requests in
        order.
      </p>
    </header>

    <div v-if="!runs.length" class="empty">No runs yet.</div>

    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Label</th>
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
                title="Repeat this run with the same path_find requests in the same order"
                @click="emit('rerun', r.id)"
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
