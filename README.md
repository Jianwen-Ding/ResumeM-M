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

---

## Application tracking

`rmm apply` (or the extension's "Save application folder") writes:

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
npm test
```

53 unit tests cover resolution, inheritance, escaping, extraction, and matching.
Six integration tests compile real PDFs to verify the one-page guarantee; they
skip automatically when no LaTeX engine is installed.
