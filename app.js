'use strict';

const state = {
  sequences: [],
  commonResult: null,
  alignmentResult: null,
  worker: null,
  busyTask: null,
  alignmentSearch: { query: '', hits: [], columns: new Set() }
};

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $('fileInput'), dropZone: $('dropZone'), sequenceInput: $('sequenceInput'), sampleButton: $('sampleButton'),
  sequenceStats: $('sequenceStats'), minLength: $('minLength'), flankLength: $('flankLength'), alignmentLimit: $('alignmentLimit'),
  treatUasT: $('treatUasT'), reverseComplement: $('reverseComplement'), analyzeButton: $('analyzeButton'), stopButton: $('stopButton'),
  csvButton: $('csvButton'), progressWrap: $('progressWrap'), progressBar: $('progressBar'), progressText: $('progressText'),
  statusMessage: $('statusMessage'), resultsPanel: $('resultsPanel'), summaryCount: $('summaryCount'), summaryLongest: $('summaryLongest'),
  summaryRegions: $('summaryRegions'), summaryReference: $('summaryReference'), regionTableBody: $('regionTableBody'), regionSelect: $('regionSelect'),
  contextSummary: $('contextSummary'), contextViewer: $('contextViewer'), referenceSelect: $('referenceSelect'), alignButton: $('alignButton'),
  alignmentNotice: $('alignmentNotice'), alignmentViewer: $('alignmentViewer'),
  alignmentFastaButton: $('alignmentFastaButton'), alignmentClustalButton: $('alignmentClustalButton'),
  alignmentSearchInput: $('alignmentSearchInput'), alignmentSearchReverse: $('alignmentSearchReverse'),
  alignmentSearchButton: $('alignmentSearchButton'), alignmentSearchClearButton: $('alignmentSearchClearButton'),
  alignmentSearchSummary: $('alignmentSearchSummary')
};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function parseSequenceText(text) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  const treatUasT = els.treatUasT.checked;
  const records = [];
  if (clean.includes('>')) {
    let currentName = null;
    let buffer = [];
    const flush = () => {
      if (currentName !== null) {
        const sequence = normalizeSequence(buffer.join(''), treatUasT);
        if (sequence) records.push({ name: currentName || `Seq${records.length + 1}`, sequence });
      }
    };
    for (const rawLine of clean.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith('>')) {
        flush();
        currentName = line.slice(1).trim() || `Seq${records.length + 1}`;
        buffer = [];
      } else if (line) buffer.push(line);
    }
    flush();
  } else {
    const lines = clean.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    lines.forEach((line, index) => {
      const parts = line.split(/[\t,; ]+/);
      const sequencePart = parts.length > 1 ? parts[parts.length - 1] : parts[0];
      const name = parts.length > 1 ? parts.slice(0, -1).join('_') : `Seq${index + 1}`;
      const sequence = normalizeSequence(sequencePart, treatUasT);
      if (sequence) records.push({ name, sequence });
    });
  }
  const used = new Map();
  return records.map((item, index) => {
    const base = item.name || `Seq${index + 1}`;
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    return { name: count === 1 ? base : `${base}_${count}`, sequence: item.sequence };
  });
}

function normalizeSequence(raw, treatUasT) {
  let seq = String(raw || '').toUpperCase().replace(/\s+/g, '').replace(/[^ACGTUNRYKMSWBDHV-]/g, '').replace(/-/g, '');
  if (treatUasT) seq = seq.replace(/U/g, 'T');
  return seq;
}

function refreshSequences() {
  state.sequences = parseSequenceText(els.sequenceInput.value);
  renderStats();
  populateReferenceSelect();
  state.commonResult = null;
  state.alignmentResult = null;
  clearAlignmentSearch(false);
  els.alignmentFastaButton.disabled = true;
  els.alignmentClustalButton.disabled = true;
  els.alignmentSearchButton.disabled = true;
  els.resultsPanel.hidden = true;
  els.csvButton.disabled = true;
}

