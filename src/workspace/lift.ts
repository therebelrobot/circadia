// RFC-0004 §6.2: `circadia lift` — a human moves one fact from one vault to a shared
// layer. It writes an *episode*, not a fact, so the target vault's invariant (only
// consolidation promotes) holds and `src::` links never need to cross vaults. The target's
// consolidation then promotes the claim like any user episode, including supersession of
// a contradicted fact.
//
// `lift` is CLI-only, like `review`: the same human firewall the dreaming design uses.

import { loadConfig } from '../config.ts';
import { parseVault } from '../index/indexer.ts';
import { writeEpisodes } from '../episodes/episode.ts';
import type { Fact, ParsedNote } from '../types.ts';
import type { WorkspaceRegistry } from './registry.ts';

export interface LiftResult {
  targetVault: string;
  episodePath: string;
  origin: string;
  claim: string;
}

/** Render a fact's object as text: a wikilink target or a literal. */
function objectText(f: Fact): string {
  return f.object.kind === 'link' ? `[[${f.object.link.target}]]` : f.object.value;
}

/** The body of a lifted episode: the claim and its original `src::`, as prose. */
export function liftBody(note: ParsedNote, fact: Fact, origin: string): string {
  const src = fact.src ? ` (src: [[${fact.src.target}]])` : '';
  return `Lifted from ${origin}\n\n${note.id} ${fact.predicate} ${objectText(fact)}${src}`;
}

/**
 * Lift `<noteId>^<factId>` from `fromId` into `toId`. Both ids must be registered; the
 * source vault is read, the target vault receives one episode with `by: user`,
 * `source: import` and `origin: "<fromId>:<noteId>^<factId>"`.
 */
export async function lift(
  reg: WorkspaceRegistry,
  workspaceDir: string,
  fromId: string,
  toId: string,
  ref: string,
): Promise<LiftResult> {
  const from = reg.vaults[fromId];
  const to = reg.vaults[toId];
  if (!from) throw new Error(`unknown source vault "${fromId}"`);
  if (!to) throw new Error(`unknown target vault "${toId}"`);

  const caret = ref.lastIndexOf('^');
  if (caret <= 0 || caret === ref.length - 1) {
    throw new Error(`lift reference must be <note-id>^<fact-id> (got "${ref}")`);
  }
  const noteId = ref.slice(0, caret);
  const factId = ref.slice(caret + 1);

  const fromPath = `${workspaceDir}/${fromId}`;
  const toPath = `${workspaceDir}/${toId}`;
  const fromCfg = loadConfig(fromPath, reg.defaults);
  const notes = parseVault(fromPath, fromCfg);
  const note = notes.find((n) => n.id === noteId);
  if (!note) throw new Error(`note "${noteId}" not found in vault "${fromId}"`);
  const fact = note.facts.find((f) => f.id === factId);
  if (!fact) throw new Error(`fact "${factId}" not found in note "${noteId}"`);

  const origin = `${fromId}:${noteId}^${factId}`;
  const toCfg = loadConfig(toPath, reg.defaults);
  const result = await writeEpisodes(
    toPath,
    toCfg,
    [{ text: liftBody(note, fact, origin), boundary: 'none', title: `Lifted: ${noteId} ${fact.predicate}` }],
    { by: 'user', source: 'import', origin },
  );

  return {
    targetVault: toId,
    episodePath: result.episodes[0].path,
    origin,
    claim: `${noteId} ${fact.predicate} ${objectText(fact)}`,
  };
}
