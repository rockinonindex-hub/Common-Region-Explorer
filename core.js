(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SequenceCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const DNA_RE = /[^ACGTUNRYKMSWBDHV-]/gi;
  const COMPLEMENT = {
    A: 'T', C: 'G', G: 'C', T: 'A', U: 'A',
    N: 'N', R: 'Y', Y: 'R', K: 'M', M: 'K',
    S: 'S', W: 'W', B: 'V', V: 'B', D: 'H', H: 'D', '-': '-'
  };

  function normalizeSequence(raw, treatUasT = true) {
    let seq = String(raw || '').toUpperCase().replace(/\s+/g, '').replace(DNA_RE, '');
    seq = seq.replace(/-/g, '');
    if (treatUasT) seq = seq.replace(/U/g, 'T');
    return seq;
  }

  function reverseComplement(seq) {
    let out = '';
    for (let i = seq.length - 1; i >= 0; i -= 1) out += COMPLEMENT[seq[i]] || 'N';
    return out;
  }

  function findAllOccurrences(haystack, needle) {
    const hits = [];
    if (!needle) return hits;
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const idx = haystack.indexOf(needle, from);
      if (idx < 0) break;
      hits.push(idx);
      from = idx + 1;
    }
    return hits;
  }

  function buildSuffixAutomaton(reference) {
    const states = [{ next: Object.create(null), link: -1, len: 0, firstPos: -1 }];
    let last = 0;

    for (let pos = 0; pos < reference.length; pos += 1) {
      const ch = reference[pos];
      const cur = states.length;
      states.push({ next: Object.create(null), link: 0, len: states[last].len + 1, firstPos: pos });
      let p = last;
      while (p >= 0 && states[p].next[ch] === undefined) {
        states[p].next[ch] = cur;
        p = states[p].link;
      }
      if (p < 0) {
        states[cur].link = 0;
      } else {
        const q = states[p].next[ch];
        if (states[p].len + 1 === states[q].len) {
          states[cur].link = q;
        } else {
          const clone = states.length;
          states.push({
            next: Object.assign(Object.create(null), states[q].next),
            link: states[q].link,
            len: states[p].len + 1,
            firstPos: states[q].firstPos
          });
          while (p >= 0 && states[p].next[ch] === q) {
            states[p].next[ch] = clone;
            p = states[p].link;
          }
          states[q].link = clone;
          states[cur].link = clone;
        }
      }
      last = cur;
    }

    const order = Array.from({ length: states.length }, (_, i) => i)
      .sort((a, b) => states[a].len - states[b].len);
    return { states, order };
  }

  function bestMatchesForSequence(sam, sequence) {
    const { states, order } = sam;
    const best = new Int32Array(states.length);
    let v = 0;
    let l = 0;

    for (const ch of sequence) {
      while (v !== 0 && states[v].next[ch] === undefined) {
        v = states[v].link;
        l = Math.min(l, states[v].len);
      }
      if (states[v].next[ch] !== undefined) {
        v = states[v].next[ch];
        l += 1;
      } else {
        v = 0;
        l = 0;
      }
      if (l > best[v]) best[v] = l;
    }

    for (let oi = order.length - 1; oi > 0; oi -= 1) {
      const stateId = order[oi];
      const parent = states[stateId].link;
      if (parent >= 0) {
        const propagated = Math.min(best[stateId], states[parent].len);
        if (propagated > best[parent]) best[parent] = propagated;
      }
    }
    return best;
  }

  function occurrenceDetails(sequences, motif, allowReverseComplement) {
    return sequences.map((item) => {
      const plus = findAllOccurrences(item.sequence, motif).map((start) => ({
        start, end: start + motif.length - 1, strand: '+'
      }));
      let minus = [];
      if (allowReverseComplement) {
        const rc = reverseComplement(item.sequence);
        minus = findAllOccurrences(rc, motif).map((rcStart) => ({
          start: item.sequence.length - (rcStart + motif.length),
          end: item.sequence.length - rcStart - 1,
          strand: '-'
        }));
        const seen = new Set(plus.map((x) => `${x.start}:${x.end}:${x.strand}`));
        minus = minus.filter((x) => !seen.has(`${x.start}:${x.end}:${x.strand}`));
      }
      return { name: item.name, length: item.sequence.length, hits: plus.concat(minus) };
    });
  }

  function findCommonRegions(sequences, options = {}, onProgress = () => {}) {
    if (!Array.isArray(sequences) || sequences.length < 2) {
      throw new Error('2本以上の配列が必要です。');
    }
    const minLength = Math.max(1, Number(options.minLength || 19));
    const allowReverseComplement = Boolean(options.allowReverseComplement);

    let refIndex = 0;
    for (let i = 1; i < sequences.length; i += 1) {
      if (sequences[i].sequence.length < sequences[refIndex].sequence.length) refIndex = i;
    }
    const reference = sequences[refIndex].sequence;
    if (reference.length < minLength) return { referenceIndex: refIndex, regions: [], longest: 0 };

    onProgress({ phase: 'index', done: 0, total: 1, message: '最短配列の検索インデックスを作成中' });
    const sam = buildSuffixAutomaton(reference);
    const common = new Int32Array(sam.states.length);
    for (let s = 0; s < sam.states.length; s += 1) common[s] = sam.states[s].len;

    const others = sequences.map((_, i) => i).filter((i) => i !== refIndex);
    for (let k = 0; k < others.length; k += 1) {
      const idx = others[k];
      const forwardBest = bestMatchesForSequence(sam, sequences[idx].sequence);
      let reverseBest = null;
      if (allowReverseComplement) reverseBest = bestMatchesForSequence(sam, reverseComplement(sequences[idx].sequence));
      for (let s = 1; s < sam.states.length; s += 1) {
        const observed = reverseBest ? Math.max(forwardBest[s], reverseBest[s]) : forwardBest[s];
        if (observed < common[s]) common[s] = observed;
      }
      onProgress({
        phase: 'compare', done: k + 1, total: others.length,
        message: `${k + 1} / ${others.length} 配列を比較`
      });
    }

    const raw = [];
    for (let s = 1; s < sam.states.length; s += 1) {
      const length = Math.min(common[s], sam.states[s].len);
      if (length < minLength) continue;
      const end = sam.states[s].firstPos;
      const start = end - length + 1;
      if (start < 0) continue;
      raw.push({ sequence: reference.slice(start, end + 1), length, refStart: start, refEnd: end });
    }

    raw.sort((a, b) => b.length - a.length || a.refStart - b.refStart || a.sequence.localeCompare(b.sequence));
    const unique = [];
    const seen = new Set();
    for (const item of raw) {
      if (seen.has(item.sequence)) continue;
      seen.add(item.sequence);
      if (unique.some((kept) => kept.sequence.includes(item.sequence))) continue;
      unique.push(item);
    }

    onProgress({ phase: 'locate', done: 0, total: unique.length, message: '各配列上の位置を確認中' });
    const regions = unique.map((item, i) => {
      const occurrences = occurrenceDetails(sequences, item.sequence, allowReverseComplement);
      onProgress({ phase: 'locate', done: i + 1, total: unique.length, message: `${i + 1} / ${unique.length} 領域` });
      return Object.assign({}, item, { id: i + 1, occurrences });
    });

    return {
      referenceIndex: refIndex,
      referenceName: sequences[refIndex].name,
      regions,
      longest: regions.length ? regions[0].length : 0
    };
  }

  function globalAlign(reference, query, options = {}) {
    const match = Number(options.match ?? 2);
    const mismatch = Number(options.mismatch ?? -1);
    const gap = Number(options.gap ?? -2);
    const maxCells = Number(options.maxCells || 8000000);
    const n = reference.length;
    const m = query.length;
    const cells = (n + 1) * (m + 1);
    if (cells > maxCells) {
      throw new Error(`アラインメント行列が大きすぎます（${cells.toLocaleString()}セル）。短い配列にするか、対象配列数を減らしてください。`);
    }

    const cols = m + 1;
    const trace = new Uint8Array(cells); // 1 diag, 2 up, 3 left
    let prev = new Int32Array(cols);
    let curr = new Int32Array(cols);
    for (let j = 1; j <= m; j += 1) {
      prev[j] = prev[j - 1] + gap;
      trace[j] = 3;
    }
    for (let i = 1; i <= n; i += 1) {
      curr[0] = prev[0] + gap;
      trace[i * cols] = 2;
      for (let j = 1; j <= m; j += 1) {
        const diag = prev[j - 1] + (reference[i - 1] === query[j - 1] ? match : mismatch);
        const up = prev[j] + gap;
        const left = curr[j - 1] + gap;
        let score = diag;
        let dir = 1;
        if (up > score) { score = up; dir = 2; }
        if (left > score) { score = left; dir = 3; }
        curr[j] = score;
        trace[i * cols + j] = dir;
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }

    let i = n;
    let j = m;
    const a = [];
    const b = [];
    while (i > 0 || j > 0) {
      const dir = trace[i * cols + j];
      if (i > 0 && j > 0 && dir === 1) {
        a.push(reference[i - 1]); b.push(query[j - 1]); i -= 1; j -= 1;
      } else if (i > 0 && (dir === 2 || j === 0)) {
        a.push(reference[i - 1]); b.push('-'); i -= 1;
      } else {
        a.push('-'); b.push(query[j - 1]); j -= 1;
      }
    }
    a.reverse(); b.reverse();
    return { alignedReference: a.join(''), alignedQuery: b.join(''), score: prev[m] };
  }

  function alignmentToProfile(alignedReference, alignedQuery, referenceLength) {
    const insertions = Array.from({ length: referenceLength + 1 }, () => '');
    const alignedAt = Array.from({ length: referenceLength }, () => '-');
    let pos = 0;
    for (let i = 0; i < alignedReference.length; i += 1) {
      const r = alignedReference[i];
      const q = alignedQuery[i];
      if (r === '-') insertions[pos] += q;
      else {
        alignedAt[pos] = q;
        pos += 1;
      }
    }
    return { insertions, alignedAt };
  }

  function summarizeAlignment(alignedSequences) {
    if (!alignedSequences.length) return { consensus: '', conservation: '' };
    const width = alignedSequences[0].aligned.length;
    let consensus = '';
    let conservation = '';
    for (let col = 0; col < width; col += 1) {
      const counts = Object.create(null);
      let nonGap = 0;
      for (const row of alignedSequences) {
        const ch = row.aligned[col];
        if (ch === '-') continue;
        counts[ch] = (counts[ch] || 0) + 1;
        nonGap += 1;
      }
      let bestBase = '-';
      let bestCount = 0;
      for (const [base, count] of Object.entries(counts)) {
        if (count > bestCount) { bestCount = count; bestBase = base; }
      }
      consensus += bestBase;
      if (nonGap === 0) conservation += ' ';
      else if (bestCount === alignedSequences.length) conservation += '*';
      else if (bestCount / alignedSequences.length >= 0.8) conservation += ':';
      else if (bestCount / alignedSequences.length >= 0.5) conservation += '.';
      else conservation += ' ';
    }
    return { consensus, conservation };
  }

  function buildStarAlignment(sequences, referenceIndex = 0, options = {}, onProgress = () => {}) {
    if (!sequences.length) throw new Error('配列がありません。');
    const ref = sequences[referenceIndex];
    const profiles = new Array(sequences.length);
    profiles[referenceIndex] = {
      insertions: Array.from({ length: ref.sequence.length + 1 }, () => ''),
      alignedAt: ref.sequence.split('')
    };

    const targets = sequences.map((_, i) => i).filter((i) => i !== referenceIndex);
    for (let k = 0; k < targets.length; k += 1) {
      const idx = targets[k];
      const pair = globalAlign(ref.sequence, sequences[idx].sequence, options);
      profiles[idx] = alignmentToProfile(pair.alignedReference, pair.alignedQuery, ref.sequence.length);
      onProgress({ phase: 'align', done: k + 1, total: targets.length, message: `${k + 1} / ${targets.length} 配列を整列` });
    }

    const maxInsertions = new Int32Array(ref.sequence.length + 1);
    for (const profile of profiles) {
      for (let b = 0; b < profile.insertions.length; b += 1) {
        if (profile.insertions[b].length > maxInsertions[b]) maxInsertions[b] = profile.insertions[b].length;
      }
    }

    const alignedSequences = sequences.map((item, idx) => {
      const p = profiles[idx];
      let aligned = '';
      for (let b = 0; b <= ref.sequence.length; b += 1) {
        aligned += p.insertions[b];
        aligned += '-'.repeat(maxInsertions[b] - p.insertions[b].length);
        if (b < ref.sequence.length) aligned += p.alignedAt[b];
      }
      return { name: item.name, aligned, sourceLength: item.sequence.length };
    });

    const summary = summarizeAlignment(alignedSequences);
    return {
      referenceIndex,
      referenceName: ref.name,
      alignedSequences,
      consensus: summary.consensus,
      conservation: summary.conservation,
      length: alignedSequences[0].aligned.length
    };
  }

  return {
    normalizeSequence,
    reverseComplement,
    findAllOccurrences,
    findCommonRegions,
    globalAlign,
    buildStarAlignment
  };
});
