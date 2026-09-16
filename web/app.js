/**
 * The editor GUI. Deliberately dependency-free: it is a local tool whose value
 * is in the store and the renderer, and a build step for the front end would be
 * one more thing to keep working.
 *
 * The idea on screen: you are never editing a document, you are picking among
 * phrasings that already exist — and adding to them should be one click from
 * wherever you noticed the gap.
 */

const $ = (sel) => document.querySelector(sel);

/** Build an element. `children` may contain strings, nodes, or null. */
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) if (c != null && c !== false) node.append(c);
  return node;
};

const state = {
  store: null,
  resumeId: null,
  /** Unsaved variant selections, layered over the resume's own. */
  choices: {},
  /** Unsaved skill-item selections, keyed by group id. */
  skillEdits: null,
  dirty: false,
};

/* ------------------------------------------------------------------ *
 * Plumbing                                                            *
 * ------------------------------------------------------------------ */

let statusTimer;
function setStatus(text, isError = false) {
  const s = $('#status');
  s.textContent = text;
  s.className = isError ? 'status err' : 'status';
  clearTimeout(statusTimer);
  if (text && !isError) {
    statusTimer = setTimeout(() => {
      if (s.textContent === text) s.textContent = '';
    }, 3500);
  }
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

/** "1 change" / "3 changes" — the `(s)` suffix reads like a form letter. */
function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Render the store's inline markup as real nodes. Raw `**asterisks**` on screen
 * were the single most obviously wrong thing about the first version.
 */
function markup(text) {
  const frag = document.createDocumentFragment();
  const re = /\*\*(.+?)\*\*|`(.+?)`|(?:^|(?<=[\s(]))\*([^*]+)\*(?=[\s).,;:]|$)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1] !== undefined) frag.append(el('strong', { textContent: m[1] }));
    else if (m[2] !== undefined) frag.append(el('span', { className: 'mono', textContent: m[2] }));
    else frag.append(el('em', { textContent: m[3] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/** Turn a label into a usable id fragment. */
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}

/* ------------------------------------------------------------------ *
 * Spec helpers                                                        *
 * ------------------------------------------------------------------ */

function resumeById(id) {
  return state.store.resumes.find((r) => r.id === id);
}

/** The `extends` chain, root first. */
function chain(id) {
  const out = [];
  let spec = resumeById(id);
  const seen = new Set();
  while (spec && !seen.has(spec.id)) {
    seen.add(spec.id);
    out.unshift(spec);
    spec = spec.extends ? resumeById(spec.extends) : null;
  }
  return out;
}

/** Choices as they resolve today, including unsaved edits. */
function effectiveChoices() {
  return Object.assign({}, ...chain(state.resumeId).map((s) => s.choices ?? {}), state.choices);
}

/** Flattened section list through the chain, child replacing parent by kind. */
function resolveSections(id = state.resumeId) {
  let sections = [];
  for (const spec of chain(id)) {
    if (!spec.sections?.length) continue;
    const next = sections.map((base) => spec.sections.find((o) => o.kind === base.kind) ?? base);
    for (const o of spec.sections) if (!next.some((x) => x.kind === o.kind)) next.push(o);
    sections = next;
  }
  return sections;
}

/** The spec to compile: the selected resume plus everything unsaved. */
function currentSpec() {
  const base = resumeById(state.resumeId);
  const spec = { ...base, choices: { ...(base.choices ?? {}), ...state.choices } };
  if (state.skillEdits) {
    const skills = resolveSections().find((s) => s.kind === 'skills');
    if (skills) spec.sections = [{ ...skills, items: { ...(skills.items ?? {}), ...state.skillEdits } }];
  }
  return spec;
}

function isVariantField(f) {
  return f && typeof f === 'object' && Array.isArray(f.variants);
}

function fieldText(field, choices, key) {
  if (field == null) return '';
  if (!isVariantField(field)) return String(field);
  const id = choices[key] ?? field.default;
  return String((field.variants.find((v) => v.id === id) ?? field.variants[0])?.text ?? '');
}

function markDirty(message = 'Changed — press Preview to recompile') {
  state.dirty = true;
  setStatus(message);
}

/* ------------------------------------------------------------------ *
 * Store mutations                                                     *
 * ------------------------------------------------------------------ */

async function saveEntry(entry, message) {
  await api(`/entries/${encodeURIComponent(entry.id)}`, { method: 'PUT', body: JSON.stringify(entry) });
  setStatus(message ?? `Saved ${entry.id}`);
  await loadStore();
  render();
}

async function saveResumeSpec(spec, message) {
  await api(`/resumes/${encodeURIComponent(spec.id)}`, { method: 'PUT', body: JSON.stringify(spec) });
  setStatus(message ?? `Saved ${spec.id}`);
  await loadStore();
}

/* ------------------------------------------------------------------ *
 * Build tab: the editor                                               *
 * ------------------------------------------------------------------ */

const SECTION_LABELS = {
  education: 'Education',
  experience: 'Experience',
  project: 'Projects',
  skills: 'Technical skills',
  custom: 'Additional',
};

const FIELD_LABELS = {
  title: 'Title',
  dates: 'Dates',
  subtitle: 'Role / degree / stack',
  location: 'Location',
};

/**
 * The dropdown that picks a phrasing, plus the affordances for adding to and
 * editing the set it is picking from.
 */
function variantPicker({ key, field, current, onAdd, onEdit, addLabel = '+ alternate', extraActions = [], trailingActions = [] }) {
  const select = el('select');
  for (const v of field.variants) {
    const tags = v.tags?.length ? ` · ${v.tags.join(', ')}` : '';
    select.append(
      el('option', {
        value: v.id,
        textContent: `${v.label}${tags}${v.suggested ? ' · unreviewed' : ''}`,
        selected: v.id === current,
      }),
    );
  }
  select.onchange = () => {
    state.choices[key] = select.value;
    markDirty();
    render();
  };

  // Order matters: status chips, then the two things you do most (edit the
  // wording, add another), then the incidental actions.
  const actions = el('div', { className: 'actions' });
  for (const a of extraActions) actions.append(a);
  if (onEdit) {
    actions.append(el('button', { className: 'tiny', textContent: 'Edit', title: 'Edit this wording', onclick: onEdit }));
  }
  if (onAdd) {
    actions.append(
      el('button', {
        className: 'link',
        textContent: addLabel,
        title: 'Add another way of saying this — available to every resume',
        onclick: onAdd,
      }),
    );
  }
  for (const a of trailingActions) actions.append(a);

  return el('div', { className: 'variant-row' }, [select, actions]);
}

/** Everything the user can do to one bullet, in one block. */
function bulletBlock(entry, bullet, choices, included) {
  const key = bullet.id;
  const chosenId = choices[key] ?? bullet.default;
  const chosen = bullet.variants.find((v) => v.id === chosenId) ?? bullet.variants[0];

  const wrap = el('div', { className: `bullet${included ? '' : ' dim'}` });
  const text = el('div', { className: 'text' });
  text.append(chosen ? markup(String(chosen.text)) : '(no phrasings yet)');
  wrap.append(text);

  const row = variantPicker({
    key,
    field: bullet,
    current: chosenId,
    addLabel: '+ phrasing',
    onAdd: () => addBulletVariant(entry, bullet),
    onEdit: chosen ? () => editVariant(entry, bullet, chosen) : null,
    extraActions: [
      el('span', {
        className: 'chip count',
        textContent: plural(bullet.variants.length, 'phrasing'),
        title: 'How many ways this point can be said',
      }),
      chosen?.suggested ? el('span', { className: 'chip suggested', textContent: 'unreviewed' }) : null,
      key in state.choices ? el('span', { className: 'chip overridden', textContent: 'changed' }) : null,
    ].filter(Boolean),
    trailingActions: [
      el('button', { className: 'tiny', textContent: 'Feedback', onclick: () => askBulletFeedback(entry.id, bullet.id) }),
      el('button', {
        className: 'tiny danger',
        textContent: 'Remove',
        title: 'Delete this bullet from the store',
        onclick: () => removeBullet(entry, bullet),
      }),
    ],
  });
  wrap.append(row);

  if (chosen?.note) wrap.append(el('div', { className: 'note', textContent: chosen.note }));
  return wrap;
}

function entryBlock(entry, section, choices) {
  const box = el('div', { className: 'entry' });

  const head = el('div', { className: 'entry-head' }, [
    el('span', { className: 'title', textContent: fieldText(entry.title, choices, `${entry.id}.title`) || entry.id }),
    el('span', { className: 'id', textContent: entry.id }),
    el('span', { className: 'grow' }),
    el('div', { className: 'entry-actions' }, [
      el('button', { className: 'tiny', textContent: 'Edit', title: 'Edit this entry’s heading fields', onclick: () => editEntry(entry) }),
      el('button', { className: 'tiny danger', textContent: 'Delete', onclick: () => removeEntry(entry) }),
    ]),
  ]);
  box.append(head);

  /*
   * Heading fields get weight in proportion to how much there is to decide.
   * A field with alternates is a choice, and gets a labelled row with its
   * dropdown. A plain string is just a fact, and gets one compact line with an
   * affordance to give it alternates — that conversion is the heart of the
   * model and must not require opening YAML.
   */
  const plainFields = [];
  for (const name of ['title', 'dates', 'subtitle', 'location']) {
    const field = entry[name];
    const key = `${entry.id}.${name}`;

    if (isVariantField(field)) {
      const current = choices[key] ?? field.default;
      const chosen = field.variants.find((v) => v.id === current);
      const control = variantPicker({
        key,
        field,
        current,
        addLabel: '+ alternate',
        onAdd: () => addFieldAlternate(entry, name),
        onEdit: chosen ? () => editFieldVariant(entry, name, chosen) : null,
        extraActions: [
          el('span', { className: 'chip count', textContent: plural(field.variants.length, 'alternate') }),
          key in state.choices ? el('span', { className: 'chip overridden', textContent: 'changed' }) : null,
        ].filter(Boolean),
      });
      if (chosen?.note) control.append(el('div', { className: 'note', textContent: chosen.note }));
      box.append(
        el('div', { className: 'field' }, [
          el('div', { className: 'field-label' }, FIELD_LABELS[name] ?? name),
          control,
        ]),
      );
      continue;
    }

    // The title already reads as the entry heading; repeating it as a row was
    // the single biggest source of wasted height.
    if (field == null) continue;
    plainFields.push({ name, text: String(field) });
  }

  if (plainFields.length > 0) {
    const meta = el('div', { className: 'meta-row' });
    for (const f of plainFields) {
      meta.append(
        el('span', { className: 'meta-item' }, [
          f.name === 'title' ? null : el('span', { className: 'meta-label', textContent: FIELD_LABELS[f.name] }),
          el('span', { textContent: f.text }),
          el('button', {
            className: 'link meta-add',
            textContent: '+ alt',
            title: `Give ${FIELD_LABELS[f.name] ?? f.name} a second option — a different graduation date, say`,
            onclick: () => addFieldAlternate(entry, f.name),
          }),
        ]),
      );
    }
    // Fields the entry does not have yet, so a missing date is still reachable.
    const missing = ['dates', 'subtitle', 'location'].filter((n) => entry[n] == null);
    if (missing.length > 0) {
      meta.append(
        el('button', {
          className: 'link',
          textContent: `+ ${missing.map((m) => FIELD_LABELS[m].toLowerCase()).join(' / ')}`,
          title: 'Fill in a heading field this entry does not have yet',
          onclick: () => editEntry(entry),
        }),
      );
    }
    box.append(meta);
  }

  const listed = section.bullets?.[entry.id];
  for (const bullet of entry.bullets ?? []) {
    if (bullet.archived) continue;
    box.append(bulletBlock(entry, bullet, choices, listed ? listed.includes(bullet.id) : true));
  }

  box.append(
    el('div', { className: 'add-row' }, [
      el('button', { className: 'link', textContent: '+ Add bullet', onclick: () => addBullet(entry) }),
    ]),
  );
  return box;
}

function skillsBlock(section) {
  const frag = document.createDocumentFragment();

  for (const gid of section.groups ?? []) {
    const group = state.store.skillGroups.find((g) => g.id === gid);
    if (!group) continue;

    const picked = state.skillEdits?.[gid] ?? section.items?.[gid] ?? group.items.map((i) => i.id);
    const box = el('div', { className: 'entry' });
    box.append(
      el('div', { className: 'entry-head' }, [
        el('span', { className: 'title', textContent: group.name }),
        el('span', { className: 'id', textContent: gid }),
        el('span', { className: 'grow' }),
        el('div', { className: 'entry-actions' }, [
          el('button', { className: 'tiny danger', textContent: 'Delete group', onclick: () => removeSkillGroup(group) }),
        ]),
      ]),
    );

    const items = el('div', { className: 'skill-items' });
    for (const item of group.items) {
      const on = picked.includes(item.id);
      const chip = el('label', { className: `skill-chip${on ? ' on' : ''}` });
      const cb = el('input', { type: 'checkbox', checked: on });
      cb.onchange = () => {
        const cur = new Set(state.skillEdits?.[gid] ?? picked);
        if (cb.checked) cur.add(item.id);
        else cur.delete(item.id);
        state.skillEdits = { ...(state.skillEdits ?? {}), [gid]: [...cur] };
        markDirty();
        render();
      };
      chip.append(cb, item.text);
      chip.append(
        el('span', {
          className: 'x',
          textContent: '×',
          title: 'Delete this skill from the store',
          onclick: (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            removeSkill(group, item);
          },
        }),
      );
      items.append(chip);
    }
    box.append(items);
    box.append(
      el('div', { className: 'add-row' }, [
        el('button', { className: 'link', textContent: '+ Add skill', onclick: () => addSkill(group) }),
      ]),
    );
    frag.append(box);
  }

  frag.append(
    el('div', { className: 'add-row' }, [
      el('button', { className: 'link', textContent: '+ Add skill group', onclick: addSkillGroup }),
    ]),
  );
  return frag;
}

function renderEditor() {
  const editor = $('#editor');
  editor.replaceChildren();
  if (!state.store || !state.resumeId) return;

  const choices = effectiveChoices();
  const sections = resolveSections();

  for (const section of sections) {
    const heading = el('div', { className: 'section-heading' }, [
      el('span', { className: 'name', textContent: SECTION_LABELS[section.kind] ?? section.kind }),
      el('span', { className: 'rule' }),
      section.kind !== 'skills'
        ? el('button', {
            className: 'link',
            textContent: '+ Add entry',
            onclick: () => addEntry(section.kind),
          })
        : null,
    ]);
    editor.append(heading);

    if (section.kind === 'skills') {
      editor.append(skillsBlock(section));
      continue;
    }

    const entries = (section.entries ?? [])
      .map((eid) => state.store.entries.find((e) => e.id === eid))
      .filter(Boolean);

    if (entries.length === 0) {
      editor.append(
        el('div', { className: 'empty' }, [
          el('b', {}, `No ${SECTION_LABELS[section.kind].toLowerCase()} yet`),
          'Add an entry and it becomes available to every resume.',
        ]),
      );
      continue;
    }
    for (const entry of entries) editor.append(entryBlock(entry, section, choices));
  }
}

/* ------------------------------------------------------------------ *
 * Adding and editing                                                  *
 * ------------------------------------------------------------------ */

async function addEntry(kind) {
  const answer = await form(`New ${kind} entry`, [
    { name: 'title', label: kind === 'education' ? 'School' : kind === 'project' ? 'Project name' : 'Company', value: '' },
    { name: 'subtitle', label: FIELD_LABELS.subtitle, value: '' },
    { name: 'dates', label: 'Dates', value: '' },
    { name: 'location', label: 'Location', value: '' },
    { name: 'bullet', label: 'First bullet (optional)', value: '', multiline: true },
    { name: 'tags', label: 'Tags, comma separated', value: '' },
  ]);
  if (!answer?.title?.trim()) return;

  const prefix = { education: 'edu', experience: 'exp', project: 'proj' }[kind] ?? 'entry';
  let id = `${prefix}_${slug(answer.title)}`;
  // Ids must be unique: they are how every resume refers to this entry.
  let n = 2;
  while (state.store.entries.some((e) => e.id === id)) id = `${prefix}_${slug(answer.title)}_${n++}`;

  const entry = {
    id,
    kind,
    title: answer.title.trim(),
    ...(answer.subtitle?.trim() ? { subtitle: answer.subtitle.trim() } : {}),
    ...(answer.dates?.trim() ? { dates: answer.dates.trim() } : {}),
    ...(answer.location?.trim() ? { location: answer.location.trim() } : {}),
    ...(answer.tags?.trim() ? { tags: answer.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
    bullets: answer.bullet?.trim()
      ? [{ id: `b_${slug(answer.title)}_1`, default: 'v_base', variants: [{ id: 'v_base', label: 'Base', text: answer.bullet.trim() }] }]
      : [],
  };

  await api(`/entries/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(entry) });

  // A new entry nobody references is invisible, so add it to the section of the
  // resume being edited — at the root of the chain, so every resume gets it.
  const root = chain(state.resumeId)[0];
  const sections = resolveSections().map((s) =>
    s.kind === kind ? { ...s, entries: [...(s.entries ?? []), id] } : s,
  );
  if (!sections.some((s) => s.kind === kind)) sections.push({ kind, entries: [id] });
  await saveResumeSpec({ ...root, sections }, `Added ${id}`);
  render();
  renderPreview();
}

async function editEntry(entry) {
  const plainOrNote = (f) => (isVariantField(f) ? '' : (f ?? ''));
  const answer = await form(`Edit ${entry.id}`, [
    { name: 'title', label: FIELD_LABELS.title, value: plainOrNote(entry.title), disabled: isVariantField(entry.title) },
    { name: 'subtitle', label: FIELD_LABELS.subtitle, value: plainOrNote(entry.subtitle), disabled: isVariantField(entry.subtitle) },
    { name: 'dates', label: FIELD_LABELS.dates, value: plainOrNote(entry.dates), disabled: isVariantField(entry.dates) },
    { name: 'location', label: FIELD_LABELS.location, value: plainOrNote(entry.location), disabled: isVariantField(entry.location) },
    { name: 'tags', label: 'Tags, comma separated', value: (entry.tags ?? []).join(', ') },
  ], 'Fields that have alternates are edited through their own dropdown.');
  if (!answer) return;

  const next = { ...entry };
  for (const f of ['title', 'subtitle', 'dates', 'location']) {
    if (isVariantField(entry[f])) continue;
    const v = answer[f]?.trim();
    if (v) next[f] = v;
    else delete next[f];
  }
  next.tags = answer.tags ? answer.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
  await saveEntry(next);
  renderPreview();
}

async function removeEntry(entry) {
  if (!(await confirmModal(`Delete ${entry.id}?`, 'The entry and all of its phrasings are removed from the store. Resumes referencing it will warn until you remove the reference.'))) return;
  await api(`/entries/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });

  // Drop the reference too, so the next compile does not warn about it.
  const root = chain(state.resumeId)[0];
  const sections = resolveSections().map((s) => ({
    ...s,
    entries: (s.entries ?? []).filter((id) => id !== entry.id),
  }));
  await saveResumeSpec({ ...root, sections }, `Deleted ${entry.id}`);
  render();
  renderPreview();
}

/** Add a new bullet to an entry, with its first phrasing. */
async function addBullet(entry) {
  const answer = await form(`New bullet on ${entry.id}`, [
    { name: 'text', label: 'Text', value: '', multiline: true },
    { name: 'label', label: 'Label for this phrasing', value: 'Base' },
    { name: 'tags', label: 'Tags, comma separated', value: '' },
  ], 'Markup: **bold**, *italic*, `code`.');
  if (!answer?.text?.trim()) return;

  let id = `b_${slug(entry.id).replace(/^(exp|edu|proj)_/, '')}_${(entry.bullets?.length ?? 0) + 1}`;
  const taken = new Set((entry.bullets ?? []).map((b) => b.id));
  let n = 2;
  while (taken.has(id)) id = `${id}_${n++}`;

  const next = {
    ...entry,
    bullets: [
      ...(entry.bullets ?? []),
      {
        id,
        default: 'v_base',
        variants: [
          {
            id: 'v_base',
            label: answer.label?.trim() || 'Base',
            text: answer.text.trim(),
            ...(answer.tags?.trim() ? { tags: answer.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
          },
        ],
      },
    ],
  };
  await saveEntry(next, `Added bullet ${id}`);
  renderPreview();
}

async function removeBullet(entry, bullet) {
  if (!(await confirmModal(`Delete bullet ${bullet.id}?`, `All ${plural(bullet.variants.length, 'phrasing')} of it are removed from the store.`))) return;
  await saveEntry({ ...entry, bullets: (entry.bullets ?? []).filter((b) => b.id !== bullet.id) }, `Deleted ${bullet.id}`);
  renderPreview();
}

/** Add another phrasing of an existing bullet. */
async function addBulletVariant(entry, bullet) {
  const current = bullet.variants.find((v) => v.id === bullet.default) ?? bullet.variants[0];
  const answer = await form(`New phrasing for ${bullet.id}`, [
    { name: 'label', label: 'Label', value: '' },
    { name: 'text', label: 'Text', value: current?.text ?? '', multiline: true },
    { name: 'tags', label: 'Tags, comma separated', value: '' },
    { name: 'note', label: 'Note to self (optional)', value: '' },
    { name: 'useNow', label: 'Use it in this resume straight away', type: 'checkbox', value: true },
  ], 'Starts from the current wording so you can adjust rather than retype.');
  if (!answer?.text?.trim()) return;

  const variant = await api(
    `/entries/${encodeURIComponent(entry.id)}/bullets/${encodeURIComponent(bullet.id)}/variants`,
    {
      method: 'POST',
      body: JSON.stringify({
        label: answer.label?.trim() || 'New phrasing',
        text: answer.text,
        tags: answer.tags ? answer.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        note: answer.note?.trim() || undefined,
      }),
    },
  );

  if (answer.useNow) {
    state.choices[bullet.id] = variant.id;
    markDirty();
  }
  setStatus(`Added phrasing "${variant.label}"`);
  await loadStore();
  render();
  if (answer.useNow) renderPreview();
}

/** Edit an existing phrasing in place — it changes everywhere it is used. */
async function editVariant(entry, bullet, variant) {
  const answer = await form(`Edit "${variant.label}"`, [
    { name: 'label', label: 'Label', value: variant.label },
    { name: 'text', label: 'Text', value: variant.text, multiline: true },
    { name: 'tags', label: 'Tags, comma separated', value: (variant.tags ?? []).join(', ') },
    { name: 'note', label: 'Note to self', value: variant.note ?? '' },
  ], 'This wording is shared: every resume using it changes too. That is the point.');
  if (!answer?.text?.trim()) return;

  const next = {
    ...entry,
    bullets: entry.bullets.map((b) =>
      b.id !== bullet.id
        ? b
        : {
            ...b,
            variants: b.variants.map((v) =>
              v.id !== variant.id
                ? v
                : {
                    ...v,
                    label: answer.label?.trim() || v.label,
                    text: answer.text.trim(),
                    tags: answer.tags ? answer.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
                    note: answer.note?.trim() || undefined,
                    // Editing it is the review.
                    suggested: undefined,
                  },
            ),
          },
    ),
  };
  await saveEntry(next, 'Phrasing updated');
  renderPreview();
}

/**
 * Give a heading field an alternate. When the field is currently a plain
 * string, this converts it into a variant set, keeping the existing text as
 * the default — the "two graduation dates" move, without touching YAML.
 */
async function addFieldAlternate(entry, name) {
  const field = entry[name];
  const existing = isVariantField(field) ? field : null;
  const currentText = existing
    ? (existing.variants.find((v) => v.id === existing.default) ?? existing.variants[0])?.text ?? ''
    : String(field ?? '');

  const answer = await form(`New alternate for ${FIELD_LABELS[name] ?? name}`, [
    { name: 'label', label: 'Label', value: '' },
    { name: 'text', label: 'Text', value: currentText, multiline: false },
    { name: 'tags', label: 'Tags, comma separated', value: '' },
    { name: 'note', label: 'Note to self (optional)', value: '' },
    { name: 'useNow', label: 'Use it in this resume straight away', type: 'checkbox', value: true },
  ], existing ? null : `"${currentText || '(empty)'}" is kept as the default.`);
  if (!answer?.text?.trim()) return;

  const key = `${entry.id}.${name}`;
  let id = `v_${slug(answer.label || answer.text)}` || `v_${Date.now()}`;
  const taken = new Set((existing?.variants ?? []).map((v) => v.id));
  let n = 2;
  while (taken.has(id)) id = `v_${slug(answer.label || answer.text)}_${n++}`;

  const newVariant = {
    id,
    label: answer.label?.trim() || answer.text.trim().slice(0, 24),
    text: answer.text.trim(),
    ...(answer.tags?.trim() ? { tags: answer.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
    ...(answer.note?.trim() ? { note: answer.note.trim() } : {}),
  };

  const nextField = existing
    ? { ...existing, variants: [...existing.variants, newVariant] }
    : {
        default: 'v_base',
        variants: [
          { id: 'v_base', label: currentText.slice(0, 24) || 'Default', text: currentText },
          newVariant,
        ],
      };

  await saveEntry({ ...entry, [name]: nextField }, `Added alternate for ${key}`);
  if (answer.useNow) {
    state.choices[key] = id;
    markDirty();
    render();
    renderPreview();
  }
}

async function editFieldVariant(entry, name, variant) {
  const field = entry[name];
  const answer = await form(`Edit "${variant.label}"`, [
    { name: 'label', label: 'Label', value: variant.label },
    { name: 'text', label: 'Text', value: variant.text },
    { name: 'tags', label: 'Tags, comma separated', value: (variant.tags ?? []).join(', ') },
    { name: 'note', label: 'Note to self', value: variant.note ?? '' },
    { name: 'remove', label: 'Delete this alternate instead', type: 'checkbox', value: false },
  ]);
  if (!answer) return;

  let variants;
  if (answer.remove) {
    if (field.variants.length < 2) {
      setStatus('An alternate set needs at least one option', true);
      return;
    }
    variants = field.variants.filter((v) => v.id !== variant.id);
  } else {
    if (!answer.text?.trim()) return;
    variants = field.variants.map((v) =>
      v.id !== variant.id
        ? v
        : {
            ...v,
            label: answer.label?.trim() || v.label,
            text: answer.text.trim(),
            tags: answer.tags ? answer.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
            note: answer.note?.trim() || undefined,
          },
    );
  }

  const nextDefault = variants.some((v) => v.id === field.default) ? field.default : variants[0].id;
  await saveEntry({ ...entry, [name]: { default: nextDefault, variants } }, 'Alternate updated');
  renderPreview();
}

/* ---- Skills ---- */

async function addSkill(group) {
  const answer = await form(`Add a skill to ${group.name}`, [
    { name: 'text', label: 'Skill', value: '' },
    { name: 'tags', label: 'Tags, comma separated', value: '' },
  ], 'Tags are what the extension matches against a job posting.');
  if (!answer?.text?.trim()) return;

  const groups = state.store.skillGroups.map((g) =>
    g.id !== group.id
      ? g
      : {
          ...g,
          items: [
            ...g.items,
            {
              id: `s_${slug(answer.text)}`,
              text: answer.text.trim(),
              ...(answer.tags?.trim() ? { tags: answer.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
            },
          ],
        },
  );
  await api('/skills', { method: 'PUT', body: JSON.stringify(groups) });
  setStatus('Skill added');
  await loadStore();
  render();
  renderPreview();
}

async function removeSkill(group, item) {
  const groups = state.store.skillGroups.map((g) =>
    g.id !== group.id ? g : { ...g, items: g.items.filter((i) => i.id !== item.id) },
  );
  await api('/skills', { method: 'PUT', body: JSON.stringify(groups) });
  setStatus(`Removed ${item.text}`);
  await loadStore();
  render();
  renderPreview();
}

async function addSkillGroup() {
  const answer = await form('New skill group', [
    { name: 'name', label: 'Group name, e.g. Languages', value: '' },
    { name: 'items', label: 'Skills, comma separated', value: '' },
  ]);
  if (!answer?.name?.trim()) return;

  const id = `sk_${slug(answer.name)}`;
  const groups = [
    ...state.store.skillGroups,
    {
      id,
      name: answer.name.trim(),
      items: (answer.items ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((text) => ({ id: `s_${slug(text)}`, text })),
    },
  ];
  await api('/skills', { method: 'PUT', body: JSON.stringify(groups) });

  const root = chain(state.resumeId)[0];
  const sections = resolveSections().map((s) =>
    s.kind === 'skills' ? { ...s, groups: [...(s.groups ?? []), id] } : s,
  );
  if (!sections.some((s) => s.kind === 'skills')) sections.push({ kind: 'skills', entries: [], groups: [id] });
  await saveResumeSpec({ ...root, sections }, 'Skill group added');
  render();
  renderPreview();
}

async function removeSkillGroup(group) {
  if (!(await confirmModal(`Delete "${group.name}"?`, 'The group and its skills are removed from the store.'))) return;
  await api('/skills', {
    method: 'PUT',
    body: JSON.stringify(state.store.skillGroups.filter((g) => g.id !== group.id)),
  });
  const root = chain(state.resumeId)[0];
  const sections = resolveSections().map((s) =>
    s.kind === 'skills' ? { ...s, groups: (s.groups ?? []).filter((g) => g !== group.id) } : s,
  );
  await saveResumeSpec({ ...root, sections }, 'Group deleted');
  render();
  renderPreview();
}

/* ------------------------------------------------------------------ *
 * Compiling and feedback                                              *
 * ------------------------------------------------------------------ */

async function renderPreview() {
  const fit = $('#fit');
  fit.className = 'fit idle';
  fit.textContent = 'Compiling…';
  try {
    const result = await api('/render', { method: 'POST', body: JSON.stringify({ spec: currentSpec() }) });

    // Chrome's viewer otherwise fills the pane with its own dark toolbar and a
    // thumbnail rail. `zoom=page-fit` shows the whole page, which is the only
    // view that answers "does this fit, and how does it look" at a glance.
    $('#preview').src = `${result.pdfUrl}#toolbar=0&navpanes=0&scrollbar=0&zoom=page-fit`;
    $('#preview').closest('.preview-frame').classList.add('loaded');

    fit.className = result.fits ? 'fit' : 'fit bad';
    fit.replaceChildren(
      result.fits
        ? `Fits on one page${
            result.overflowLines < 0 ? ` — room for about ${plural(Math.abs(result.overflowLines), 'more line')}` : ''
          }`
        : `${plural(result.pages, 'page')} — about ${plural(result.overflowLines, 'line')} too long. Pick a shorter phrasing or drop a bullet.`,
    );
    if (result.adjustments.length) {
      fit.append(el('span', { className: 'adj', textContent: ` · auto-fit: ${result.adjustments.join('; ')}` }));
    }

    $('#warnings').replaceChildren(...(result.warnings ?? []).map((w) => el('div', { textContent: w })));
  } catch (err) {
    fit.className = 'fit bad';
    fit.textContent = err.message;
  }
}

async function saveAsVariation() {
  const answer = await form('Save as variation', [
    { name: 'id', label: 'Id — becomes the filename', value: `${state.resumeId}-variant` },
    { name: 'label', label: 'Label', value: `${resumeById(state.resumeId)?.label ?? state.resumeId} variation` },
  ], `Inherits from "${state.resumeId}", so later edits there still reach it.`);
  if (!answer?.id?.trim()) return;

  const spec = {
    id: answer.id.trim(),
    label: answer.label?.trim() || answer.id.trim(),
    extends: state.resumeId,
    choices: { ...state.choices },
  };
  if (state.skillEdits) {
    const skills = resolveSections().find((s) => s.kind === 'skills');
    if (skills) spec.sections = [{ ...skills, items: { ...(skills.items ?? {}), ...state.skillEdits } }];
  }

  await saveResumeSpec(spec, `Saved ${spec.id}`);
  state.choices = {};
  state.skillEdits = null;
  state.dirty = false;
  state.resumeId = spec.id;
  render();
}

async function askFeedback() {
  showModal('Feedback', el('p', { className: 'hint', textContent: 'Asking the configured AI…' }));
  try {
    const result = await api('/ai/feedback', { method: 'POST', body: JSON.stringify({ resumeId: state.resumeId }) });
    showModal(
      result.executed ? 'Feedback' : 'AI is off — this is the prompt it would have run',
      el('pre', { textContent: result.output }),
    );
  } catch (err) {
    showModal('Feedback failed', el('pre', { textContent: err.message }));
  }
}

async function askBulletFeedback(entryId, bulletId) {
  showModal('Feedback', el('p', { className: 'hint', textContent: 'Asking the configured AI…' }));
  try {
    const result = await api('/ai/feedback', { method: 'POST', body: JSON.stringify({ entryId, bulletId }) });
    showModal(
      result.executed ? `Feedback on ${bulletId}` : 'AI is off — this is the prompt it would have run',
      el('pre', { textContent: result.output }),
    );
  } catch (err) {
    showModal('Feedback failed', el('pre', { textContent: err.message }));
  }
}

/* ------------------------------------------------------------------ *
 * Applications                                                        *
 * ------------------------------------------------------------------ */

const STATUSES = ['interested', 'applied', 'oa', 'interview', 'offer', 'rejected', 'ghosted', 'withdrawn'];

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

  const wrap = $('#apps-wrap');
  if (applications.length === 0) {
    wrap.replaceChildren(
      el('div', { className: 'empty' }, [
        el('b', {}, 'Nothing tracked yet'),
        'Applications land here when you use “Save application folder” in the browser extension, or run ',
        el('code', {}, 'rmm apply'),
        '.',
      ]),
    );
    return;
  }

  const rows = [...applications]
    .sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))
    .map((a) => {
      const sel = el('select');
      for (const s of STATUSES) sel.append(el('option', { value: s, textContent: s, selected: s === a.status }));
      sel.onchange = async () => {
        await api(`/applications/${encodeURIComponent(a.id)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: sel.value }),
        });
        setStatus('Status updated');
        loadApplications();
      };
      return el('tr', {}, [
        el('td', { textContent: a.appliedAt?.slice(0, 10) ?? '' }),
        el('td', { textContent: a.company }),
        el('td', { textContent: a.role }),
        el('td', {}, [sel]),
        el('td', { className: 'mono', textContent: a.resumeId ?? '' }),
        el('td', { className: 'mono', textContent: a.snapshotDir ?? '' }),
        el('td', {}, [
          el('button', {
            className: 'tiny danger',
            textContent: 'Remove',
            onclick: async () => {
              if (!(await confirmModal(`Remove ${a.company}?`, 'The tracker row goes; the files on disk stay.'))) return;
              await api(`/applications/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
              loadApplications();
            },
          }),
        ]),
      ]);
    });

  wrap.replaceChildren(
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, ['Date', 'Company', 'Role', 'Status', 'Resume', 'Files', ''].map((h) => el('th', { textContent: h }))),
      ]),
      el('tbody', {}, rows),
    ]),
  );
}

