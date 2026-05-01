import { Jieba } from '@node-rs/jieba';

// Singleton instance — loading the dictionary is expensive (~50ms) so we do it once.
let _jieba: Jieba | null = null;

function getJieba(): Jieba {
  if (!_jieba) {
    _jieba = new Jieba();
  }
  return _jieba;
}

// Matches tokens that carry no search value: pure punctuation / operators / whitespace.
// Alphanumeric ASCII and CJK Unified Ideographs (BMP + Extension A) are always kept.
const NOISE_TOKEN_RE = /^[^a-zA-Z0-9\u4e00-\u9fff\u3400-\u4dbf]+$/;

/**
 * Tokenize text for FTS5 indexing / querying.
 *
 * Strategy:
 *  - jieba splits Chinese text into meaningful words, while leaving ASCII
 *    sequences (identifiers, version numbers, English words) intact.
 *  - We filter out pure-punctuation tokens (e.g. `_`, `.`, `-`) that have
 *    no search value in an AND-based FTS5 query.
 *  - The same function is applied at write-time (indexing) and read-time
 *    (query), so the tokenization is perfectly symmetric.
 *
 * Examples:
 *   "使用 JWT 令牌进行 OAuth2 认证"  →  "使用 JWT 令牌 进行 OAuth2 认证"
 *   "getUserById"                   →  "getUserById"     (camelCase kept whole)
 *   "user_id config"                →  "user id config"  (underscore filtered)
 *   "Redis缓存 user_name"           →  "Redis 缓存 user name"
 */
export function tokenize(text: string): string[] {
  if (!text || text.trim().length === 0) return [];
  return getJieba()
    .cut(text, /* hmm= */ true)
    .filter(t => t.trim().length > 0 && !NOISE_TOKEN_RE.test(t));
}

/**
 * Returns the tokenized text as a space-joined string suitable for storing
 * in an FTS5 column (tokenize='unicode61').
 */
export function tokenizeForIndex(text: string): string {
  return tokenize(text).join(' ');
}

/**
 * Builds a FTS5 MATCH expression for one or more query terms.
 *
 * Each term is individually tokenized.  A `*` suffix is appended to every
 * resulting token so that FTS5 performs a **prefix search**, matching any
 * indexed token that *starts with* that string.  This replicates the
 * intent of the original `LIKE '%term%'` approach for normal English words
 * (e.g. query `auth` matches the indexed token `authentication`) while
 * still benefiting from the FTS5 B-tree index.
 *
 * All tokens are AND-joined (FTS5 default), so every token must be present
 * in the document for it to be returned.
 *
 * @param terms  One or more raw query strings from the caller.
 * @returns      A FTS5 MATCH expression string, or null if no usable tokens.
 */
export function buildFtsQuery(terms: string[]): string | null {
  const tokens = terms
    .flatMap(t => tokenize(t))
    .filter(t => t.length > 0)
    // Wrap each token in double-quotes and add prefix wildcard (*).
    // The quotes prevent FTS5 from re-tokenizing the string; the * enables
    // prefix matching so "auth" matches "authentication".
    .map(t => `"${t.replace(/"/g, '""')}"*`);
  if (tokens.length === 0) return null;
  return tokens.join(' ');
}
