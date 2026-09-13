/* Motor Optimizer -- configuration, the run loop, and the results workspace.
 *
 * Everything the user types is held in SI internally and converted only for
 * display, so switching between inches and millimetres can never quietly
 * change a design. */

const App = (() => {

  const PA_PER_PSI = 6894.757293168361;
  const KG_PER_LB  = 703.0696;
  const M_PER_IN   = 0.0254;

  const state = {
    spec: null, motor: null, metrics: {}, orderingModes: {}, effortLevels: {},
    unit: 'in', jobId: null, poll: null, results: null, runs: [],
    tolerances: null, toleranceFields: {}, robustness: null,
    profile: 'design', selected: 0, baselineCurves: null, reportJob: null,
    step: 0, reached: 0, validation: { problems: [] },
    ready: {}, diagnostic: null, diagRunning: false, bundleKind: 'sheets',
    battery: null, batteryHandle: null, wakeLock: null, presetSeconds: null,
    liveRange: null, liveSnap: null, runStart: 0
  };

  /* ------------------------------------------------------------- numbers */

  function parseNumber(text) {
    if (typeof text === 'number') return text;
    const raw = String(text || '').trim().replace(/["″]/g, '');
    if (!raw) return NaN;
    let total = 0;
    for (const part of raw.replace(/(\d)-(\d)/g, '$1 $2').split(/\s+/)) {
      if (part.includes('/')) {
        const [a, b] = part.split('/').map(Number);
        if (!b) return NaN;
        total += a / b;
      } else total += Number(part);
    }
    return total;
  }

  //: The two unit systems. Storage is SI throughout; these only shape what
  //: is shown and parsed. Digits are what a shop holds: 0.01 in on a reamer,
  //: 0.1 mm likewise; 0.01 mm would be false precision.
  const SYSTEMS = {
    in: { name: 'imperial',
          length:    { scale: M_PER_IN,   label: '\u2033', sep: '',  dp: 2 },
          pressure:  { scale: PA_PER_PSI, label: 'psi',    dp: 0 },
          mass_flux: { scale: KG_PER_LB,  label: 'lb/in\u00b2s', dp: 3 },
          steps: [[0, 'any'], [0.01, '0.01\u2033'], [0.05, '0.05\u2033'],
                  [0.1, '0.1\u2033'], [0.0625, '1/16\u2033']],
          stepHint: 'e.g. 0.05' },
    mm: { name: 'metric',
          length:    { scale: 0.001, label: 'mm',     sep: ' ', dp: 1 },
          pressure:  { scale: 1e6,   label: 'MPa',    dp: 2 },
          mass_flux: { scale: 1,     label: 'kg/m\u00b2s', dp: 0 },
          steps: [[0, 'any'], [0.25, '0.25 mm'], [0.5, '0.5 mm'],
                  [1, '1 mm'], [1.5, '1.5 mm']],
          stepHint: 'e.g. 1.5' },
  };
  const units = () => SYSTEMS[state.unit] || SYSTEMS.in;
  const unitScale = () => units().length.scale;
  const toDisplay = m => m / unitScale();
  const toSI = v => v * unitScale();
  const lenDigits = () => units().length.dp;
  const fmtLen = m => {
    const u = units().length;
    return toDisplay(m).toFixed(u.dp) + u.sep + u.label;
  };

  //: Pressure and mass flux follow the system; everything else is shown as
  //: stored (N, N·s, s, kg, ratios).
  function metricKind(metric) {
    return (state.metrics[metric] || {}).kind;
  }
  function metricToDisplay(metric, value) {
    const u = units()[metricKind(metric)];
    return u ? value / u.scale : value;
  }
  function metricToSI(metric, value) {
    const u = units()[metricKind(metric)];
    return u ? value * u.scale : value;
  }
  function metricUnit(metric) {
    const u = units()[metricKind(metric)];
    return u ? u.label : ((state.metrics[metric] || {}).unit || '');
  }
  function metricDigits(metric) {
    const u = units()[metricKind(metric)];
    return u ? u.dp : ((state.metrics[metric] || {}).places || 0);
  }
  //: Pressure and flux names the report understands, from the same choice.
  function displayUnits() {
    const u = units();
    return { length: state.unit, pressure: u.pressure.label,
             mass_flux: state.unit === 'in' ? 'lb/(in^2*s)' : 'kg/(m^2*s)' };
  }

  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  };

  const reducedMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  //: Animates a number into an element from whatever it last showed there.
  //: ``key`` names the figure so the previous value survives a re-render.
  const LAST = {};
  function tweenNumber(node, key, value, format) {
    const from = LAST[key];
    LAST[key] = value;
    if (from === undefined || from === value || reducedMotion() || !isFinite(from)) {
      node.textContent = format(value);
      return;
    }
    const start = performance.now(), ms = 420;
    const ease = t => 1 - Math.pow(1 - t, 3);
    node.classList.remove('ticked'); void node.offsetWidth; node.classList.add('ticked');
    const frame = now => {
      const t = Math.min((now - start) / ms, 1);
      node.textContent = format(from + (value - from) * ease(t));
      if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  //: Fires ``fn`` once typing pauses, so a keystroke never redraws the page.
  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function toast(message, ms = 2600) {
    const node = $('#toast');
    node.textContent = message; node.hidden = false;
    clearTimeout(node._t);
    node._t = setTimeout(() => { node.hidden = true; }, ms);
  }

  /* ---------------------------------------------------------- bootstrap */

  async function boot() {
    wireChrome();
    readBattery();
    wireWizard();
    await loadDefaults();
    // A finished run can be reopened by its id, which makes a result something
    // a bookmarkable address for a run in progress on this machine.
    const params = new URLSearchParams(location.search);
    if (params.get('profile')) state.profile = params.get('profile');
    const job = params.get('job');
    const step = params.get('step');
    if (job) await attachToRun(job);
    if (step !== null) goTo(Number(step));
    else if (!job) goTo(0);
  }

  async function loadDefaults(payload) {
    let data = payload;
    if (!data) {
      const res = await fetch('/api/defaults');
      data = await res.json();
      if (!res.ok || !data.spec) {
        // Without this the page dereferences an error body and dies silently,
        // leaving the header stuck on "loading…" with nothing to explain it.
        $('#chipName').textContent = 'no motor loaded';
        $('#emptyState').hidden = false;
        $('#emptyState').innerHTML =
          `<h2>No motor loaded</h2><p>${data.detail || 'Could not read the default motor.'}
           Use <strong>Change</strong> in the header to pick a <code>.ric</code> file.</p>`;
        return;
      }
    }
    state.spec = data.spec;
    state.spec.display_units = displayUnits();
    state.motor = data.motor;
    state.metrics = data.metrics;
    state.orderingModes = data.ordering_modes;
    state.effortLevels = data.effort_levels;
    state.baselineCurves = data.curves;
    state.hardware = data.hardware || {};
    state.toleranceFields = data.tolerance_fields || {};
    state.machine = data.machine || {};
    if (!state.tolerances) state.tolerances = data.tolerances || [];
    renderMotor();
    renderHardware();
    renderConfig();
    renderEmptyPreview();
    // ?step=N opens on that step and ?job=ID reopens a held run, for
    // screenshots and the field guide.
    const query = new URLSearchParams(location.search);
    const wanted = Number(query.get('step'));
    if (Number.isInteger(wanted) && wanted > 0 && wanted < STEPS) {
      state.reached = wanted;
      goTo(wanted);
    }
    if (query.get('profile')) state.profile = query.get('profile');
    if (query.get('job')) { state.reached = STEPS - 1; attachToRun(query.get('job')); }
    renderMotorPreview();
    renderBaselineBoxes();
    validate();
  }

  function setUnit(unit, silent) {
    if (!SYSTEMS[unit]) return;
    state.unit = unit;
    try { localStorage.setItem('units', unit); } catch (e) { /* fine */ }
    document.querySelectorAll('.unit-toggle button').forEach(x =>
      x.classList.toggle('active', x.dataset.unit === unit));
    if (state.spec) state.spec.display_units = displayUnits();
    renderStepChips();
    if (silent && !state.motor) return;
    if (state.motor) {
      renderMotor(); renderHardware(); renderVariables(); renderObjectives();
      renderConstraints(); renderOrdering(); renderTolerances();
      renderBaselineCheck();
      if (state.validation) renderSizing(state.validation.sizing);
    }
    if (state.results) renderPanels();
    if (state.liveSnap) { state.liveRange = null; redrawLive(); }
  }

  //: The "set every step to" chips, in the active system's sizes.
  function renderStepChips() {
    const host = $('.quick-steps');
    if (!host) return;
    host.querySelectorAll('.chip[data-step]').forEach(c => c.remove());
    units().steps.forEach(([size, label]) => {
      const b = el('button', 'chip', label);
      b.type = 'button';
      b.dataset.step = String(size);
      b.addEventListener('click', () => {
        state.spec.variables.forEach(v => { v.step = toSI(size); });
        renderVariables(); validate();
      });
      host.appendChild(b);
    });
  }

  function wireChrome() {
    document.querySelectorAll('.unit-toggle button').forEach(b =>
      b.addEventListener('click', () => setUnit(b.dataset.unit)));
    try { setUnit(localStorage.getItem('units') || state.unit, true); }
    catch (e) { /* storage may be blocked; the default stands */ }

    window.addEventListener('resize', debounce(placeStepIndicator, 80));

    $('#btnTheme').addEventListener('click', () => {
      const root = document.documentElement;
      const now = root.getAttribute('data-theme');
      root.setAttribute('data-theme', now === 'dark' ? 'light' : 'dark');
      if (state.results) renderPanels(); else renderEmptyPreview();
    });

    $('#btnRun').addEventListener('click', startRun);
    $('#btnHardware').addEventListener('click', applyHardware);
    $('#btnHardwareReset').addEventListener('click', resetHardware);
    $('#btnRefit').addEventListener('click', () =>
      Charts.fitAxes($('#livePlot'),
                     state.liveSnap ? fitRange(state.liveSnap) : state.liveRange));
    $('#btnReportOpen').addEventListener('click', openReport);
    $('#btnBundle').addEventListener('click', () => downloadBundle('sheets'));
    on('#btnEng', 'click', () => downloadBundle('eng'));
    on('#btnRic', 'click', () => downloadBundle('ric'));
    on('#btnBestRic', 'click', downloadBest);
    $('#btnCancel').addEventListener('click', cancelRun);
    $('#btnLoad').addEventListener('click', () => $('#fileInput').click());
    on('#btnLoadBaseline', 'click', () => $('#fileInput').click());
    on('#btnLoadedExport', 'click', () => exportDesign(state.selected));
    $('#fileInput').addEventListener('change', onFilePicked);
    $('#btnAddObjective').addEventListener('click', () => {
      state.spec.objectives.push({ metric: 'total_impulse', direction: 'max',
                                   weight: 1, target: null, enabled: true });
      renderObjectives(); validate();
    });
    $('#btnAddConstraint').addEventListener('click', () => {
      state.spec.constraints.push({ metric: 'peak_kn', op: '<=', value: 225,
                                    enabled: true, margin: 0, label: '' });
      renderConstraints(); validate();
    });
    document.querySelectorAll('[data-all]').forEach(b =>
      b.addEventListener('click', () => {
        const free = b.dataset.all === 'free';
        state.spec.variables.forEach(v => { v.free = free || (countIsFree() && isCore(v)); });
        renderVariables(); validate();
      }));
    document.querySelectorAll('[data-preset]').forEach(b =>
      b.addEventListener('click', () => applyPreset(b.dataset.preset)));
  }

  async function onFilePicked(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    const content = await file.text();
    const res = await fetch('/api/motor/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, content })
    });
    if (!res.ok) { toast('Could not read that .ric file.'); return; }
    state.results = null;
    $('#panels').hidden = true; $('#emptyState').hidden = false;
    await loadDefaults(await res.json());
    toast('Loaded ' + file.name);
  }

  function applyPreset(kind) {
    const s = state.spec;
    const off = () => s.objectives.forEach(o => { o.enabled = false; });
    const on = (metric, direction) => {
      let row = s.objectives.find(o => o.metric === metric);
      if (!row) { row = { metric, direction, weight: 1, target: null, enabled: true };
                  s.objectives.push(row); }
      Object.assign(row, { enabled: true, direction, weight: 1 });
    };
    off();
    if (kind === 'thrust') on('initial_thrust', 'max');
    if (kind === 'impulse') on('total_impulse', 'max');
    if (kind === 'flat') on('thrust_variation', 'min');
    if (kind === 'tradeoff') { on('initial_thrust', 'max'); on('total_impulse', 'max');
                               s.mode = 'pareto'; }
    if (kind !== 'tradeoff') s.mode = 'fast';
    $('#modePareto').checked = s.mode === 'pareto';
    renderObjectives(); validate();
  }

  /* ------------------------------------------------------------- config */

  function renderMotor() {
    const m = state.motor;
    $('#chipName').textContent = m.name || 'motor';
    $('#chipClass').textContent = m.designation || '';
    const rows = [
      ['Grains', m.grain_count + ' × ' + fmtLen(m.grain_lengths[0])],
      ['Grain OD (case bore)', fmtLen(m.grain_diameter)],
      ['Throat / exit', fmtLen(m.throat) + ' / ' + fmtLen(m.exit)],
      ['Throat length', fmtLen(m.throat_length)],
      ['Inhibited ends', m.inhibited_ends],
      ['Propellant', m.propellant],
      ['Initial thrust', Math.round(m.initial_thrust).toLocaleString() + ' N'],
      ['Total impulse', Math.round(m.total_impulse).toLocaleString() + ' N·s'],
      ['Peak pressure', fmtMetric('max_pressure', m.max_pressure)],
      ['Kn', m.initial_kn.toFixed(0) + ' → ' + m.peak_kn.toFixed(0)],
      ['Peak mass flux', fmtMetric('peak_mass_flux', m.peak_mass_flux)]
    ];
    $('#motorSpecs').innerHTML = rows.map(([k, v]) =>
      `<dt>${k}</dt><dd>${v}</dd>`).join('');
    $('#motorWarnings').innerHTML = (m.warnings || [])
      .map(w => `<div class="warn-pill">${w}</div>`).join('');
  }

  function renderHardware() {
    const m = state.motor, hw = state.hardware || {};
    $('#hwDiameter').value = toDisplay(hw.grain_diameter || m.grain_diameter).toFixed(lenDigits());
    $('#hwLength').value = toDisplay(hw.grain_length || m.grain_lengths[0]).toFixed(lenDigits());
    $('#hwEnds').value = hw.inhibited_ends || m.inhibited_ends || 'Neither';
    // A motor that no longer matches its file has to say so, or the app is
    // quietly simulating something other than what the user opened.
    $('#hwFlag').hidden = !hw.overridden;
    $('#btnHardwareReset').hidden = !hw.overridden;
  }

  async function resetHardware() {
    const res = await fetch('/api/hardware/reset', { method: 'POST' });
    if (!res.ok) { toast('Could not reset.'); return; }
    state.results = null;
    $('#panels').hidden = true; $('#emptyState').hidden = false;
    await loadDefaults(await res.json());
    toast('Reloaded the motor exactly as the file has it');
  }

  async function applyHardware() {
    const body = { inhibited_ends: $('#hwEnds').value };
    const res = await fetch('/api/hardware', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) { toast('Could not apply that hardware.'); return; }
    state.results = null;
    $('#panels').hidden = true; $('#emptyState').hidden = false;
    await loadDefaults(await res.json());
    toast('Hardware applied. Bounds and baseline updated.');
  }

  function renderConfig() {
    renderVariables(); renderObjectives(); renderConstraints();
    renderTolerances(); renderOrdering(); renderEffort();
  }

  function renderFreeSummary() {
    const host = $('#freeSummary');
    if (!host) return;
    const vars = state.spec.variables || [];
    const free = vars.filter(v => v.free);
    const steps = [...new Set(free.map(v => v.step || 0))];
    const gc = state.spec.grain_count || {};
    const countRow = gc.free
      ? `<div class="free-row"><span class="k">Grain count</span>
         <span class="v">${gc.n_min} \u2013 ${gc.n_max}</span></div>` : '';
    host.innerHTML = `
      <div class="big"><span class="n">${free.length + (gc.free ? 1 : 0)}</span>
        <span class="of">of ${vars.length + (gc.free ? 1 : 0)} free</span></div>
      <div class="free-rows">${countRow}${(gc.free
        ? [Object.assign({}, vars.find(isCore) || {}, { label: 'Grain cores (all)' }),
           ...vars.filter(v => !isCore(v))]
        : vars).map(v => `
        <div class="free-row ${v.free ? '' : 'held'}">
          <span class="k">${v.label || v.name}</span>
          <span class="v">${v.free
            ? fmtLen(v.low) + ' \u2013 ' + fmtLen(v.high)
            : 'held at ' + fmtLen(v.fixed_value || 0)}</span>
        </div>`).join('')}</div>
      <p class="hint">${steps.length === 1
        ? 'Every free dimension is on a ' +
          (steps[0] ? fmtLen(steps[0]) : 'continuous') + ' grid.'
        : 'Mixed machining grids across the free dimensions.'}</p>`;
  }

  //: Grain lengths a builder can cast and handle, as a multiple of the outer
  //: diameter. Outside this the count is allowed, but the page says so.
  const GRAIN_LD = [0.5, 3.0];

  function renderGrainCount() {
    const free = $('#gcFree');
    if (!free || !state.motor) return;
    const spec = state.spec;
    if (!spec.grain_count) spec.grain_count = { free: false, n_min: 4, n_max: 8 };
    const gc = spec.grain_count;
    const m = state.motor;
    const stack = m.stack_length || m.grain_lengths.reduce((a, b) => a + b, 0);
    const bore = m.grain_diameter;
    free.checked = !!gc.free;
    $('#gcRange').hidden = !gc.free;
    $('#gcMin').value = String(gc.n_min);
    $('#gcMax').value = String(gc.n_max);
    const note = $('#gcNote');
    if (!gc.free) {
      note.textContent = `Held at ${m.grain_count} grains of ${fmtLen(m.grain_lengths[0])}, as the file has it.`;
    } else {
      note.innerHTML = `The ${fmtLen(stack)} stack is cut into every count from
        ${gc.n_min} to ${gc.n_max} (${fmtLen(stack / gc.n_max)} to ${fmtLen(stack / gc.n_min)}
        each). Each count gets a short search; the best go on to the full one.`;
    }
    const warn = $('#gcWarn');
    const ld = n => stack / n / bore;
    const long = gc.free && ld(gc.n_min) > GRAIN_LD[1];
    const short = gc.free && ld(gc.n_max) < GRAIN_LD[0];
    warn.hidden = !(long || short);
    warn.textContent = long
      ? `${gc.n_min} grains means ${fmtLen(stack / gc.n_min)} each, ${ld(gc.n_min).toFixed(1)}× the diameter. Long grains are hard to cast and handle; the model does not care.`
      : short
        ? `${gc.n_max} grains means ${fmtLen(stack / gc.n_max)} each, ${ld(gc.n_max).toFixed(1)}× the diameter. Very short grains burn mostly on their faces; the model allows it.`
        : '';
    free.onchange = () => { gc.free = free.checked; renderVariables(); validate(); };
    const bound = (id, key) => {
      const take = () => {
        const v = parseInt($(id).value, 10);
        if (!isNaN(v) && v > 0) gc[key] = v;
        if (gc.n_max < gc.n_min) gc[key === 'n_min' ? 'n_max' : 'n_min'] = gc[key];
      };
      $(id).oninput = debounce(() => { take(); renderVarPreview(); renderFreeSummary(); validate(); }, 160);
      $(id).onchange = () => { take(); renderVariables(); validate(); };
    };
    bound('#gcMin', 'n_min'); bound('#gcMax', 'n_max');
  }

  const isCore = v => v.name.startsWith('core');

  //: With the count free there may be any number of grains, so the cores
  //: share one row and one set of bounds. Every core is then free.
  function countIsFree() {
    return !!(state.spec.grain_count && state.spec.grain_count.free);
  }

  function renderVariables() {
    renderFreeSummary();
    renderGrainCount();
    const body = $('#varRows');
    body.innerHTML = '';
    const vars = state.spec.variables;
    const collapse = countIsFree();
    if (collapse) vars.forEach(v => { if (isCore(v)) v.free = true; });
    // Each row edits a group of variables: every core at once when collapsed.
    const rows = [];
    vars.forEach((v, i) => {
      if (collapse && isCore(v)) {
        if (!rows.some(r => r.shared)) rows.push({ shared: true, v, label: 'Grain cores (all)' });
        return;
      }
      rows.push({ shared: false, v, label: v.label || v.name, i });
    });
    rows.forEach((row, r) => {
      const v = row.v;
      const tr = el('tr', v.free ? '' : 'fixed');
      const dp = lenDigits();
      const lock = row.shared ? 'disabled title="Every core is free while the count is"' : '';
      tr.innerHTML = `
        <td><input type="checkbox" ${v.free ? 'checked' : ''} data-r="${r}" data-k="free" ${lock}></td>
        <td class="var-name">${row.label}</td>
        <td><input type="text" value="${toDisplay(v.low).toFixed(dp)}" data-r="${r}" data-k="low" ${v.free ? '' : 'disabled'}></td>
        <td><input type="text" value="${toDisplay(v.high).toFixed(dp)}" data-r="${r}" data-k="high" ${v.free ? '' : 'disabled'}></td>
        <td><input type="text" value="${v.step ? toDisplay(v.step).toFixed(dp) : ''}" placeholder="any" data-r="${r}" data-k="step" ${v.free ? '' : 'disabled'}></td>`;
      body.appendChild(tr);
    });
    const apply = input => {
      const row = rows[Number(input.dataset.r)];
      const targets = row.shared ? vars.filter(isCore) : [row.v];
      const key = input.dataset.k;
      targets.forEach(v => {
        if (key === 'free') v.free = input.checked;
        else if (key === 'step') {
          const parsed = parseNumber(input.value);
          v.step = isNaN(parsed) ? 0 : toSI(parsed);
        } else {
          const parsed = parseNumber(input.value);
          if (!isNaN(parsed)) v[key] = toSI(parsed);
        }
      });
      return key;
    };
    // Typing updates the model, the preview and the counts as it goes; the
    // table itself only redraws on commit, so the caret is never lost.
    const live = debounce(input => { apply(input); renderVarPreview(); renderFreeSummary(); validate(); }, 160);
    body.querySelectorAll('input[type="text"]').forEach(input =>
      input.addEventListener('input', () => live(input)));
    body.querySelectorAll('input').forEach(input => {
      input.addEventListener('change', () => {
        const key = apply(input);
        if (key === 'free') renderVariables();
        else { renderVarPreview(); renderFreeSummary(); }
        validate();
      });
    });
    renderVarPreview();
  }

  //: The stack as the bounds describe it: every grain's outer wall, the band
  //: a core may sit in, and where the loaded core is now. Redrawn on every
  //: keystroke, so the bounds are seen rather than imagined.
  function renderVarPreview() {
    const host = $('#varPreview');
    if (!host || !state.motor) return;
    const m = state.motor, gc = state.spec.grain_count || {};
    const vars = state.spec.variables;
    const cores = vars.filter(isCore);
    if (!cores.length) { host.innerHTML = ''; return; }
    const stack = m.stack_length || m.grain_lengths.reduce((a, b) => a + b, 0);
    const bore = m.grain_diameter;
    const n = gc.free ? gc.n_max : m.grain_count;
    const lengths = gc.free ? Array(n).fill(stack / n) : m.grain_lengths;
    const W = 640, pad = 12, H = 150;
    const sx = (W - 2 * pad) / stack;
    const sy = Math.min((H - 2 * pad) / bore, sx);
    const cy = H / 2;
    const gap = 3;
    let x = pad;
    const parts = [];
    lengths.forEach((L, i) => {
      const v = gc.free ? cores[0] : (cores[i] || cores[0]);
      const w = Math.max(L * sx - gap, 2);
      const r = q => Math.max(q * sy / 2, 0);
      const fixed = v.free ? null : (v.fixed_value !== null && v.fixed_value !== undefined
        ? v.fixed_value : m.cores[i] || m.cores[0]);
      parts.push(`<rect x="${x}" y="${cy - r(bore)}" width="${w}" height="${2 * r(bore)}"
        rx="2" fill="var(--surface-2)" stroke="var(--line)"/>`);
      if (v.free) {
        parts.push(`<rect x="${x}" y="${cy - r(v.high)}" width="${w}" height="${2 * r(v.high)}"
          fill="var(--accent)" opacity=".18"/>`);
        parts.push(`<rect x="${x}" y="${cy - r(v.low)}" width="${w}" height="${2 * r(v.low)}"
          fill="var(--accent)" opacity=".42"/>`);
      } else {
        parts.push(`<rect x="${x}" y="${cy - r(fixed)}" width="${w}" height="${2 * r(fixed)}"
          fill="var(--ink-3)" opacity=".55"/>`);
      }
      const now = m.cores[i];
      if (now !== undefined && !gc.free) {
        parts.push(`<line x1="${x}" x2="${x + w}" y1="${cy - r(now)}" y2="${cy - r(now)}"
          stroke="var(--ink)" stroke-width="1" stroke-dasharray="3 3"/>
          <line x1="${x}" x2="${x + w}" y1="${cy + r(now)}" y2="${cy + r(now)}"
          stroke="var(--ink)" stroke-width="1" stroke-dasharray="3 3"/>`);
      }
      x += L * sx;
    });
    const c0 = cores[0];
    const cap = gc.free
      ? `${gc.n_min}\u2013${gc.n_max} grains \u00b7 cores ${fmtLen(c0.low)}\u2013${fmtLen(c0.high)}`
      : `${m.grain_count} grains \u00b7 core band per grain, dashed line is the loaded core`;
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Core bounds preview">${parts.join('')}</svg>
      <p class="cap">${cap}</p>`;
  }

  function metricOptions(selected) {
    return Object.entries(state.metrics).map(([key, m]) =>
      `<option value="${key}" ${key === selected ? 'selected' : ''}>${m.label}</option>`).join('');
  }

  function renderObjectives() {
    const host = $('#objectiveRows');
    host.innerHTML = '';
    state.spec.objectives.forEach((o, i) => {
      const row = el('div', 'row' + (o.enabled ? '' : ' off'));
      row.innerHTML = `
        <input type="checkbox" ${o.enabled ? 'checked' : ''} data-i="${i}" data-k="enabled">
        <select data-i="${i}" data-k="metric">${metricOptions(o.metric)}</select>
        <select data-i="${i}" data-k="direction">
          <option value="max" ${o.direction === 'max' ? 'selected' : ''}>maximize</option>
          <option value="min" ${o.direction === 'min' ? 'selected' : ''}>minimize</option>
          <option value="target" ${o.direction === 'target' ? 'selected' : ''}>hit target</option>
        </select>
        <button class="del" data-del="${i}" title="Remove">×</button>`;
      if (o.direction === 'target') {
        const t = el('div', 'row');
        t.style.gridColumn = '1 / -1';
        t.innerHTML = `<span class="op">target</span>
          <input type="text" data-i="${i}" data-k="target"
            value="${o.target !== null && o.target !== undefined ? metricToDisplay(o.metric, o.target) : ''}">
          <span class="unit">${metricUnit(o.metric)}</span><span></span>`;
        host.appendChild(row); host.appendChild(t);
      } else host.appendChild(row);
    });
    host.querySelectorAll('[data-k]').forEach(input => {
      input.addEventListener('change', () => {
        const o = state.spec.objectives[Number(input.dataset.i)];
        const key = input.dataset.k;
        if (key === 'enabled') o.enabled = input.checked;
        else if (key === 'target') {
          const p = parseNumber(input.value);
          o.target = isNaN(p) ? null : metricToSI(o.metric, p);
        } else o[key] = input.value;
        renderObjectives(); validate();
      });
    });
    host.querySelectorAll('[data-del]').forEach(b =>
      b.addEventListener('click', () => {
        state.spec.objectives.splice(Number(b.dataset.del), 1);
        renderObjectives(); validate();
      }));
    renderObjectiveNote();
  }

  function renderObjectiveNote() {
    const host = $('#objectiveNote');
    if (!host) return;
    const on = (state.spec.objectives || []).filter(o => o.enabled);
    const names = on.map(o => Charts.metricLabel(o.metric).toLowerCase());
    host.innerHTML = !on.length
      ? 'Nothing is selected yet.'
      : on.length === 1
        ? `One objective, so the run returns a single best motor for
           <strong>${names[0]}</strong>.`
        : `${on.length} objectives, so the run returns a curve of options trading
           <strong>${names.join('</strong> against <strong>')}</strong>. Every design
           on it is buildable; choosing between them is the point.`;
  }

  function renderConstraints() {
    const host = $('#constraintRows');
    host.innerHTML = '';
    state.spec.constraints.forEach((c, i) => {
      const unit = metricUnit(c.metric);
      const shown = metricToDisplay(c.metric, c.value);
      const dp = Math.abs(shown) < 10 ? 3 : 0;
      // Two lines: the metric gets the full width so its name is never clipped,
      // and the comparison sits under it where the numbers line up.
      const row = el('div', 'row constraint' + (c.enabled ? '' : ' off'));
      row.innerHTML = `
        <input type="checkbox" ${c.enabled ? 'checked' : ''} data-i="${i}" data-k="enabled">
        <select data-i="${i}" data-k="metric">${metricOptions(c.metric)}</select>
        <button class="del" data-del="${i}" title="Remove">×</button>
        <div class="row-compare">
          <select data-i="${i}" data-k="op">
            <option value="<=" ${c.op === '<=' ? 'selected' : ''}>≤</option>
            <option value=">=" ${c.op === '>=' ? 'selected' : ''}>≥</option>
          </select>
          <input type="text" data-i="${i}" data-k="value" value="${shown.toFixed(dp)}">
          <span class="unit">${unit}</span>
        </div>`;
      host.appendChild(row);
    });
    // A limit typed in is checked against the loaded motor as it is typed.
    const liveValue = debounce(input => {
      const c = state.spec.constraints[Number(input.dataset.i)];
      const p = parseNumber(input.value);
      if (isNaN(p)) return;
      c.value = metricToSI(c.metric, p);
      renderBaselineCheck(); renderDupes(); validate();
    }, 160);
    host.querySelectorAll('[data-k="value"]').forEach(input =>
      input.addEventListener('input', () => liveValue(input)));
    host.querySelectorAll('[data-k]').forEach(input => {
      input.addEventListener('change', () => {
        const c = state.spec.constraints[Number(input.dataset.i)];
        const key = input.dataset.k;
        if (key === 'enabled') c.enabled = input.checked;
        else if (key === 'value') {
          const p = parseNumber(input.value);
          if (!isNaN(p)) c.value = metricToSI(c.metric, p);
        } else if (key === 'metric') {
          c.metric = input.value; c.label = '';
        } else c[key] = input.value;
        renderConstraints(); validate();
      });
    });
    host.querySelectorAll('[data-del]').forEach(b =>
      b.addEventListener('click', () => {
        state.spec.constraints.splice(Number(b.dataset.del), 1);
        renderConstraints(); validate();
      }));
    renderDupes();
    renderBaselineCheck();
  }

  // Two limits on one metric are not an error, but only the tighter one binds,
  // and a contradictory pair rules out every design.
  function renderDupes() {
    const host = $('#constraintDupes');
    if (!host) return;
    const seen = {};
    (state.spec.constraints || []).forEach(c => {
      if (!c.enabled) return;
      (seen[c.metric] = seen[c.metric] || []).push(c);
    });
    const notes = Object.keys(seen).filter(m => seen[m].length > 1).map(m => {
      const rows = seen[m];
      const label = Charts.metricLabel(m);
      const ops = rows.map(c => c.op);
      const opposed = ops.indexOf('<=') >= 0 && ops.indexOf('>=') >= 0;
      const values = rows.map(c =>
        (c.op === '<=' ? '≤ ' : '≥ ') + fmtMetric(m, c.value)).join(' and ');
      if (opposed) {
        const hi = Math.min.apply(null, rows.filter(c => c.op === '<=').map(c => c.value));
        const lo = Math.max.apply(null, rows.filter(c => c.op === '>=').map(c => c.value));
        return lo > hi
          ? `<div class="problem err"><strong>${label}</strong> is limited twice,
             ${values}, and no value satisfies both.</div>`
          : `<div class="problem note"><strong>${label}</strong> is limited twice,
             ${values}. Together they are a band.</div>`;
      }
      const binding = rows[0].op === '<='
        ? Math.min.apply(null, rows.map(c => c.value))
        : Math.max.apply(null, rows.map(c => c.value));
      return `<div class="problem note"><strong>${label}</strong> is limited twice,
        ${values}. Only ${rows[0].op === '<=' ? '≤ ' : '≥ '}${fmtMetric(m, binding)}
        has any effect.</div>`;
    });
    host.innerHTML = notes.join('');
  }

  function fmtMetric(metric, value) {
    const shown = metricToDisplay(metric, value);
    const unit = metricUnit(metric);
    const dp = metricKind(metric) ? metricDigits(metric) : 3;
    return shown.toLocaleString(undefined, { maximumFractionDigits: dp }) +
           (unit ? ' ' + unit : '');
  }

  function renderTolerances() {
    const host = $('#toleranceRows');
    if (!host) return;
    host.innerHTML = (state.tolerances || []).map((t, i) => {
      const meta = state.toleranceFields[t.field] || {};
      // Absolute tolerances are a length; relative ones are a percentage.
      const abs = meta.kind === 'absolute';
      const shown = abs ? toDisplay(t.sigma).toFixed(lenDigits() + 2) : (t.sigma * 100).toFixed(1);
      const unit = abs ? units().length.label : '%';
      return `<div class="row tol ${t.enabled ? '' : 'off'}">
        <input type="checkbox" ${t.enabled ? 'checked' : ''} data-t="${i}" data-k="enabled">
        <span class="tol-name" title="${meta.help || ''}">${meta.label || t.field}</span>
        <input type="text" data-t="${i}" data-k="sigma" value="${shown}">
        <span class="unit">${unit}</span></div>`;
    }).join('');
    host.querySelectorAll('[data-k]').forEach(input => {
      input.addEventListener('change', () => {
        const t = state.tolerances[Number(input.dataset.t)];
        const meta = state.toleranceFields[t.field] || {};
        if (input.dataset.k === 'enabled') t.enabled = input.checked;
        else {
          const v = parseNumber(input.value);
          if (!isNaN(v)) t.sigma = meta.kind === 'absolute' ? toSI(v) : v / 100;
        }
        renderTolerances();
      });
    });
  }

  async function checkRobustness(node) {
    const ctx = context();
    if (!ctx.design) { toast('Run the optimizer first.'); return; }
    node.innerHTML = '<p class="sub">Building 400 motors and firing them…</p>';
    const res = await fetch('/api/robustness', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: state.results.spec || state.spec, x: ctx.design.x,
                             n_grains: ctx.design.n_grains || null,
                             tolerances: state.tolerances, samples: 400 })
    });
    if (!res.ok) { node.innerHTML = '<p class="sub">Could not run the check.</p>'; return; }
    state.robustness = await res.json();
    renderPanels();
  }

  //: What each rule costs or buys, since the choice moves the result by more
  //: than most of the bounds do.
  const ORDERING_WHY = {
    none: 'No rule. Tends to choke the aft grain, and rules out nothing.',
    nondecreasing: 'The default. Keeps the aft port open without forcing six '
      + 'different mandrels.',
    strict: 'Every core wider than the one ahead. Costs roughly 0.8% of thrust '
      + 'against allowing ties.',
    paired: 'A few sizes shared across the grains. Fewer mandrels to buy or turn.'
  };

  function renderOrdering() {
    const sel = $('#orderingMode');
    sel.innerHTML = Object.entries(state.orderingModes).map(([k, label]) =>
      `<option value="${k}" ${state.spec.ordering.mode === k ? 'selected' : ''}>${label}</option>`).join('');
    sel.onchange = () => { state.spec.ordering.mode = sel.value; renderOrdering(); validate(); };

    const note = $('#orderingNote');
    if (note) note.textContent = ORDERING_WHY[state.spec.ordering.mode] || '';

    const stepField = $('#orderingStepField');
    stepField.hidden = state.spec.ordering.mode !== 'strict';
    const stepInput = $('#orderingStep');
    stepInput.value = state.spec.ordering.min_step
      ? toDisplay(state.spec.ordering.min_step).toFixed(lenDigits()) : '';
    stepInput.placeholder = units().stepHint;
    stepInput.onchange = () => {
      const p = parseNumber(stepInput.value);
      state.spec.ordering.min_step = isNaN(p) ? 0 : toSI(p);
      validate();
    };

    const groupsField = $('#orderingGroupsField');
    groupsField.hidden = state.spec.ordering.mode !== 'paired';
    const n = state.motor.grain_count;
    const options = partitions(n);
    const groupSel = $('#orderingGroups');
    const current = (state.spec.ordering.groups || []).join(',');
    groupSel.innerHTML = options.map(g =>
      `<option value="${g.join(',')}" ${g.join(',') === current ? 'selected' : ''}>
        ${g.length} size${g.length > 1 ? 's' : ''} — ${g.join(' + ')} grains</option>`).join('');
    if (!current && options.length) state.spec.ordering.groups = options[0];
    groupSel.onchange = () => {
      state.spec.ordering.groups = groupSel.value.split(',').map(Number);
      validate();
    };
  }

  function partitions(n) {
    // Even splits only: how many mandrel sizes, spread as evenly as possible.
    const out = [];
    for (let k = 1; k <= n; k++) {
      const base = Math.floor(n / k), extra = n % k;
      out.push(Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0)));
    }
    return out;
  }

  //: Wall-clock for each preset on a typical laptop, before any diagnostic.
  const PRESET_ORDER = ['quick', 'standard', 'thorough', 'extreme'];

  function renderEffort() {
    const spec = state.spec;
    const expert = !!spec.expert;
    const seg = $('#effortSeg');
    seg.innerHTML = PRESET_ORDER
      .filter(k => state.effortLevels[k])
      .map(k => {
        const v = state.effortLevels[k];
        const b = presetBudget(k);
        return `<button type="button" class="effort ${spec.effort === k ? 'active' : ''}"
          data-effort="${k}">
          <span class="name">${v.label}</span>
          <span class="figs">${v.budget.toLocaleString()} simulations &middot;
            ${v.seeds} search${v.seeds === 1 ? '' : 'es'}</span>
          <span class="figs dim">${b.pop} &times; ${b.gen} each</span>
          <span class="time ${state.presetSeconds ? 'measured' : ''}">${
            state.presetSeconds && state.presetSeconds[k]
              ? fmtDuration(state.presetSeconds[k])
              : '~' + Math.round(v.seconds / 60) + ' min'}</span>
        </button>`;
      }).join('');
    seg.querySelectorAll('button').forEach(b =>
      b.addEventListener('click', () => {
        spec.effort = b.dataset.effort;
        // A preset replaces anything typed in by hand.
        spec.budget_simulations = null;
        spec.seeds = null;
        renderEffort(); validate();
      }));

    const level = state.effortLevels[spec.effort] || {};
    const budget = $('#budgetSims'), budgetRead = $('#budgetRead');
    budget.hidden = !expert;
    budgetRead.hidden = expert;
    budgetRead.textContent = (spec.budget_simulations || level.budget || 0).toLocaleString();
    budget.value = spec.budget_simulations
      ? Number(spec.budget_simulations).toLocaleString() : '';
    budget.placeholder = 'preset (' + (level.budget || '') + ')';
    budget.onchange = () => {
      const n = parseInt(String(budget.value).replace(/[^0-9]/g, ''), 10);
      spec.budget_simulations = Number.isFinite(n) && n > 0 ? n : null;
      renderEffort(); validate();
    };

    const seeds = $('#seedCount'), seedRead = $('#seedRead');
    const nSeeds = spec.seeds || level.seeds || 3;
    seeds.hidden = !expert;
    seedRead.hidden = expert;
    seedRead.textContent = nSeeds + (nSeeds === 1 ? '' : ' merged');
    seeds.innerHTML = [1, 2, 3, 4, 5, 6, 8].map(n =>
      `<option value="${n}" ${n === nSeeds ? 'selected' : ''}>${
        n === 1 ? '1 — no merging' : n + ' merged'}</option>`).join('');
    seeds.onchange = () => {
      spec.seeds = Number(seeds.value); renderEffort(); validate();
    };

    // Simulation is CPU-bound and runs one design per process, so this is the
    // one setting that turns better hardware into a shorter wait.
    const machine = state.machine || {};
    const cores = machine.cores || 4;
    const auto = machine.default_workers || Math.max(1, cores - 2);
    const workers = $('#workerCount'), workerRead = $('#workerRead');
    workers.hidden = !expert;
    workerRead.hidden = expert;
    workerRead.textContent = (spec.workers || auto) + ' of ' + cores;
    const choices = [];
    for (let n = 1; n <= cores; n++) {
      if (n === 1 || n === cores || n === auto ||
          n % Math.max(1, Math.round(cores / 6)) === 0) choices.push(n);
    }
    workers.innerHTML =
      `<option value="">Automatic — ${auto} of ${cores}</option>` +
      [...new Set(choices)].sort((a, b) => a - b).map(n =>
        `<option value="${n}" ${spec.workers === n ? 'selected' : ''}>${
          n}${n === cores ? ' — all cores' : ''}</option>`).join('');
    if (!spec.workers) workers.value = '';
    workers.onchange = () => {
      spec.workers = workers.value ? Number(workers.value) : null;
      renderEffort(); validate();
    };

    const toggle = $('#expertMode');
    toggle.checked = expert;
    toggle.onchange = () => {
      spec.expert = toggle.checked;
      if (!spec.expert) {
        spec.budget_simulations = null; spec.seeds = null; spec.workers = null;
      }
      renderEffort(); validate();
    };

    const pareto = $('#modePareto');
    pareto.checked = spec.mode === 'pareto';
    pareto.onchange = () => {
      spec.mode = pareto.checked ? 'pareto' : 'fast'; validate();
    };

    renderReadyList();
    renderDiagnostic();
  }

  function presetBudget(key) {
    const v = state.effortLevels[key] || {};
    const perSeed = Math.max(Math.floor(v.budget / v.seeds), 80);
    const pop = Math.min(Math.max(Math.floor(perSeed / 50), 40), 240);
    return { pop, gen: Math.max(Math.floor(perSeed / pop), 2), perSeed };
  }

  //: What the machine has to be for the run not to take far longer than it
  //: should. `check` returns true when it already is, or null when it is not.
  //: `sensed` says whether the browser can see the answer or only the user can,
  //: because a list that mixes the two without saying so reads as generic.
  const READY_CHECKS = [
    {
      id: 'power', icon: '\u26a1', title: 'Power adapter',
      sensed: () => !!(state.battery && state.battery.supported),
      warn: () => 'Running on battery. The processor is capped, so the search '
        + 'will take far longer.',
      done: () => state.battery && state.battery.supported
        ? 'Plugged in.' : 'Confirmed by you.',
      action: 'I plugged it in',
      check: () => (state.battery && state.battery.supported && state.battery.charging)
        || (!(state.battery && state.battery.supported) && state.ready.power) || null
    },
    {
      id: 'awake', icon: '\u25d1', title: 'Sleep during the run',
      sensed: () => !!navigator.wakeLock,
      warn: () => navigator.wakeLock
        ? 'Nothing is stopping the screen sleeping. A search interrupted part '
          + 'way through has to start again.'
        : 'This browser cannot hold the screen awake. Turn sleep off yourself.',
      done: () => state.wakeLock ? 'This page is holding the screen awake.'
                                 : 'Confirmed by you.',
      action: navigator.wakeLock ? 'Keep awake' : 'I turned sleep off',
      run: navigator.wakeLock ? requestWakeLock : null,
      check: () => (state.wakeLock ? true : null) || state.ready.awake || null
    },
    {
      id: 'power-mode', icon: '\u2699', title: 'Power mode',
      sensed: () => false,
      warn: powerModeHint, done: () => 'Confirmed by you.',
      action: 'I set it',
      check: () => state.ready['power-mode'] || null
    }
  ];

  function powerModeHint() {
    const p = (state.machine || {}).platform;
    if (p === 'mac') return 'Set System Settings \u2192 Battery \u2192 Energy Mode '
      + 'to High Power. No browser can read this setting, so it needs confirming.';
    if (p === 'windows') return 'Set Settings \u2192 System \u2192 Power & battery '
      + '\u2192 Power mode to Best performance. No browser can read this setting, '
      + 'so it needs confirming.';
    return 'Set the CPU governor or power profile to performance. No browser can '
      + 'read this setting, so it needs confirming.';
  }

  async function readBattery() {
    if (!navigator.getBattery) { state.battery = { supported: false }; return; }
    try {
      const b = await navigator.getBattery();
      state.batteryHandle = b;
      const sync = () => {
        state.battery = { supported: true, charging: b.charging, level: b.level };
        renderReadyList();
      };
      b.addEventListener('chargingchange', sync);
      b.addEventListener('levelchange', sync);
      sync();
    } catch (err) { state.battery = { supported: false }; }
  }

  //: chargingchange does not always fire in every browser, so arriving on the
  //: settings step re-reads rather than trusting the last event.
  function recheckMachine() {
    const b = state.batteryHandle;
    if (b) {
      state.battery = { supported: true, charging: b.charging, level: b.level };
    }
    if (state.wakeLock && state.wakeLock.released) state.wakeLock = null;
    renderReadyList();
  }

  async function requestWakeLock() {
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      // The browser drops the lock whenever the tab goes to the background.
      state.wakeLock.addEventListener('release', () => {
        state.wakeLock = null; renderReadyList();
      });
    } catch (err) {
      state.wakeLock = null;
      toast('This browser will not hold the screen awake.');
    }
    renderReadyList();
  }

  function renderReadyList() {
    const host = $('#readyList');
    if (!host) return;
    let outstanding = 0;
    host.innerHTML = READY_CHECKS.map(item => {
      const ok = item.check();
      const sensed = item.sensed();
      if (!ok) outstanding++;
      const button = (!ok && item.action)
        ? `<button type="button" class="chip" data-ready="${item.id}">${item.action}</button>` : '';
      return `<div class="alert ${ok ? 'ok' : 'warn'}">
        <span class="ico">${ok ? '\u2713' : item.icon}</span>
        <span class="body">
          <span class="title">${item.title}
            <span class="src ${sensed ? 'auto' : 'manual'}">${
              sensed ? 'detected' : 'cannot be detected'}</span></span>
          <span class="why">${ok ? item.done() : item.warn()}</span></span>
        ${button}</div>`;
    }).join('');
    host.querySelectorAll('[data-ready]').forEach(b =>
      b.addEventListener('click', () => {
        const item = READY_CHECKS.find(i => i.id === b.dataset.ready);
        if (item && item.run) { item.run(); return; }
        state.ready[b.dataset.ready] = true;
        renderReadyList();
      }));
    const count = $('#readyCount');
    if (count) {
      count.textContent = outstanding ? outstanding + ' to do' : 'ready';
      count.className = 'ready-count ' + (outstanding ? 'warn' : 'ok');
    }
    const card = $('#readyCard');
    if (card) card.classList.toggle('has-warning', outstanding > 0);
  }

  function renderDiagnostic() {
    const note = $('#diagNote'), status = $('#diagStatus'), btn = $('#btnDiagnostic');
    if (!btn) return;
    const d = state.diagnostic;
    note.textContent = d
      ? 'Measured ' + d.rate + ' simulations a second on ' + d.workers + ' cores.'
      : 'A time estimate needs a measurement from this machine. Takes about a minute.';
    status.textContent = state.diagRunning ? 'measuring\u2026' : '';
    btn.disabled = !!state.diagRunning;
    btn.textContent = d ? 'Measure again' : 'Run the diagnostic';
    btn.onclick = runDiagnostic;
  }

  async function runDiagnostic() {
    state.diagRunning = true;
    renderDiagnostic();
    try {
      const res = await fetch('/api/diagnostic', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: state.spec })
      });
      const data = await res.json();
      if (!res.ok) { toast(data.detail || 'The diagnostic failed.'); return; }
      state.diagnostic = data.diagnostic;
      toast('Measured ' + data.diagnostic.rate + ' simulations a second.');
    } catch (err) {
      toast('The diagnostic could not run.');
    } finally {
      state.diagRunning = false;
      renderDiagnostic();
      validate();
    }
  }


  /* ------------------------------------------------------------- wizard */

  const STEPS = 7;
  const SETTINGS = 4, RUNNING = 5, RESULTS = 6;

  // Which step can fix each kind of problem, so a fault never blocks a step
  // that cannot resolve it.
  const AREA_STEP = { variables: 1, constraints: 2, objectives: 3, settings: SETTINGS };

  function problemsFor(i) {
    const areas = state.validation.problem_areas || [];
    return (state.validation.problems || [])
      .filter((_, n) => (AREA_STEP[areas[n]] !== undefined
                         ? AREA_STEP[areas[n]] : SETTINGS) === i);
  }

  // What has to be true before a step will let you past it.
  function stepDone(i) {
    const spec = state.spec;
    if (!spec) return false;
    switch (i) {
      case 0: return !!state.motor;
      case 1: return spec.variables.some(v => v.free) && !problemsFor(1).length;
      case 2: return !problemsFor(2).length;
      case 3: return spec.objectives.some(o => o.enabled) && !problemsFor(3).length;
      case SETTINGS: return (state.validation.problems || []).length === 0;
      case RUNNING: return !!state.results;
      default: return true;
    }
  }

  function furthestAllowed() {
    let i = 0;
    while (i < STEPS - 1 && stepDone(i)) i++;
    // One past the furthest step actually visited, so the flow is walked
    // rather than jumped, and never behind it, so nothing can trap the user.
    return Math.min(i, state.reached + 1);
  }

  //: The underline under the active tab is one element that slides, rather
  //: than a border that jumps from tab to tab.
  function placeStepIndicator() {
    const nav = $('#stepper');
    if (!nav) return;
    let bar = nav.querySelector('.step-indicator');
    if (!bar) { bar = el('div', 'step-indicator'); nav.appendChild(bar); }
    const active = nav.querySelector('.step-tab.active');
    if (!active) { bar.style.width = '0'; return; }
    bar.style.left = active.offsetLeft + 'px';
    bar.style.width = active.offsetWidth + 'px';
  }

  function goTo(i) {
    state.step = Math.max(0, Math.min(i, STEPS - 1));
    state.reached = Math.max(state.reached, state.step);
    document.querySelectorAll('.step').forEach(el => {
      el.hidden = Number(el.dataset.wstep) !== state.step;
    });
    renderStepper();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Plotly cannot size a hidden container, so these draw on arrival.
    if (state.step === 0) renderMotorPreview();
    if (state.step === RUNNING) redrawLive();
    if (state.step === SETTINGS) recheckMachine();
    resizePlots();
  }

  //: Anything drawn while its section was hidden kept a default size. One
  //: sweep after the step is visible puts every chart back on its container.
  function resizePlots() {
    requestAnimationFrame(() => {
      document.querySelectorAll('.step:not([hidden]) .js-plotly-plot')
        .forEach(node => { try { Plotly.Plots.resize(node); } catch (e) {} });
    });
  }

  function renderStepper() {
    const reach = furthestAllowed();
    document.querySelectorAll('.step-tab').forEach(tab => {
      const i = Number(tab.dataset.wstep);
      tab.classList.toggle('active', i === state.step);
      tab.classList.toggle('done', i < state.step && stepDone(i));
      tab.disabled = i > reach;
    });
    const crumb = $('#stepCrumb');
    if (crumb) crumb.textContent = 'Step ' + (state.step + 1) + ' of ' + STEPS;
    placeStepIndicator();
    const back = $('#btnBack'), next = $('#btnNext'), gate = $('#stepGate');
    if (!back || !next || !gate) return;
    const last = state.step === STEPS - 1;
    back.hidden = last;                 // nothing to return to once it has run
    back.disabled = state.step === 0;
    next.hidden = last;
    next.textContent = state.step === SETTINGS ? 'Optimize' : 'Next';
    next.disabled = !stepDone(state.step);
    gate.textContent = last || stepDone(state.step) ? '' : gateReason(state.step);

    // Only from the settings step, so the flow is walked rather than skipped.
    const ready = state.step >= SETTINGS && [0, 1, 2, 3].every(stepDone)
      && (state.validation.problems || []).length === 0;
    const run = $('#btnRun');
    if (run && !state.jobId) {
      run.disabled = !ready;
      run.title = ready ? '' : 'Available on the Settings step';
    }
  }

  function gateReason(i) {
    switch (i) {
      case 0: return 'Load a .ric file to continue.';
      case 1: return problemsFor(1)[0] || 'At least one dimension has to be free to change.';
      case 2: return problemsFor(2)[0] || 'Resolve the problems above.';
      case 3: return problemsFor(3)[0] || 'Pick at least one thing to optimize.';
      case SETTINGS: return (state.validation.problems || [])[0] || 'Resolve the problems above.';
      case RUNNING: return state.jobId ? 'The search is still running.' : 'Run the search first.';
      default: return '';
    }
  }

  function on(sel, event, fn) {
    const el = $(sel);
    if (el) el.addEventListener(event, fn);
    return el;
  }

  function wireWizard() {
    on('#btnBack', 'click', () => goTo(state.step - 1));
    on('#btnNext', 'click', () => {
      if (state.step === SETTINGS) { startRun(); return; }
      goTo(state.step + 1);
    });
    document.querySelectorAll('.step-tab').forEach(tab =>
      tab.addEventListener('click', () => goTo(Number(tab.dataset.wstep))));
  }

  //: Named in one place, since the motor page, the results page and the
  //: constraint check all refer to the same file.
  function renderBaselineBoxes() {
    const m = state.motor;
    const name = (m && m.name) || 'no motor loaded';
    const set = (sel, text) => { const e = $(sel); if (e) e.textContent = text; };
    set('#baselineName', name);
    set('#resultBaselineName', name);
    set('#resultBaselineFigs', m
      ? Math.round(m.initial_thrust).toLocaleString() + ' N  \u00b7  '
        + Math.round(m.total_impulse).toLocaleString() + ' N\u00b7s' : '');
  }

  //: The design being reviewed, shown beside the baseline it is measured
  //: against, with the .ric for it a click away.
  function renderLoadedBox() {
    const box = $('#loadedBox');
    if (!box) return;
    const d = ((state.results || {}).designs || [])[state.selected];
    box.hidden = !d;
    if (!d) return;
    $('#loadedName').textContent =
      'Option ' + (state.selected + 1) + (d.designation ? '  \u00b7  ' + d.designation : '');
    const figs = $('#loadedFigs');
    if (!figs.querySelector('.f1')) figs.innerHTML = '<span class="f1"></span>  \u00b7  <span class="f2"></span>';
    tweenNumber(figs.querySelector('.f1'), 'loaded:thrust', d.initial_thrust,
                v => Math.round(v).toLocaleString() + ' N');
    tweenNumber(figs.querySelector('.f2'), 'loaded:impulse', d.total_impulse,
                v => Math.round(v).toLocaleString() + ' N\u00b7s');
  }

  function renderMotorPreview() {
    if (!state.motor || !$('#motorPreview')) return;
    const b = Object.assign({}, state.motor, { curves: state.baselineCurves });
    $('#motorPreview').innerHTML = Charts.crossSectionSVG(b, b);
    Charts.behaviourStack($('#motorThrust'), state.baselineCurves, [],
                          ['thrust', 'pressure', 'kn', 'mass_flux']);
  }


  function renderBaselineCheck() {
    const host = $('#baselineCheck');
    const m = state.motor;
    const title = $('#baselineTitle');
    if (title) title.textContent = 'Loaded Motor: ' + ((m && m.name) || 'none');
    if (!host) return;
    if (!m || !state.spec) { host.innerHTML = ''; return; }
    const num = v => v.toLocaleString(undefined, { maximumFractionDigits: 3 });
    let unknown = 0;
    const rows = state.spec.constraints.filter(c => c.enabled).map(c => {
      const raw = m[c.metric];
      if (raw === undefined || raw === null || Number.isNaN(raw)) { unknown++; return ''; }
      const have = metricToDisplay(c.metric, raw);
      const want = metricToDisplay(c.metric, c.value);
      const ok = c.op === '<=' ? have <= want : have >= want;
      return `<div class="check-row ${ok ? 'ok' : 'bad'}">
        <span class="k">${Charts.metricLabel(c.metric)}</span>
        <span class="v">${num(have)}</span>
        <span class="lim">${c.op === '<=' ? '≤' : '≥'} ${num(want)}</span>
        <span class="tag">${ok ? 'ok' : 'over'}</span></div>`;
    }).join('');
    const note = unknown
      ? `<p class="hint">${unknown} limit${unknown > 1 ? 's are' : ' is'} only measured during a run.</p>` : '';
    host.innerHTML = (rows || '<p class="hint">No limits are enabled.</p>') + note;
  }

  /* ----------------------------------------------------------- validate */

  let validateTimer = null;
  function validate() {
    clearTimeout(validateTimer);
    const busy = on => ['#sizing', '#estimate', '#freeSummary'].forEach(sel => {
      const card = $(sel) && $(sel).closest('.card');
      if (card) card.classList.toggle('busy', on);
    });
    busy(true);
    validateTimer = setTimeout(async () => {
      const res = await fetch('/api/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: state.spec })
      });
      const data = await res.json();
      busy(false);
      const host = $('#problems');
      host.innerHTML =
        (data.problems || []).map(p => `<div class="problem err">${p}</div>`).join('') +
        (data.notes || []).map(p => `<div class="problem note">${p}</div>`).join('');
      state.validation = data;
      // Only once measured: before that the preset's own nominal figure is
      // closer to the truth than a rate this machine has never run.
      state.presetSeconds = (data.estimate || {}).measured
        ? data.preset_seconds || null : null;
      renderStepper();
      renderSizing(data.sizing);
      if (state.step === SETTINGS) renderEffort();
      const est = data.estimate || {};
      const counts = est.grain_counts > 1
        ? ` First a ${est.stage_one.toLocaleString()}-simulation pass across
           <strong>${est.grain_counts}</strong> grain counts, then the full search on the
           best ${est.carried}.`
        : '';
      $('#budgetSplit').innerHTML = est.seeds
        ? `<strong>${est.seeds}</strong> search${est.seeds === 1 ? '' : 'es'} of
           ${est.pop} × ${est.gen}, merged into one front.${counts}`
        : '';
      // Predictions and burns cost wildly different amounts; quoting one
      // total made a surrogate run look an hour long when it takes minutes.
      const work = est.model_runs
        ? `${est.openmotor_runs.toLocaleString()} openMotor runs plus
           ${est.model_runs.toLocaleString()} model evaluations`
        : `${(est.openmotor_runs || 0).toLocaleString()} openMotor runs`;
      // A rate this machine has not measured is a guess, so no time is quoted
      // until the diagnostic has run.
      $('#estimate').innerHTML = !est.simulations ? ''
        : est.measured
          ? `roughly <strong>${fmtDuration(est.seconds)}</strong> &middot; ${work}`
          : `${work} &middot; <span class="rate">run the diagnostic for a time
             estimate</span>`;
    }, 220);
  }

  function supExp(text) {
    // "4.5 × 10^19" reads far better with a real superscript — and these appear
    // more than once in a sentence, so replace every occurrence.
    return String(text).replace(/\^(-?\d+)/g, (_, d) => `<sup>${d}</sup>`);
  }

  function renderSizing(sizing) {
    const host = $('#sizing');
    if (!sizing) { host.innerHTML = ''; return; }
    const rows = [];
    const add = (k, v, why) => rows.push(
      `<div class="srow"><span class="k">${k}</span><span class="v">${v}</span>` +
      (why ? `<span class="why">${why}</span>` : '') + '</div>');

    const num = b => b && b.count_exact
      ? Number(b.count_exact).toLocaleString()
      : (b && b.count === null ? 'continuous' : '—');
    if (sizing.counts) add('Grain counts', String(sizing.counts.length),
      sizing.counts.map(c => `${c.n} grains: ${supExp(c.total_text || '—')}`).join(' · '));
    if (sizing.cores) add('Core arrangements', num(sizing.cores), sizing.cores.note);
    if (sizing.nozzle) add('Throat + exit', num(sizing.nozzle), sizing.nozzle.note);
    (sizing.others || []).forEach(o =>
      add(o.name, o.held ? 'held' : (o.values === null ? 'continuous'
                                     : o.values.toLocaleString())));

    const red = sizing.reduction;
    let reduction = '';
    if (red && red.legal_text && !sizing.continuous) {
      const bits = [];
      (red.tightened && red.tightened.changes || []).forEach(c => bits.push(
        `<div class="srow"><span class="k">${c.variable === 'cores' ? 'Core ceiling' : 'Throat floor'}</span>
         <span class="v">${fmtLen(c.to)}</span>
         <span class="why">${c.why}</span></div>`));
      (red.equivalences || []).forEach(e => bits.push(
        `<div class="srow"><span class="k">${e.title}</span><span class="v"></span>
         <span class="why">${e.detail}</span></div>`));
      reduction = `
        <div class="chain">
          <div class="chain-row"><span>Geometry alone</span><b>${supExp(red.total_text)}</b></div>
          <div class="chain-row"><span>After limits that rule bounds out</span><b>${supExp(red.after_bounds_text)}</b></div>
          <div class="chain-row lead"><span>Passing Kn and port/throat</span><b>${supExp(red.legal_text)}</b></div>
        </div>
        <div class="rows">${bits.join('')}</div>
        ${red.tightened && red.tightened.changes && red.tightened.changes.length
          ? '<div class="design-actions"><button type="button" class="chip" id="btnTighten">Apply tighter bounds</button></div>'
          : ''}`;
    }

    const coverage = sizing.continuous
      ? `Every value in range is allowed, so there is no finite count. Set a
         <strong>step</strong> on each dimension to see one.`
      : `The search simulates <b>${(sizing.evaluated || 0).toLocaleString()}</b> of them
         &mdash; ${sizing.fraction_text || ''}. Trying all of them one at a time would
         take <b>${sizing.brute_force_text || '—'}</b>, which is why this uses a genetic
         search rather than brute force.`;

    host.innerHTML = `
      <span class="total">${supExp(sizing.total_text || '—')}</span>
      <span class="total-note">distinct motors from ${sizing.free_variables} free
        ${sizing.free_variables === 1 ? 'dimension' : 'dimensions'}${
          sizing.held_variables ? `, ${sizing.held_variables} held` : ''}</span>
      <div class="rows">${rows.join('')}</div>
      <div class="coverage">${supExp(coverage)}</div>
      ${reduction}`;
    const tighten = $('#btnTighten');
    if (tighten) tighten.addEventListener('click', applyTighterBounds);
  }

  async function applyTighterBounds() {
    const res = await fetch('/api/tighten', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: state.spec })
    });
    if (!res.ok) { toast('Could not tighten those bounds.'); return; }
    const data = await res.json();
    state.spec = data.spec;
    state.spec.display_units = displayUnits();
    renderVariables();
    validate();
    const what = (data.changes || []).map(c =>
      `${c.variable} to ${fmtLen(c.to)}`).join(', ');
    toast(what ? `Narrowed ${what}. Nothing legal was removed.` : 'Already as tight as it gets');
  }

  function fmtDuration(seconds) {
    if (!seconds) return 'a moment';
    if (seconds < 90) return Math.round(seconds) + ' s';
    if (seconds < 5400) return Math.round(seconds / 60) + ' min';
    const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  function fmtClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    const s = Math.round(seconds);
    const pad = n => String(n).padStart(2, '0');
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) +
           ':' + pad(s % 60);
  }

  /* --------------------------------------------------------- run + poll */

  async function startRun() {
    const res = await fetch('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: state.spec })
    });
    if (!res.ok) { toast((await res.json()).detail || 'Could not start.'); return; }
    const job = await res.json();
    state.jobId = job.id;
    $('#progress').hidden = false;
    $('#btnRun').disabled = true;
    $('#runLabel').textContent = 'Working…';
    // Hand the workspace over to the live view for the duration.
    Charts.resetLive();
    state.results = null;
    state.liveRange = null; state.liveSnap = null;
    state.runStart = Date.now();
    $('#runBar').hidden = false;
    $('#runFill').style.width = '0%';
    $('#emptyState').hidden = true;
    $('#panels').hidden = true;
    $('#live').hidden = false;
    $('#liveStats').innerHTML = '';
    $('#liveNote').textContent = 'Waiting for the first generation…';
    renderBest(null);
    goTo(RUNNING);
    state.poll = setInterval(pollJob, 900);
  }

  async function pollJob() {
    if (!state.jobId) return;
    const res = await fetch('/api/jobs/' + state.jobId + '/live');
    if (!res.ok) return;
    const job = await res.json();
    if (job.telemetry) renderLive(job.telemetry);
    renderBest(job.best);
    renderRunBar(job);
    $('#progressFill').style.width = (job.fraction * 100).toFixed(1) + '%';
    $('#progressMsg').textContent = job.message + '  ·  ' + job.elapsed + 's';
    if (job.status === 'done') {
      finishRun();
      // The report was written as part of the run; surface it and the sheets.
      showReportCard(job);
      await loadResults();
    }
    else if (job.status === 'failed') {
      finishRun(); $('#emptyState').hidden = false;
      toast(job.error || 'Run failed.');
    } else if (job.status === 'cancelled') {
      finishRun(); $('#emptyState').hidden = false; toast('Run cancelled.');
    }
  }

  //: A snapshot arrives in SI. Everything drawn from it is in display units,
  //: so it is converted once here and the SI copy is left untouched.
  function shownSnap(raw) {
    const [mx, my] = raw.metrics || [];
    const cx = v => metricToDisplay(mx, v), cy = v => metricToDisplay(my, v);
    const t = Object.assign({}, raw);
    t.points = (raw.points || []).map(p => [cx(p[0]), cy(p[1]), p[2]]);
    t.front = (raw.front || []).map(p => [cx(p[0]), cy(p[1])]);
    if (raw.best) t.best = [cy(raw.best[0]), cx(raw.best[1])];
    t.trace = (raw.trace || []).map(r => Object.assign({}, r, { a: cy(r.a), b: cx(r.b) }));
    if (state.motor && my && mx) {
      const bx = state.motor[mx], by = state.motor[my];
      if (Number.isFinite(bx) && Number.isFinite(by)) t.baseline = [cx(bx), cy(by)];
    }
    return t;
  }

  //: Which metric a live stat shows, by its label, so the tween can format.
  const LIVE_METRIC = {};
  function fmtLiveNumber(label, v) {
    const m = LIVE_METRIC[label];
    return v.toLocaleString(undefined, { maximumFractionDigits: m ? metricDigits(m) : 0 });
  }

  function renderLive(raw) {
    const t = shownSnap(raw);
    const gen = t.generation || 0;
    const total = t.total_generations || 0;
    const grains = t.n_grains ? ` \u00b7 ${t.n_grains} grains` : '';
    $('#liveTitle').textContent = t.stage === 'stage1'
      ? `Trying ${t.n_grains} grains (${t.seed_index + 1} of ${t.n_seeds})`
      : t.n_seeds > 1
        ? `Search ${t.seed_index + 1} of ${t.n_seeds}${grains}`
        : 'Searching' + grains;
    // The claim "actually been simulated" is only true on the simulator path;
    // in trade-off mode these are model predictions, verified later.
    const dot = t.surrogate
      ? 'Every dot is a motor the trained model has scored. The winners are '
        + 'simulated for real at the end.'
      : 'Every dot is a motor that has actually been simulated.';
    const best = t.single_objective
      ? 'the orange marker is the best one found so far.'
      : 'the orange line is the best trade-off found so far.';
    $('#liveSub').textContent =
      `${dot} Grey broke a limit; blue met them all; ${best}`;

    const stats = [
      ['generation', `${gen}/${total}`, ''],
      ['legal', `${Math.round(100 * (t.feasible_fraction || 0))}%`, ''],
    ];
    if (t.best) {
      LIVE_METRIC[Charts.metricLabel(t.metrics[1])] = t.metrics[1];
      LIVE_METRIC[Charts.metricLabel(t.metrics[0])] = t.metrics[0];
      stats.push([Charts.metricLabel(t.metrics[1]), t.best[0], 'accent']);
      stats.push([Charts.metricLabel(t.metrics[0]), t.best[1], 'accent']);
    }
    const host = $('#liveStats');
    // Keep the nodes between generations so the numbers can move.
    const keys = stats.map(([k]) => k);
    if (host.dataset.keys !== keys.join('|')) {
      host.innerHTML = stats.map(([k, , cls]) =>
        `<div class="live-stat"><span class="k">${k}</span>
         <span class="v ${cls}" data-k="${k}"></span></div>`).join('');
      host.dataset.keys = keys.join('|');
    }
    stats.forEach(([k, v]) => {
      const node = host.querySelector(`.v[data-k="${k}"]`);
      if (!node) return;
      const numeric = typeof v === 'number';
      if (numeric) tweenNumber(node, 'live:' + k, v, x => fmtLiveNumber(k, x));
      else node.textContent = v;
    });

    state.liveSnap = raw;
    if (!state.liveRange) state.liveRange = fitRange(t);
    try { Charts.liveFrame($('#livePlot'), t, state.liveRange); }
    catch (e) { console.error(e); }
    try { Charts.liveBlocking($('#liveBlocking'), t); } catch (e) { console.error(e); }
    try { Charts.liveSpark($('#liveSpark'), t.trace); } catch (e) { console.error(e); }
    renderSpeed(t);
    $('#liveNote').textContent = t.trace && t.trace.length > 1
      ? 'Best ' + Charts.metricLabel(t.metrics[1]).toLowerCase() + ' found so far.'
      : '';
  }

  function redrawLive() {
    if (state.liveSnap) renderLive(state.liveSnap);
  }

  //: The best legal motor so far can be taken before the run ends. Mostly
  //: for single-objective runs, where "best" is one motor, not a curve.
  function renderBest(best) {
    const box = $('#bestDl');
    if (!box) return;
    state.best = best || null;
    box.hidden = !best;
    if (!best) return;
    const grains = best.n_grains ? ` \u00b7 ${best.n_grains} grains` : '';
    const shown = metricToDisplay(best.metric, best.value).toLocaleString(
      undefined, { maximumFractionDigits: metricDigits(best.metric) });
    const unit = metricUnit(best.metric);
    $('#bestMeta').textContent =
      `${Charts.metricLabel(best.metric)} ${shown}${unit ? ' ' + unit : ''}`
      + `${grains} \u00b7 generation ${best.generation}`;
  }

  async function downloadBest() {
    if (!state.jobId || !state.best) return;
    const res = await fetch('/api/jobs/' + state.jobId + '/best.ric');
    if (!res.ok) { toast('No legal design yet.'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'best-so-far.ric';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('Saved the best motor so far. Open it in openMotor.');
  }

  //: Everything drawn, plus a tenth of the span so nothing sits on the frame.
  function fitRange(t) {
    const [ax] = Charts.orderAxes(t.metrics || ['initial_thrust', 'total_impulse']);
    const flip = ax !== (t.metrics || [])[0];
    const xs = [], ys = [];
    const add = p => { xs.push(flip ? p[1] : p[0]); ys.push(flip ? p[0] : p[1]); };
    (t.points || []).forEach(add);
    (t.front || []).forEach(add);
    if (t.baseline) add(t.baseline);
    if (!xs.length) return null;
    const span = v => {
      const lo = Math.min.apply(null, v), hi = Math.max.apply(null, v);
      const pad = Math.max((hi - lo) * 0.1, Math.abs(hi) * 0.01, 1e-9);
      return [lo - pad, hi + pad];
    };
    return { x: span(xs), y: span(ys) };
  }

  function renderSpeed(t) {
    try { Charts.speedometer($('#speedGauge'), t.rate || 0, 'sims / second'); }
    catch (e) { console.error(e); }
    $('#speedNote').textContent = t.workers ? 'Across ' + t.workers + ' cores.' : '';
  }

  //: Elapsed against what is left, from the run's own measured throughput
  //: rather than the optimiser's stage fractions, which jump.
  function renderRunBar(job) {
    const bar = $('#runBar');
    if (!bar) return;
    bar.hidden = false;
    const t = job.telemetry || {};
    const done = t.simulations_done || 0, total = t.simulations_total || 0;
    const frac = total ? Math.min(done / total, 1) : (job.fraction || 0);
    $('#runElapsed').textContent = fmtClock(job.elapsed || 0);
    const left = t.rate > 0 && total > done ? (total - done) / t.rate : null;
    $('#runLeft').textContent = left === null ? '\u2014'
      : fmtClock(left * ((state.diagnostic || {}).thermal_derate || 1));
    $('#runFill').style.width =
      (Math.max(frac, job.fraction || 0) * 100).toFixed(1) + '%';
    $('#runStage').textContent = job.message || '';
    $('#runCount').textContent = total
      ? done.toLocaleString() + ' / ' + total.toLocaleString() + ' simulations' : '';
  }

  function finishRun() {
    clearInterval(state.poll); state.poll = null;
    $('#live').hidden = true;
    $('#progress').hidden = true;
    $('#btnRun').disabled = false;
    $('#runLabel').textContent = 'Optimize';
  }

  async function cancelRun() {
    if (!state.jobId) return;
    await fetch('/api/jobs/' + state.jobId + '/cancel', { method: 'POST' });
  }

  /* ------------------------------------------------- report & sheets */

  // A run writes its own report when it finishes, so there is nothing here that
  // builds one. What is left is getting at it, and at the per-design sheets.

  function showReportCard(job) {
    const card = $('#reportCard');
    const ready = job && job.status === 'done';
    card.hidden = !ready;
    if (!ready) return;
    state.reportJob = job.id;
    const open = $('#btnReportOpen');
    open.disabled = !job.report;
    open.textContent = job.report
      ? "Open this run's report"
      : (job.report_error ? 'Report could not be written' : 'No report');
    bundleButtons(!job.n_designs);
  }

  function openReport() {
    if (state.reportJob) window.open('/api/jobs/' + state.reportJob + '/report', '_blank');
  }

  //: The downloads share one progress bar, so only one runs at a time.
  const BUNDLE_BUTTONS = { sheets: '#btnBundle', eng: '#btnEng', ric: '#btnRic' };
  const BUNDLE_NAMES = { sheets: 'design-sheets.zip', eng: 'motors.eng',
                         ric: 'ric-files.zip' };

  function bundleButtons(disabled) {
    Object.values(BUNDLE_BUTTONS).forEach(sel => {
      const b = $(sel);
      if (b) b.disabled = disabled;
    });
  }

  async function downloadBundle(kind) {
    if (!state.reportJob) return;
    state.bundleKind = kind;
    bundleButtons(true);
    $('#bundleProgress').hidden = false;
    $('#bundleMsg').textContent = 'Starting\u2026';
    $('#bundleFill').style.width = '0%';
    const res = await fetch('/api/jobs/' + state.reportJob + '/bundle?kind=' + kind,
                            { method: 'POST' });
    if (!res.ok) {
      toast((await res.json()).detail || 'Could not start.');
      bundleButtons(false); $('#bundleProgress').hidden = true;
      return;
    }
    pollBundle();
  }

  async function pollBundle() {
    const res = await fetch('/api/jobs/' + state.reportJob + '/bundle');
    if (!res.ok) { $('#bundleProgress').hidden = true; bundleButtons(false); return; }

    // Ready, and the file itself is the response rather than a status.
    const disposition = res.headers.get('Content-Disposition') || '';
    if (disposition.startsWith('attachment')) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = disposition.replace(/.*filename="([^"]+)".*/, '$1')
        || BUNDLE_NAMES[state.bundleKind] || 'download';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      $('#bundleFill').style.width = '100%';
      $('#bundleMsg').textContent = 'Downloaded.';
      bundleButtons(false);
      return;
    }

    const job = await res.json();
    if (job.bundle_status === 'failed') {
      toast(job.bundle_error || 'Could not build that download.');
      $('#bundleProgress').hidden = true; bundleButtons(false);
      return;
    }
    const frac = job.bundle_total ? job.bundle_done / job.bundle_total : 0;
    $('#bundleFill').style.width = (100 * frac).toFixed(1) + '%';
    $('#bundleMsg').textContent = job.bundle_message || 'Working\u2026';
    setTimeout(pollBundle, 900);
  }

  async function attachToRun(id) {
    // A run can be reopened while it is still going, not only once it is done.
    const res = await fetch('/api/jobs/' + id + '/live');
    if (!res.ok) { toast('That run is no longer held.'); return; }
    const job = await res.json();
    state.jobId = id;
    if (job.status === 'done') { showReportCard(job); await loadResults(); return; }
    if (job.status === 'running' || job.status === 'queued') {
      Charts.resetLive();
      $('#emptyState').hidden = true;
      $('#panels').hidden = true;
      $('#live').hidden = false;
      $('#progress').hidden = false;
      $('#btnRun').disabled = true;
      $('#runLabel').textContent = 'Working…';
      goTo(RUNNING);
      if (job.telemetry) renderLive(job.telemetry);
      renderBest(job.best);
      state.poll = setInterval(pollJob, 900);
      return;
    }
    toast('That run ' + job.status + '.');
  }

  async function loadResults() {
    const res = await fetch('/api/jobs/' + state.jobId + '/results');
    if (!res.ok) { toast('Could not fetch results.'); return; }
    state.results = await res.json();
    state.selected = 0;
    state.compare = null;
    state.robustness = null;
    if (!state.results.designs.length) {
      toast(state.results.messages[0] || 'No design met every limit.', 6000);
    } else {
      toast(`Found ${state.results.designs.length} option${
        state.results.designs.length > 1 ? 's' : ''} in ${state.results.stats.seconds}s`);
    }
    $('#emptyState').hidden = true;
    $('#panels').hidden = false;
    // Reveal before drawing. Plotly cannot measure a container inside a hidden
    // section, so charts built here came out at a default size and their
    // traces ran off the plot area once the step was shown.
    if (state.results.designs.length) goTo(RESULTS);
    renderProfiles();
    renderPanels();
    renderLoadedBox();
    renderStepper();
  }

  /* -------------------------------------------------------- the results */

  function renderProfiles() {
    const nav = $('#profiles');
    nav.innerHTML = Charts.PROFILES.map(p =>
      `<button type="button" data-profile="${p.id}"
        class="${state.profile === p.id ? 'active' : ''}">${p.label}</button>`).join('');
    nav.querySelectorAll('button').forEach(b =>
      b.addEventListener('click', () => {
        state.profile = b.dataset.profile;
        renderProfiles(); renderPanels();
      }));
  }

  function context() {
    const r = state.results || {};
    const labels = (r.stats && r.stats.objective_labels) || ['initial_thrust'];
    const pair = labels.length > 1 ? labels : [labels[0],
      labels[0] === 'total_impulse' ? 'initial_thrust' : 'total_impulse'];
    const axes = Charts.orderAxes(pair);
    return {
      design: (r.designs || [])[state.selected],
      compare: state.compare === null || state.compare === undefined
        ? null : (r.designs || [])[state.compare],
      compareIndex: state.compare,
      onCompare: compareDesign,
      onHighlight: highlightDesign,
      designs: r.designs || [],
      baseline: r.baseline,
      population: r.population || [],
      convergence: r.convergence || [],
      surrogate: r.surrogate,
      constraintActivity: r.constraint_activity || [],
      sensitivity: r.sensitivity || [],
      constraints: (((r.spec || state.spec).constraints) || []).filter(c => c.enabled),
      robustness: state.robustness,
      onCheckRobustness: checkRobustness,
      searched: (r.stats && r.stats.searched) || [],
      grainCounts: (r.stats && r.stats.grain_counts) || null,
      selected: state.selected,
      axes
    };
  }

  function renderCompareStrip(ctx) {
    let strip = $('#compareStrip');
    if (!ctx.compare) { if (strip) strip.remove(); return; }
    if (!strip) {
      strip = el('div', 'compare-strip');
      strip.id = 'compareStrip';
      $('#panels').before(strip);
    }
    const name = i => 'Option ' + (i + 1);
    strip.innerHTML = `Comparing <b>${name(state.selected)}</b> with
      <b>${name(state.compareIndex)}</b> \u2014 dashed in every curve.
      Shift-click a row or point to compare another.
      <button type="button" class="chip" id="btnClearCompare">Clear</button>`;
    strip.querySelector('#btnClearCompare').addEventListener('click', () => compareDesign(null));
  }

  function renderPanels() {
    const host = $('#panels');
    host.innerHTML = '';
    const profile = Charts.PROFILES.find(p => p.id === state.profile);
    const ctx = context();
    renderCompareStrip(ctx);
    profile.panels.forEach(([id, span]) => {
      const def = Charts.PANELS[id];
      if (!def) return;
      const card = el('div', 'panel' + (span === 2 ? ' wide' : ''));
      card.innerHTML = `<h3>${def.title}</h3><p class="sub">${def.sub}</p>`;
      const body = el('div', 'plot' + (span === 2 ? ' tall' : ''));
      card.appendChild(body);
      host.appendChild(card);
      try { def.render(body, ctx); }
      catch (err) {
        body.innerHTML = '<p class="sub">Could not draw this panel.</p>';
        console.error(id, err);
      }
    });
  }

  //: Only the first few designs come back with curves, so the rest are
  //: simulated on demand; without them Design Review has nothing to draw.
  async function ensureCurves(design, index) {
    if (design.curves) return;
    toast('Simulating option ' + (index + 1) + '…');
    try {
      const res = await fetch('/api/curves', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: state.spec, x: design.x,
                               n_grains: design.n_grains || null })
      });
      if (res.ok) {
        const full = await res.json();
        if (full.curves) design.curves = full.curves;
      }
    } catch (err) { /* the panels that need curves say so themselves */ }
  }

  async function selectDesign(index) {
    const designs = (state.results || {}).designs || [];
    const design = designs[index];
    if (!design) return;
    state.selected = index;
    if (state.compare === index) state.compare = null;
    state.robustness = null;   // belongs to the design it was run on
    await ensureCurves(design, index);
    state.profile = 'design';
    renderProfiles();
    renderPanels();
    renderLoadedBox();
    toast('Option ' + (index + 1) + ' loaded as the optimized motor.');
  }

  //: A second design drawn against the selected one, in every curve panel.
  async function compareDesign(index) {
    const designs = (state.results || {}).designs || [];
    if (index === null || index === state.selected || !designs[index]) {
      state.compare = null;
    } else {
      state.compare = index;
      await ensureCurves(designs[index], index);
      if (state.profile !== 'design' && state.profile !== 'compare') state.profile = 'design';
    }
    renderProfiles();
    renderPanels();
  }

  //: Hovering a point on a chart lights its row in the options table, so
  //: the same design is recognisable in both places.
  function highlightDesign(index) {
    document.querySelectorAll('tr.clickable').forEach(tr =>
      tr.classList.toggle('hover', index !== null && Number(tr.dataset.index) === index));
  }

  function wireOptionsTable(node) {
    node.querySelectorAll('th[data-sort]').forEach(th =>
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        const now = state.optionSort || { key: 'rank', dir: 1 };
        // Same column again flips the direction; a new column starts descending
        // for metrics, since bigger is usually what is being looked for.
        state.optionSort = now.key === key
          ? { key, dir: -now.dir }
          : { key, dir: key === 'rank' || key === 'n_grains' ? 1 : -1 };
        renderPanels();
      }));
    node.querySelectorAll('tr.clickable').forEach(tr =>
      tr.addEventListener('click', ev => {
        if (ev.target.dataset.export !== undefined) return;
        selectDesign(Number(tr.dataset.index));
      }));
    node.querySelectorAll('[data-export]').forEach(b =>
      b.addEventListener('click', ev => {
        ev.stopPropagation();
        exportDesign(Number(b.dataset.export));
      }));
    node.querySelectorAll('[data-compare]').forEach(b =>
      b.addEventListener('click', ev => {
        ev.stopPropagation();
        const i = Number(b.dataset.compare);
        compareDesign(state.compare === i ? null : i);
      }));
    // Shift-click a row to compare it instead of loading it.
    node.querySelectorAll('tr.clickable').forEach(tr =>
      tr.addEventListener('click', ev => {
        if (!ev.shiftKey) return;
        ev.stopImmediatePropagation();
        compareDesign(Number(tr.dataset.index));
      }, true));
  }

  async function exportDesign(index) {
    const design = state.results.designs[index];
    const res = await fetch('/api/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: state.spec, x: design.x,
                             n_grains: design.n_grains || null,
                             name: 'optimized_' + (design.designation || index + 1) })
    });
    if (!res.ok) { toast('Export failed.'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'optimized_' + (design.designation || ('option' + (index + 1))) + '.ric';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('Saved .ric. Open it in openMotor.');
  }

  function renderEmptyPreview() {
    const host = $('#emptyPreview');
    const b = Object.assign({}, state.motor, { curves: state.baselineCurves });
    host.innerHTML = Charts.crossSectionSVG(b, b);
  }

  return { boot, state, units, unitScale, fmtLen, lenDigits, metricToDisplay,
           metricUnit, metricDigits, selectDesign, compareDesign, highlightDesign,
           wireOptionsTable,
           parseNumber, metricToDisplay, renderTolerances };
})();

document.addEventListener('DOMContentLoaded', App.boot);
