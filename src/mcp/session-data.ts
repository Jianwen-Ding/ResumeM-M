/**
 * What of the store a tool session is handed, by kind.
 *
 * The session file is written into the AI's working directory (`wireUp`),
 * where a coding CLI reads files without asking. It used to carry the whole
 * `StoreData`: the profile with its phone, email and autofill block (address,
 * GPA), the application tracker, every letter and every draft for every
 * employer, the whole answer bank and the config — when the tools read a
 * handful of fields. `redactDeep` takes out national-ID shapes and nothing
 * else, so the rest went to the model as it was.
 *
 * So each kind gets what its tools read and nothing more, picked here at run
 * time — a `Pick` type alone would let a whole `StoreData` through, since it
 * is structurally one — and the resume's profile is cut down to the name,
 * which is the only part of it any tool uses.
 *
 * - tailor: `TailorSession` reads entries, skill groups, and each resume's id
 *   and sections (`sectionForEntry`).
 * - write: `WritingSession` reads the letters (`find_my_letters`,
 *   `check_claim`, the length cap) and the answer bank, filtered as every AI
 *   read of it is (`answersForAi`). Letters are signed from the resume text,
 *   so no part of the profile is needed beyond the resume's name.
 * - author: `AuthoringSession` reads only the documents and the ids it is
 *   handed; no store data at all.
 */

import type { ResolvedResume, ResumeSpec, StoreData } from '../model/types.js';
import { answersForAi, withoutContactDetails } from '../ai/privacy.js';

export type TailorData = Pick<StoreData, 'entries' | 'skillGroups'> & {
  resumes: Pick<ResumeSpec, 'id' | 'label' | 'sections'>[];
};
export type WritingData = Pick<StoreData, 'coverLetters' | 'answers'>;
export type SessionResume = Pick<ResolvedResume, 'id' | 'label' | 'sections'> & {
  profile: { name: string };
};

export function tailorData(data: Pick<StoreData, 'entries' | 'skillGroups' | 'resumes'>): TailorData {
  return {
    entries: data.entries ?? [],
    skillGroups: data.skillGroups ?? [],
    // A resume's label is its own name; its notes and what it was generated
    // for are the tracker's, and no tool reads them.
    resumes: (data.resumes ?? []).map((r) => ({ id: r.id, label: r.label, sections: r.sections })),
  };
}

/*
 * The letters with their signatures' phone numbers, email addresses and home
 * addresses taken out (`withoutContactDetails`): the file is read by the
 * model, and no tool needs them to find a letter or check a claim.
 */
export function writingData(data: Pick<StoreData, 'coverLetters' | 'answers'>): WritingData {
  return {
    coverLetters: (data.coverLetters ?? []).map((l) => ({ ...l, body: withoutContactDetails(l.body) })),
    answers: answersForAi(data.answers),
  };
}

export function sessionResume(resume: Pick<ResolvedResume, 'id' | 'label' | 'sections' | 'profile'>): SessionResume {
  return { id: resume.id, label: resume.label, sections: resume.sections, profile: { name: resume.profile?.name ?? '' } };
}
