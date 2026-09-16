/**
 * The editor GUI. Deliberately dependency-free: it is a local tool whose value
 * is in the store and the renderer, and a build step for the front end would be
 * one more thing to keep working.
 *
 * The central idea on screen: you are never editing a document, you are picking
 * among phrasings that already exist. Every dropdown here is a `choice` written
 * back to a small YAML file.
 */

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) node.append(c);
  return node;
};

const state = {
  store: null,
  resumeId: null,
  /** Working copy of the selected resume's choices, before saving. */
  choices: {},
  dirty: false,
};

/* ------------------------------------------------------------------ */

function setStatus(text, isError = false) {
  const s = $('#status');
  s.textContent = text;
  s.className = isError ? 'status err' : 'status';
  if (text && !isError) setTimeout(() => (s.textContent === text ? (s.textContent = '') : null), 3000);
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/* ------------------------------------------------------------------ *
 * Build tab                                                           *
 * ------------------------------------------------------------------ */

/** The effective spec for the selected resume, with unsaved choices applied. */
function currentSpec() {
  const base = state.store.resumes.find((r) => r.id === state.resumeId);
  return { ...base, choices: { ...(base.choices ?? {}), ...state.choices } };
}

/**
 * Resolve inherited choices for display. The server owns real resolution; this
 * only needs to know which variant a dropdown should show as selected.
 */
function effectiveChoices() {
  const chain = [];
  let spec = state.store.resumes.find((r) => r.id === state.resumeId);
  while (spec) {
    chain.unshift(spec);
    spec = spec.extends ? state.store.resumes.find((r) => r.id === spec.extends) : null;
  }
  return Object.assign({}, ...chain.map((s) => s.choices ?? {}), state.choices);
}

function variantSelect(key, field, current, inheritedFrom) {
  const select = el('select');
  for (const v of field.variants) {
    const tags = v.tags?.length ? ` · ${v.tags.join(', ')}` : '';
    const flag = v.suggested ? ' · AI-suggested' : '';
    select.append(
      el('option', {
        value: v.id,
        textContent: `${v.label}${tags}${flag}`,
        selected: v.id === current,
      }),
    );
  }
  select.onchange = () => {
    state.choices[key] = select.value;
    state.dirty = true;
    setStatus('Changed — press Preview to recompile');
    render();
  };

  const row = el('div', { className: 'variant-row' }, [select]);
  const chosen = field.variants.find((v) => v.id === current);
  if (chosen?.note) row.append(el('span', { className: 'hint', textContent: chosen.note }));
  if (inheritedFrom && !(key in state.choices)) {
    row.append(el('span', { className: 'hint', textContent: `inherited` }));
  }
  return row;
}

function renderEditor() {
  const editor = $('#editor');
  editor.replaceChildren();
  if (!state.store || !state.resumeId) return;

  const choices = effectiveChoices();
  const spec = state.store.resumes.find((r) => r.id === state.resumeId);
  const sections = resolveSections(spec);

  for (const section of sections) {
    editor.append(el('div', { className: 'section-heading', textContent: section.kind }));

    if (section.kind === 'skills') {
      for (const gid of section.groups ?? []) {
        const group = state.store.skillGroups.find((g) => g.id === gid);
        if (!group) continue;
        const picked = section.items?.[gid] ?? group.items.map((i) => i.id);
        const box = el('div', { className: 'entry' });
        box.append(
          el('header', {}, [
            el('span', { className: 'title', textContent: group.name }),
            el('span', { className: 'id', textContent: gid }),
          ]),
        );
        for (const item of group.items) {
          const on = picked.includes(item.id);
          const cb = el('input', { type: 'checkbox', checked: on });
          cb.onchange = () => {
            // Skill inclusion lives on the section, not in `choices`, so it is
            // tracked separately and written on save.
            state.skillEdits ??= {};
            const cur = new Set(state.skillEdits[gid] ?? picked);
            cb.checked ? cur.add(item.id) : cur.delete(item.id);
            state.skillEdits[gid] = [...cur];
            state.dirty = true;
            setStatus('Changed — press Preview to recompile');
          };
          box.append(el('label', { className: 'field' }, [cb, ' ', item.text]));
        }
        editor.append(box);
      }
      continue;
    }

    for (const eid of section.entries ?? []) {
      const entry = state.store.entries.find((e) => e.id === eid);
      if (!entry) continue;

      const box = el('div', { className: 'entry' });
      box.append(
        el('header', {}, [
          el('span', { className: 'title', textContent: plain(entry.title, choices, `${entry.id}.title`) }),
          el('span', { className: 'id', textContent: entry.id }),
        ]),
      );

      // Fields that carry alternates — graduation date is the one that matters.
      for (const f of ['title', 'dates', 'subtitle', 'location']) {
        const field = entry[f];
        if (!field || typeof field === 'string' || !Array.isArray(field.variants)) continue;
        const key = `${entry.id}.${f}`;
        box.append(
          el('div', { className: 'field' }, [
            el('div', { className: 'hint', textContent: f }),
            variantSelect(key, field, choices[key] ?? field.default, true),
          ]),
        );
      }

      for (const bullet of entry.bullets ?? []) {
        if (bullet.archived) continue;
        const key = bullet.id;
        const chosenId = choices[key] ?? bullet.default;
        const chosen = bullet.variants.find((v) => v.id === chosenId) ?? bullet.variants[0];

        const included = (section.bullets?.[entry.id] ?? (entry.bullets ?? []).map((b) => b.id)).includes(bullet.id);
        const wrap = el('div', { className: `bullet${included ? '' : ' excluded'}` });
        wrap.append(el('div', { className: 'text', textContent: chosen?.text ?? '(no phrasings)' }));

        const row = variantSelect(key, bullet, chosenId, true);
        row.append(
          el('button', {
            textContent: 'Feedback',
            onclick: () => askBulletFeedback(entry.id, bullet.id),
          }),
          el('button', {
            textContent: '+ phrasing',
            title: 'Add another way of saying this, available to every resume',
            onclick: () => addVariant(entry.id, bullet.id),
          }),
        );
        wrap.append(row);
        box.append(wrap);
      }
      editor.append(box);
    }
  }
}

/** Flatten a spec's section list through its `extends` chain. */
function resolveSections(spec) {
  const chain = [];
  let cur = spec;
  while (cur) {
    chain.unshift(cur);
    cur = cur.extends ? state.store.resumes.find((r) => r.id === cur.extends) : null;
  }
  let sections = [];
  for (const s of chain) {
    if (!s.sections?.length) continue;
    const next = sections.map((base) => s.sections.find((o) => o.kind === base.kind) ?? base);
    for (const o of s.sections) if (!next.some((x) => x.kind === o.kind)) next.push(o);
    sections = next;
  }
  return sections;
}

function plain(field, choices, key) {
  if (!field) return '';
  if (typeof field === 'string') return field;
  const id = choices[key] ?? field.default;
  return (field.variants.find((v) => v.id === id) ?? field.variants[0])?.text ?? '';
}

/* ------------------------------------------------------------------ *
 * Actions                                                             *
 * ------------------------------------------------------------------ */

async function renderPreview() {
  const fit = $('#fit');
  fit.className = 'fit idle';
  fit.textContent = 'Compiling…';
  try {
    const spec = currentSpec();
    applySkillEdits(spec);
    const result = await api('/render', { method: 'POST', body: JSON.stringify({ spec }) });

    $('#preview').src = result.pdfUrl;
    fit.className = result.fits ? 'fit' : 'fit bad';
    fit.replaceChildren(
      document.createTextNode(
        result.fits
          ? `Fits on one page${result.overflowPt < 0 ? ` — about ${Math.abs(result.overflowLines)} line(s) of room left` : ''}`
          : `${result.pages} pages — over by about ${result.overflowLines} line(s). Pick a shorter phrasing or drop a bullet.`,
      ),
    );
    if (result.adjustments.length) {
      fit.append(el('span', { className: 'adj', textContent: ` · auto-fit: ${result.adjustments.join('; ')}` }));
    }

    const warn = $('#warnings');
    warn.replaceChildren(...(result.warnings ?? []).map((w) => el('div', { textContent: `! ${w}` })));
  } catch (err) {
    fit.className = 'fit bad';
    fit.textContent = err.message;
  }
}

function applySkillEdits(spec) {
  if (!state.skillEdits) return;
  const sections = resolveSections(spec);
  const skills = sections.find((s) => s.kind === 'skills');
  if (!skills) return;
  spec.sections = [{ ...skills, items: { ...(skills.items ?? {}), ...state.skillEdits } }];
}

/** Save the current mix as a new resume that inherits from the current one. */
async function saveAsVariation() {
  const id = await prompt2('Save as variation', [
    { name: 'id', label: 'Id (filename)', value: `${state.resumeId}-variant` },
    { name: 'label', label: 'Label', value: `${state.resumeId} variation` },
  ]);
  if (!id) return;

  const spec = {
    id: id.id.trim(),
    label: id.label.trim(),
    extends: state.resumeId,
    choices: { ...state.choices },
  };
  applySkillEdits(spec);

  await api(`/resumes/${encodeURIComponent(spec.id)}`, { method: 'PUT', body: JSON.stringify(spec) });
  setStatus(`Saved ${spec.id}`);
  state.choices = {};
  state.skillEdits = null;
  state.dirty = false;
  await loadStore();
  state.resumeId = spec.id;
  render();
}

async function askFeedback() {
  showModal('Feedback', el('p', { textContent: 'Asking the configured AI…' }));
  try {
    const result = await api('/ai/feedback', {
      method: 'POST',
      body: JSON.stringify({ resumeId: state.resumeId }),
    });
    showModal(
      result.executed ? 'Feedback' : 'AI is disabled — here is the prompt',
      el('pre', { textContent: result.output }),
    );
  } catch (err) {
    showModal('Feedback failed', el('pre', { textContent: err.message }));
  }
}

async function askBulletFeedback(entryId, bulletId) {
  showModal('Feedback', el('p', { textContent: 'Asking the configured AI…' }));
  try {
    const result = await api('/ai/feedback', { method: 'POST', body: JSON.stringify({ entryId, bulletId }) });
    showModal(
      result.executed ? `Feedback on ${bulletId}` : 'AI is disabled — here is the prompt',
      el('pre', { textContent: result.output }),
    );
  } catch (err) {
    showModal('Feedback failed', el('pre', { textContent: err.message }));
  }
}

/** Add a phrasing to a bullet — available to every resume immediately. */
async function addVariant(entryId, bulletId) {
  const answer = await prompt2(`New phrasing for ${bulletId}`, [
    { name: 'label', label: 'Label', value: '' },
    { name: 'text', label: 'Text', value: '', multiline: true },
    { name: 'tags', label: 'Tags (comma separated)', value: '' },
  ]);
  if (!answer?.text?.trim()) return;

  await api(`/entries/${encodeURIComponent(entryId)}/bullets/${encodeURIComponent(bulletId)}/variants`, {
    method: 'POST',
    body: JSON.stringify({
      label: answer.label || 'New phrasing',
      text: answer.text,
      tags: answer.tags ? answer.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
    }),
  });
  setStatus('Phrasing added');
  await loadStore();
  render();
}

/* ------------------------------------------------------------------ *
 * Applications tab                                                    *
 * ------------------------------------------------------------------ */

async function loadApplications() {
  const { applications, stats } = await api('/applications');

  $('#stats').replaceChildren(
    ...[
      ['Total', stats.total],
      ['Last 7 days', stats.last7],
      ['Last 30 days', stats.last30],
      ['Response rate', `${stats.responseRate}%`],
    ].map(([label, value]) =>
      el('div', { className: 'stat' }, [el('b', { textContent: String(value) }), el('span', { textContent: label })]),
    ),
  );

  const statuses = ['interested', 'applied', 'oa', 'interview', 'offer', 'rejected', 'ghosted', 'withdrawn'];
  const body = $('#apps tbody');
  body.replaceChildren(
    ...[...applications]
      .sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))
      .map((a) => {
        const sel = el('select');
        for (const s of statuses) {
          sel.append(el('option', { value: s, textContent: s, selected: s === a.status }));
        }
        sel.onchange = async () => {
          await api(`/applications/${encodeURIComponent(a.id)}/status`, {
            method: 'POST',
            body: JSON.stringify({ status: sel.value }),
          });
          setStatus('Updated');
          loadApplications();
        };
        return el('tr', {}, [
          el('td', { textContent: a.appliedAt?.slice(0, 10) ?? '' }),
          el('td', { textContent: a.company }),
          el('td', { textContent: a.role }),
          el('td', {}, [sel]),
          el('td', { textContent: a.resumeId ?? '' }),
          el('td', { className: 'hint', textContent: a.snapshotDir ?? '' }),
        ]);
      }),
  );
}

