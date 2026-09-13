/* Panels and the profiles that group them.
 *
 * A profile is just a list of panel ids, so adding one is a one-line change.
 * Colours come from the same validated palette the printed report uses, and
 * scatter plots stay within its first three slots -- past three, adjacent hues
 * stop being reliably separable for colourblind readers. */

const Charts = (() => {

  const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];
  const LIMIT  = '#e34948';
  const RAMP   = ['#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];

  function css(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  function theme() {
    return {
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: 'system-ui, -apple-system, sans-serif', size: 11,
              color: css('--ink-2') },
      margin: { l: 58, r: 16, t: 10, b: 46 },
      xaxis: { gridcolor: css('--line-2'), zerolinecolor: css('--line'),
               linecolor: css('--line'), automargin: true },
      yaxis: { gridcolor: css('--line-2'), zerolinecolor: css('--line'),
               linecolor: css('--line'), automargin: true },
      legend: { orientation: 'h', y: -0.30, yanchor: 'top', xanchor: 'center',
                x: 0.5, font: { size: 10.5 } },
      hoverlabel: { bgcolor: css('--surface'), bordercolor: css('--line'),
                    font: { size: 11, color: css('--ink') } },
      showlegend: false
    };
  }

  const CONFIG = { displayModeBar: false, responsive: true };

  // Plotly 4 ignores a plain string here, so every axis title in the app was
  // silently dropped. Written once, applied to every layout that goes out.
  function fixTitles(layout) {
    Object.keys(layout).forEach(key => {
      if (!/^[xy]axis\d*$/.test(key)) return;
      const axis = layout[key];
      if (axis && typeof axis.title === 'string') {
        layout[key] = Object.assign({}, axis, { title: { text: axis.title } });
      }
    });
    return layout;
  }

  function draw(node, traces, extra) {
    const layout = fixTitles(Object.assign(theme(), extra || {}));
    Plotly.react(node, traces, makeRoom(layout), CONFIG);
  }

  //: A legend below the plot lands on the x-axis title unless the bottom
  //: margin grows to hold both. Applied centrally so no panel can forget.
  function makeRoom(layout) {
    if (!layout.showlegend) return layout;
    const legend = layout.legend || {};
    if (legend.orientation !== 'h' || (legend.y || 0) >= 0) return layout;
    const margin = Object.assign({}, layout.margin);
    margin.b = Math.max(margin.b || 0, 78);
    layout.margin = margin;
    return layout;
  }

  //: Impulse reads as the horizontal axis and thrust as the vertical one, so
  //: the pair is always drawn that way whichever order the run reports.
  function orderAxes(pair) {
    const [a, b] = pair;
    return (b === 'total_impulse' && a !== 'total_impulse') ? [b, a] : [a, b];
  }

  /* ------------------------------------------------------------ helpers */

  function metricLabel(key) {
    const m = (App.state.metrics || {})[key];
    return m ? m.label : key;
  }

  function metricValue(row, key) {
    // Storage is SI; pressure and mass flux are shown in the chosen system.
    return App.metricToDisplay(key, row[key]);
  }

  function metricUnit(key) {
    return App.metricUnit(key);
  }

  const U = () => App.units();

  /* ------------------------------------------------------------- panels */

  const PANELS = {

    thrustCurve: {
      title: 'Thrust curve',
      sub: 'Selected design, simulated at full fidelity',
      render(node, ctx) {
        const d = ctx.design, b = ctx.baseline;
        const traces = [];
        if (b && b.curves) traces.push({
          x: b.curves.time, y: b.curves.thrust, mode: 'lines', name: 'your motor',
          line: { color: css('--ink-3'), width: 1.5, dash: 'dot' }
        });
        if (d && d.curves) traces.push({
          x: d.curves.time, y: d.curves.thrust, mode: 'lines', name: 'optimized',
          line: { color: SERIES[0], width: 2.2 }
        });
        const c = ctx.compare;
        if (c && c.curves) traces.push({
          x: c.curves.time, y: c.curves.thrust, mode: 'lines',
          name: 'Option ' + (ctx.compareIndex + 1),
          line: { color: LIMIT, width: 2, dash: 'dash' }
        });
        draw(node, traces, {
          showlegend: true,
          xaxis: Object.assign(theme().xaxis, { title: 'Time (s)' }),
          yaxis: Object.assign(theme().yaxis, { title: 'Thrust (N)', rangemode: 'tozero' })
        });
      }
    },

    pressureKn: {
      title: 'Chamber pressure and Kn',
      sub: 'Two stacked panels — never two scales on one axis',
      render(node, ctx) {
        const d = ctx.design; if (!d || !d.curves) return;
        const pressure = d.curves.pressure.map(p => p / U().pressure.scale);
        const t = theme();
        const traces = [
          { x: d.curves.time, y: pressure, mode: 'lines', name: 'pressure',
            line: { color: SERIES[1], width: 2 }, xaxis: 'x', yaxis: 'y' },
          { x: d.curves.time, y: d.curves.kn, mode: 'lines', name: 'Kn',
            line: { color: SERIES[2], width: 2 }, xaxis: 'x2', yaxis: 'y2' }
        ];
        const c = ctx.compare;
        if (c && c.curves) {
          const label = 'Option ' + (ctx.compareIndex + 1);
          traces.push({ x: c.curves.time, y: c.curves.pressure.map(p => p / U().pressure.scale),
            mode: 'lines', name: label + ' pressure', xaxis: 'x', yaxis: 'y',
            line: { color: LIMIT, width: 1.6, dash: 'dash' } });
          traces.push({ x: c.curves.time, y: c.curves.kn, mode: 'lines',
            name: label + ' Kn', xaxis: 'x2', yaxis: 'y2',
            line: { color: LIMIT, width: 1.6, dash: 'dash' } });
        }
        const limits = [];
        (ctx.constraints || []).forEach(c => {
          if (c.metric === 'max_pressure')
            limits.push(hline(c.value / U().pressure.scale, 'y'));
          if (c.metric === 'peak_kn') limits.push(hline(c.value, 'y2'));
        });
        draw(node, traces, {
          grid: { rows: 2, columns: 1, pattern: 'independent', roworder: 'top to bottom' },
          margin: { l: 54, r: 16, t: 8, b: 38 },
          xaxis:  Object.assign({}, t.xaxis, { anchor: 'y', showticklabels: false }),
          yaxis:  Object.assign({}, t.yaxis, { title: U().pressure.label, domain: [0.56, 1] }),
          xaxis2: Object.assign({}, t.xaxis, { anchor: 'y2', title: 'Time (s)' }),
          yaxis2: Object.assign({}, t.yaxis, { title: 'Kn', domain: [0, 0.44] }),
          shapes: limits
        });
      }
    },

    crossSection: {
      title: 'Motor cross-section',
      sub: 'To scale, forward at left',
      render(node, ctx) { node.innerHTML = crossSectionSVG(ctx.design, ctx.baseline); }
    },

    specSheet: {
      title: 'Specification',
      sub: 'Optimized design against your current motor',
      render(node, ctx) { node.innerHTML = deltaTable(ctx.design, ctx.baseline); }
    },

    marginBars: {
      title: 'How close it runs to each limit',
      sub: 'Full bar means the limit is reached exactly',
      render(node, ctx) {
        const d = ctx.design; if (!d) return;
        node.innerHTML = (ctx.constraints || []).filter(c => c.enabled)
          .map(c => marginRow(c, d)).join('') ||
          '<p class="sub">No limits set.</p>';
      }
    },

    /* ------------------------------------------------- trade-off explorer */

    paretoFront: {
      title: 'Your options',
      sub: 'Click any point to load that motor into Design Review',
      render(node, ctx) {
        const designs = ctx.designs || [];
        if (!designs.length) { node.innerHTML = '<p class="sub">No feasible designs.</p>'; return; }
        const [ax, ay] = ctx.axes;
        const sel = ctx.selected, cmp = ctx.compareIndex;
        const traces = [{
          x: designs.map(d => metricValue(d, ax)),
          y: designs.map(d => metricValue(d, ay)),
          mode: 'lines+markers', type: 'scatter',
          marker: {
            size: designs.map((_, i) => i === sel ? 15 : (i === cmp ? 13 : 9)),
            color: designs.map((_, i) => i === cmp ? LIMIT : SERIES[0]),
            line: { color: designs.map((_, i) => i === sel ? css('--ink') : css('--surface')),
                    width: designs.map((_, i) => i === sel ? 2.5 : 1.5) }
          },
          line: { color: SERIES[0], width: 1.5 },
          text: designs.map((d, i) => (d.designation || 'Option ' + (i + 1))
            + (i === sel ? ' \u00b7 selected' : i === cmp ? ' \u00b7 comparing' : '')),
          name: 'options',
          hovertemplate: '%{text}<br>' + metricLabel(ax) + ': %{x:,.0f}<br>' +
                         metricLabel(ay) + ': %{y:,.0f}<extra></extra>'
        }];
        if (ctx.baseline) traces.push({
          x: [metricValue(ctx.baseline, ax)], y: [metricValue(ctx.baseline, ay)],
          mode: 'markers', name: 'your motor',
          marker: { size: 13, symbol: 'diamond', color: LIMIT,
                    line: { color: css('--surface'), width: 1.5 } },
          hovertemplate: 'your motor<extra></extra>'
        });
        draw(node, traces, {
          showlegend: true,
          xaxis: Object.assign(theme().xaxis, { title: axisTitle(ax) }),
          yaxis: Object.assign(theme().yaxis, { title: axisTitle(ay) })
        });
        node.on('plotly_click', ev => {
          const p = ev.points[0];
          if (p.curveNumber !== 0) return;
          const shift = ev.event && ev.event.shiftKey;
          if (shift) App.compareDesign(p.pointIndex); else App.selectDesign(p.pointIndex);
        });
        node.on('plotly_hover', ev => {
          const p = ev.points[0];
          if (p.curveNumber === 0) App.highlightDesign(p.pointIndex);
        });
        node.on('plotly_unhover', () => App.highlightDesign(null));
      }
    },

    populationCloud: {
      title: 'Every design tried',
      sub: 'Grey failed a limit; blue met them all',
      render(node, ctx) {
        const pop = ctx.population || [];
        if (!pop.length) { node.innerHTML = '<p class="sub">No population recorded.</p>'; return; }
        const [ax, ay] = ctx.axes;
        const ok = pop.filter(r => r.feasible), bad = pop.filter(r => !r.feasible);
        const traces = [
          { x: bad.map(r => metricValue(r, ax)), y: bad.map(r => metricValue(r, ay)),
            mode: 'markers', name: 'over a limit',
            marker: { size: 3.5, color: css('--line'), opacity: .85 }, hoverinfo: 'skip' },
          { x: ok.map(r => metricValue(r, ax)), y: ok.map(r => metricValue(r, ay)),
            mode: 'markers', name: 'legal',
            marker: { size: 4, color: SERIES[0], opacity: .55 }, hoverinfo: 'skip' }
        ];
        if (ctx.baseline) traces.push({
          x: [metricValue(ctx.baseline, ax)], y: [metricValue(ctx.baseline, ay)],
          mode: 'markers', name: 'your motor',
          marker: { size: 13, symbol: 'diamond', color: LIMIT,
                    line: { color: css('--surface'), width: 1.5 } }
        });
        draw(node, traces, {
          showlegend: true,
          xaxis: Object.assign(theme().xaxis, { title: axisTitle(ax) }),
          yaxis: Object.assign(theme().yaxis, { title: axisTitle(ay) })
        });
      }
    },

    parallelCoords: {
      title: 'What the good designs have in common',
      sub: 'Each line is one legal design, coloured by how well it scored',
      render(node, ctx) {
        const pop = (ctx.population || []).filter(r => r.feasible);
        if (pop.length < 5) {
          node.innerHTML = '<p class="sub">Not enough legal designs to compare yet.</p>';
          return;
        }
        const vars = (ctx.searched || []).filter(v => pop[0][v] !== undefined);
        if (!vars.length) { node.innerHTML = '<p class="sub">No searched dimensions.</p>'; return; }
        node.innerHTML = parallelSVG(pop, vars, ctx.axes[0]);
      }
    },

    objectiveSpread: {
      title: 'Spread of results',
      sub: 'Where the search spent its time',
      render(node, ctx) {
        const pop = ctx.population || [];
        if (!pop.length) { node.innerHTML = '<p class="sub">No population recorded.</p>'; return; }
        const key = ctx.axes[0];
        const ok = pop.filter(r => r.feasible).map(r => metricValue(r, key));
        const bad = pop.filter(r => !r.feasible).map(r => metricValue(r, key));
        draw(node, [
          { x: bad, type: 'histogram', name: 'over a limit',
            marker: { color: css('--line') }, opacity: .9, nbinsx: 40 },
          { x: ok, type: 'histogram', name: 'legal',
            marker: { color: SERIES[0] }, opacity: .85, nbinsx: 40 }
        ], {
          barmode: 'overlay', showlegend: true,
          xaxis: Object.assign(theme().xaxis, { title: axisTitle(key) }),
          yaxis: Object.assign(theme().yaxis, { title: 'designs' })
        });
      }
    },

    /* -------------------------------------------------------- diagnostics */

    convergence: {
      title: 'Search progress',
      sub: 'Best legal score found, against simulations spent',
      render(node, ctx) {
        const c = ctx.convergence || [];
        if (!c.length) { node.innerHTML = '<p class="sub">No convergence data.</p>'; return; }
        draw(node, [{
          x: c.map(p => p.n), y: c.map(p => p.best), mode: 'lines',
          line: { color: SERIES[0], width: 2 }, name: 'best so far'
        }], {
          xaxis: Object.assign(theme().xaxis, { title: 'simulations', type: 'log' }),
          yaxis: Object.assign(theme().yaxis, { title: 'score' })
        });
      }
    },

    parity: {
      title: 'Model accuracy',
      sub: 'Predicted against simulated, on designs held back from training',
      render(node, ctx) {
        const s = ctx.surrogate;
        if (!s || !s.parity) {
          node.innerHTML = '<p class="sub">Only trained in full trade-off mode. ' +
            'Tick “Map the full trade-off” to see this.</p>'; return;
        }
        const key = ctx.axes[0] in s.parity ? ctx.axes[0] : Object.keys(s.parity)[0];
        const p = s.parity[key];
        const lo = Math.min(...p.actual), hi = Math.max(...p.actual);
        draw(node, [
          { x: p.actual, y: p.predicted, mode: 'markers', name: key,
            marker: { size: 4, color: SERIES[0], opacity: .35 }, hoverinfo: 'skip' },
          { x: [lo, hi], y: [lo, hi], mode: 'lines', name: 'perfect',
            line: { color: css('--ink-3'), width: 1, dash: 'dash' }, hoverinfo: 'skip' }
        ], {
          xaxis: Object.assign(theme().xaxis, { title: 'simulated ' + metricLabel(key) }),
          yaxis: Object.assign(theme().yaxis, { title: 'predicted' })
        });
      }
    },

    importance: {
      title: 'Which dimension matters most',
      sub: 'Drop in model accuracy when that value is shuffled',
      render(node, ctx) {
        const s = ctx.surrogate;
        if (!s || !s.importances) {
          node.innerHTML = '<p class="sub">Only measured in full trade-off mode.</p>'; return;
        }
        const rows = s.importances.slice(0, 10).reverse();
        draw(node, [{
          type: 'bar', orientation: 'h',
          y: rows.map(r => shortVar(r.feature)), x: rows.map(r => r.importance),
          marker: { color: SERIES[0] }, hovertemplate: '%{y}: %{x:.3f}<extra></extra>'
        }], {
          margin: { l: 108, r: 16, t: 8, b: 38 },
          xaxis: Object.assign(theme().xaxis, { title: 'importance' }),
          yaxis: Object.assign(theme().yaxis, { automargin: true })
        });
      }
    },

    grainCounts: {
      title: 'Grain counts',
      sub: 'The stack cut each way: checked on paper, tried briefly, searched in full',
      render(node, ctx) {
        const info = ctx.grainCounts;
        if (!info || !info.free) {
          node.innerHTML = '<p class="sub">The grain count was held at the file\'s value.</p>';
          return;
        }
        node.innerHTML = grainCountTable(info, ctx);
      }
    },

    constraintActivity: {
      title: 'Which limit is holding you back',
      sub: 'Share of legal designs sitting within 2% of each limit',
      render(node, ctx) {
        const rows = ctx.constraintActivity || [];
        if (!rows.length) { node.innerHTML = '<p class="sub">No limits set.</p>'; return; }
        const sorted = rows.slice().sort((a, b) => a.binding_fraction - b.binding_fraction);
        draw(node, [{
          type: 'bar', orientation: 'h',
          y: sorted.map(r => r.label), x: sorted.map(r => r.binding_fraction * 100),
          marker: { color: sorted.map(r => r.binding_fraction > 0.4 ? LIMIT : SERIES[0]) },
          hovertemplate: '%{y}: %{x:.0f}% of legal designs are up against it<extra></extra>'
        }], {
          margin: { l: 130, r: 16, t: 8, b: 38 },
          xaxis: Object.assign(theme().xaxis, { title: '% of legal designs at the limit' }),
          yaxis: Object.assign(theme().yaxis, { automargin: true })
        });
      }
    },

    /* ----------------------------------------------------- compare & safety */

    compareThrust: {
      title: 'Before and after',
      sub: 'Your motor against the selected design',
      render(node, ctx) { PANELS.thrustCurve.render(node, ctx); }
    },

    grainFlux: {
      title: 'Mass flux in each grain',
      sub: 'The aft grain always runs hottest — that is the one the limit is about',
      render(node, ctx) {
        const d = ctx.design;
        if (!d || !d.curves || !d.curves.mass_flux || !d.curves.mass_flux.length) {
          node.innerHTML = '<p class="sub">No flux data.</p>'; return;
        }
        const n = d.curves.mass_flux.length;
        const traces = d.curves.mass_flux.map((series, i) => ({
          x: d.curves.time, y: series.map(v => v / U().mass_flux.scale), mode: 'lines',
          name: 'grain ' + (i + 1),
          line: { color: RAMP[Math.round(i * (RAMP.length - 1) / Math.max(n - 1, 1))], width: 1.8 }
        }));
        const limits = (ctx.constraints || [])
          .filter(c => c.metric === 'peak_mass_flux' && c.enabled)
          .map(c => hline(c.value / U().mass_flux.scale, 'y'));
        draw(node, traces, {
          showlegend: true, shapes: limits,
          xaxis: Object.assign(theme().xaxis, { title: 'Time (s)' }),
          yaxis: Object.assign(theme().yaxis, { title: U().mass_flux.label, rangemode: 'tozero' })
        });
      }
    },

    grainMach: {
      title: 'Core Mach in each grain',
      sub: 'Gas speed down the port; past Mach 1 the core chokes',
      render(node, ctx) {
        const d = ctx.design;
        if (!d || !d.curves || !d.curves.mach || !d.curves.mach.length) {
          node.innerHTML = '<p class="sub">No Mach data.</p>'; return;
        }
        const n = d.curves.mach.length;
        const traces = d.curves.mach.map((series, i) => ({
          x: d.curves.time, y: series, mode: 'lines', name: 'grain ' + (i + 1),
          line: { color: RAMP[Math.round(i * (RAMP.length - 1) / Math.max(n - 1, 1))], width: 1.8 }
        }));
        const limits = (ctx.constraints || [])
          .filter(c => c.metric === 'peak_mach' && c.enabled)
          .map(c => hline(c.value, 'y'));
        draw(node, traces, {
          showlegend: true, shapes: limits,
          xaxis: Object.assign(theme().xaxis, { title: 'Time (s)' }),
          yaxis: Object.assign(theme().yaxis, { title: 'Mach', rangemode: 'tozero' })
        });
      }
    },

    tornado: {
      title: 'What moves the needle',
      sub: 'Change in the leading goal from one step either way',
      render(node, ctx) {
        const rows = (ctx.sensitivity || []).slice(0, 9).reverse();
        if (!rows.length) { node.innerHTML = '<p class="sub">No sensitivity data.</p>'; return; }
        draw(node, [
          { type: 'bar', orientation: 'h', name: 'one step smaller',
            y: rows.map(r => shortVar(r.variable)), x: rows.map(r => r.down),
            marker: { color: SERIES[1] },
            hovertemplate: '%{y} smaller: %{x:+,.1f}<extra></extra>' },
          { type: 'bar', orientation: 'h', name: 'one step larger',
            y: rows.map(r => shortVar(r.variable)), x: rows.map(r => r.up),
            marker: { color: SERIES[0] },
            hovertemplate: '%{y} larger: %{x:+,.1f}<extra></extra>' }
        ], {
          barmode: 'overlay', showlegend: true,
          margin: { l: 108, r: 16, t: 8, b: 38 },
          xaxis: Object.assign(theme().xaxis, { title: 'change in ' + metricLabel(ctx.axes[0]),
                                                zeroline: true }),
          yaxis: Object.assign(theme().yaxis, { automargin: true })
        });
      }
    },

    robustness: {
      title: 'What happens when you build it',
      sub: 'The same design made many times, with your tolerances applied',
      render(node, ctx) {
        const r = ctx.robustness;
        if (!r) {
          // The tolerances live here rather than earlier in the flow: they are
          // only ever read by this check, so this is the one place they matter.
          node.innerHTML = `<div class="robust">
            <p class="lead">The optimizer works from nominal dimensions, so every
            design it returns sits exactly on whatever limits you set. This simulates
            the design as it would actually come out of the shop and reports how often
            it still stays legal.</p>
            <div class="tol-block">
              <div class="card-head"><h4>Build tolerances</h4>
                <span class="sigma">1&sigma;</span></div>
              <div class="rows" id="toleranceRows"></div>
            </div>
            <div><button type="button" class="chip" id="btnRobust">Check robustness</button></div>
          </div>`;
          App.renderTolerances();
          const b = node.querySelector('#btnRobust');
          if (b) b.addEventListener('click', () => ctx.onCheckRobustness(node));
          return;
        }
        if (!r.available) {
          node.innerHTML = `<p class="sub">${r.reason || 'No robustness data.'}</p>`;
          return;
        }
        const pct = 100 * r.pass_rate;
        const cls = pct >= 90 ? 'ok' : (pct >= 70 ? '' : 'bad');
        const bars = (r.per_limit || []).map(l => {
          const p = 100 * l.exceed_probability;
          const fill = p < 1 ? 'none' : (p < 10 ? 'low' : '');
          return `<div class="bar-row">
            <span class="label">${l.label}</span>
            <span class="track"><span class="fill ${fill}"
              style="width:${Math.min(p, 100).toFixed(1)}%"></span></span>
            <span class="pct">${p.toFixed(0)}% over</span></div>`;
        }).join('');
        node.innerHTML = `<div class="robust">
          <div class="headline">
            <span class="rate ${cls}">${pct.toFixed(0)}%</span>
            <span class="rate-note">of ${r.samples} builds stay inside every limit<br>
              95% confidence ${(100 * r.pass_low).toFixed(0)}–${(100 * r.pass_high).toFixed(0)}%</span>
          </div>
          <div>${bars}</div>
          <div class="tol-block">
            <div class="card-head"><h4>Build tolerances</h4>
              <span class="sigma">1&sigma;</span></div>
            <div class="rows" id="toleranceRows"></div>
          </div>
          <div><button type="button" class="chip" id="btnRobust">Run again</button></div>
        </div>`;
        App.renderTolerances();
        const b = node.querySelector('#btnRobust');
        if (b) b.addEventListener('click', () => ctx.onCheckRobustness(node));
      }
    },

    robustnessSpread: {
      title: 'Where the builds land',
      sub: 'The limit that goes over most often, across every simulated build',
      render(node, ctx) {
        const r = ctx.robustness;
        if (!r || !r.available || !r.per_limit || !r.per_limit.length) {
          node.innerHTML = '<p class="sub">Run the robustness check to see this.</p>';
          return;
        }
        const worst = r.per_limit[0];
        // Samples arrive in SI; metricValue converts one row, so wrap each in
        // the shape it expects rather than repeating the unit table here.
        const toShown = v => metricValue({ [worst.metric]: v }, worst.metric);
        const shown = (worst.samples || []).map(toShown);
        const limit = toShown(worst.limit);
        const over = shown.filter(v => worst.op === '<=' ? v > limit : v < limit);
        const under = shown.filter(v => worst.op === '<=' ? v <= limit : v >= limit);
        draw(node, [
          { x: under, type: 'histogram', name: 'legal',
            marker: { color: SERIES[0] }, opacity: .85, nbinsx: 44 },
          { x: over, type: 'histogram', name: 'over the limit',
            marker: { color: LIMIT }, opacity: .85, nbinsx: 44 }
        ], {
          barmode: 'overlay', showlegend: true,
          shapes: [hline(limit, 'y')].map(sh => Object.assign(sh, {
            xref: 'x', yref: 'paper', x0: limit, x1: limit, y0: 0, y1: 1,
            line: { color: LIMIT, width: 1.6, dash: 'dash' } })),
          xaxis: Object.assign(theme().xaxis, { title: axisTitle(worst.metric) }),
          yaxis: Object.assign(theme().yaxis, { title: 'builds' })
        });
      }
    },

    optionsTable: {
      title: 'All options found',
      sub: 'Click a row to inspect it, vs to compare it, .ric to export it',
      render(node, ctx) { node.innerHTML = optionsTable(ctx); App.wireOptionsTable(node); }
    }
  };

  /* --------------------------------------------------------- the profiles */

  const PROFILES = [
    { id: 'design',      label: 'Design Review',
      panels: [['thrustCurve', 1], ['pressureKn', 1], ['crossSection', 2],
               ['specSheet', 1], ['marginBars', 1]] },
    { id: 'tradeoff',    label: 'Trade-off Explorer',
      panels: [['paretoFront', 1], ['populationCloud', 1], ['parallelCoords', 2],
               ['objectiveSpread', 1], ['optionsTable', 1]] },
    { id: 'diagnostics', label: 'Optimizer Diagnostics',
      panels: [['convergence', 1], ['constraintActivity', 1], ['grainCounts', 2],
               ['parity', 1], ['importance', 1]] },
    { id: 'compare',     label: 'Compare & Safety',
      panels: [['compareThrust', 2], ['specSheet', 1], ['grainFlux', 1],
               ['grainMach', 1], ['robustness', 1], ['robustnessSpread', 1],
               ['tornado', 2]] }
  ];

  /* ------------------------------------------------------------ fragments */

  function hline(y, axisRef) {
    return { type: 'line', xref: 'paper', x0: 0, x1: 1, yref: axisRef, y0: y, y1: y,
             line: { color: LIMIT, width: 1, dash: 'dot' } };
  }

  function axisTitle(key) {
    const u = metricUnit(key);
    return metricLabel(key) + (u ? ' (' + u + ')' : '');
  }

  function shortVar(name) {
    return name.replace('core_', 'core ').replace('exit_frac', 'exit')
               .replace('n_grains', 'grains').replace('_', ' ');
  }

  function parallelSVG(rows, vars, colourBy) {
    const W = 760, H = 312, padL = 26, padR = 26, padT = 48, padB = 46;
    const n = vars.length;
    const step = (W - padL - padR) / Math.max(n - 1, 1);
    const y0 = padT, y1 = H - padB;

    // Each axis gets its own scale; a shared one would flatten every
    // dimension whose range is small next to the largest.
    const scales = vars.map(v => {
      const values = rows.map(r => r[v]);
      let lo = Math.min(...values), hi = Math.max(...values);
      if (hi - lo < 1e-12) { hi = lo + 1; }
      return { lo, hi };
    });
    const cValues = rows.map(r => metricValue(r, colourBy));
    const cLo = Math.min(...cValues), cHi = Math.max(...cValues);
    const colourAt = v => {
      const t = (cHi - cLo) < 1e-12 ? 1 : (v - cLo) / (cHi - cLo);
      return RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))];
    };
    const shown = rows.length > 700 ? rows.filter((_, i) => i % Math.ceil(rows.length / 700) === 0) : rows;

    let lines = '';
    shown.forEach(r => {
      const pts = vars.map((v, i) => {
        const s = scales[i];
        const y = y1 - ((r[v] - s.lo) / (s.hi - s.lo)) * (y1 - y0);
        return (padL + i * step).toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
      lines += `<polyline points="${pts}" fill="none" stroke="${colourAt(metricValue(r, colourBy))}"
                stroke-width="0.9" opacity="0.42"/>`;
    });

    let axes = '';
    vars.forEach((v, i) => {
      const x = (padL + i * step).toFixed(1);
      const s = scales[i];
      // Cores, throat and lengths are metres; the exit is a fraction and the
      // grain count is a count. Only the lengths change with the unit system.
      const fmt = q => v === 'exit_frac' ? q.toFixed(2)
                     : v === 'n_grains' ? String(Math.round(q))
                     : (q / App.unitScale()).toFixed(App.lenDigits());
      axes += `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" stroke="var(--line)" stroke-width="1"/>
        <text x="${x}" y="${y0 - 9}" font-size="8.5" fill="var(--ink-3)" text-anchor="middle"
          font-family="ui-monospace, monospace">${fmt(s.hi)}</text>
        <text x="${x}" y="${y1 + 13}" font-size="8.5" fill="var(--ink-3)" text-anchor="middle"
          font-family="ui-monospace, monospace">${fmt(s.lo)}</text>
        <text x="${x}" y="${y1 + 30}" font-size="9.5" fill="var(--ink-2)" text-anchor="middle"
          font-family="system-ui, sans-serif">${shortVar(v)}</text>`;
    });

    const keyX = padL + 34;
    const swatches = RAMP.map((c, i) =>
      `<rect x="${(keyX + i * 14).toFixed(0)}" y="10" width="13" height="6" fill="${c}"/>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
      aria-label="Parallel coordinates of legal designs">${lines}${axes}${swatches}
      <text x="${keyX - 5}" y="16" font-size="8.5" fill="var(--ink-3)" text-anchor="end"
        font-family="system-ui, sans-serif">worse</text>
      <text x="${keyX + RAMP.length * 14 + 5}" y="16" font-size="8.5" fill="var(--ink-3)"
        font-family="system-ui, sans-serif">better</text></svg>`;
  }

  function crossSectionSVG(design, baseline) {
    const d = design || baseline;
    if (!d || !d.cores) return '<p class="sub">No geometry.</p>';
    const lengths = d.grain_lengths || d.cores.map(() => 0.1524);
    const bore = d.grain_diameter || 0.0822;
    const total = lengths.reduce((a, b) => a + b, 0) + d.throat * 4;
    const W = 640, H = 190, pad = 14;
    const sx = (W - 2 * pad) / total, sy = (H - 2 * pad) / bore;
    const s = Math.min(sx, sy);
    const cy = H / 2;
    let x = pad, out = '';
    d.cores.forEach((core, i) => {
      const L = lengths[i] * s, R = bore * s / 2, r = core * s / 2;
      out += `<rect x="${x.toFixed(1)}" y="${(cy - R).toFixed(1)}" width="${L.toFixed(1)}"
              height="${(R - r).toFixed(1)}" fill="var(--accent)" opacity="0.82"/>`;
      out += `<rect x="${x.toFixed(1)}" y="${(cy + r).toFixed(1)}" width="${L.toFixed(1)}"
              height="${(R - r).toFixed(1)}" fill="var(--accent)" opacity="0.82"/>`;
      out += `<line x1="${x.toFixed(1)}" y1="${(cy - R).toFixed(1)}" x2="${x.toFixed(1)}"
              y2="${(cy + R).toFixed(1)}" stroke="var(--surface)" stroke-width="1.5"/>`;
      out += `<text x="${(x + L / 2).toFixed(1)}" y="${(cy + R + 12).toFixed(1)}"
              font-size="8.5" fill="var(--ink-3)" text-anchor="middle"
              font-family="ui-monospace, monospace">${App.fmtLen(core)}</text>`;
      x += L;
    });
    // nozzle: convergent cone into the throat, then the exit cone
    const R = bore * s / 2, rt = d.throat * s / 2, re = d.exit * s / 2;
    const conv = d.throat * 1.6 * s, div = d.throat * 2.6 * s;
    out += `<polygon points="${x},${cy - R} ${x + conv},${cy - rt} ${x + conv + div},${cy - re}
            ${x + conv + div},${cy + re} ${x + conv},${cy + rt} ${x},${cy + R}"
            fill="var(--ink-3)" opacity="0.55"/>`;
    out += `<line x1="${pad}" y1="${cy}" x2="${(x + conv + div).toFixed(1)}" y2="${cy}"
            stroke="var(--ink-3)" stroke-dasharray="3 3" stroke-width="0.8" opacity="0.6"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
      aria-label="Motor cross-section, forward at left">${out}</svg>
      <p class="cross-cap">Throat ${App.fmtLen(d.throat)} &middot;
      exit ${App.fmtLen(d.exit)} &middot; expansion ${(d.exit / d.throat * d.exit / d.throat).toFixed(2)}</p>`;
  }

  const SPEC_ROWS = [
    ['n_grains', 'Grains', '', 0],
    ['initial_thrust', 'Initial thrust', 'N', 0],
    ['total_impulse', 'Total impulse', 'N·s', 0],
    ['peak_thrust', 'Peak thrust', 'N', 0],
    ['isp', 'Specific impulse', 's', 1],
    ['burn_time', 'Burn time', 's', 2],
    ['max_pressure', 'Peak pressure', null, null],
    ['initial_kn', 'Initial Kn', '', 0],
    ['peak_kn', 'Peak Kn', '', 0],
    ['peak_mass_flux', 'Peak mass flux', null, null],
    ['peak_mach', 'Peak core Mach', 'M', 2],
    ['port_throat', 'Port/throat', '', 2],
    ['prop_mass', 'Propellant', 'kg', 3],
    ['residual_pct', 'Residual propellant', '%', 2]
  ];

  function grainCountTable(info, ctx) {
    const labels = ((App.state.results || {}).stats || {}).objective_labels || [];
    const multi = labels.length > 1;
    const live = (info.stacks || []).filter(s => !s.dropped).length;
    const rows = (info.stacks || []).map(s => {
      const s1 = s.stage1 || {};
      let outcome, why, cls = '';
      if (s.dropped) { outcome = 'screened out'; why = s.dropped; }
      else if (s.carried) {
        outcome = 'searched in full'; cls = 'pick';
        why = `${s.designs} legal design${s.designs === 1 ? '' : 's'}`;
      } else {
        outcome = 'tried, not carried';
        why = s1.rank ? `ranked ${s1.rank} of ${live} after ${info.stage_generations} generations` : '';
      }
      const score = s1.score !== null && s1.score !== undefined ? s1.score.toFixed(3)
        : (s1.near !== null && s1.near !== undefined ? 'no legal design' : '—');
      return `<tr class="${cls}"><td class="n">${s.n}</td>
        <td class="n">${App.fmtLen(s.grain_length)}</td>
        <td>${outcome}</td><td class="n">${score}</td>
        <td class="why">${why}</td><td class="n">${(s.simulations || 0).toLocaleString()}</td></tr>`;
    }).join('');
    return `<div style="overflow-x:auto"><table class="data-table">
      <thead><tr><th class="n">grains</th><th class="n">length</th><th>outcome</th>
      <th class="n">${multi ? 'hypervolume' : 'best score'}</th><th></th>
      <th class="n">sims</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="sub">Score is after the first ${info.stage_generations} generations, on the
      same axes for every count. The ${App.fmtLen(info.stack_length)} stack length
      was held throughout.</p></div>`;
  }

  function deltaTable(design, baseline) {
    if (!design) return '<p class="sub">Run the optimizer to compare.</p>';
    const rows = SPEC_ROWS.map(([key, label, fixedUnit, fixedDp]) => {
      if (design[key] === undefined || design[key] === null) return '';
      // A null unit means the row follows the chosen system.
      const unit = fixedUnit === null ? metricUnit(key) : fixedUnit;
      const dp = fixedDp === null ? App.metricDigits(key) : fixedDp;
      const a = baseline && baseline[key] !== undefined ? metricValue(baseline, key) : null;
      const b = metricValue(design, key);
      let delta = '';
      if (a) {
        const pct = (b / a - 1) * 100;
        const cls = Math.abs(pct) < 0.05 ? '' : (pct > 0 ? 'pos' : 'neg');
        delta = `<td class="n ${cls}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</td>`;
      } else delta = '<td class="n"></td>';
      return `<tr><td>${label}</td>
        <td class="n">${a !== null && a !== undefined ? a.toFixed(dp) : '—'}</td>
        <td class="n" style="font-weight:650">${b.toFixed(dp)}</td>${delta}
        <td style="color:var(--ink-3)">${unit}</td></tr>`;
    }).join('');
    return `<div style="overflow-x:auto"><table class="data-table">
      <thead><tr><th></th><th class="n">yours</th><th class="n">optimized</th>
      <th class="n">Δ</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function marginRow(c, design) {
    const key = { max_pressure: 'max_pressure', peak_mass_flux: 'peak_mass_flux' }[c.metric] || c.metric;
    let value = design[key];
    if (value === undefined || value === null) return '';
    const limit = c.value;
    const ratio = c.op === '<=' ? value / limit : limit / Math.max(value, 1e-9);
    const pct = Math.max(0, Math.min(ratio, 1.35)) * 100;
    const cls = ratio > 1.0005 ? 'over' : (ratio > 0.97 ? 'close' : '');
    const shown = metricValue(design, c.metric);
    const limitShown = App.metricToDisplay(c.metric, limit);
    const dp = limitShown < 10 ? 3 : 0;
    return `<div class="margin-row">
      <span class="label">${c.label || metricLabel(c.metric)}</span>
      <span class="track"><span class="bar ${cls}" style="width:${Math.min(pct, 100).toFixed(1)}%"></span></span>
      <span class="value">${shown.toFixed(dp)} / ${limitShown.toFixed(dp)}</span></div>`;
  }

  function optionsTable(ctx) {
    const designs = ctx.designs || [];
    if (!designs.length) return '<p class="sub">No feasible designs found.</p>';
    const [ax, ay] = ctx.axes;
    const b = ctx.baseline;
    const counted = !!(ctx.grainCounts && ctx.grainCounts.free);
    const U = App.units();
    // Rows keep their original index so a click still selects the right design.
    const sort = App.state.optionSort || { key: 'rank', dir: 1 };
    const value = (d, key) => key === 'rank' ? d._rank : (d[key] === undefined ? null : +d[key]);
    const order = designs.map((d, i) => Object.assign({}, d, { _i: i, _rank: i + 1 }));
    order.sort((p, q) => {
      const a = value(p, sort.key), c = value(q, sort.key);
      if (a === null || c === null) return (a === null) - (c === null);
      return (a - c) * sort.dir || p._rank - q._rank;
    });
    const rows = order.map(d => {
      const i = d._i;
      const pct = v => b && b[v] ? ((d[v] / b[v] - 1) * 100) : null;
      const cell = v => {
        const p = pct(v);
        return p === null ? '<td class="n"></td>' :
          `<td class="n ${p >= 0 ? 'pos' : 'neg'}">${p >= 0 ? '+' : ''}${p.toFixed(2)}%</td>`;
      };
      const cls = (i === ctx.selected ? 'pick ' : '') + (i === ctx.compareIndex ? 'vs' : '');
      return `<tr class="clickable ${cls}" data-index="${i}">
        <td class="n">${d._rank}</td>
        <td>${d.designation || ('Option ' + (i + 1))}</td>
        ${counted ? `<td class="n">${d.n_grains || ''}</td>` : ''}
        <td class="n">${metricValue(d, ax).toFixed(0)}</td>${cell(ax)}
        <td class="n">${metricValue(d, ay).toFixed(0)}</td>${cell(ay)}
        <td class="n">${metricValue(d, 'max_pressure').toFixed(U.pressure.dp)}</td>
        <td class="n">${d.peak_kn.toFixed(0)}</td>
        <td class="n">${metricValue(d, 'peak_mass_flux').toFixed(U.mass_flux.dp)}</td>
        <td class="acts"><button class="chip" data-compare="${i}" title="Compare with the selected design">${i === ctx.compareIndex ? 'vs \u2713' : 'vs'}</button>
        <button class="chip" data-export="${i}">.ric</button></td></tr>`;
    }).join('');
    const th = (key, label) => {
      const on = sort.key === key;
      const mark = on ? (sort.dir > 0 ? ' \u25b4' : ' \u25be') : '';
      return `<th class="n sortable ${on ? 'on' : ''}" data-sort="${key}"
        title="Sort by ${label}">${label}${mark}</th>`;
    };
    return `<div style="overflow-x:auto;max-height:340px"><table class="data-table options">
      <thead><tr>${th('rank', '#')}<th>class</th>${counted ? th('n_grains', 'grains') : ''}
      ${th(ax, metricLabel(ax))}<th class="n">Δ</th>
      ${th(ay, metricLabel(ay))}<th class="n">Δ</th>
      ${th('max_pressure', U.pressure.label)}${th('peak_kn', 'Kn')}
      ${th('peak_mass_flux', 'flux')}<th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  /* ------------------------------------------------- the search, live */

  const LIVE = { ghosts: [], lastSeed: -1 };

  function resetLive() { LIVE.ghosts = []; LIVE.lastSeed = -1; }

  function liveFrame(node, snap, range) {
    const [ax, ay] = orderAxes(snap.metrics);
    // Every series arrives in the run's own metric order, so putting impulse on
    // the horizontal axis has to move the data as well as the labels.
    const flip = ax !== snap.metrics[0];
    const xy = p => flip ? [p[1], p[0], p[2]] : p;
    // A new seed starts somewhere else entirely; carrying its predecessor's
    // trail over would read as one search teleporting.
    if (snap.seed_index !== LIVE.lastSeed) { LIVE.ghosts = []; LIVE.lastSeed = snap.seed_index; }

    const points = snap.points.map(xy);
    const front = snap.front.map(xy);
    const baseline = snap.baseline ? xy(snap.baseline) : null;
    const feas = points.filter(p => p[2]);
    const infeas = points.filter(p => !p[2]);
    LIVE.ghosts.push(feas.map(p => [p[0], p[1]]));
    if (LIVE.ghosts.length > 14) LIVE.ghosts.shift();

    // Older generations fade out, so the population leaves a wake and you can
    // see which way the search is travelling.
    const trails = LIVE.ghosts.slice(0, -1).map((g, i) => ({
      x: g.map(p => p[0]), y: g.map(p => p[1]), mode: 'markers', type: 'scatter',
      marker: { size: 4, color: SERIES[0],
                opacity: 0.05 + 0.16 * (i / Math.max(LIVE.ghosts.length - 1, 1)) },
      hoverinfo: 'skip', showlegend: false
    }));

    const traces = trails.concat([
      { x: infeas.map(p => p[0]), y: infeas.map(p => p[1]), mode: 'markers',
        name: 'over a limit', type: 'scatter',
        marker: { size: 5, color: css('--ink-3'), opacity: .38 }, hoverinfo: 'skip' },
      { x: feas.map(p => p[0]), y: feas.map(p => p[1]), mode: 'markers',
        name: 'legal', type: 'scatter',
        marker: { size: 7, color: SERIES[0], opacity: .9,
                  line: { color: css('--surface'), width: 1 } }, hoverinfo: 'skip' },
      { x: baseline ? [baseline[0]] : [],
        y: baseline ? [baseline[1]] : [],
        mode: 'markers', name: 'your motor', type: 'scatter',
        marker: { size: 11, color: LIMIT, symbol: 'diamond',
                  line: { color: css('--surface'), width: 1.5 } }, hoverinfo: 'skip' },
      { x: front.map(p => p[0]), y: front.map(p => p[1]),
        mode: 'lines+markers', name: 'best so far', type: 'scatter',
        line: { color: SERIES[1], width: 2 },
        marker: { size: 7, color: SERIES[1], line: { color: css('--surface'), width: 1 } },
        hoverinfo: 'skip' }
    ]);

    const already = node.data && node.data.length;
    const layout = fixTitles(Object.assign(theme(), {
      showlegend: true,
      margin: { l: 70, r: 18, t: 8, b: 52 },
      uirevision: 'live-' + App.state.unit,
      dragmode: 'pan',
      xaxis: Object.assign(theme().xaxis, { title: axisTitle(ax) }),
      yaxis: Object.assign(theme().yaxis, { title: axisTitle(ay) })
    }));
    // The range is set once, on the first frame. Re-sending it every frame
    // fought the user's own pan: the drag applied, the next frame put the
    // stored range back, and uirevision then re-applied the drag -- which is
    // the jump back and forth. After that first frame the axes belong to the
    // user, and uirevision alone carries them across updates.
    if (!already) {
      if (range) { layout.xaxis.range = range.x; layout.yaxis.range = range.y; }
      Plotly.newPlot(node, traces, makeRoom(layout),
                     { displayModeBar: false, responsive: true, scrollZoom: true });
      return;
    }
    // Data only. Plotly.restyle leaves the axes untouched, so a drag in
    // progress is never interrupted by an arriving generation.
    Plotly.react(node, traces, makeRoom(layout),
                 { displayModeBar: false, responsive: true, scrollZoom: true });
  }

  function fitAxes(node, range) {
    if (!node || !range) return;
    Plotly.relayout(node, { 'xaxis.range': range.x.slice(),
                            'yaxis.range': range.y.slice() });
  }

  /* ------------------------------------------------- behaviour over time */

  //: One stacked row each, sharing the time axis. Every row names its own
  //: quantity and unit, and carries the limit that applies to it.
  const BEHAVIOUR = {
    thrust: { title: () => 'Thrust (N)', colour: SERIES[0],
              series: c => c.thrust, limits: [] },
    pressure: { title: () => 'Pressure (' + U().pressure.label + ')', colour: SERIES[1],
                series: c => c.pressure.map(v => v / U().pressure.scale),
                limits: ['max_pressure', 'avg_pressure'],
                scale: v => v / U().pressure.scale },
    kn: { title: () => 'Kn', colour: SERIES[2],
          series: c => c.kn, limits: ['peak_kn'], scale: v => v },
    mass_flux: { title: () => 'Mass flux (' + U().mass_flux.label + ')', colour: LIMIT,
                 // Per grain in openMotor; the limit applies to the worst one.
                 series: c => worstFlux(c), limits: ['peak_mass_flux'],
                 scale: v => v / U().mass_flux.scale }
  };

  function worstFlux(c) {
    const grains = (c.mass_flux || []).filter(g => g && g.length);
    if (!grains.length) return [];
    const scale = U().mass_flux.scale;
    return c.time.map((_, i) =>
      Math.max.apply(null, grains.map(g => (g[i] || 0) / scale)));
  }

  //: One axis, thrust, with the rest drawn against it. Each curve is scaled to
  //: the thrust range so the shapes are comparable; the tooltip and the legend
  //: both carry the real value, so nothing has to be read off the axis.
  function behaviourStack(node, c, constraints, keys) {
    if (!c || !c.time || !c.time.length) { node.innerHTML = ''; return; }
    const rows = keys.filter(k => BEHAVIOUR[k] && BEHAVIOUR[k].series(c).length);
    if (!rows.length) { node.innerHTML = ''; return; }

    const series = {};
    rows.forEach(k => { series[k] = BEHAVIOUR[k].series(c); });
    const peak = arr => Math.max.apply(null, arr.map(Math.abs)) || 1;
    const anchor = series.thrust ? peak(series.thrust) : peak(series[rows[0]]);

    const t = theme();
    const traces = rows.map(key => {
      const row = BEHAVIOUR[key], data = series[key];
      const title = row.title();
      const top = peak(data);
      const scale = key === 'thrust' ? 1 : anchor / top;
      const unit = title.replace(/^[^(]*\(?|\)$/g, '') || '';
      return {
        x: c.time, y: data.map(v => v * scale), customdata: data,
        mode: 'lines', line: { color: row.colour, width: 2 },
        name: key === 'thrust' ? title
          : title + '  \u2022  peak ' + fmtNum(top),
        hovertemplate: '%{customdata:,.4~r} ' + unit + '<extra></extra>'
      };
    });

    const shapes = [];
    (constraints || []).forEach(con => {
      const key = rows.find(k => BEHAVIOUR[k].limits.indexOf(con.metric) >= 0);
      if (!key) return;
      const scale = key === 'thrust' ? 1 : anchor / peak(series[key]);
      shapes.push(hline(BEHAVIOUR[key].scale(con.value) * scale, 'y'));
    });

    draw(node, traces, {
      showlegend: true,
      hovermode: 'x unified',
      shapes,
      xaxis: Object.assign({}, t.xaxis, { title: 'Time (s)' }),
      yaxis: Object.assign({}, t.yaxis, { title: 'Thrust (N)', rangemode: 'tozero' })
    });
  }

  function fmtNum(v) {
    if (v >= 1000) return Math.round(v).toLocaleString();
    if (v >= 10) return v.toFixed(0);
    return v.toFixed(v < 1 ? 3 : 2);
  }

  /* -------------------------------------------------- the running screen */

  //: A 240-degree sweep, drawn rather than plotted: Plotly has no gauge that
  //: reads at a glance in a box this size. The reading sits under the dial
  //: rather than inside it, so the needle never crosses its own number.
  //: Fixed 0-100 scale. A ceiling that moved with the reading made the needle
  //: meaningless and let it run off the end.
  const SPEED_MAX = 100;

  function speedometer(node, value, label) {
    const ceiling = SPEED_MAX;
    const W = 180, H = 116, cx = 90, cy = 86, r = 66;
    const START = 210, SWEEP = 240;            // clockwise, both ends below level
    const frac = Math.max(0, Math.min(value / (ceiling || 1), 1));
    const pt = (deg, rad) => {
      const a = deg * Math.PI / 180;
      return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)];
    };
    const arc = (from, to, rad) => {
      const [x0, y0] = pt(from, rad), [x1, y1] = pt(to, rad);
      return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${rad} ${rad} 0 ${
        Math.abs(to - from) > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    };
    const end = START - SWEEP, now = START - SWEEP * frac;
    let ticks = '';
    for (let i = 0; i <= 4; i++) {
      const deg = START - SWEEP * i / 4;
      const [x0, y0] = pt(deg, r - 10), [x1, y1] = pt(deg, r - 3);
      const [lx, ly] = pt(deg, r - 20);
      ticks += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}"
        x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"
        stroke="var(--ink-3)" stroke-width="1.2" opacity=".45"/>
        <text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="middle"
          font-family="ui-monospace, monospace" font-size="7.5"
          fill="var(--ink-3)">${(SPEED_MAX * i / 4).toFixed(0)}</text>`;
    }
    const [nx, ny] = pt(now, r - 27);
    node.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
      aria-label="${label}: ${value.toFixed(1)}">
      <path d="${arc(START, end, r)}" fill="none" stroke="var(--line)"
        stroke-width="8" stroke-linecap="round"/>
      <path d="${arc(START, now, r)}" fill="none" stroke="var(--accent)"
        stroke-width="8" stroke-linecap="round"/>
      ${ticks}
      <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"
        stroke="var(--ink)" stroke-width="2.2" stroke-linecap="round"
        class="gauge-needle"/>
      <circle cx="${cx}" cy="${cy}" r="4.5" fill="var(--ink)"/>
      <circle cx="${cx}" cy="${cy}" r="2" fill="var(--surface)"/>
    </svg>
    <div class="gauge-read"><span class="n">${value ? value.toFixed(1) : '\u2014'}</span>
      <span class="u">${label}</span></div>`;
  }

  //: Which limit is stopping designs right now. More useful than a spread:
  //: it says what is shaping the search, not merely that it is running.
  function liveBlocking(node, snap) {
    const rows = (snap && snap.blocking) || [];
    if (!rows.length) { node.innerHTML = ''; return; }
    const sorted = rows.slice().sort((a, b) => b.share - a.share);
    node.innerHTML = sorted.map(r => {
      const pct = Math.round(r.share * 100);
      return `<div class="block-row">
        <span class="k">${metricLabel(r.metric)}</span>
        <span class="bar"><span class="fill${pct > 60 ? ' hot' : ''}"
          style="width:${pct}%"></span></span>
        <span class="v">${pct}%</span></div>`;
    }).join('') +
      `<p class="sub">Share of this generation that each limit rules out. A limit
       near 100% is the one the search is fighting.</p>`;
  }

  function liveSpark(node, trace) {
    if (!trace || trace.length < 2) { node.innerHTML = ''; return; }
    const running = [];
    let best = -Infinity;
    trace.forEach(t => { best = Math.max(best, t.a); running.push(best); });
    // Best-so-far only ever climbs, and it climbs within a narrow band. Filling
    // to zero would paint the whole box solid and hide every step.
    const lo = Math.min(...running), hi = Math.max(...running);
    const pad = Math.max((hi - lo) * 0.18, Math.abs(hi) * 0.004, 1e-6);
    Plotly.react(node, [{
      y: running, mode: 'lines', type: 'scatter',
      line: { color: SERIES[1], width: 2, shape: 'hv' }, hoverinfo: 'skip'
    }], Object.assign(theme(), {
      margin: { l: 0, r: 0, t: 6, b: 6 }, showlegend: false,
      xaxis: { visible: false },
      yaxis: { visible: false, range: [lo - pad, hi + pad] }
    }), { displayModeBar: false, responsive: true, staticPlot: true });
  }

  return { PANELS, PROFILES, theme, draw, metricValue, metricLabel, axisTitle,
           liveFrame, liveSpark, resetLive, orderAxes, behaviourStack,
           speedometer, liveBlocking, fitAxes,
           crossSectionSVG, parallelSVG, deltaTable };
})();
