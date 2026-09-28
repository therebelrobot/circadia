// Graph modes: which edge origins each query mode traverses (docs/RETRIEVAL.md).

import type { EdgeOrigin, GraphMode } from '../types.ts';

export const MODE_ORIGINS: Record<GraphMode, readonly EdgeOrigin[]> = {
  /** Links you wrote. Zero extraction cost. Default first rung. */
  wikilink: ['contains', 'link'],
  /** + typed, bi-temporal facts and their provenance. Still zero LLM cost. */
  typed: ['contains', 'link', 'fact', 'provenance'],
  /** + HippoRAG phrase graph (LLM triples, synonym bridges). Needs the triple cache. */
  hipporag: ['contains', 'link', 'fact', 'provenance', 'triple', 'synonym'],
};
