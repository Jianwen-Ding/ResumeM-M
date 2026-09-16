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

/**
 * Replace a node's children, dropping nulls. `replaceChildren(null)` renders
 * the literal text "null", which is exactly the sort of thing that reaches a
 * screenshot.
 */
const setChildren = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

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
  /** Unsaved entry inclusion, keyed by section kind. */
  entryEdits: null,
  /** Unsaved bullet inclusion, keyed by entry id. */
  bulletEdits: null,
  /** Unsaved list-item selections on list bullets, keyed by bullet id. */
  listEdits: null,
  dirty: false,
};

/** Forget every unsaved edit — used when switching resumes. */
function clearEdits() {
  state.choices = {};
  state.skillEdits = null;
  state.entryEdits = null;
  state.bulletEdits = null;
  state.listEdits = null;
  state.dirty = false;
}

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

/**
 * Display text for stored source. The store holds LaTeX-flavoured text — `--`
 * for an en dash, `**bold**` — which is right for the renderer and looks like a
 * typo everywhere else.
 */
function display(text) {
  return String(text ?? '')
    .replace(/\s--\s/g, ' \u2013 ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/[`*]/g, '')
    .trim();
}

/**
 * What one option in a phrasing dropdown reads as: the wording that will be
 * printed, with the store's markup stripped, truncated only when it would
 * otherwise blow out the control.
 */
function optionText(variant) {
  const text = display(variant.text);
  const shown = text.length > 110 ? `${text.slice(0, 110).trimEnd()}…` : text;
  return variant.suggested ? `${shown}  · unreviewed` : shown;
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

/** Which items a list bullet shows right now, including unsaved edits. */
function listSelection(bullet) {
  const saved = Object.assign({}, ...chain(state.resumeId).map((s) => s.lists ?? {}));
  return state.listEdits?.[bullet.id] ?? saved[bullet.id] ?? bullet.items.map((i) => i.id);
}

/** Which entries a section shows right now, including unsaved edits. */
function entrySelection(section) {
  return state.entryEdits?.[section.kind] ?? section.entries ?? [];
}

/** Which bullets an entry shows right now, including unsaved edits. */
function bulletSelection(section, entry) {
  return (
    state.bulletEdits?.[entry.id] ??
    section.bullets?.[entry.id] ??
    (entry.bullets ?? []).filter((b) => !b.archived).map((b) => b.id)
  );
}

/**
 * The spec to compile: the selected resume plus everything unsaved. Inclusion
 * edits live on the sections, variant choices on `choices`, and list-item
 * selections on `lists`.
 */
function currentSpec() {
  const base = resumeById(state.resumeId);
  const spec = {
    ...base,
    choices: { ...(base.choices ?? {}), ...state.choices },
    lists: { ...(base.lists ?? {}), ...(state.listEdits ?? {}) },
  };

  const touchesSections = state.skillEdits || state.entryEdits || state.bulletEdits;
  if (touchesSections) {
    spec.sections = resolveSections().map((section) => {
      if (section.kind === 'skills') {
        return state.skillEdits
          ? { ...section, items: { ...(section.items ?? {}), ...state.skillEdits } }
          : section;
      }
      const entries = entrySelection(section);
      const bullets = { ...(section.bullets ?? {}) };
      for (const eid of entries) {
        const entry = state.store.entries.find((e) => e.id === eid);
        if (entry && state.bulletEdits?.[eid]) bullets[eid] = state.bulletEdits[eid];
      }
      return { ...section, entries, bullets };
    });
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

/** An entry's name as a person would say it, for dialog titles. */
function entryName(entry) {
  const title = fieldText(entry.title, effectiveChoices(), `${entry.id}.title`);
  return title || entry.id;
}

/**
 * A bullet named by its own opening words. Ids are how the store refers to
 * things; they are not what belongs in a dialog title asking you to confirm a
 * deletion.
 */
function bulletName(entry, bullet) {
  const chosen = bullet.variants.find((v) => v.id === bullet.default) ?? bullet.variants[0];
  const text = String(chosen?.text ?? '').replace(/[*`]/g, '').trim();
  if (!text) return bullet.id;
  return text.length > 44 ? `${text.slice(0, 44).trimEnd()}…` : text;
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
    // Show the wording itself. A label like "Kafka-forward · streaming" tells
    // you what the author meant; the sentence tells you what will be printed,
    // which is the thing you are actually choosing between.
    select.append(
      el('option', {
        value: v.id,
        textContent: optionText(v),
        title: [v.label, v.tags?.join(', '), v.note].filter(Boolean).join(' — '),
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

/** A checkbox that includes or excludes something from this variation. */
function toggle({ on, title, onChange }) {
  const cb = el('input', { type: 'checkbox', checked: on, title });
  cb.onchange = () => {
    onChange(cb.checked);
    markDirty();
    render();
  };
  return el('label', { className: 'toggle', title }, [cb]);
}

/** The courses/awards inside a list bullet, picked the way skills are. */
function listItems(entry, bullet) {
  const picked = listSelection(bullet);
  const wrap = el('div', { className: 'chip-set' });

  for (const item of bullet.items) {
    const on = picked.includes(item.id);
    const chip = el('label', { className: `chip-toggle${on ? ' on' : ''}` });
    const cb = el('input', { type: 'checkbox', checked: on });
    cb.onchange = () => {
      // Preserve store order, so the printed list does not reshuffle as you
      // click around.
      const next = new Set(picked);
      if (cb.checked) next.add(item.id);
      else next.delete(item.id);
      state.listEdits = {
        ...(state.listEdits ?? {}),
        [bullet.id]: bullet.items.filter((i) => next.has(i.id)).map((i) => i.id),
      };
      markDirty();
      render();
    };
    chip.append(cb, item.text);
    chip.append(
      el('span', {
        className: 'x',
        textContent: '×',
        title: 'Delete this item from the store',
        onclick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          removeListItem(entry, bullet, item);
        },
      }),
    );
    wrap.append(chip);
  }

  wrap.append(
    el('button', {
      className: 'link',
      textContent: '+ item',
      onclick: () => addListItem(entry, bullet),
    }),
  );
  return wrap;
}

/** Everything the user can do to one bullet, in one block. */
function bulletBlock(entry, section, bullet, choices) {
  const included = bulletSelection(section, entry).includes(bullet.id);
  const isList = Array.isArray(bullet.items) && bullet.items.length > 0;

  const wrap = el('div', { className: `bullet${included ? '' : ' off'}` });

  const head = el('div', { className: 'bullet-head' }, [
    toggle({
      on: included,
      title: included ? 'Showing on this variation' : 'Hidden on this variation',
      onChange: (checked) => {
        const current = bulletSelection(section, entry);
        const next = new Set(current);
        if (checked) next.add(bullet.id);
        else next.delete(bullet.id);
        state.bulletEdits = {
          ...(state.bulletEdits ?? {}),
          // Keep store order so bullets do not jump around when re-enabled.
          [entry.id]: (entry.bullets ?? []).filter((b) => next.has(b.id)).map((b) => b.id),
        };
      },
    }),
    el('div', { className: 'text' }, isList ? listPreview(bullet) : markup(String(currentText(bullet, choices) ?? ''))),
  ]);
  wrap.append(head);

  if (isList) {
    wrap.append(listItems(entry, bullet));
    wrap.append(
      el('div', { className: 'variant-row' }, [
        el('span', { className: 'grow' }),
        el('div', { className: 'actions' }, [
          el('span', { className: 'chip count', textContent: `${listSelection(bullet).length}/${bullet.items.length} shown` }),
          el('button', { className: 'tiny', textContent: 'Feedback', onclick: () => askBulletFeedback(entry, bullet) }),
          el('button', { className: 'tiny danger', textContent: 'Remove', onclick: () => removeBullet(entry, bullet) }),
        ]),
      ]),
    );
    return wrap;
  }

  const key = bullet.id;
  const chosenId = choices[key] ?? bullet.default;
  const chosen = bullet.variants.find((v) => v.id === chosenId) ?? bullet.variants[0];

  wrap.append(
    variantPicker({
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
        el('button', { className: 'tiny', textContent: 'Feedback', onclick: () => askBulletFeedback(entry, bullet) }),
        el('button', {
          className: 'tiny danger',
          textContent: 'Remove',
          title: 'Delete this bullet from the store',
          onclick: () => removeBullet(entry, bullet),
        }),
      ],
    }),
  );

  if (chosen?.note) wrap.append(el('div', { className: 'note', textContent: chosen.note }));
  return wrap;
}

/** The text a non-list bullet currently resolves to. */
function currentText(bullet, choices) {
  const chosen = bullet.variants.find((v) => v.id === (choices[bullet.id] ?? bullet.default)) ?? bullet.variants[0];
  return chosen?.text ?? '(no phrasings yet)';
}

/** What a list bullet will print, given the current selection. */
function listPreview(bullet) {
  const picked = listSelection(bullet);
  const chosen = bullet.items.filter((i) => picked.includes(i.id)).map((i) => i.text);
  const body = chosen.join(bullet.separator ?? ', ') || '(nothing selected)';
  return markup(bullet.prefix ? `${bullet.prefix} ${body}` : body);
}

function entryBlock(entry, section, choices) {
  const box = el('div', {});

  const included = entrySelection(section).includes(entry.id);
  const head = el('div', { className: 'entry-head' }, [
    toggle({
      on: included,
      title: included ? 'Showing on this variation' : 'Hidden on this variation',
      onChange: (checked) => {
        const current = entrySelection(section);
        const next = new Set(current);
        if (checked) next.add(entry.id);
        else next.delete(entry.id);
        // Keep the section's own order rather than click order.
        const ordered = (section.entries ?? []).filter((id) => next.has(id));
        for (const id of next) if (!ordered.includes(id)) ordered.push(id);
        state.entryEdits = { ...(state.entryEdits ?? {}), [section.kind]: ordered };
      },
    }),
    el('span', { className: 'title', textContent: fieldText(entry.title, choices, `${entry.id}.title`) || entry.id }),
    el('span', { className: 'id', textContent: entry.id }),
    el('span', { className: 'grow' }),
    el('div', { className: 'entry-actions' }, [
      // The title has no meta-line row of its own, so its "give this
      // alternates" action lives here beside the name it applies to.
      isVariantField(entry.title)
        ? null
        : el('button', {
            className: 'link',
            textContent: '+ alt',
            title: 'Give the title a second option',
            onclick: () => addFieldAlternate(entry, 'title'),
          }),
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

    // The title already reads as the entry heading, so it never joins the
    // meta line; its "+ alternate" lives in the header instead.
    if (field == null || name === 'title') continue;
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

  for (const bullet of entry.bullets ?? []) {
    if (bullet.archived) continue;
    box.append(bulletBlock(entry, section, bullet, choices));
  }

  box.append(
    el('div', { className: 'add-row' }, [
      el('button', { className: 'link', textContent: '+ Add bullet', onclick: () => addBullet(entry) }),
    ]),
  );
  box.className = `entry${included ? '' : ' off'}`;
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

    // Everything of this kind in the store, with the entries this resume
    // already lists first. Showing only the included ones would make a
    // toggled-off entry disappear, with no way to bring it back.
    const listed = section.entries ?? [];
    const entries = [
      ...listed.map((eid) => state.store.entries.find((e) => e.id === eid)).filter(Boolean),
      ...state.store.entries.filter((e) => e.kind === section.kind && !e.archived && !listed.includes(e.id)),
    ];

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
  const answer = await form(`Edit ${entryName(entry)}`, [
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
  if (!(await confirmModal(`Delete ${entryName(entry)}?`, 'The entry and all of its phrasings are removed from the store. Resumes referencing it will warn until you remove the reference.'))) return;
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
  const answer = await form(`New bullet — ${entryName(entry)}`, [
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
  if (!(await confirmModal(`Delete “${bulletName(entry, bullet)}”?`, `All ${plural(bullet.variants.length, 'phrasing')} of it are removed from the store.`))) return;
  await saveEntry({ ...entry, bullets: (entry.bullets ?? []).filter((b) => b.id !== bullet.id) }, `Deleted ${bullet.id}`);
  renderPreview();
}

/** Add another phrasing of an existing bullet. */
async function addBulletVariant(entry, bullet) {
  const current = bullet.variants.find((v) => v.id === bullet.default) ?? bullet.variants[0];
  const answer = await form(`New phrasing — ${bulletName(entry, bullet)}`, [
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

  const answer = await form(`New alternate — ${FIELD_LABELS[name] ?? name} of ${entryName(entry)}`, [
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

/* ---- List bullets ---- */

async function addListItem(entry, bullet) {
  const answer = await form(`Add to ${bullet.prefix?.replace(/[*:]/g, '').trim() || 'the list'}`, [
    { name: 'text', label: 'Item', value: '' },
    { name: 'tags', label: 'Tags, comma separated', value: '' },
  ], 'Tags are what the extension matches against a job posting.');
  if (!answer?.text?.trim()) return;

  const id = `i_${slug(answer.text)}`;
  const next = {
    ...entry,
    bullets: entry.bullets.map((b) =>
      b.id !== bullet.id
        ? b
        : {
            ...b,
            items: [
              ...b.items,
              {
                id,
                text: answer.text.trim(),
                ...(answer.tags?.trim() ? { tags: answer.tags.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
              },
            ],
          },
    ),
  };
  await saveEntry(next, 'Item added');

  // A newly added item is shown by default; not doing so makes the click
  // look like it failed.
  state.listEdits = { ...(state.listEdits ?? {}), [bullet.id]: [...listSelection(bullet), id] };
  markDirty();
  render();
  renderPreview();
}

async function removeListItem(entry, bullet, item) {
  const next = {
    ...entry,
    bullets: entry.bullets.map((b) =>
      b.id !== bullet.id ? b : { ...b, items: b.items.filter((i) => i.id !== item.id) },
    ),
  };
  await saveEntry(next, `Removed ${item.text}`);
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

  // A variation is the whole bundle: which entries and bullets are switched
  // on, which phrasings are used, and which list items are shown. Saving only
  // the phrasings would silently drop half of what you just did.
  const built = currentSpec();
  const spec = {
    id: answer.id.trim(),
    label: answer.label?.trim() || answer.id.trim(),
    extends: state.resumeId,
    choices: { ...state.choices },
    ...(state.listEdits ? { lists: { ...state.listEdits } } : {}),
    ...(built.sections ? { sections: built.sections } : {}),
  };

  await saveResumeSpec(spec, `Saved ${spec.id}`);
  clearEdits();
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

async function askBulletFeedback(entry, bullet) {
  showModal('Feedback', el('p', { className: 'hint', textContent: 'Asking the configured AI…' }));
  try {
    const result = await api('/ai/feedback', {
      method: 'POST',
      body: JSON.stringify({ entryId: entry.id, bulletId: bullet.id }),
    });
    showModal(
      result.executed
        ? `Feedback — ${bulletName(entry, bullet)}`
        : 'AI is off — this is the prompt it would have run',
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
 * Settings                                                            *
 * ------------------------------------------------------------------ */

const AI_PRESETS = [
  { label: 'Claude Code', command: 'claude', args: ['-p', '{prompt}'] },
  { label: 'Codex CLI', command: 'codex', args: ['exec', '{promptText}'] },
  { label: 'Gemini CLI', command: 'gemini', args: ['-p', '{promptText}'] },
  { label: 'Custom…', command: '', args: [] },
];

async function loadSettings() {
  const config = await api('/config');
  const box = $('#settings');

  const field = (labelText, input, note) =>
    el('label', { className: 'f' }, [
      el('div', { className: 'lbl', textContent: labelText }),
      input,
      note ? el('div', { className: 'hint', textContent: note }) : null,
    ]);

  const enabled = el('input', { type: 'checkbox', checked: config.ai.enabled });
  const command = el('input', { type: 'text', value: config.ai.command });
  const args = el('input', { type: 'text', value: (config.ai.args ?? []).join(' ') });
  const timeout = el('input', { type: 'text', value: String(Math.round(config.ai.timeoutMs / 1000)) });

  const preset = el('select');
  for (const p of AI_PRESETS) preset.append(el('option', { value: p.label, textContent: p.label }));
  const matching = AI_PRESETS.find(
    (p) => p.command === config.ai.command && p.args.join(' ') === (config.ai.args ?? []).join(' '),
  );
  preset.value = matching?.label ?? 'Custom…';
  preset.onchange = () => {
    const chosen = AI_PRESETS.find((p) => p.label === preset.value);
    if (!chosen || chosen.label === 'Custom…') return;
    command.value = chosen.command;
    args.value = chosen.args.join(' ');
  };

  const engine = el('select');
  for (const e of ['', 'tectonic', 'latexmk', 'pdflatex']) {
    engine.append(
      el('option', { value: e, textContent: e || 'Auto-detect', selected: (config.latex.engine ?? '') === e }),
    );
  }

  const autoCommit = el('input', { type: 'checkbox', checked: config.git.autoCommit });
  const result = el('div', { className: 'result idle', textContent: 'Not tested yet.' });

  const save = async () => {
    const seconds = Number(timeout.value);
    await api('/config', {
      method: 'PUT',
      body: JSON.stringify({
        ai: {
          enabled: enabled.checked,
          command: command.value.trim(),
          // The template is whitespace-separated; `{prompt}` becomes the path
          // to a file holding the prompt, `{promptText}` the prompt itself.
          args: args.value.split(/\s+/).filter(Boolean),
          timeoutMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 180_000,
        },
        latex: { engine: engine.value || undefined },
        git: { autoCommit: autoCommit.checked },
      }),
    });
    setStatus('Settings saved');
  };

  setChildren(
    box,
    el('label', { className: 'check', style: 'margin-bottom:12px' }, [
      enabled,
      el('span', {}, 'Let the tool run the AI command'),
    ]),
    config.overrides.ai
      ? el('div', { className: 'override', textContent: 'RMM_AI=0 is set, so the AI stays off whatever this says.' })
      : null,
    field('Preset', preset),
    field('Command', command, 'Must be on your PATH.'),
    field('Arguments', args, '{prompt} is a file holding the prompt; {promptText} inlines it.'),
    field('Timeout, seconds', timeout),
    field('LaTeX engine', engine, 'Auto-detect tries tectonic, then latexmk, then pdflatex.'),
    el('label', { className: 'check', style: 'margin:12px 0' }, [
      autoCommit,
      el('span', {}, 'Commit every change to the store'),
    ]),
    config.overrides.autoCommit
      ? el('div', { className: 'override', textContent: 'RMM_AUTOCOMMIT=0 is set, so nothing is committed.' })
      : null,
    el('div', { className: 'row' }, [
      el('button', { className: 'primary', textContent: 'Save', onclick: () => save().catch((e) => setStatus(e.message, true)) }),
      el('button', {
        textContent: 'Save and test',
        onclick: async () => {
          try {
            await save();
            result.className = 'result idle';
            result.textContent = 'Running…';
            const test = await api('/config/test-ai', { method: 'POST' });
            if (test.ok) {
              result.className = 'result ok';
              result.textContent = `${test.command} replied in ${(test.ms / 1000).toFixed(1)}s: ${test.output.slice(0, 160)}`;
            } else {
              result.className = 'result bad';
              result.textContent = test.message;
            }
          } catch (err) {
            result.className = 'result bad';
            result.textContent = err.message;
          }
        },
      }),
    ]),
    result,
  );
}

/* ------------------------------------------------------------------ *
 * History                                                             *
 * ------------------------------------------------------------------ */

let selectedCommit = null;

async function loadHistory() {
  const { commits } = await api('/history?limit=80');
  const list = $('#commits');

  if (commits.length === 0) {
    list.replaceChildren(
      el('div', { className: 'empty' }, [
        el('b', {}, 'No history yet'),
        'The store is not a git repository, or nothing has been committed. Run ',
        el('code', {}, 'rmm serve'),
        ' once and it will be initialised.',
      ]),
    );
    return;
  }

  list.replaceChildren(
    ...commits.map((c) =>
      el(
        'div',
        {
          className: `commit${c.hash === selectedCommit ? ' selected' : ''}`,
          onclick: () => showCommit(c.hash),
        },
        [
          el('div', { className: 'msg', textContent: c.message }),
          el('div', {
            className: 'meta',
            textContent: `${c.hash.slice(0, 8)} · ${formatWhen(c.date)}`,
          }),
        ],
      ),
    ),
  );
}

/** Dates in a history are read as "how long ago", not as timestamps. */
function formatWhen(iso) {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${plural(mins, 'minute')} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${plural(days, 'day')} ago`;
  return new Date(then).toISOString().slice(0, 10);
}

async function showCommit(hash) {
  selectedCommit = hash;
  const panel = $('#commit-detail');
  panel.replaceChildren(el('p', { className: 'hint', textContent: 'Loading…' }));
  await loadHistory();

  try {
    const c = await api(`/history/${encodeURIComponent(hash)}`);
    setChildren(
      panel,
      el('h3', { textContent: c.message }),
      el('div', {
        className: 'sub',
        textContent: `${c.hash.slice(0, 10)} · ${c.author} · ${formatWhen(c.date)}`,
      }),
      c.body ? el('p', { className: 'hint commit-body', textContent: c.body }) : null,
      ...c.files.map((f) =>
        el('div', { className: 'file-row' }, [
          el('span', { className: 'add', textContent: f.added === null ? '—' : `+${f.added}` }),
          el('span', { className: 'del', textContent: f.removed === null ? '—' : `−${f.removed}` }),
          el('span', { textContent: f.path }),
        ]),
      ),
      renderDiff(c.diff),
    );
  } catch (err) {
    panel.replaceChildren(el('div', { className: 'err', textContent: err.message }));
  }
}

/** A unified diff, coloured. Reading a patch as flat text is unpleasant. */
function renderDiff(diff) {
  if (!diff?.trim()) return el('p', { className: 'hint', textContent: 'No textual changes.' });

  const pre = el('pre');
  for (const line of diff.split('\n')) {
    let cls = '';
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
    else if (line.startsWith('@@')) cls = 'hunk';
    else if (/^(diff |index |\+\+\+ |--- |new file|deleted file|similarity|rename )/.test(line)) cls = 'meta';
    pre.append(el('div', { className: `line ${cls}`.trim(), textContent: line || ' ' }));
  }
  return el('div', { className: 'diff' }, [pre]);
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
      if (btn.dataset.tab === 'history') loadHistory().catch((e) => setStatus(e.message, true));
      if (btn.dataset.tab === 'voice') {
        api('/voice').then(({ voice }) => ($('#voice').value = voice));
        loadSettings().catch((e) => setStatus(e.message, true));
      }
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
    clearEdits();
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