async function addApplication() {
  const answer = await prompt2('Record an application', [
    { name: 'company', label: 'Company', value: '' },
    { name: 'role', label: 'Role', value: '' },
    { name: 'url', label: 'URL', value: '' },
    { name: 'notes', label: 'Notes', value: '', multiline: true },
  ]);
  if (!answer?.company || !answer?.role) return;
  await api('/applications', {
    method: 'POST',
    body: JSON.stringify({ ...answer, resumeId: state.resumeId }),
  });
  loadApplications();
}

/* ------------------------------------------------------------------ *
 * Modal helpers                                                       *
 * ------------------------------------------------------------------ */

function showModal(title, content) {
  $('#modal-title').textContent = title;
  $('#modal-content').replaceChildren(content);
  $('#modal-cancel').style.display = 'none';
  $('#modal').classList.remove('hidden');
  $('#modal-ok').onclick = () => $('#modal').classList.add('hidden');
}

/** A small form modal, since `prompt()` cannot ask for several fields. */
function prompt2(title, fields) {
  return new Promise((resolve) => {
    const inputs = {};
    const content = el('div');
    for (const f of fields) {
      content.append(el('div', { className: 'hint', textContent: f.label }));
      const input = f.multiline
        ? el('textarea', { value: f.value, style: 'min-height:90px' })
        : el('input', { type: 'text', value: f.value });
      inputs[f.name] = input;
      content.append(input);
    }

    $('#modal-title').textContent = title;
    $('#modal-content').replaceChildren(content);
    $('#modal-cancel').style.display = '';
    $('#modal').classList.remove('hidden');

    const close = (value) => {
      $('#modal').classList.add('hidden');
      resolve(value);
    };
    $('#modal-ok').onclick = () =>
      close(Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value])));
    $('#modal-cancel').onclick = () => close(null);
  });
}

