/** Project files and source-backed resume drafts. */
export function setupAssets({ api, el, setChildren, readAsBase64, flushEdits, isDirty, reloadStore, entryName, status, projectChanged, loadProjectSettings }) {
  const $ = s => document.querySelector(s);
  let project;
  let importing = false;
  let signature = '';
  let shown = [];
  const report = error => status(error.message, true);
  const action = fn => async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await fn(); } catch (error) { report(error); }
    finally { button.disabled = false; }
  };
  /*
   * Whether the job title goes in a produced filename.
   *
   * Lives beside the output folder because that is what it is about. Off by
   * default: most of the time the reviewer opening the attachment already
   * knows which role they advertised, and a longer name is a worse one. It
   * earns its place when several applications are open at once and you want to
   * tell them apart in a file picker without opening them.
   */
  /*
   * Shown as the names themselves rather than described, because the only
   * question anyone has here is what the file in the picker will be called.
   * The second shape shows both files: it is the one that cannot tell a resume
   * from a cover letter on its own, and seeing the type come back on exactly
   * the two that would have clashed explains that better than a sentence.
   */
  const NAME_EXAMPLES = {
    type: 'Jane-Doe-Resume.pdf, Jane-Doe-Cover-Letter.pdf',
    title: 'Jane-Doe-Software-Engineer-Resume.pdf, Jane-Doe-Software-Engineer-Cover-Letter.pdf',
    'title-type': 'Jane-Doe-Software-Engineer-Resume.pdf, Jane-Doe-Software-Engineer-Cover-Letter.pdf',
  };

  async function refreshFileNaming() {
    const config = await api('/config');
    const shape = config.output?.fileNames ?? 'type';
    const picker = $('#output-file-names');
    if (!picker) return;
    picker.value = shape;
    $('#output-name-example').textContent = NAME_EXAMPLES[shape] ?? NAME_EXAMPLES.type;
  }

  async function refreshProject() {
    project = await api('/projects');
    projectChanged(project.current);
    const open = Boolean(project.current);
    const folderName = open ? project.current.split('/').pop() : null;
    const name = folderName === 'store' ? 'Resume Save' : folderName;
    $('#project-current').textContent = project.current || 'No Save Open';
    $('#project-output').textContent = open ? `Generated Files: ${project.output}` : '';
    if (open) await refreshFileNaming();
    $('#project-chip').textContent = open ? `Save: ${name}` : 'Open Save…';
    $('#project-chip').title = project.current || 'Open or create a save';
    $('#project-status').textContent = open ? `Open Save: ${name}` : 'No Save Open';
    $('#project-banner-path').textContent = project.current || 'Open or create a save to access resumes, applications, and files.';
    /*
     * The banner is for the state that stops everything: no save open, so
     * nothing on any tab can work, and the way out has to be impossible to
     * miss.
     *
     * Once one is open it had nothing left to say. It repeated the chip in
     * the header word for word — "Save: jh-store" up there, "Open Save:
     * jh-store" here — and added the folder's full path, so every screen in
     * the application carried a row of somebody's filesystem across the top
     * of it, permanently, to answer a question nobody asks twice. The chip
     * still names the save, and still gives the whole path on hover; Save &
     * Files gives it in full.
     */
    $('#project-banner').hidden = open;
    document.title = open ? `${name} — ResumeM-M` : 'ResumeM-M';
    $('#project-description').textContent = project.openedBy === 'restored'
      ? 'This save was reopened from your last session. All visible resumes and applications belong to this folder.'
      : open ? 'All visible resumes, applications, settings, and imported files belong to this save.'
      : 'Choose the folder that owns your resumes, applications, settings, and source files.';
    $('#project-close').hidden = !open;
    $('#project-welcome').hidden = open;
    document.querySelectorAll('[data-project-required]').forEach(node => { node.hidden = !open; });
    document.querySelectorAll('#tabs button').forEach(button => { button.disabled = !open && button.dataset.tab !== 'save'; });
    $('#project-mode').querySelector('[value="move"]').disabled = !open;
    setChildren($('#project-recents'), el('option', { value: '', textContent: 'Recent Saves…' }),
      project.recent.filter(p => p !== project.current).map(p => el('option', { value: p, textContent: p })));
    /*
     * There are two ways to have no save open, and they want different things
     * said. One is a machine with saves on it that simply has not been pointed
     * at one yet — that wants a list to pick from. The other is a machine with
     * nothing at all, where a chooser offering nothing to choose reads as a
     * fault: that one wants to be told plainly that there is no save yet and
     * offered the one thing that will help, which is making one.
     */
    const knownSaves = [project.suggested, ...project.recent].filter(Boolean);
    const nothingAtAll = !open && knownSaves.length === 0;
    $('#project-welcome-title').textContent = nothingAtAll ? 'No Save Yet' : 'No Save Open';
    $('#project-welcome-message').textContent = nothingAtAll
      ? 'There is nothing to open on this computer yet. Create a save and it becomes the home for your resumes, applications, imported files, and settings.'
      : 'Open a save folder or create a blank save to begin. Resumes, applications, imported files, and settings belong to that save.';

    setChildren($('#project-existing'), nothingAtAll
      ? el('button', { className: 'primary', textContent: 'Create a Save…', onclick: () => {
          $('#project-mode').value = 'create';
          // Through the one handler, so the button and the field's label both
          // follow. Setting the button text here left the label saying "Folder
          // to open" above a box you are about to create a folder in.
          $('#project-mode').onchange?.();
          $('#project-path').focus();
        } })
      : project.suggested ? [
        el('p', { textContent: 'Existing data was found in this folder. Open it as a save to continue working with it.' }),
        el('p', { className: 'mono-path', textContent: project.suggested }),
        el('button', { className: 'primary', textContent: 'Open Existing Save', onclick: action(async () => {
          $('#project-path').value = project.suggested;
          $('#project-mode').value = 'open';
          $('#project-mode').onchange?.();
          await changeProject();
        }) }),
      ] : el('p', { className: 'hint', textContent: 'Choose Open Existing Save or Create Blank Save on the left.' }));
    $('#project-override').textContent = project.environmentOverride
      ? 'Opened from launch settings. A terminal launched with RMM_DATA will use that folder again.' : '';
    const defaults = [...new Set([project.current, project.defaultFolder, ...project.recent].filter(Boolean))];
    setChildren($('#save-default'), el('option', { value: '', textContent: 'Ask Me on Startup' }),
      defaults.map(dir => el('option', { value: dir, textContent: dir })));
    $('#save-default').value = project.defaultFolder || '';
    $('#save-default-current').hidden = !open;
    $('#save-default-current').disabled = project.defaultFolder === project.current;
    $('#save-default-status').textContent = project.defaultFolder
      ? 'This save will open automatically at startup. You can switch or close it at any time.'
      : 'ResumeM-M will start with the save chooser.';
    if (project.startupError) status(project.startupError, true);
    return project;
  }

  async function changeProject() {
    if (importing) throw new Error('Wait for the import batch to finish');
    await flushEdits();
    if (isDirty()) throw new Error('Your edits could not be saved. Retry saving before changing saves.');
    const mode = $('#project-mode').value;
    /*
     * Cloning reaches the network and can take a while — long enough that a
     * button which does nothing visible reads as a button that did not work.
     */
    if (mode === 'clone') status('Cloning the save…');
    await api('/projects/switch', {
      method: 'POST',
      body: JSON.stringify({
        dir: $('#project-path').value.trim(),
        mode,
        ...(mode === 'clone' ? { url: $('#project-url')?.value.trim() ?? '' } : {}),
      }),
    });
    // A fresh page clears previews, cached selections, and all project-specific UI.
    location.hash = 'save';
    location.reload();
  }
  function readDirectory(entry) {
    if (entry.isFile) return new Promise((resolve, reject) => entry.file(file => resolve([file]), reject));
    if (!entry.isDirectory) return Promise.resolve([]);
    const reader = entry.createReader();
    return (async () => {
      const files = [];
      while (true) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) if (!child.name.startsWith('.')) files.push(...await readDirectory(child));
      }
      return files;
    })();
  }
  async function importFiles(files) {
    if (importing || !files.length) return;
    importing = true;
    const progress = $('#asset-progress');
    const failures = [];
    let duplicates = 0;
    const known = new Set(shown.map(a => a.id));
    $('#asset-drop').classList.add('busy');
    try {
      for (const [i, file] of files.entries()) {
        progress.textContent = `${i + 1} / ${files.length} — Reading and sorting ${file.name}…`;
        try {
          if (file.size > 20 * 1024 * 1024) throw new Error('Larger than 20 MB');
          const asset = await api('/assets/import', { method: 'POST', body: JSON.stringify({ name: file.name, data: await readAsBase64(file), generate: $('#asset-generate').checked }) });
          if (known.has(asset.id)) duplicates++;
          known.add(asset.id);
          if (asset.error) failures.push(`${file.name}: ${asset.error}`);
        } catch (error) { failures.push(`${file.name}: ${error.message}`); }
        await refresh();
      }
      progress.textContent = `Finished ${files.length} files${duplicates ? ` · ${duplicates} duplicates skipped` : ''}.${failures.length ? '\n' + failures.join('\n') : ' Ready to review below.'}`;
    } finally { importing = false; $('#asset-drop').classList.remove('busy'); }
  }
  function detail(title, text) {
    return el('details', {}, [el('summary', { textContent: title }), el('pre', { className: 'asset-source', textContent: text })]);
  }
  async function renderAssets(data) {
    const store = await api('/store');
    $('#asset-ai-state').textContent = store.config.ai.enabled
      ? 'AI is enabled. Draft points stay here until you review and add them to an entry.'
      : 'AI is off. Files are sorted with local rules; generation provides a prompt to copy. Enable AI in Voice & AI to generate points here.';
    const filter = $('#asset-filter').value;
    const assets = data.assets.filter(a => !filter || (filter === 'error' ? a.status === 'error' : a.items.some(item => item.kind === filter)));
    setChildren($('#asset-list'), assets.length ? assets.map(asset => {
      const generate = el('button', { textContent: asset.status === 'error' ? 'Retry / Generate Points' : 'Generate Points', disabled: asset.status === 'processing', onclick: action(async () => {
        status(`Generating points from ${asset.name}…`);
        const result = await api(`/assets/${asset.id}/generate`, { method: 'POST', body: '{}' });
        if (result.error) throw new Error(result.error);
        await refresh(true);
      }) });
      return el('article', { className: 'asset-card' }, [
        el('div', { className: 'toolbar' }, [el('h3', { textContent: asset.name }), el('span', { className: 'grow' }),
          el('a', { href: `/api/assets/${asset.id}/original`, textContent: 'Original', download: asset.name }), generate]),
        el('p', { className: 'hint', textContent: `${Math.ceil(asset.size / 1024)} KB · ${asset.status} · ${asset.usedAi ? 'AI sorted' : 'Local sorting'} · ${[...new Set(asset.items.map(i => ({ resume: 'Resume', letter: 'Letter', answer: 'Answer', other: 'Notes & Other' })[i.kind]))].join(', ') || 'Unsorted'}` }),
        asset.error ? el('p', { className: 'result err', textContent: asset.error }) : null,
        asset.aiError ? el('p', { className: 'hint', textContent: `Used local sorting: ${asset.aiError}` }) : null,
        detail('Sorted Source Material', asset.items.map(i => `${i.kind.toUpperCase()} — ${i.title}\n\n${i.text}`).join('\n\n————\n\n')),
        asset.items.length ? el('button', { className: 'tiny', textContent: 'Add Source Text to Voice', onclick: action(async () => {
          await api('/voice/ingest/accept', { method: 'POST', body: JSON.stringify({ source: asset.name, items: asset.items }) });
          status('Source text added to your writing samples.');
        }) }) : null,
        asset.hasPrompt ? el('button', { textContent: 'Show Generation Prompt', onclick: action(async () => {
          const full = await api(`/assets/${asset.id}`);
          const old = document.getElementById(`prompt-${asset.id}`);
          if (old) { old.remove(); return; }
          const node = detail('Copy this prompt into your AI', full.prompt || 'No prompt stored.');
          node.id = `prompt-${asset.id}`; node.open = true; generate.parentElement.parentElement.append(node);
        }) }) : null,
        !asset.points.length ? el('p', { className: 'hint', textContent: 'No draft points yet. Generate points to turn evidence of your work into resume bullets.' }) : null,
        ...asset.points.map(point => {
          const text = el('textarea', { value: point.text, rows: 3, disabled: Boolean(point.entryId), 'ariaLabel': 'Draft resume point' });
          const target = el('select', { title: 'Entry to add this point to' }, [el('option', { value: '', textContent: 'Choose an Entry…' }),
            ...store.entries.filter(e => !e.archived).map(e => el('option', { value: e.id, textContent: entryName(e) })),
            el('option', { value: '__new', textContent: '+ New Entry…' })]);
          const title = el('input', { placeholder: 'Company, project, or school name', hidden: true });
          const kind = el('select', { hidden: true }, ['project', 'experience', 'education', 'custom'].map(value => el('option', { value, textContent: value[0].toUpperCase() + value.slice(1) })));
          target.onchange = () => { title.hidden = kind.hidden = target.value !== '__new'; };
          return el('div', { className: 'asset-point' }, [text, detail('Source evidence — check the claim against this', point.evidence),
            point.entryId ? el('p', { className: 'hint', textContent: `Added to ${entryName(store.entries.find(e => e.id === point.entryId) || { title: point.entryId })}` })
              : el('div', { className: 'toolbar' }, [target, title, kind, el('button', { textContent: 'Add Reviewed Point', onclick: action(async () => {
                let entryId = target.value;
                if (!entryId) throw new Error('Choose an entry first');
                if (!text.value.trim()) throw new Error('Write a point first');
                if (entryId === '__new') {
                  if (!title.value.trim()) throw new Error('Name the new entry first');
                  entryId = `asset_${crypto.randomUUID()}`;
                  await api(`/entries/${entryId}`, { method: 'PUT', body: JSON.stringify({ id: entryId, kind: kind.value, title: title.value.trim(), bullets: [] }) });
                  target.append(el('option', { value: entryId, textContent: title.value.trim() })); target.value = entryId;
                }
                await api(`/assets/${asset.id}/points/${point.id}/accept`, { method: 'POST', body: JSON.stringify({ entryId, text: text.value }) });
                await reloadStore(); await refresh(true); status('Point added. Include the entry in Resumes to use it on a resume.');
              }) })]),
          ]);
        }),
      ]);
    }) : el('div', { className: 'empty' }, [el('b', { textContent: 'Your source library starts here' }), 'Drop resumes, project notes, reviews, and past applications above. Originals and draft points stay with this save.']));
  }
  async function refresh(force = false) {
    if (!project?.current) return;
    const data = await api('/assets');
    $('#asset-inbox').textContent = data.inbox;
    $('#asset-watch').checked = data.settings.watch;
    $('#asset-generate').checked = data.settings.generate;
    shown = data.assets;
    const next = JSON.stringify(data.assets);
    if (force || signature !== next) { signature = next; await renderAssets(data); }
  }
  $('#project-chip').onclick = () => document.querySelector('[data-tab="save"]').click();
  async function saveDefault(dir) {
    const result = await api('/projects/default', { method: 'PUT', body: JSON.stringify({ dir: dir || null }) });
    project.defaultFolder = result.defaultFolder;
    $('#save-default').value = result.defaultFolder || '';
    $('#save-default-current').disabled = result.defaultFolder === project.current;
    $('#save-default-status').textContent = result.defaultFolder ? 'This save will open automatically at startup.' : 'ResumeM-M will start with the save chooser.';
    status('Startup preference saved');
  }
  $('#save-default').onchange = action(async () => {
    try { await saveDefault($('#save-default').value); }
    catch (error) { $('#save-default').value = project.defaultFolder || ''; throw error; }
  });
  $('#save-default-current').onclick = action(() => saveDefault(project.current));
  $('#project-switch').onclick = action(changeProject);
  $('#project-close').onclick = action(async () => {
    if (importing) throw new Error('Wait for the import batch to finish');
    await flushEdits();
    if (isDirty()) throw new Error('Save your edits before closing this save');
    await api('/projects/close', { method: 'POST', body: '{}' });
    location.hash = 'save';
    location.reload();
  });
  /*
   * The button already followed the action; the field above it did not.
   *
   * It was labelled "Save Folder" — the same two words as the heading at the
   * top of this column, which names the save that is currently open. Two
   * different things with one name, four hundred pixels apart, and the one
   * that means "type a path here" is the second.
   */
  const PATH_LABEL = {
    open: 'Folder to open',
    create: 'Where to create it',
    clone: 'Where to put it',
    move: 'Where to move it',
  };
  $('#project-mode').onchange = () => {
    const mode = $('#project-mode').value;
    $('#project-switch').textContent = ({ open: 'Open Save', create: 'Create Save', clone: 'Clone Save', move: 'Move Save' })[mode];
    const label = document.querySelector('label[for="project-path"]');
    if (label) label.textContent = PATH_LABEL[mode] ?? 'Folder to open';
    /*
     * The address box only exists for the one mode that needs it. A field
     * that is permanently on screen and permanently ignored teaches people to
     * ignore the ones that are not.
     */
    const urlRow = $('#project-url-row');
    if (urlRow) urlRow.hidden = mode !== 'clone';
  };
  // The markup ships the "open" wording; run once so a restored mode agrees.
  $('#project-mode').onchange?.();
  $('#project-recents').onchange = event => { $('#project-path').value = event.target.value; $('#project-mode').value = 'open'; $('#project-mode').onchange(); };
  const native = window.webkit?.messageHandlers?.chooseProjectFolder;
  $('#project-browse').hidden = !native;
  $('#project-browse').onclick = () => native.postMessage({});
  window.rmmFolderChosen = path => { if (path) $('#project-path').value = path; };
  $('#asset-add').onclick = () => $('#asset-files').click();
  $('#asset-add-folder').onclick = () => $('#asset-folder').click();
  for (const id of ['asset-files', 'asset-folder']) $( `#${id}`).onchange = event => { const files = [...event.target.files]; event.target.value = ''; importFiles(files).catch(report); };
  const zone = $('#asset-drop');
  zone.onclick = () => $('#asset-files').click();
  zone.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); zone.click(); } };
  zone.ondragover = event => { event.preventDefault(); zone.classList.add('over'); };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = async event => {
    event.preventDefault(); zone.classList.remove('over');
    const entries = [...(event.dataTransfer.items || [])].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    const fallback = [...event.dataTransfer.files];
    try { await importFiles(entries.length ? (await Promise.all(entries.map(readDirectory))).flat() : fallback); } catch (error) { report(error); }
  };
  const naming = $('#output-file-names');
  if (naming) {
    let lastShape = naming.value;
    naming.onchange = async () => {
      naming.disabled = true;
      try {
        await api('/config', {
          method: 'PUT',
          body: JSON.stringify({ output: { fileNames: naming.value } }),
        });
        lastShape = naming.value;
        await refreshFileNaming();
        status('New files will use that shape. Files already built keep their names.');
      } catch (error) {
        report(error);
        naming.value = lastShape;
      } finally {
        naming.disabled = false;
      }
    };
  }

  for (const id of ['asset-watch', 'asset-generate']) $(`#${id}`).onchange = action(async () => {
    await api('/assets/settings', { method: 'PUT', body: JSON.stringify({ watch: $('#asset-watch').checked, generate: $('#asset-generate').checked }) });
  });
  $('#asset-filter').onchange = () => refresh(true).catch(report);
  $('#asset-refresh').onclick = action(() => refresh(true));
  setInterval(() => {
    if ($('#tab-save').classList.contains('active') && !importing && !$('#asset-list').contains(document.activeElement)) refresh().catch(report);
  }, 5000);
  return { init: refreshProject, load: async () => { if (project?.current) await Promise.all([refresh(true), loadProjectSettings()]); } };
}
