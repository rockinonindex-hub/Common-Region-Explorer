'use strict';
importScripts('core.js');

self.onmessage = (event) => {
  const { type, payload } = event.data || {};
  try {
    if (type === 'findCommon') {
      const result = SequenceCore.findCommonRegions(
        payload.sequences,
        payload.options,
        (progress) => self.postMessage({ type: 'progress', task: 'common', progress })
      );
      self.postMessage({ type: 'commonResult', result });
    } else if (type === 'align') {
      const result = SequenceCore.buildStarAlignment(
        payload.sequences,
        payload.referenceIndex,
        payload.options,
        (progress) => self.postMessage({ type: 'progress', task: 'align', progress })
      );
      self.postMessage({ type: 'alignmentResult', result });
    }
  } catch (error) {
    self.postMessage({ type: 'error', task: type, message: error.message || String(error) });
  }
};
