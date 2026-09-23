// Track the URL represented by the mounted content, including filter replacements.
// Hash history entries refer to that same content and need native anchor behavior.
export const rankingLocation = { key: location.pathname + location.search };
export function replaceRankingUrl(url: URL) {
  history.replaceState(history.state, '', url);
  rankingLocation.key = url.pathname + url.search;
}