function renderStats() {
  if (!state.sequences.length) {
    els.sequenceStats.className = 'stats empty';
    els.sequenceStats.textContent = 'まだ配列は読み込まれていません。';
    return;
  }
  const lengths = state.sequences.map((x) => x.sequence.length);
  const total = lengths.reduce((a, b) => a + b, 0);
  els.sequenceStats.className = 'stats';
  els.sequenceStats.innerHTML = [
    `配列数 ${state.sequences.length}`,
    `最短 ${Math.min(...lengths).toLocaleString()} nt`,
    `最長 ${Math.max(...lengths).toLocaleString()} nt`,
    `合計 ${total.toLocaleString()} nt`
  ].map((x) => `<span>${x}</span>`).join('');
}

function populateReferenceSelect() {
  els.referenceSelect.innerHTML = state.sequences.map((item, i) => `<option value="${i}">${escapeHtml(item.name)} (${item.sequence.length} nt)</option>`).join('');
}

function setBusy(task, busy) {
  state.busyTask = busy ? task : null;
  els.analyzeButton.disabled = busy;
  els.alignButton.disabled = busy;
  els.stopButton.disabled = !busy;
  els.progressWrap.hidden = !busy;
  if (!busy) {
    els.progressBar.style.width = '0%';
    els.progressText.textContent = '';
  }
}

function createWorker() {
  if (state.worker) state.worker.terminate();
  state.worker = new Worker('worker.js?v=0.1.5');
  state.worker.onmessage = handleWorkerMessage;
  state.worker.onerror = (event) => {
    showError(event.message || 'Web Workerでエラーが発生しました。');
    setBusy(null, false);
  };
}

function handleWorkerMessage(event) {
  const msg = event.data || {};
  if (msg.type === 'progress') updateProgress(msg.progress);
  if (msg.type === 'commonResult') {
    state.commonResult = msg.result;
    setBusy(null, false);
    renderCommonResult();
    els.statusMessage.className = 'status';
    els.statusMessage.textContent = msg.result.regions.length
      ? `${msg.result.regions.length}個の最大共通領域を検出しました。`
      : '指定長以上の完全共通領域は見つかりませんでした。';
  }
  if (msg.type === 'alignmentResult') {
    state.alignmentResult = msg.result;
    clearAlignmentSearch(false);
    setBusy(null, false);
    renderAlignment();
    els.alignmentFastaButton.disabled = false;
    els.alignmentClustalButton.disabled = false;
    els.alignmentSearchButton.disabled = false;
    els.statusMessage.className = 'status';
    els.statusMessage.textContent = `${msg.result.alignedSequences.length}配列を整列しました。`;
  }
  if (msg.type === 'error') {
    setBusy(null, false);
    showError(msg.message);
  }
}

function updateProgress(progress) {
  const total = Math.max(1, progress.total || 1);
  const done = Math.min(total, progress.done || 0);
  els.progressBar.style.width = `${Math.round(done / total * 100)}%`;
  els.progressText.textContent = progress.message || `${done} / ${total}`;
}

function showError(message) {
  els.statusMessage.className = 'status error';
  els.statusMessage.textContent = message;
}

function analyze() {
  refreshSequences();
  if (state.sequences.length < 2) {
    showError('2本以上の配列を読み込んでください。');
    return;
  }
  const minLength = Math.max(2, Number(els.minLength.value || 19));
  const shortest = Math.min(...state.sequences.map((x) => x.sequence.length));
  if (minLength > shortest) {
    showError(`最小共通長が最短配列（${shortest} nt）を超えています。`);
    return;
  }
  createWorker();
  setBusy('common', true);
  els.statusMessage.className = 'status';
  els.statusMessage.textContent = '共通領域を解析しています。';
  state.worker.postMessage({
    type: 'findCommon',
    payload: {
      sequences: state.sequences,
      options: { minLength, allowReverseComplement: els.reverseComplement.checked }
    }
  });
}

