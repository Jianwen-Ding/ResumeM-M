/*
 * The store the golden documents were resolved from, written out as files.
 *
 * Shared by the generator that runs against the *old* code — the last commit
 * where resumes still inherited — and by the test that checks today's fold
 * against what it produced. Both have to lay down byte-identical stores, so
 * the fixture lives in one file and neither of them describes it twice.
 *
 * Plain YAML strings rather than the test helpers: the generator runs inside a
 * git worktree of an older commit, where those helpers are a different file.
 *
 * To regenerate the golden file after changing anything here:
 *
 *   git worktree add /tmp/old <the last commit where resumes inherited>
 *   ln -s "$PWD/node_modules" /tmp/old/node_modules
 *   cp tests/fixtures/make-golden.ts /tmp/old/
 *   (cd /tmp/old && npx tsx make-golden.ts) > tests/fixtures/pre-flatten-documents.json
 *   git worktree remove /tmp/old --force
 *
 * The commit in question is the one that added `src/model/flatten.ts`, minus
 * one. If that history is ever rewritten away, the golden file is the record
 * and must not be regenerated from this tree — resolving it here would only
 * ever confirm that this code agrees with itself.
 */

import fs from 'node:fs';
import path from 'node:path';

const FILES: Record<string, string> = {
  'profile.yaml': `
name: Test Person
email: test@example.com
phone: 555-0100
`,
  'education.yaml': `
- id: edu_neu
  kind: education
  title: Northeastern University
  subtitle: BS Computer Science
  dates:
    variants:
      - id: v_may2026
        text: Expected May 2026
      - id: v_dec2026
        text: Expected December 2026
    default: v_may2026
  bullets:
    - id: b_course
      kind: list
      lead: 'Coursework:'
      items:
        - id: c_algo
          text: Algorithms
        - id: c_db
          text: Databases
        - id: c_os
          text: Operating Systems
`,
  'experience.yaml': `
- id: exp_acme
  kind: experience
  title:
    variants:
      - id: v_long
        text: Software Engineer Co-op, Acme Co.
      - id: v_short
        text: SWE Co-op, Acme
    default: v_long
  subtitle: Boston, MA
  bullets:
    - id: b_pipeline
      variants:
        - id: v_generic
          text: Built a data pipeline handling ten million rows a day.
        - id: v_kafka
          text: Built a Kafka pipeline handling ten million rows a day.
      default: v_generic
    - id: b_testing
      variants:
        - id: v_tests
          text: Raised test coverage from forty to ninety per cent.
      default: v_tests
`,
  'projects.yaml': `
- id: proj_thing
  kind: project
  title: A Thing
  bullets:
    - id: b_thing
      variants:
        - id: v_thing
          text: Wrote a thing that does the thing.
      default: v_thing
    - id: b_stack
      kind: list
      lead: 'Built with:'
      items:
        - id: t_react
          text: React
        - id: t_node
          text: Node
        - id: t_pg
          text: Postgres
`,
  'skills.yaml': `
- id: sk_lang
  name: Languages
  items:
    - id: s_py
      text: Python
    - id: s_ts
      text: TypeScript
    - id: s_go
      text: Go
- id: sk_tools
  name: Tools
  items:
    - id: s_git
      text: Git
    - id: s_docker
      text: Docker
`,
  'answers.yaml': '[]\n',
  'applications.yaml': '[]\n',
  'config.yaml': `
ai:
  enabled: false
git:
  autoCommit: false
output:
  dir: out
`,

  /* A root that states everything. */
  'resumes/base.yaml': `
id: base
label: Base resume
base: true
notes: The one I keep up to date.
sections:
  - kind: education
    entries: [edu_neu]
  - kind: experience
    entries: [exp_acme]
  - kind: project
    entries: [proj_thing]
  - kind: skills
    groups: [sk_lang, sk_tools]
    items:
      sk_tools: [s_git]
choices:
  exp_acme.title: v_long
layout:
  fontSizePt: 11
  marginIn: 0.5
lists:
  b_course: [c_algo, c_db, c_os]
  b_stack: [t_pg, t_react]
`,

  /* A child that only changes a choice — the ordinary case. */
  'resumes/newgrad.yaml': `
id: newgrad
label: New grad
extends: base
choices:
  edu_neu.dates: v_dec2026
`,

  /*
   * A child that narrows one skills group without restating which groups it
   * shows. This is the shape the merge existed for: read as "these groups,
   * exactly" it prints a skills heading with nothing under it.
   */
  'resumes/narrow.yaml': `
id: narrow
label: Narrowed skills
extends: base
sections:
  - kind: skills
    entries: []
    items:
      sk_lang: [s_py, s_go]
`,

  /* A child that hides a bullet without restating the entry list. */
  'resumes/hidden.yaml': `
id: hidden
label: One line hidden
extends: base
sections:
  - kind: experience
    bullets:
      exp_acme: [b_pipeline]
`,

  /* Three deep, each level deciding something different. */
  'resumes/mid.yaml': `
id: mid
label: Middle
extends: base
choices:
  b_pipeline: v_kafka
lists:
  b_course: [c_os, c_algo]
`,
  'resumes/leaf.yaml': `
id: leaf
label: Leaf
extends: mid
choices:
  exp_acme.title: v_short
layout:
  marginIn: 0.75
`,

  /* Two custom sections, one of which a child re-states. */
  'resumes/awards.yaml': `
id: awards
label: With awards
extends: base
sections:
  - kind: custom
    heading: Awards
    entries: [proj_thing]
  - kind: custom
    heading: Leadership
    entries: [exp_acme]
`,
  'resumes/awards-child.yaml': `
id: awards-child
label: Awards child
extends: awards
sections:
  - kind: custom
    heading: Leadership
    entries: [exp_acme, proj_thing]
`,
};

/** Write the fixture into `dir`, which is created if it is not there. */
export function writeInheritedStore(dir: string): string {
  for (const [rel, body] of Object.entries(FILES)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body.replace(/^\n/, ''), 'utf8');
  }
  return dir;
}

/** The resumes in the fixture, in the order the golden file lists them. */
export const RESUME_IDS = [
  'awards',
  'awards-child',
  'base',
  'hidden',
  'leaf',
  'mid',
  'narrow',
  'newgrad',
];
