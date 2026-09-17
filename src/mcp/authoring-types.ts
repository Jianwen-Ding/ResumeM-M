/**
 * The two names `authoring.ts` needs from elsewhere.
 *
 * Its own file so that the authoring session — which is pure logic over text
 * the caller supplies — does not import the store's whole type surface to
 * borrow one union. It is also what lets it be tested without a store.
 */
export type { EntryKind } from '../model/types.js';
export type { MoveResult } from './session.js';