function renderCommonResult() {
  const result = state.commonResult;
  els.resultsPanel.hidden = false;
  els.summaryCount.textContent = state.sequences.length;
  els.summaryLongest.textContent = `${result.longest} nt`;
  els.summaryRegions.textContent = result.regions.length;
  els.summaryReference.textContent = result.referenceName || '-';
  els.csvButton.disabled = result.regions.length === 0;
  els.regionTableBody.innerHTML = result.regions.map((r) => `
    <tr>
      <td>${r.id}</td>
      <td><strong>${r.length}</strong> nt</td>
      <td class="sequence-cell">${escapeHtml(r.sequence)}</td>
      <td>${r.refStart + 1}–${r.refEnd + 1}</td>
      <td><button class="ghost context-jump" data-region="${r.id}">前後を見る</button></td>
    </tr>`).join('');
  els.regionSelect.innerHTML = result.regions.length
    ? result.regions.map((r) => `<option value="${r.id}">#${r.id} · ${r.length} nt · ${escapeHtml(r.sequence.slice(0, 24))}${r.sequence.length > 24 ? '…' : ''}</option>`).join('')
    : '<option>領域なし</option>';
  renderContext();
  document.querySelectorAll('.context-jump').forEach((button) => {
    button.addEventListener('click', () => {
      els.regionSelect.value = button.dataset.region;
      switchTab('context');
      renderContext();
    });
  });
}

function renderContext() {
  if (!state.commonResult || !state.commonResult.regions.length) {
    els.contextSummary.textContent = '';
    els.contextViewer.innerHTML = '<p class="muted">表示できる共通領域がありません。</p>';
    return;
  }
  const id = Number(els.regionSelect.value || 1);
  const region = state.commonResult.regions.find((x) => x.id === id) || state.commonResult.regions[0];
  const flank = Math.max(0, Number(els.flankLength.value || 30));
  els.contextSummary.textContent = `${region.length} nt · ${state.sequences.length}配列すべてに存在`;
  els.contextViewer.innerHTML = region.occurrences.map((occ, index) => {
    const seq = state.sequences[index].sequence;
    if (!occ.hits.length) {
      return `<article class="context-row missing"><header><strong>${escapeHtml(occ.name)}</strong><span>未検出</span></header></article>`;
    }
    const hit = occ.hits[0];
    let oriented = seq;
    let start = hit.start;
    if (hit.strand === '-') {
      oriented = reverseComplement(seq);
      start = seq.length - (hit.end + 1);
    }
    const leftStart = Math.max(0, start - flank);
    const rightEnd = Math.min(oriented.length, start + region.length + flank);
    const left = oriented.slice(leftStart, start);
    const motif = oriented.slice(start, start + region.length);
    const right = oriented.slice(start + region.length, rightEnd);
    const more = occ.hits.length > 1 ? ` · 他${occ.hits.length - 1}か所` : '';
    return `<article class="context-row">
      <header><strong>${escapeHtml(occ.name)}</strong><span>${hit.start + 1}–${hit.end + 1} (${hit.strand})${more}</span></header>
      <code><span class="flank">${escapeHtml(left)}</span><mark>${escapeHtml(motif)}</mark><span class="flank">${escapeHtml(right)}</span></code>
    </article>`;
  }).join('');
}

function reverseComplement(seq) {
  const map = { A: 'T', C: 'G', G: 'C', T: 'A', U: 'A', N: 'N', R: 'Y', Y: 'R', K: 'M', M: 'K', S: 'S', W: 'W', B: 'V', V: 'B', D: 'H', H: 'D' };
  let out = '';
  for (let i = seq.length - 1; i >= 0; i -= 1) out += map[seq[i]] || 'N';
  return out;
}

function runAlignment() {
  if (state.sequences.length < 2) {
    showError('先に2本以上の配列を読み込んでください。');
    return;
  }
  const limit = Math.max(2, Math.min(200, Number(els.alignmentLimit.value || 50)));
  const subset = state.sequences.slice(0, limit);
  const selectedReference = Number(els.referenceSelect.value || 0);
  const referenceIndex = selectedReference < subset.length ? selectedReference : 0;
  const refLength = subset[referenceIndex].sequence.length;
  const maxOther = Math.max(...subset.map((x) => x.sequence.length));
  const cells = (refLength + 1) * (maxOther + 1);
  if (cells > 8000000) {
    showError(`選択した参照配列では1配列あたり最大${cells.toLocaleString()}セル必要です。短い参照配列にするか、配列を短くしてください。`);
    return;
  }
  createWorker();
  setBusy('align', true);
  els.alignmentNotice.textContent = state.sequences.length > limit
    ? `入力${state.sequences.length}本のうち、先頭${limit}本をアラインメントします。共通領域検索は全配列を使用しています。`
    : `${subset.length}本をアラインメントします。`;
  state.worker.postMessage({
    type: 'align',
    payload: { sequences: subset, referenceIndex, options: { maxCells: 8000000 } }
  });
}