/* ------------------------------------------------------------------ *
 * Boot                                                                *
 * ------------------------------------------------------------------ */

function render() {
  const select = $('#resume-select');
  if (select.options.length !== state.store.resumes.length) {
    select.replaceChildren(
      ...state.store.resumes.map((r) =>
        el('option', { value: r.id, textContent: `${r.label} (${r.id})`, selected: r.id === state.resumeId }),
      ),
    );
  }
  select.value = state.resumeId;
  renderEditor();
}

async function loadStore() {
  state.store = await api('/store');
  if (!state.resumeId || !state.store.resumes.some((r) => r.id === state.resumeId)) {
    state.resumeId = state.store.resumes.find((r) => r.id === 'newgrad')?.id ?? state.store.resumes[0]?.id ?? null;
  }
}

function setupTabs() {
  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.onclick = () => {
      for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b === btn);
      for (const t of document.querySelectorAll('.tab')) {
        t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`);
      }
      if (btn.dataset.tab === 'applications') loadApplications();
      if (btn.dataset.tab === 'voice') api('/voice').then(({ voice }) => ($('#voice').value = voice));
    };
  }
}

async function boot() {
  setupTabs();
  await loadStore();
  render();
  renderPreview();

  $('#resume-select').onchange = (e) => {
    state.resumeId = e.target.value;
    state.choices = {};
    state.skillEdits = null;
    state.dirty = false;
    render();
    renderPreview();
  };
  $('#btn-render').onclick = renderPreview;
  $('#btn-save-as').onclick = saveAsVariation;
  $('#btn-feedback').onclick = askFeedback;
  $('#btn-add-app').onclick = addApplication;
  $('#btn-master').onclick = async () => {
    setStatus('Compiling master…');
    const r = await api('/render', { method: 'POST', body: JSON.stringify({ master: true }) });
    $('#master-preview').src = r.pdfUrl;
    setStatus(`Master: ${r.pages} page(s)`);
  };
  $('#btn-save-voice').onclick = async () => {
    await api('/voice', { method: 'PUT', body: JSON.stringify({ voice: $('#voice').value }) });
    setStatus('Voice notes saved');
  };
}

boot().catch((err) => setStatus(err.message, true));
