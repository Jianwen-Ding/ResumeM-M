# ResumeM-M

A local, file-backed resume system built around one idea:

> **A resume is not a document. It is a set of choices over a store of things you could say.**

Every bullet point and every varying field lives in exactly one place in a YAML
store, holding all of its phrasings. A "resume" is a short file that picks among
them. Edit the canonical text once and every resume that points at it moves.

It compiles Jake Gutierrez's LaTeX template through a real LaTeX engine, and
enforces a strict one-page limit by measuring the actual typeset height.

Companion browser extension: [JobHelper](https://github.com/Jianwen-Ding/JobHelper).

---

## Why

| The problem | How this addresses it |
| --- | --- |
| Switching between new-grad and intern applications means editing a graduation date in several files | The date is one field with two variants. `newgrad.yaml` and `intern.yaml` are four lines each and differ by one line. |
| Mixing and matching projects per posting creates a pile of near-duplicate files | A tailored resume is a `choices` map that inherits from a base. Nothing is copied. |
| Updating one point means editing it across every variation | There is only ever one copy of the text. Every resume references it. |
| Rename → download → re-upload with Google Docs | `rmm apply` writes a folder with `Your Name Resume Company.pdf`, named the way portals expect. |
| Re-explaining to an AI chat how to give feedback and write in your voice | `voice.md` and the prompt templates live in the repo and are prepended to every request. |
| Filling in redundant forms | The extension autofills from `profile.yaml` and a bank of reusable answers. |

---

## Getting started

```bash
npm install

# You need a LaTeX engine. Any one of these:
#   tectonic   — recommended, one binary, fetches its own packages
#   latexmk / pdflatex — from TeX Live or MacTeX
npm run rmm -- list          # what's in the store
npm run rmm -- build newgrad # → out/newgrad.pdf
npm run serve                # editor GUI at http://127.0.0.1:4600
```

The sample store under `data/` is a working example. Replace it with your own
content; the structure is the documentation.

### Mac app

On macOS, install a native app with its own window, Dock icon, and Spotlight entry:

```bash
npm run mac:install
```

Then press **⌘ Space**, search **ResumeM-M**, and open it. The installer puts
`ResumeM-M.app` in `~/Applications`. You can also drag it onto the Dock.
The app starts its local server automatically; Terminal does not need to stay open.
Closing the window keeps the app and extension API available; **⌘ Q** quits the
app and its server. If a matching server was already running, the app reuses it
and leaves it running when you quit. JobHelper still connects on port 4600.

The app uses your existing store (normally `~/.resumem-m/store`). If you use
`RMM_DATA`, set it when installing to select that store. The **Save & Files → Save Folder** controls let you create, open, close, or move a save and choose a default folder for startup. **File → Show Save Folder** opens it in Finder. No personal data is moved by the installer.

Building requires macOS 12+, Xcode Command Line Tools, installed npm
dependencies, and Node.js 20+. The installed app includes a snapshot of the
editor and server, and uses the Node.js installation already on this Mac.
LaTeX and any configured AI command also remain external tools. The installer
preserves their command search path so they work when launched from Spotlight.
Run `npm run mac:install` again after code updates or changing the Node location
(quit the app first). This is a locally signed app for this Mac, not a notarized
distribution for other machines.

`npm run mac:build` builds `dist/macos/ResumeM-M.app` without installing it.
`npm run mac:smoke` checks the packaged server using a disposable store.
Startup errors are logged to `~/Library/Logs/ResumeM-M/server.log`.

### Save Folders and Files

Open **Save & Files** to drop a batch of files or a whole folder. Originals are copied
into `assets/originals/`, sorted source material and draft points are saved in
`assets/records/`, and duplicate file contents are imported only once. Each file
can be up to 20 MB. PDF, Word (`.docx`), Markdown, plain text, LaTeX, HTML, RTF,
and text-based data files are supported. Scanned PDFs need a text layer; this
importer does not perform OCR. Failed imports keep their originals and can be retried.

Leave **Generate draft points after sorting** checked to draft resume bullets
with the configured AI. Each draft includes a source quote: edit the wording,
check the claim, choose an existing or new entry, and click **Add reviewed
point**. Add that entry to a resume in Resumes when you want to use it. Imported
material only enters the Voice corpus when you click **Add source text to
Voice**. With AI off, local rules sort the files and generation gives you a
copyable prompt. Generation uses the first 60,000 extracted characters of each
file; the complete extracted text and original remain saved.

For files saved from other apps, enable **Automatically import the inbox** and
save them inside the displayed `assets/inbox/` folder. ResumeM-M checks that
folder and its subfolders every five seconds while running. It leaves inbox
files in place and skips duplicates, hidden files, symlinks, unsupported formats,
and files over 20 MB. Turn the checkbox off to stop importing.

The **Save Folder** panel manages the folder containing your saved work:

- **Create** starts a blank save in a new or empty folder, with `assets/` and
  `out/` inside it.
- **Open** switches to an existing save; recent folders are listed for quick
  switching.
- **Move** copies the store, its git history, assets, and generated output to an
  empty destination, then switches future saves there. The original folder is
  retained as a backup. Existing destination files are never overwritten.

Choose **Default Save Folder** to configure the save that opens automatically
at startup, or select **Ask Me on Startup**. Changing this preference does not
switch the currently open save. **Close Save** returns to the chooser and keeps
all files on disk. Without an open save, resume and application tabs, imports,
and the extension's data endpoints are unavailable. A missing default folder
returns to the chooser with an error; it never recreates example data.

The old default folder is offered as **Open Existing Save** when present. It is
not silently opened on a fresh installation. An explicit terminal `RMM_DATA`
or CLI data directory still opens the requested save directly. Existing saved
folder preferences continue to work until you change the startup setting.
The current save name and full path are always shown above the editor.

The Mac app offers a native folder chooser; the browser editor accepts an
absolute folder path or `~/...`. Save-folder preferences are remembered in
`~/.resumem-m/projects.json` (`RMM_PROJECTS_FILE` can override this for testing).
An explicit terminal `RMM_DATA` still takes precedence on that terminal's next
launch. Other open editor windows must reload after a switch before saving.

### Required LaTeX packages

The template uses `titlesec`, `enumitem`, `fancyhdr`, `tabularx`, `hyperref`,
`scrextend` (KOMA), and `zref-savepos`/`zref-abspage`. Tectonic fetches these
automatically. On TeX Live, `texlive-latex-recommended` and
`texlive-latex-extra` cover them.

---

## The store

```
data/
  profile.yaml       Name, contact details, and form-autofill fields
  education.yaml     ┐
  experience.yaml    ├ entries, each with bullets, each with variants
  projects.yaml      ┘
  skills.yaml        Skill groups, individually selectable items
  resumes/*.yaml     One file per resume — the choices, not the content
  answers.yaml       Reusable answers to application questions
  letters/*.md       Cover letters, with front-matter
  applications.yaml  The tracker
  voice.md           Standing instructions handed to any AI
  config.yaml        Engine, AI command, git, output directory
```

### It is its own repository

The store is kept apart from this source tree on purpose: it has a different
lifetime, it is the thing you might push somewhere private, and it should
survive deleting and re-cloning the code.

Which is also how you get it onto a second machine:

```bash
rmm clone git@github.com:you/my-resume-save.git ~/Documents/My\ Resume\ Save
```

or, in the editor, **Save & Files → Folder Action → Clone Save from Git**.
Either way the clone is staged beside the destination and checked before it
becomes the open save — a repository that turns out to hold something else is
refused and the folder it was cloned into goes with it.

### Variants

A field that can differ between resumes holds its alternates inline:

```yaml
- id: edu_neu
  kind: education
  title: Northeastern University
  dates:
    default: v_may2026
    variants:
      - id: v_may2026
        label: May 2026 (new grad)
        text: Sep. 2022 -- May 2026
        tags: [newgrad]
      - id: v_dec2026
        label: Dec 2026 (intern)
        text: Sep. 2022 -- Dec. 2026
        tags: [intern]
        note: Later date keeps intern eligibility for summer 2026.
```

Bullets work the same way, and this is where most of the value is — one piece of
real work, several angles on it:

```yaml
bullets:
  - id: b_ec_pipeline
    default: v_base
    variants:
      - id: v_base
        label: Neutral
        text: Built an event-processing pipeline handling **2M events/day**, cutting median latency from 900ms to 180ms
        tags: [backend, performance]
      - id: v_kafka
        label: Kafka-forward
        text: Built a `Kafka`-backed event-processing pipeline handling **2M events/day**, …
        tags: [kafka, streaming, distributed]
      - id: v_short
        label: Short (one line)
        text: Built an event pipeline handling **2M events/day**, cutting median latency 900ms to 180ms
        tags: [short]
        note: For when the resume is one line over. Same claim, tighter.
```

`**bold**`, `*italic*`, `` `code` ``, and `[text](url)` are supported in any
text field. Everything else is escaped, so `R&D` and `50%` are safe to type.

### Resumes

A resume selects; it does not contain.

```yaml
# data/resumes/intern.yaml — the entire file
id: intern
label: Summer intern
extends: base
choices:
  edu_neu.dates: v_dec2026
```

Keys in `choices` are either a bullet id (`b_ec_pipeline`) or a field path
(`edu_neu.dates`). `extends` merges the parent's sections and choices, with the
child winning. A posting-specific resume is usually three or four overrides on
top of `intern` or `newgrad` — and because it inherits, a later fix to a bullet
still reaches it.

A choice that matches nothing is reported as a warning rather than silently
ignored, since a renamed id is exactly how a resume quietly reverts to the wrong
graduation date.

---

## The one-page rule

The limit is enforced against what LaTeX actually typeset, not an estimate:

1. Compile.
2. Read the page count from `\@abspage@last` in the `.aux`.
3. Read the start and end content positions recorded by `zref-savepos`, which
   gives the real height used in points.

If it does not fit, auto-fit searches the font-size / leading / margin family
for the *least* shrinking that does, binary searching a single monotonic
parameter — so a resume that fits costs one compile, and one that can never fit
is rejected after two rather than after a dozen.

```
$ rmm build --all
base           ✓ 1 page, ~18 lines of room left  → out/base.pdf
intern-kafka   ✓ 1 page, ~17 lines of room left  → out/intern-kafka.pdf

$ rmm check overstuffed
overstuffed: ✗ 2 pages — over by 539pt (~41 lines)
```

Nothing is shrunk past the floors in `layout.fitBounds`. When even the floor is
not enough you get a number of lines to cut, not a silently unreadable PDF. Set
`autoFit: false` to be told instead of accommodated.

The **Resumes** tab combines source editing and tailored resumes in one workspace.
Choose **Master Document — All Source Content** in the resume selector to edit
shared entries and see every phrasing alongside the live master preview. Choose
a saved resume to select which entries, bullets, skills, and variants it uses.
Adding entries or phrasings in the master keeps them available without changing
a tailored resume's selections.

The same **Feedback** button follows the selected view. **Master Feedback**
reviews the source inventory, with instructions explaining that ResumeM-M
compiles smaller sub-resumes from it. It distinguishes useful variants from
duplicate claims and does not impose a one-page limit on the master. Resume and
individual-bullet feedback receive that shared-source context too. Results
open below the rendered document, so you can read them while continuing to
edit. Markdown headings, lists, emphasis, code, and tables are rendered.
Use the review picker for earlier results or **Hide** to give the preview more
room; **Feedback Results** reopens the panel. With AI off, it shows the prompt.

Double-click a heading field or bullet (or use its **…** button) to reveal its actions: wording
choices, **AI Feedback**, details, and bullet removal. Only one field or bullet's actions stay
open at a time; press **Escape** or click **×** to hide them. Text and inclusion
checkboxes stay visible while browsing.

Click **AI Feedback** beside a bullet phrasing or heading wording to critique
that exact phrase. **Compare Phrasings** reviews all versions of a bullet.
The **AI Feedback** button at the top of an entry reviews its complete heading,
bullets, and alternate phrasings together, including repetition and evidence gaps.
These requests run in the background and use the same feedback panel.
Double-clicking text still edits it.

The master document (`rmm master`) is the opposite: every entry, bullet, and
phrasing in the store across as many pages as needed, including beyond two
pages, without shrinking to fit a submission limit. It is an
inventory for deciding what to use, not something to send.

---

## Commands

```
rmm list                          What's in the store
rmm build <id> | --all            Compile to out/<id>.pdf (strict one page)
rmm check <id>                    Fit report without writing a PDF
rmm master                        Everything, for browsing
rmm feedback <id> [--focus "…"]   Ask the configured AI for a critique
rmm apply <id> --company C --role R [--url U]
                                  Named bundle + tracker entry + snapshot
rmm track                         The tracker
rmm voice add <file…>             Read files into your writing corpus, sorted
                                  into letters, answers, resumes, and the rest
rmm save [-m "why"] [--push]      Commit the whole store to git
rmm serve [--port 4600]           Editor GUI and the extension's API

Any command also takes:
  --data <folder>                 Work on the save in this folder rather than
                                  the one that is open. Beats RMM_DATA.
```

---

## AI

Configured in `data/config.yaml`, and **off by default**:

```yaml
ai:
  command: claude
  args: ["-p", "--add-dir", "{sandbox}", "--disallowedTools", "Bash,Write,Edit,WebFetch,WebSearch"]
  enabled: false
```

While disabled, every AI endpoint returns the prompt it *would* have run, so you
can paste it wherever you like and still not have to rewrite the instructions.

For Antigravity CLI (`agy`), choose **Antigravity (agy)** in Settings → Preset,
enable AI, then click **Save and test**. Sign in through `agy` first. Its preset
uses plan mode and terminal sandbox restrictions, with plain-text output:

```yaml
ai:
  command: agy
  args: ["--mode", "plan", "--sandbox", "--disable-slash-commands", "--output-format", "text", "--print={promptText}"]
  enabled: true
  timeoutMs: 180000
```

`agy` requires the prompt text as the value of `--print`; a prompt-file path
is treated as literal text, and text on stdin is not used as the prompt. Saved
`agy` print arguments using `{prompt}` are repaired when the config is loaded.
The desktop app includes `~/.local/bin` in its command search path.

Two things make this different from pasting into a chat window:

- **`voice.md` is prepended to every request.** The rules about how you write
  live in a file you edit once.
- **Your voice comes from your writing, not a description of it.** Drop files —
  PDF, Word, Markdown, LaTeX, plain text — onto the Voice tab, or run
  `rmm voice add <file…>`, and a file holding four old cover letters becomes
  four samples. The AI does the sorting by naming block numbers; the text of
  every sample is reassembled from the file, so nothing it says can end up
  stored as something you wrote.
- **Feedback prompts refuse to rewrite.** They quote the fragment, say what is
  weak, and say what would fix it. The words stay yours.

Tailoring asks for a *selection* over phrasings that already exist, which cannot
drift. New phrasings come back in a separate list, are capped at three, and are
stored with `suggested: true` until you have looked at them.

### Which model, and how hard it thinks

Settings → Voice & AI has a **Model** box and an **Effort** picker. Both are
settings rather than arguments you edit by hand: a preset is copied when you
choose it, so hand-editing the argument line turns your configuration into a
custom one that then drifts out of date with the preset it came from. They are
applied to the arguments when the config is loaded, the way the research switch
is.

Only Codex has a reasoning-effort flag. Rather than invent one for the others —
a flag a CLI does not recognise usually stops it running at all — effort is also
said in the prompt, in words, which reaches every model. The panel tells you
which mechanism is in play for the command you have configured.

Under **A different model for a particular kind of work**, each kind can name
its own and fall back to the one above when it does not:

| | |
| --- | --- |
| Tailoring a resume | Choosing which of your wordings suit a posting, and what order they go in |
| Writing letters and answers | Drafting in your voice |
| Reviewing what you wrote | Reading a resume, a letter or an answer and saying what is weak |
| Drafting new entries and wordings | Reading a repository or a note. The one that runs while you wait |

Four rather than one per endpoint: switches nobody adjusts are worse than
fewer that get used.

### Tailoring through tools, not one big JSON reply

Where the configured CLI supports MCP (Claude Code, Codex and Gemini do), the
tailoring pass gets a small tool server instead of being asked for one large
JSON object:

    read_posting      read_resume       read_inventory
    choose_wording    reorder_bullets   reorder_entries
    hide              show              choose_skills
    suggest_wording   review_changes    finish

The difference is where mistakes are caught. A JSON reply is checked once, at
the end, and everything wrong in it is dropped in silence — an id the model
half-remembered simply does not happen, and a reply wrapped in prose that will
not parse loses *every* choice rather than one. A tool call is checked as it is
made, so a wrong id comes back as "there is no bullet `b_kafka`; the bullets on
this entry are b_pipeline, b_testing" while the model can still act on it. It
can also read the page back after each move and see what it actually did.

Nothing about what it is allowed to do changes. Every tool names things that
already exist; `suggest_wording` takes text and puts it in the same quarantine
the JSON path does, where a person accepts or declines it.

The server runs inside the same empty scratch directory the CLI is confined to
— the CLI spawns it over a pipe, there is no port and no token, and the whole
exchange is two processes and a file that is deleted when the run ends. A CLI
we do not know how to wire up, or one where MCP is unavailable, falls back to
asking for JSON, which is what every run did before this existed.

Writing gets the same treatment, with the tools the job actually needs:

    read_posting     read_resume      read_work
    find_my_letters  find_my_answers  check_claim
    save_letter      save_answer      finish

`check_claim` is the one worth pointing at. A letter is read beside the resume
that supports it, so "does the resume actually say 2M events a day" is the
question it most needs answered — and it is a lookup, which a model doing it
from memory mid-sentence is about to get wrong. Ask, and it says which part of
the claim the resume carries and quotes the lines. `find_my_letters` is a
search rather than three pre-selected samples: ranking is a guess made before
anyone knows what the letter needs to say. And `save_letter` takes the letter
as an argument, which means an agent's habit of explaining itself first cannot
put "I have prepared the implementation plan in cover_letter_plan.md" at the
top of somebody's cover letter — a real run, and the reason `trimToLetter`
exists.

And getting started — turning an old resume, some cover letters and a README
into a store — has:

    list_documents   read_document   read_store
    propose_entry    propose_bullet  propose_alternate
    propose_skill    review_proposal finish

This is the one place the AI writes text that ends up on a resume, so the line
moves rather than disappearing, and it moves in exactly one place. Nothing is
written to the store: the session builds a proposal you accept entry by entry.
And every bullet must quote the sentence in your material it is a rewording
of — checked, not requested. A model that has to point at what it is
paraphrasing cannot invent a job, which is the difference between "read what I
wrote" and "write me a resume".

It runs from **Voice & AI → Read these into entries**, over the files already
in your corpus, and shows you each proposal beside the sentence it came from:

```
From your material — Vega Analytics
Backend Engineer · 2023–2024

  Built a Kafka-backed ingest pipeline handling 2M events a day
    from your material: "Built a Kafka-backed ingest pipeline handling 2M events a day."

                                            [ Skip ]  [ Add it ]
```

One at a time, on purpose. Eleven proposals behind a single "Add them all" is
eleven decisions collapsed into one, which is how a line nobody read ends up
on a resume.

---

## Application tracking

`rmm apply` (or the extension's "Prepare to submit") writes:

```
out/applications/2026-09-16-streamly-software-engineer-intern/
  Jianwen Ding Resume Streamly.pdf        ← named for upload, no renaming needed
  Jianwen Ding Cover Letter Streamly.pdf  ← typeset to match the resume
  Jianwen Ding Cover Letter Streamly.txt  ← same letter, for paste-in-a-box portals
  source/resume.tex                       ← exactly what compiled
  source/cover-letter.tex
  source/resolved.yaml                    ← the choices, frozen
```

and records the application in `applications.yaml` with its status history. The
snapshot is the point: six weeks later, when they ask about "the pipeline
project", the file that went out is still there, byte for byte.

The same files also land together in `out/current` — one flat folder holding
everything still in flight, already named, so a portal's file picker has one
place to be pointed at. It is browsable at
[`/current`](http://127.0.0.1:4600/current) as well as on disk, which is what
the extension's "Open the folder" opens.

Preparing the files is what records an application as sent. The step that
actually sends it happens inside a portal where nothing here can see it, and
the button pressed afterwards to confirm is the one nobody presses — by then
the tab is on a confirmation page. Wrong in the rare direction is cheap to fix
("Not sent after all" in the extension, or the status dropdown here); wrong in
the other means applying twice.

The Workspace keeps a sent application open for a fortnight, below the ones
still being written and greyed out — the portal that rejects an upload, and the
question that comes back a week later, both want the letter you wrote rather
than a snapshot of it. After a fortnight without a keystroke it lets itself go;
the application record keeps everything that went out.

### Saving

Every mutation made through the app is auto-committed to git, scoped to the
store directory. For everything else — YAML you edited by hand, a store that is
not a repository yet, auto-commit switched off — there is one command:

```bash
rmm save                              # commit everything in the store
rmm save -m "Before the Streamly interview"
rmm save --push                       # and send it to the remote
```

It prints what it saved, derives a message from what changed ("Save: 2 resumes,
the answer bank") when you do not give one, and says so plainly rather than
making an empty commit when there was nothing to save. The same operation is a
button in **Save & Files → Save History & Backup**, and `POST /api/store/save`.

### Version history

Every mutation is auto-committed to git, scoped to the store directory. The
**History** tab turns that into a per-resume timeline that reads like a document
history rather than a commit log: each version shows what the *resume* said
before and what it says now — a bullet reworded, a date moved, an entry gone —
and any version can be restored in one click.

Two details make it a document history:

- A version is the resume **resolved** against the whole store as it was at that
  commit. Rewording a bullet in `experience.yaml` changes what this resume
  prints, even though `resumes/newgrad.yaml` never moved, and it shows up here.
- A commit that leaves this resume's document identical — a different resume, a
  cover letter, an application — produces no version at all.

The raw commit log, with patches, is still one click away for anyone who wants
it.

---

## Local API

`npm run serve` binds to **127.0.0.1 only and has no authentication**. It is a
local tool. Do not expose it; CORS is open so the extension can reach it from a
`chrome-extension://` origin, and that is only safe on loopback.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/store` | Everything, for the GUI |
| `POST /api/render` | Compile a stored resume, an ad-hoc spec, or the master |
| `POST /api/render/letter` | Typeset a cover letter, set to match the resume |
| `POST /api/store/save` | Commit the whole store to git (optionally push) |
| `GET /api/resumes/:id/history` | That resume's versions, and what changed between them |
| `POST /api/extension/analyze` | Page HTML → proposed tailored spec |
| `GET /api/autofill` | Profile fields and the answer bank |
| `POST /api/applications/bundle` | Compile, name, file, snapshot, track |
| `POST /api/ai/feedback` \| `/tailor` \| `/cover-letter` \| `/answer` | AI paths |

---

## Tests

```bash
npm test              # the whole suite, in Node and jsdom
npm run test:editor   # the editor, driven in a real browser
```

`npm test` covers resolution, inheritance, escaping, extraction, matching, the
three-way merge that keeps two edits to one entry from overwriting each other,
and the editor's own behaviour under jsdom — including the cases where a panel
reloading used to throw away something you had typed into it. Integration tests
compile real PDFs to verify the one-page guarantee; they skip automatically
when no LaTeX engine is installed.

`test:editor` is the other half: it drives the real editor in Chromium, from
loading the store through compiling, switching a wording, undoing it, writing an
application and building its files — and it reports how long each step took
against a budget, because "it works" and "it is worth using" are different
claims.

It starts its own server on a scratch store, so it never touches yours. Point
it at a running one with `RMM_SERVER=http://127.0.0.1:4788` if you would rather
watch it work.