async function addApplication() {
  const answer = await form('Record an application', [
    { name: 'company', label: 'Company', value: '' },
    { name: 'role', label: 'Role', value: '' },
    { name: 'url', label: 'URL', value: '' },
    { name: 'notes', label: 'Notes', value: '', multiline: true },
  ]);
  if (!answer?.company?.trim() || !answer?.role?.trim()) return;
  await api('/applications', { method: 'POST', body: JSON.stringify({ ...answer, resumeId: state.resumeId }) });
  loadApplications();
}

/* ------------------------------------------------------------------ *
 * Letters and answers                                                 *
 * ------------------------------------------------------------------ */

async function loadLetters() {
  const [letters, store] = await Promise.all([api('/letters'), api('/store')]);

  $('#letters').replaceChildren(
    letters.length === 0
      ? el('div', { className: 'empty' }, [
          el('b', {}, 'No letters yet'),
          'Drafts written by the extension are saved here, and become the voice reference for the next one.',
        ])
      : el(
          'div',
          { className: 'card-list' },
          letters.map((l) =>
            el('div', { className: 'mini-card' }, [
              el('div', { className: 'row1' }, [
                el('b', { textContent: l.title }),
                el('span', { className: 'faint', textContent: l.createdAt?.slice(0, 10) ?? '' }),
                el('span', { style: 'flex:1' }),
                el('button', { className: 'tiny', textContent: 'Open', onclick: () => editLetter(l) }),
              ]),
              el('div', { className: 'body', textContent: l.body.slice(0, 260) }),
            ]),
          ),
        ),
  );

  $('#answers').replaceChildren(
    store.answers.length === 0
      ? el('div', { className: 'empty' }, [el('b', {}, 'No saved answers'), 'Add the questions every form asks.'])
      : el(
          'div',
          { className: 'card-list' },
          store.answers.map((a) => {
            const v = a.variants.find((x) => x.id === a.default) ?? a.variants[0];
            return el('div', { className: 'mini-card' }, [
              el('div', { className: 'row1' }, [
                el('b', { textContent: a.question }),
                el('span', { style: 'flex:1' }),
                el('span', { className: 'chip count', textContent: plural(a.variants.length, 'version') }),
                el('button', { className: 'tiny', textContent: 'Edit', onclick: () => editAnswer(a) }),
              ]),
              el('div', { className: 'body', textContent: v?.text ?? '' }),
            ]);
          }),
        ),
  );
}

