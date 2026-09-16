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

The master document (`rmm master`) is the opposite: every entry, bullet, and
phrasing in the store on one long page, each labelled with its id. It is an
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
rmm save [-m "why"] [--push]      Commit the whole store to git
rmm serve [--port 4600]           Editor GUI and the extension's API
```

---

## AI

Configured in `data/config.yaml`, and **off by default**:

```yaml
ai:
  command: claude      # or codex, agy, or anything that reads a prompt file
  args: ["-p", "{prompt}"]
  enabled: false
```

While disabled, every AI endpoint returns the prompt it *would* have run, so you
can paste it wherever you like and still not have to rewrite the instructions.

Two things make this different from pasting into a chat window:

- **`voice.md` is prepended to every request.** The rules about how you write
  live in a file you edit once.
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
button in **Voice & AI → Your store**, and `POST /api/store/save`.

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