function makeUngappedPrefix(aligned) {
  const prefix = new Uint32Array(aligned.length + 1);
  for (let i = 0; i < aligned.length; i += 1) {
    prefix[i + 1] = prefix[i] + (aligned[i] === '-' ? 0 : 1);
  }
  return prefix;
}

function coordinatesForBlock(prefix, start, end) {
  const before = prefix[start];
  const after = prefix[end];
  if (after === before) return { start: '', end: '' };
  return { start: before + 1, end: after };
}

function findAllExact(sequence, query) {
  const hits = [];
  let from = 0;
  while (from <= sequence.length - query.length) {
    const index = sequence.indexOf(query, from);
    if (index < 0) break;
    hits.push(index);
    from = index + 1;
  }
  return hits;
}

function referenceRowForAlignment(result) {
  const index = Number.isInteger(result.referenceIndex) ? result.referenceIndex : 0;
  return result.alignedSequences[index] || result.alignedSequences[0];
}

function alignmentColumnsForReferenceHits(alignedReference, hits) {
  const columns = new Set();
  if (!hits.length) return columns;
  let sourcePos = 0;
  for (let col = 0; col < alignedReference.length; col += 1) {
    if (alignedReference[col] === '-') continue;
    for (const hit of hits) {
      if (sourcePos >= hit.start && sourcePos < hit.end) {
        columns.add(col);
        break;
      }
    }
    sourcePos += 1;
  }
  return columns;
}

function clearAlignmentSearch(rerender = true) {
  state.alignmentSearch = { query: '', hits: [], columns: new Set() };
  if (els.alignmentSearchInput) els.alignmentSearchInput.value = '';
  if (els.alignmentSearchSummary) {
    els.alignmentSearchSummary.textContent = '';
    els.alignmentSearchSummary.className = 'alignment-search-summary muted';
  }
  if (els.alignmentSearchClearButton) els.alignmentSearchClearButton.disabled = true;
  if (rerender && state.alignmentResult) renderAlignment();
}

function searchAlignmentReference() {
  const result = state.alignmentResult;
  if (!result) {
    showError('先に多重配列アラインメントを実行してください。');
    return;
  }
  const query = normalizeSequence(els.alignmentSearchInput.value, els.treatUasT.checked);
  if (!query) {
    clearAlignmentSearch();
    return;
  }
  const refRow = referenceRowForAlignment(result);
  const reference = refRow.aligned.replace(/-/g, '');
  const hits = findAllExact(reference, query).map((start) => ({ start, end: start + query.length, strand: '+' }));
  if (els.alignmentSearchReverse.checked) {
    const rc = reverseComplement(query);
    if (rc !== query) {
      findAllExact(reference, rc).forEach((start) => hits.push({ start, end: start + rc.length, strand: '-' }));
    }
  }
  hits.sort((a, b) => a.start - b.start || a.strand.localeCompare(b.strand));
  state.alignmentSearch = {
    query,
    hits,
    columns: alignmentColumnsForReferenceHits(refRow.aligned, hits)
  };
  els.alignmentSearchClearButton.disabled = false;
  if (hits.length) {
    const positions = hits.map((hit) => `${hit.start + 1}–${hit.end} (${hit.strand})`).join(', ');
    els.alignmentSearchSummary.textContent = `${result.referenceName || refRow.name}：${hits.length}件検出 · ${positions}`;
    els.alignmentSearchSummary.className = 'alignment-search-summary found';
  } else {
    els.alignmentSearchSummary.textContent = `${result.referenceName || refRow.name}には完全一致する配列がありません。`;
    els.alignmentSearchSummary.className = 'alignment-search-summary not-found';
  }
  renderAlignment();
}

function renderHighlightedAlignmentSlice(sequence, start, end, highlightedColumns, strong = false) {
  const parts = [];
  let runStart = start;
  let runHighlighted = highlightedColumns.has(start);
  const flush = (to) => {
    const text = escapeHtml(sequence.slice(runStart, to));
    if (!text) return;
    if (runHighlighted) {
      parts.push(`<span class="${strong ? 'search-reference-hit' : 'search-column-hit'}">${text}</span>`);
    } else {
      parts.push(text);
    }
  };
  for (let col = start + 1; col < end; col += 1) {
    const current = highlightedColumns.has(col);
    if (current !== runHighlighted) {
      flush(col);
      runStart = col;
      runHighlighted = current;
    }
  }
  flush(end);
  return parts.join('');
}

