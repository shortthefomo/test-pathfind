<script setup>
import { fmtMs, fmtPct } from "../api.js";

defineProps({
  runs: { type: Array, default: () => [] },
  selected: { type: Array, default: () => [] },
  activeId: { type: String, default: null },
  detailId: { type: String, default: null },
});

const emit = defineEmits(["toggle", "select-detail"]);

function isChecked(id, selected) {
  return selected.includes(id);
}
</script>

<template>
  <section class="panel history-panel">
    <header class="panel-head">
      <h2>Run history</h2>
      <p class="muted">
        Select 2+ completed runs to compare fall-offs. Click a row for detail
        charts.
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
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
