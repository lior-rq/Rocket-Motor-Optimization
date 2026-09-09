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
    ready: {}, diagnostic: null, diagRunning: false,
    liveRange: null, liveSnap: null, rate: null
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

  const unitScale = () => (state.unit === 'in' ? M_PER_IN : 0.001);
  const toDisplay = m => m / unitScale();
  const toSI = v => v * unitScale();
  // Two places in either unit -- 0.01 in is the finest dimension anyone
  // holds on a reamer, and 0.01 mm would be false precision.
  const lenDigits = () => 2;
  const fmtLen = m => toDisplay(m).toFixed(lenDigits()) + (state.unit === 'in' ? '″' : ' mm');

  function metricToDisplay(metric, value) {
    const kind = (state.metrics[metric] || {}).kind;
    if (kind === 'pressure') return value / PA_PER_PSI;
    if (kind === 'mass_flux') return value / KG_PER_LB;
    return value;
  }
  function metricToSI(metric, value) {
    const kind = (state.metrics[metric] || {}).kind;
    if (kind === 'pressure') return value * PA_PER_PSI;
    if (kind === 'mass_flux') return value * KG_PER_LB;
    return value;
  }

  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  };

  function toast(message, ms = 2600) {
    const node = $('#toast');
    node.textContent = message; node.hidden = false;
    clearTimeout(node._t);
    node._t = setTimeout(() => { node.hidden = true; }, ms);
  }

  /* ---------------------------------------------------------- bootstrap */

  async function boot() {
    wireChrome();
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
    validate();
  }

  function wireChrome() {
    document.querySelectorAll('.unit-toggle button').forEach(b =>
      b.addEventListener('click', () => {
        state.unit = b.dataset.unit;
        document.querySelectorAll('.unit-toggle button').forEach(x =>
          x.classList.toggle('active', x === b));
        renderMotor(); renderVariables(); renderConstraints(); renderOrdering();
        if (state.results) renderPanels();
      }));

    $('#btnTheme').addEventListener('click', () => {
      const root = document.documentElement;
      const now = root.getAttribute('data-theme');
      root.setAttribute('data-theme', now === 'dark' ? 'light' : 'dark');
      if (state.results) renderPanels(); else renderEmptyPreview();
    });

    $('#btnRun').addEventListener('click', startRun);
    $('#btnHardware').addEventListener('click', applyHardware);
    $('#btnHardwareReset').addEventListener('click', resetHardware);
    $('#btnRefit').addEventListener('click', () => {
      state.liveRange = state.liveSnap ? fitRange(state.liveSnap) : null;
      redrawLive();
    });
    $('#btnReportOpen').addEventListener('click', openReport);
    $('#btnBundle').addEventListener('click', downloadBundle);
    $('#btnCancel').addEventListener('click', cancelRun);
    $('#btnLoad').addEventListener('click', () => $('#fileInput').click());
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
        state.spec.variables.forEach(v => { v.free = free; });
        renderVariables(); validate();
      }));
    document.querySelectorAll('.chip[data-step]').forEach(b =>
      b.addEventListener('click', () => {
        const inches = Number(b.dataset.step);
        state.spec.variables.forEach(v => { v.step = inches * M_PER_IN; });
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
      ['Peak pressure', Math.round(m.max_pressure_psi) + ' psi'],
      ['Kn', m.initial_kn.toFixed(0) + ' → ' + m.peak_kn.toFixed(0)],
      ['Peak mass flux', m.mass_flux_lb.toFixed(3) + ' lb/in²s']
    ];
    $('#motorSpecs').innerHTML = rows.map(([k, v]) =>
      `<dt>${k}</dt><dd>${v}</dd>`).join('');
    $('#motorWarnings').innerHTML = (m.warnings || [])
      .map(w => `<div class="warn-pill">${w}</div>`).join('');
  }

  function renderHardware() {
    const m = state.motor, hw = state.hardware || {};
    $('#hwDiameter').value = toDisplay(hw.grain_diameter || m.grain_diameter).toFixed(2);
    $('#hwLength').value = toDisplay(hw.grain_length || m.grain_lengths[0]).toFixed(2);
    $('#hwCount').value = String(hw.grain_count || m.grain_count);
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

  function renderVariables() {
    const body = $('#varRows');
    body.innerHTML = '';
    state.spec.variables.forEach((v, i) => {
      const tr = el('tr', v.free ? '' : 'fixed');
      const dp = lenDigits();
      tr.innerHTML = `
        <td><input type="checkbox" ${v.free ? 'checked' : ''} data-i="${i}" data-k="free"></td>
        <td class="var-name">${v.label || v.name}</td>
        <td><input type="text" value="${toDisplay(v.low).toFixed(dp)}" data-i="${i}" data-k="low" ${v.free ? '' : 'disabled'}></td>
        <td><input type="text" value="${toDisplay(v.high).toFixed(dp)}" data-i="${i}" data-k="high" ${v.free ? '' : 'disabled'}></td>
        <td><input type="text" value="${v.step ? toDisplay(v.step).toFixed(dp) : ''}" placeholder="any" data-i="${i}" data-k="step" ${v.free ? '' : 'disabled'}></td>`;
      body.appendChild(tr);
    });
    body.querySelectorAll('input').forEach(input => {
      input.addEventListener('change', () => {
        const v = state.spec.variables[Number(input.dataset.i)];
        const key = input.dataset.k;
        if (key === 'free') { v.free = input.checked; renderVariables(); }
        else if (key === 'step') {
          const parsed = parseNumber(input.value);
          v.step = isNaN(parsed) ? 0 : toSI(parsed);
        } else {
          const parsed = parseNumber(input.value);
          if (!isNaN(parsed)) v[key] = toSI(parsed);
        }
        validate();
      });
    });
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
          <span class="unit">${(state.metrics[o.metric] || {}).unit || ''}</span><span></span>`;
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
  }

  function renderConstraints() {
    const host = $('#constraintRows');
    host.innerHTML = '';
    state.spec.constraints.forEach((c, i) => {
      const unit = (state.metrics[c.metric] || {}).unit || '';
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
    renderConstraintCurves();
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
    const unit = (state.metrics[metric] || {}).unit || '';
    return shown.toLocaleString(undefined, { maximumFractionDigits: 3 }) +
           (unit ? ' ' + unit : '');
  }

  //: Thrust always, plus one row for every enabled limit that is a time series.
  const CONSTRAINT_ROWS = {
    max_pressure: 'pressure', avg_pressure: 'pressure',
    peak_kn: 'kn', peak_mass_flux: 'mass_flux'
  };

  function renderConstraintCurves() {
    const host = $('#constraintCurves'), note = $('#constraintCurvesNote');
    if (!host) return;
    const c = state.baselineCurves;
    if (!c || !c.time) { host.innerHTML = ''; if (note) note.textContent = ''; return; }
    const limits = (state.spec.constraints || []).filter(x => x.enabled);
    const rows = ['thrust'];
    limits.forEach(x => {
      const row = CONSTRAINT_ROWS[x.metric];
      if (row && rows.indexOf(row) < 0) rows.push(row);
    });
    Charts.behaviourStack(host, c, limits, rows);
    const flat = limits.filter(x => !CONSTRAINT_ROWS[x.metric])
                       .map(x => Charts.metricLabel(x.metric));
    if (note) note.innerHTML = flat.length
      ? `Dotted lines are the limits. ${flat.join(' and ')} ${
          flat.length > 1 ? 'are' : 'is'} a single number rather than a curve, so
         ${flat.length > 1 ? 'they are' : 'it is'} in the table above instead.`
      : 'Dotted lines are the limits.';
  }

  function renderTolerances() {
    const host = $('#toleranceRows');
    if (!host) return;
    host.innerHTML = (state.tolerances || []).map((t, i) => {
      const meta = state.toleranceFields[t.field] || {};
      // Absolute tolerances are a length; relative ones are a percentage.
      const abs = meta.kind === 'absolute';
      const shown = abs ? toDisplay(t.sigma).toFixed(4) : (t.sigma * 100).toFixed(1);
      const unit = abs ? (state.unit === 'in' ? '″' : 'mm') : '%';
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
                             tolerances: state.tolerances, samples: 400 })
    });
    if (!res.ok) { node.innerHTML = '<p class="sub">Could not run the check.</p>'; return; }
    state.robustness = await res.json();
    renderPanels();
  }

  function renderOrdering() {
    const sel = $('#orderingMode');
    sel.innerHTML = Object.entries(state.orderingModes).map(([k, label]) =>
      `<option value="${k}" ${state.spec.ordering.mode === k ? 'selected' : ''}>${label}</option>`).join('');
    sel.onchange = () => { state.spec.ordering.mode = sel.value; renderOrdering(); validate(); };

    const stepField = $('#orderingStepField');
    stepField.hidden = state.spec.ordering.mode !== 'strict';
    const stepInput = $('#orderingStep');
    stepInput.value = state.spec.ordering.min_step
      ? toDisplay(state.spec.ordering.min_step).toFixed(lenDigits()) : '';
    stepInput.placeholder = state.unit === 'in' ? 'e.g. 0.05' : 'e.g. 1.5';
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
          <span class="time">~${Math.round(v.seconds / 60)} min</span>
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

    $('#machineNote').innerHTML = machine.performance_cores
      ? `This machine reports <strong>${cores}</strong> cores, of which
         <strong>${machine.performance_cores}</strong> are performance cores.
         Automatic uses those and leaves the efficiency cores alone: the slowest
         worker sets the pace, so adding them makes a run longer, not shorter.`
      : `This machine reports <strong>${cores}</strong> cores. Automatic leaves two
         alone so the computer stays usable.`;
    renderReadyList();
    renderDiagnostic();
  }

  function presetBudget(key) {
    const v = state.effortLevels[key] || {};
    const perSeed = Math.max(Math.floor(v.budget / v.seeds), 80);
    const pop = Math.min(Math.max(Math.floor(perSeed / 50), 40), 240);
    return { pop, gen: Math.max(Math.floor(perSeed / pop), 2), perSeed };
  }

  //: Everything that costs real time and is outside this program's control.
  const READY_STEPS = {
    mac: [
      'Plug in the power adapter. On battery, macOS caps sustained CPU speed.',
      'System Settings → Battery → Energy Mode: High Power, if the machine offers it.',
      'System Settings → Lock Screen: stop the display sleeping, or run the search with the lid open.',
      'Quit anything else that uses the CPU hard. Browsers with many tabs count.'
    ],
    windows: [
      'Plug in the power adapter. On battery, Windows caps sustained CPU speed.',
      'Settings → System → Power &amp; battery → Power mode: Best performance.',
      'Settings → System → Power &amp; battery → Screen and sleep: set sleep to Never.',
      'Quit anything else that uses the CPU hard. Browsers with many tabs count.'
    ],
    linux: [
      'Plug in the power adapter.',
      'Set the CPU governor or power profile to performance.',
      'Disable suspend for the length of the run.',
      'Quit anything else that uses the CPU hard.'
    ]
  };

  function renderReadyList() {
    const host = $('#readyList');
    if (!host) return;
    const steps = READY_STEPS[(state.machine || {}).platform] || READY_STEPS.linux;
    host.innerHTML = steps.map((text, i) =>
      `<li><label><input type="checkbox" data-ready="${i}"
        ${state.ready[i] ? 'checked' : ''}><span>${text}</span></label></li>`).join('');
    host.querySelectorAll('[data-ready]').forEach(box =>
      box.addEventListener('change', () => {
        state.ready[Number(box.dataset.ready)] = box.checked;
      }));
  }

  function renderDiagnostic() {
    const note = $('#diagNote'), status = $('#diagStatus'), btn = $('#btnDiagnostic');
    if (!btn) return;
    const d = state.diagnostic;
    note.innerHTML = d
      ? `Measured <strong>${d.rate}</strong> simulations a second on
         <strong>${d.workers}</strong> cores, at the settings above. The estimate
         adds ${Math.round((d.thermal_derate - 1) * 100)}% for the machine slowing
         down as it heats up.`
      : `Time estimates need a measurement from this machine at these settings.
         The diagnostic runs real simulations for about a minute and does not
         change anything.`;
    status.textContent = state.diagRunning ? 'measuring…' : '';
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
    if (state.step === 2) renderConstraintCurves();
    if (state.step === RUNNING) redrawLive();
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
    const back = $('#btnBack'), next = $('#btnNext'), gate = $('#stepGate');
    if (!back || !next || !gate) return;
    back.disabled = state.step === 0;
    const last = state.step === STEPS - 1;
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

  function renderMotorPreview() {
    if (!state.motor || !$('#motorPreview')) return;
    const b = Object.assign({}, state.motor, { curves: state.baselineCurves });
    $('#motorPreview').innerHTML = Charts.crossSectionSVG(b, b);
    Charts.behaviourStack($('#motorThrust'), state.baselineCurves, [],
                          ['thrust', 'pressure', 'kn', 'mass_flux']);
  }

  // The motor summary reports display units under its own key names.
  const BASELINE_KEYS = {
    max_pressure: 'max_pressure_psi', peak_mass_flux: 'mass_flux_lb',
    port_throat: 'port_throat', peak_kn: 'peak_kn', initial_kn: 'initial_kn',
    initial_thrust: 'initial_thrust', total_impulse: 'total_impulse',
    isp: 'isp', burn_time: 'burn_time',
  };

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
      const key = BASELINE_KEYS[c.metric];
      const have = key ? m[key] : undefined;
      if (have === undefined || have === null || Number.isNaN(have)) { unknown++; return ''; }
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
    validateTimer = setTimeout(async () => {
      const res = await fetch('/api/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: state.spec })
      });
      const data = await res.json();
      const host = $('#problems');
      host.innerHTML =
        (data.problems || []).map(p => `<div class="problem err">${p}</div>`).join('') +
        (data.notes || []).map(p => `<div class="problem note">${p}</div>`).join('');
      state.validation = data;
      renderStepper();
      renderSizing(data.sizing);
      const est = data.estimate || {};
      $('#budgetSplit').innerHTML = est.seeds
        ? `Split into <strong>${est.seeds}</strong> independent search${
            est.seeds === 1 ? '' : 'es'} of ${est.pop} × ${est.gen} =
           ${est.per_seed.toLocaleString()} simulations each, then merged into one
           front. Independent searches disagree by several percent, so merging
           several beats one long run at the same cost.`
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
         <span class="v">${(c.to / 0.0254).toFixed(2)}″</span>
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
    renderVariables();
    validate();
    const what = (data.changes || []).map(c =>
      `${c.variable} to ${(c.to / 0.0254).toFixed(2)}″`).join(', ');
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
    $('#emptyState').hidden = true;
    $('#panels').hidden = true;
    $('#live').hidden = false;
    $('#liveStats').innerHTML = '';
    $('#liveNote').textContent = 'Waiting for the first generation…';
    goTo(RUNNING);
    state.poll = setInterval(pollJob, 900);
  }

  async function pollJob() {
    if (!state.jobId) return;
    const res = await fetch('/api/jobs/' + state.jobId + '/live');
    if (!res.ok) return;
    const job = await res.json();
    if (job.telemetry) renderLive(job.telemetry);
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

  function renderLive(t) {
    const gen = t.generation || 0;
    const total = t.total_generations || 0;
    $('#liveTitle').textContent = t.n_seeds > 1
      ? `Search ${t.seed_index + 1} of ${t.n_seeds}`
      : 'Searching';
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
      stats.push([Charts.metricLabel(t.metrics[1]),
                  Math.round(t.best[0]).toLocaleString(), 'accent']);
      stats.push([Charts.metricLabel(t.metrics[0]),
                  Math.round(t.best[1]).toLocaleString(), 'accent']);
    }
    $('#liveStats').innerHTML = stats.map(([k, v, cls]) =>
      `<div class="live-stat"><span class="k">${k}</span>
       <span class="v ${cls}">${v}</span></div>`).join('');

    // The loaded motor, on the same axes, so progress is always relative to it.
    if (state.motor && t.metrics) {
      const at = m => state.motor[BASELINE_KEYS[m] || m];
      const bx = at(t.metrics[0]), by = at(t.metrics[1]);
      if (Number.isFinite(bx) && Number.isFinite(by)) t.baseline = [bx, by];
    }
    state.liveSnap = t;
    if (!state.liveRange) state.liveRange = fitRange(t);
    try { Charts.liveFrame($('#livePlot'), t, state.liveRange); }
    catch (e) { console.error(e); }
    try { Charts.liveSpark($('#liveSpark'), t.trace); } catch (e) { console.error(e); }
    renderAxisControls();
    renderSpeed(t);
    $('#liveNote').textContent = t.trace && t.trace.length > 1
      ? 'Best ' + Charts.metricLabel(t.metrics[1]).toLowerCase() + ' found so far, '
        + 'across every generation of this run.'
      : '';
  }

  function redrawLive() {
    if (state.liveSnap) renderLive(state.liveSnap);
  }

  //: Everything drawn, plus a tenth of the span so nothing sits on the frame.
  function fitRange(t) {
    const [ax, ay] = Charts.orderAxes(t.metrics || ['initial_thrust', 'total_impulse']);
    const flip = ax !== (t.metrics || [])[0];
    const xs = [], ys = [];
    (t.points || []).forEach(p => { xs.push(flip ? p[1] : p[0]); ys.push(flip ? p[0] : p[1]); });
    (t.front || []).forEach(p => { xs.push(flip ? p[1] : p[0]); ys.push(flip ? p[0] : p[1]); });
    if (t.baseline) {
      xs.push(flip ? t.baseline[1] : t.baseline[0]);
      ys.push(flip ? t.baseline[0] : t.baseline[1]);
    }
    if (!xs.length) return null;
    const span = v => {
      const lo = Math.min.apply(null, v), hi = Math.max.apply(null, v);
      const pad = Math.max((hi - lo) * 0.1, Math.abs(hi) * 0.01, 1e-9);
      return [lo - pad, hi + pad];
    };
    return { x: span(xs), y: span(ys) };
  }

  function renderAxisControls() {
    const t = state.liveSnap, r = state.liveRange;
    if (!t || !r) return;
    const [ax, ay] = Charts.orderAxes(t.metrics || []);
    $('#axXlabel').textContent = Charts.metricLabel(ax);
    $('#axYlabel').textContent = Charts.metricLabel(ay);
    const boxes = [['#axXmin', 'x', 0], ['#axXmax', 'x', 1],
                   ['#axYmin', 'y', 0], ['#axYmax', 'y', 1]];
    boxes.forEach(([sel, axis, i]) => {
      const box = $(sel);
      if (document.activeElement === box) return;   // never fight the typist
      box.value = Math.round(r[axis][i]).toLocaleString();
      box.onchange = () => {
        const n = parseNumber(box.value);
        if (!isNaN(n)) { r[axis][i] = n; redrawLive(); }
      };
    });
  }

  function renderSpeed(t) {
    const done = t.simulations_done || 0, total = t.simulations_total || 0;
    const rate = t.rate || 0;
    const ceiling = Math.max((state.diagnostic || {}).rate || 0,
                             (state.machine || {}).rate || 0, rate, 1);
    $('#speedNum').textContent = rate
      ? rate.toFixed(1) + ' sims/s' + (t.workers ? ' on ' + t.workers + ' cores' : '')
      : '—';
    $('#speedFill').style.width = Math.min(100, 100 * rate / ceiling) + '%';
    const left = rate > 0 && total > done ? (total - done) / rate : null;
    $('#speedEta').textContent = left === null ? '—'
      : fmtClock(left * ((state.diagnostic || {}).thermal_derate || 1));
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
    $('#btnBundle').disabled = !job.n_designs;
  }

  function openReport() {
    if (state.reportJob) window.open('/api/jobs/' + state.reportJob + '/report', '_blank');
  }

  async function downloadBundle() {
    if (!state.reportJob) return;
    const button = $('#btnBundle');
    button.disabled = true;
    $('#bundleProgress').hidden = false;
    $('#bundleMsg').textContent = 'Starting…';
    const res = await fetch('/api/jobs/' + state.reportJob + '/bundle', { method: 'POST' });
    if (!res.ok) {
      toast((await res.json()).detail || 'Could not start.');
      button.disabled = false; $('#bundleProgress').hidden = true;
      return;
    }
    pollBundle();
  }

  async function pollBundle() {
    const res = await fetch('/api/jobs/' + state.reportJob + '/bundle');
    if (!res.ok) { $('#bundleProgress').hidden = true; $('#btnBundle').disabled = false; return; }

    // Ready, and the zip itself is the response rather than a status.
    if ((res.headers.get('Content-Type') || '').includes('zip')) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (res.headers.get('Content-Disposition') || '')
        .replace(/.*filename="([^"]+)".*/, '$1') || 'design-sheets.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      $('#bundleFill').style.width = '100%';
      $('#bundleMsg').textContent = 'Downloaded.';
      $('#btnBundle').disabled = false;
      return;
    }

    const job = await res.json();
    if (job.bundle_status === 'failed') {
      toast(job.bundle_error || 'Could not build the sheets.');
      $('#bundleProgress').hidden = true; $('#btnBundle').disabled = false;
      return;
    }
    const frac = job.bundle_total ? job.bundle_done / job.bundle_total : 0;
    $('#bundleFill').style.width = (100 * frac).toFixed(1) + '%';
    $('#bundleMsg').textContent = job.bundle_message || 'Working…';
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
    state.robustness = null;
    if (!state.results.designs.length) {
      toast(state.results.messages[0] || 'No design met every limit.', 6000);
    } else {
      toast(`Found ${state.results.designs.length} option${
        state.results.designs.length > 1 ? 's' : ''} in ${state.results.stats.seconds}s`);
    }
    $('#emptyState').hidden = true;
    $('#panels').hidden = false;
    renderProfiles();
    renderPanels();
    renderStepper();
    if (state.results.designs.length) goTo(RESULTS);
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
      selected: state.selected,
      axes
    };
  }

  function renderPanels() {
    const host = $('#panels');
    host.innerHTML = '';
    const profile = Charts.PROFILES.find(p => p.id === state.profile);
    const ctx = context();
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

  async function selectDesign(index) {
    const designs = (state.results || {}).designs || [];
    const design = designs[index];
    if (!design) return;
    state.selected = index;
    state.robustness = null;   // belongs to the design it was run on
    // Only the first few designs come back with curves, so the rest are
    // simulated on demand; without them Design Review has nothing to draw.
    if (!design.curves) {
      toast('Simulating option ' + (index + 1) + '…');
      try {
        const res = await fetch('/api/curves', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ spec: state.spec, x: design.x })
        });
        if (res.ok) {
          const full = await res.json();
          if (full.curves) design.curves = full.curves;
        }
      } catch (err) { /* the panels that need curves say so themselves */ }
    }
    state.profile = 'design';
    renderProfiles();
    renderPanels();
    toast('Option ' + (index + 1) + ' loaded as the optimized motor.');
  }

  function wireOptionsTable(node) {
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
  }

  async function exportDesign(index) {
    const design = state.results.designs[index];
    const res = await fetch('/api/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: state.spec, x: design.x,
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

  return { boot, state, unitScale, fmtLen, selectDesign, wireOptionsTable,
           parseNumber, metricToDisplay };
})();

document.addEventListener('DOMContentLoaded', App.boot);