function renderAlignment() {
  const result = state.alignmentResult;
  const hasAlignment = Boolean(result && Array.isArray(result.alignedSequences) && result.alignedSequences.length);
  els.alignmentFastaButton.disabled = !hasAlignment;
  els.alignmentClustalButton.disabled = !hasAlignment;
  els.alignmentSearchButton.disabled = !hasAlignment;
  if (!hasAlignment) return;
  const blockWidth = 80;
  const referenceIndex = Number.isInteger(result.referenceIndex) ? result.referenceIndex : 0;
  const highlightedColumns = state.alignmentSearch.columns || new Set();
  const rows = result.alignedSequences.map((row, index) => ({ ...row, index, prefix: makeUngappedPrefix(row.aligned) }));
  const consensusPrefix = makeUngappedPrefix(result.consensus);
  let html = '';
  for (let start = 0; start < result.length; start += blockWidth) {
    const end = Math.min(result.length, start + blockWidth);
    html += `<div class="alignment-block">`;
    html += `<div class="alignment-line alignment-ruler"><span class="alignment-name">Alignment columns</span><span class="alignment-pos">${start + 1}</span><span>${'·'.repeat(end - start)}</span><span class="alignment-pos">${end}</span></div>`;
    for (const row of rows) {
      const coords = coordinatesForBlock(row.prefix, start, end);
      const isReference = row.index === referenceIndex;
      const sequenceHtml = renderHighlightedAlignmentSlice(row.aligned, start, end, highlightedColumns, isReference);
      html += `<div class="alignment-line${isReference ? ' search-reference-row' : ''}"><span class="alignment-name" title="${escapeHtml(row.name)}${isReference ? ' (reference)' : ''}">${escapeHtml(row.name)}${isReference ? ' ◀' : ''}</span><span class="alignment-pos">${coords.start}</span><span class="alignment-sequence-text">${sequenceHtml}</span><span class="alignment-pos">${coords.end}</span></div>`;
    }
    const consensusCoords = coordinatesForBlock(consensusPrefix, start, end);
    const consensusHtml = renderHighlightedAlignmentSlice(result.consensus, start, end, highlightedColumns, false);
    const conservationHtml = renderHighlightedAlignmentSlice(result.conservation, start, end, highlightedColumns, false);
    html += `<div class="alignment-line alignment-consensus"><span>Consensus</span><span class="alignment-pos">${consensusCoords.start}</span><span class="alignment-sequence-text">${consensusHtml}</span><span class="alignment-pos">${consensusCoords.end}</span></div>`;
    html += `<div class="alignment-line alignment-conservation"><span>Conservation</span><span class="alignment-pos"></span><span class="alignment-sequence-text">${conservationHtml}</span><span class="alignment-pos"></span></div>`;
    html += `</div>`;
  }
  els.alignmentViewer.className = 'alignment-viewer';
  els.alignmentViewer.innerHTML = html;
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  document.querySelectorAll('.tab-page').forEach((page) => page.classList.toggle('active', page.id === `tab-${name}`));
}

function downloadCsv() {
  if (!state.commonResult) return;
  const rows = [[
    'Region_ID', 'Length_nt', 'Common_sequence', 'Sequence_name', 'Sequence_length_nt',
    'Hit_number', 'Start_1based', 'End_1based', 'Strand', 'Is_reference'
  ]];
  state.commonResult.regions.forEach((region) => {
    region.occurrences.forEach((occ) => {
      if (!occ.hits.length) {
        rows.push([
          region.id, region.length, region.sequence, occ.name, occ.length,
          '', '', '', '', occ.name === state.commonResult.referenceName ? 'yes' : 'no'
        ]);
        return;
      }
      occ.hits.forEach((hit, hitIndex) => rows.push([
        region.id, region.length, region.sequence, occ.name, occ.length,
        hitIndex + 1, hit.start + 1, hit.end + 1, hit.strand,
        occ.name === state.commonResult.referenceName ? 'yes' : 'no'
      ]));
    });
  });
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'common_regions.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function safeFilePart(value) {
  return String(value || 'alignment').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 80);
}