async function editLetter(letter) {
  const answer = await form(letter.title ?? 'Cover letter', [
    { name: 'title', label: 'Title', value: letter.title ?? '' },
    { name: 'company', label: 'Company', value: letter.company ?? '' },
    { name: 'role', label: 'Role', value: letter.role ?? '' },
    { name: 'body', label: 'Body', value: letter.body ?? '', multiline: true, tall: true },
  ]);
  if (!answer) return;
  await api(`/letters/${encodeURIComponent(letter.id)}`, {
    method: 'PUT',
    body: JSON.stringify({ ...letter, ...answer }),
  });
  setStatus('Letter saved');
  loadLetters();
}

async function addLetter() {
  const answer = await form('New cover letter', [
    { name: 'company', label: 'Company', value: '' },
    { name: 'role', label: 'Role', value: '' },
    { name: 'body', label: 'Body', value: '', multiline: true, tall: true },
  ]);
  if (!answer?.body?.trim()) return;
  const id = `${new Date().toISOString().slice(0, 10)}-${slug(answer.company || 'letter')}`;
  await api(`/letters/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({
      id,
      title: `${answer.role || 'Role'} — ${answer.company || 'Unknown'}`,
      company: answer.company,
      role: answer.role,
      createdAt: new Date().toISOString(),
      body: answer.body,
    }),
  });
  setStatus('Letter saved');
  loadLetters();
}

async function addAnswer() {
  const answer = await form('New saved answer', [
    { name: 'question', label: 'Question, as forms usually word it', value: '' },
    { name: 'answer', label: 'Your answer', value: '', multiline: true, tall: true },
  ], 'Offered automatically when a form asks something close to this.');
  if (!answer?.question?.trim() || !answer?.answer?.trim()) return;
  await api('/answers/save', { method: 'POST', body: JSON.stringify(answer) });
  setStatus('Answer saved');
  loadLetters();
}

async function editAnswer(item) {
  const v = item.variants.find((x) => x.id === item.default) ?? item.variants[0];
  const answer = await form(item.question, [
    { name: 'answer', label: 'Answer', value: v?.text ?? '', multiline: true, tall: true },
    { name: 'label', label: 'Label for this version', value: 'Updated' },
    { name: 'asNew', label: 'Keep the old wording as another version', type: 'checkbox', value: false },
  ]);
  if (!answer?.answer?.trim()) return;

  if (answer.asNew) {
    await api('/answers/save', {
      method: 'POST',
      body: JSON.stringify({ itemId: item.id, question: item.question, answer: answer.answer, label: answer.label }),
    });
  } else {
    const answers = (await api('/store')).answers.map((a) =>
      a.id !== item.id
        ? a
        : { ...a, variants: a.variants.map((x) => (x.id === v.id ? { ...x, text: answer.answer.trim() } : x)) },
    );
    await api('/answers', { method: 'PUT', body: JSON.stringify(answers) });
  }
  setStatus('Answer saved');
  loadLetters();
}

/* ------------------------------------------------------------------ *
 * Modals                                                              *
 * ------------------------------------------------------------------ */

function showModal(title, content, { note = '', okLabel = 'Close', showCancel = false } = {}) {
  $('#modal-title').textContent = title;
  $('#modal-content').replaceChildren(content);
  $('#modal-note').textContent = note;
  $('#modal-cancel').style.display = showCancel ? '' : 'none';
  $('#modal-ok').textContent = okLabel;
  $('#modal').classList.remove('hidden');
  return new Promise((resolve) => {
    $('#modal-ok').onclick = () => {
      $('#modal').classList.add('hidden');
      resolve(true);
    };
    $('#modal-cancel').onclick = () => {
      $('#modal').classList.add('hidden');
      resolve(false);
    };
  });
}

function confirmModal(title, body) {
  return showModal(title, el('p', { textContent: body }), { okLabel: 'Delete', showCancel: true });
}

/** A multi-field form modal. `prompt()` can only ask for one thing. */
function form(title, fields, note) {
  return new Promise((resolve) => {
    const inputs = {};
    const content = el('div');

    for (const f of fields) {
      if (f.type === 'checkbox') {
        const cb = el('input', { type: 'checkbox', checked: Boolean(f.value), id: `f_${f.name}` });
        inputs[f.name] = { get: () => cb.checked };
        content.append(
          el('label', { className: 'form-label', style: 'display:flex;gap:7px;align-items:center;cursor:pointer' }, [
            cb,
            f.label,
          ]),
        );
        continue;
      }
      content.append(el('div', { className: 'form-label', textContent: f.label }));

      if (f.type === 'select') {
        const sel = el('select', { style: 'width:100%' });
        for (const o of f.options) {
          sel.append(
            el('option', {
              value: o.value ?? o,
              textContent: o.label ?? o,
              selected: (o.value ?? o) === f.value,
            }),
          );
        }
        inputs[f.name] = { get: () => sel.value };
        content.append(sel);
        continue;
      }

      const input = f.multiline
        ? el('textarea', { value: f.value ?? '', style: f.tall ? 'min-height:220px' : '' })
        : el('input', { type: 'text', value: f.value ?? '' });
      if (f.disabled) {
        input.disabled = true;
        input.title = 'This field has alternates — edit it through its dropdown.';
      }
      inputs[f.name] = { get: () => input.value };
      content.append(input);
    }

    $('#modal-title').textContent = title;
    $('#modal-content').replaceChildren(content);
    $('#modal-note').textContent = note ?? '';
    $('#modal-cancel').style.display = '';
    $('#modal-ok').textContent = 'Save';
    $('#modal').classList.remove('hidden');

    // Focus the first editable field so the form is usable from the keyboard.
    const first = content.querySelector('input[type=text], textarea');
    if (first) setTimeout(() => first.focus(), 0);

    const close = (value) => {
      $('#modal').classList.add('hidden');
      resolve(value);
    };
    $('#modal-ok').onclick = () =>
      close(Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.get()])));
    $('#modal-cancel').onclick = () => close(null);
  });
}

/* ------------------------------------------------------------------ *
 * Boot                                                                *
 * ------------------------------------------------------------------ */

function render() {
  const select = $('#resume-select');
  select.replaceChildren(
    ...state.store.resumes.map((r) =>
      el('option', { value: r.id, textContent: `${r.label} (${r.id})`, selected: r.id === state.resumeId }),
    ),
  );
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
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`);
      if (btn.dataset.tab === 'applications') loadApplications().catch((e) => setStatus(e.message, true));
      if (btn.dataset.tab === 'letters') loadLetters().catch((e) => setStatus(e.message, true));
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
  $('#btn-add-entry').onclick = async () => {
    const answer = await form('Add an entry', [
      {
        name: 'kind',
        label: 'Which section?',
        type: 'select',
        value: 'experience',
        options: [
          { value: 'experience', label: 'Experience — a job, co-op, or internship' },
          { value: 'project', label: 'Project' },
          { value: 'education', label: 'Education' },
          { value: 'custom', label: 'Additional' },
        ],
      },
    ]);
    if (answer?.kind) addEntry(answer.kind);
  };
  $('#btn-add-app').onclick = addApplication;
  $('#btn-add-letter').onclick = addLetter;
  $('#btn-add-answer').onclick = addAnswer;
  $('#btn-master').onclick = async () => {
    setStatus('Compiling the master document…');
    try {
      const r = await api('/render', { method: 'POST', body: JSON.stringify({ master: true }) });
      // The master document is for reading, so fit the width instead.
      $('#master-preview').src = `${r.pdfUrl}#toolbar=0&navpanes=0&zoom=page-width`;
      $('#master-preview').closest('.preview-frame').classList.add('loaded');
      setStatus(`Master document: ${plural(r.pages, 'page')}`);
    } catch (err) {
      setStatus(err.message, true);
    }
  };
  $('#btn-save-voice').onclick = async () => {
    await api('/voice', { method: 'PUT', body: JSON.stringify({ voice: $('#voice').value }) });
    setStatus('Voice notes saved');
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) $('#modal-cancel').click();
  });
}

boot().catch((err) => setStatus(err.message, true));
