<script setup>
import { ref, computed, watch } from "vue";

const props = defineProps({
  health: { type: Object, default: null },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits(["start"]);

const maxPreset = ref(50);
const maxCustom = ref(50);
const useCustomMax = ref(false);

const observePreset = ref(30);
const observeCustom = ref(30);
const useCustomObserve = ref(false);

/** "burst" | "ramp" */
const mode = ref("ramp");
const addIntervalPreset = ref(1);
const addIntervalCustom = ref(1);
const useCustomInterval = ref(false);

const readyTimeoutSec = ref(120);
const endpoint = ref("");
const label = ref("");

watch(
  () => props.health,
  (h) => {
    if (h?.endpoint && !endpoint.value) endpoint.value = h.endpoint;
  },
  { immediate: true }
);

const maxConcurrency = computed(() =>
  useCustomMax.value ? Number(maxCustom.value) || 1 : Number(maxPreset.value)
);

const observeSec = computed(() =>
  useCustomObserve.value
    ? Number(observeCustom.value) || 30
    : Number(observePreset.value)
);

const addIntervalSec = computed(() =>
  useCustomInterval.value
    ? Number(addIntervalCustom.value) || 1
    : Number(addIntervalPreset.value)
);

const highLoad = computed(() => maxConcurrency.value > 200);

const rampDurationHint = computed(() => {
  if (mode.value !== "ramp") return null;
  const max = Math.min(1000, Math.max(1, Math.floor(maxConcurrency.value)));
  const interval = Math.max(0, addIntervalSec.value);
  const oneWaySec = Math.max(0, (max - 1) * interval);
  const obs = Math.max(0, Math.floor(observeSec.value));
  const totalSec = oneWaySec * 2 + obs;
  const fmt = (sec) => {
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  };
  return `~${fmt(oneWaySec)} up · ${fmt(obs)} hold · ~${fmt(oneWaySec)} down ≈ ${fmt(totalSec)} total`;
});

function submit() {
  const max = Math.min(1000, Math.max(1, Math.floor(maxConcurrency.value)));
  const obs = Math.min(3600, Math.max(5, Math.floor(observeSec.value)));
  const m = mode.value === "ramp" ? "ramp" : "burst";
  const body = {
    maxConcurrency: max,
    mode: m,
    observeSec: obs,
    readyTimeoutSec: Math.max(5, Number(readyTimeoutSec.value) || 120),
    endpoint: endpoint.value || undefined,
    label: label.value.trim() || undefined,
  };
  if (m === "ramp") {
    body.addIntervalSec = Math.min(
      60,
      Math.max(0, Number(addIntervalSec.value) || 1)
    );
  }
  emit("start", body);
}
</script>

<template>
  <section class="panel form-panel">
    <header class="panel-head">
      <h2>New test round</h2>
      <p class="muted">
        Burst: open all → observe → close. Ramp: up → hold → down.
      </p>
    </header>

    <div class="field">
      <label>Open mode</label>
      <div class="pills">
        <button
          type="button"
          class="pill"
          :class="{ active: mode === 'burst' }"
          @click="mode = 'burst'"
        >
          Burst
        </button>
        <button
          type="button"
          class="pill"
          :class="{ active: mode === 'ramp' }"
          @click="mode = 'ramp'"
        >
          Ramp
        </button>
      </div>
      <p class="hint" style="margin-top: 8px">
        <template v-if="mode === 'burst'">
          Fire all path_finds at once → observe → close all.
        </template>
        <template v-else>
          Ramp up (+1 / interval) → hold at cap for observe window → ramp down
          (−1 / same interval).
        </template>
      </p>
    </div>

    <div v-if="mode === 'ramp'" class="field">
      <label>Ramp interval (up &amp; down)</label>
      <div class="pills">
        <button
          v-for="opt in [
            { s: 1, t: '1s' },
            { s: 3, t: '3s' },
            { s: 5, t: '5s' },
            { s: 10, t: '10s' },
          ]"
          :key="opt.s"
          type="button"
          class="pill"
          :class="{ active: !useCustomInterval && addIntervalPreset === opt.s }"
          @click="useCustomInterval = false; addIntervalPreset = opt.s"
        >
          {{ opt.t }}
        </button>
        <button
          type="button"
          class="pill"
          :class="{ active: useCustomInterval }"
          @click="useCustomInterval = true"
        >
          Custom
        </button>
      </div>
      <div v-if="useCustomInterval" class="row">
        <input
          v-model.number="addIntervalCustom"
          type="number"
          min="0"
          max="60"
          step="0.5"
        />
        <span class="hint">seconds between +1 / −1 (0–60)</span>
      </div>
      <p v-if="rampDurationHint" class="hint" style="margin-top: 8px">
        {{ rampDurationHint }}
      </p>
    </div>

    <div class="field">
      <label>Max concurrent path_finds</label>
      <div class="pills">
        <button
          v-for="n in [10, 25, 50, 75, 100, 150, 200]"
          :key="n"
          type="button"
          class="pill"
          :class="{ active: !useCustomMax && maxPreset === n }"
          @click="useCustomMax = false; maxPreset = n"
        >
          {{ n }}
        </button>
        <button
          type="button"
          class="pill"
          :class="{ active: useCustomMax }"
          @click="useCustomMax = true"
        >
          Custom
        </button>
      </div>
      <div v-if="useCustomMax" class="row">
        <input
          v-model.number="maxCustom"
          type="number"
          min="1"
          max="1000"
          step="1"
        />
        <span class="hint">1 – 1000</span>
      </div>
      <p v-if="highLoad" class="warn">
        High load (&gt;200 sockets). Watch OS file-descriptor limits and node
        capacity.
      </p>
    </div>

    <div class="field">
      <label>{{ mode === "ramp" ? "Hold at cap (observe)" : "Observe window" }}</label>
      <div class="pills">
        <button
          v-for="opt in [
            { s: 30, t: '30s' },
            { s: 60, t: '1m' },
            { s: 120, t: '2m' },
            { s: 300, t: '5m' },
          ]"
          :key="opt.s"
          type="button"
          class="pill"
          :class="{ active: !useCustomObserve && observePreset === opt.s }"
          @click="useCustomObserve = false; observePreset = opt.s"
        >
          {{ opt.t }}
        </button>
        <button
          type="button"
          class="pill"
          :class="{ active: useCustomObserve }"
          @click="useCustomObserve = true"
        >
          Custom
        </button>
      </div>
      <div v-if="useCustomObserve" class="row">
        <input
          v-model.number="observeCustom"
          type="number"
          min="5"
          max="3600"
          step="5"
        />
        <span class="hint">seconds</span>
      </div>
    </div>

    <div class="field grid-2">
      <div>
        <label>Ready timeout (s)</label>
        <input v-model.number="readyTimeoutSec" type="number" min="5" max="600" />
      </div>
      <div>
        <label>Label (optional)</label>
        <input v-model="label" type="text" placeholder="e.g. 50 @ peak hours" />
      </div>
    </div>

    <div class="field">
      <label>WebSocket endpoint</label>
      <input v-model="endpoint" type="text" class="mono" spellcheck="false" />
    </div>

    <div class="form-footer">
      <div class="wallet-status" v-if="health">
        <span class="dot" :class="{ ok: health.walletCount > 0 }" />
        <template v-if="health.walletCount > 0">
          {{ health.walletCount }} wallets cached
        </template>
        <template v-else>
          No wallets —
          <code>npm run discover</code>
        </template>
      </div>
      <button
        type="button"
        class="btn primary"
        :disabled="busy || !health?.walletCount"
        @click="submit"
      >
        {{ busy ? "Run in progress…" : "Fire test round" }}
      </button>
    </div>
  </section>
</template>