function downloadTextFile(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadAlignmentFasta() {
  const result = state.alignmentResult;
  if (!result) return;
  const width = 80;
  const lines = [];
  result.alignedSequences.forEach((row) => {
    lines.push(`>${row.name} aligned_length=${result.length}`);
    for (let i = 0; i < row.aligned.length; i += width) lines.push(row.aligned.slice(i, i + width));
  });
  const ref = referenceRowForAlignment(result)?.name || 'alignment';
  downloadTextFile(`${safeFilePart(ref)}_aligned.fasta`, lines.join('\n') + '\n', 'text/plain;charset=utf-8');
}

function downloadAlignmentClustal() {
  const result = state.alignmentResult;
  if (!result) return;
  const width = 60;
  const nameWidth = Math.min(30, Math.max(12, ...result.alignedSequences.map((row) => row.name.length)));
  const lines = ['CLUSTAL W multiple sequence alignment generated by Common Region Explorer v0.1.5', ''];
  for (let start = 0; start < result.length; start += width) {
    const end = Math.min(result.length, start + width);
    result.alignedSequences.forEach((row) => {
      const name = row.name.length > nameWidth ? row.name.slice(0, nameWidth) : row.name;
      lines.push(`${name.padEnd(nameWidth + 2)}${row.aligned.slice(start, end)}`);
    });
    lines.push(`${''.padEnd(nameWidth + 2)}${result.conservation.slice(start, end)}`);
    lines.push('');
  }
  const ref = referenceRowForAlignment(result)?.name || 'alignment';
  downloadTextFile(`${safeFilePart(ref)}_alignment.aln`, lines.join('\n') + '\n', 'text/plain;charset=utf-8');
}

async function readFiles(files) {
  const texts = [];
  for (const file of files) texts.push(await file.text());
  els.sequenceInput.value = texts.join('\n');
  refreshSequences();
}

const sample = `>Human_transcript_A
ATGGCTAACGTTACCGGATCCGATGCTGACCTGATCGTACGTAACTGGAACCTTGGACCTAAGC
>Human_transcript_B
ATGGCTAATGTTACCGGATCCGATGCTGACCTGATCGTACGTAACTGGAACCTTGGACCTTAGC
>Mouse_transcript
ATGGCGAACGTTACCGGATCCGATGCTGACCTGATCGTACGTAACTGGAGCCTTGGACCTAAGC
>Variant_with_insertion
ATGGCTAACGTTACCGGATCCGATGCTGACCTGATCGTACGTAACTGGAAACCTTGGACCTAAGC`;

els.sampleButton.addEventListener('click', () => { els.sequenceInput.value = sample; refreshSequences(); });
els.sequenceInput.addEventListener('input', () => { window.clearTimeout(els.sequenceInput._timer); els.sequenceInput._timer = window.setTimeout(refreshSequences, 250); });
els.treatUasT.addEventListener('change', refreshSequences);
els.fileInput.addEventListener('change', (e) => readFiles(e.target.files));
els.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropZone.classList.add('dragging'); });
els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('dragging'));
els.dropZone.addEventListener('drop', (e) => { e.preventDefault(); els.dropZone.classList.remove('dragging'); readFiles(e.dataTransfer.files); });
els.analyzeButton.addEventListener('click', analyze);
els.alignButton.addEventListener('click', runAlignment);
els.alignmentFastaButton.addEventListener('click', downloadAlignmentFasta);
els.alignmentClustalButton.addEventListener('click', downloadAlignmentClustal);
els.alignmentSearchButton.addEventListener('click', searchAlignmentReference);
els.alignmentSearchClearButton.addEventListener('click', () => clearAlignmentSearch());
els.alignmentSearchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    searchAlignmentReference();
  }
});
els.stopButton.addEventListener('click', () => { if (state.worker) state.worker.terminate(); setBusy(null, false); els.statusMessage.textContent = '処理を中止しました。'; });
els.csvButton.addEventListener('click', downloadCsv);
els.regionSelect.addEventListener('change', renderContext);
els.flankLength.addEventListener('change', renderContext);
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
refreshSequences();
