// Inline existing callbacks. No extra Promise chain, listener, request or timer.
const MARK = 'KinnshipDeepAsync75';
const emit = (id, stage, extra = '') =>
  `try { globalThis.__kinnshipAsyncStage?.(${id}, '${stage}'${extra}); } catch (_) {}`;
function once(s, needle, replacement) {
  if (s.split(needle).length !== 2) throw new Error(`Deep async source drift: ${needle.slice(0, 90)}`);
  return s.replace(needle, replacement);
}
function xhr(s) {
  if (s.includes(MARK)) return s;
  s = once(s, "let nativeResponseType: NativeResponseType = 'text';",
    `// ${MARK}\n    try { this.__kcAsyncRequest = globalThis.__kinnshipAsyncCurrent?.(); } catch (_) {}
    let nativeResponseType: NativeResponseType = 'text';`);
  for (const [method, stage] of [
    ['__didReceiveResponse(', 'xhr_response_received'],
    ['__didReceiveData(', 'xhr_data_received'],
    ['__didCompleteResponse(', 'xhr_completion_received'],
  ]) {
    const start = s.indexOf('  ' + method);
    if (start < 0) throw Error('XHR hook missing ' + method);
    const branch = s.indexOf('if (requestId === this._requestId) {', start);
    if (branch < 0) throw Error('XHR receipt branch missing');
    const at = branch + 'if (requestId === this._requestId) {'.length;
    s = s.slice(0, at) + '\n      ' + emit('this.__kcAsyncRequest', stage) + s.slice(at);
  }
  return s;
}
function fetch(s) {
  if (s.includes(MARK)) return s;
  s = once(s, 'var xhr = new XMLHttpRequest()', `var xhr = new XMLHttpRequest()
    // ${MARK}
    var kcAsyncRequest;
    try { kcAsyncRequest = globalThis.__kinnshipAsyncCurrent?.(); } catch (_) {}`);
  s = once(s, 'xhr.onload = function() {', `xhr.onload = function() {
      ${emit('kcAsyncRequest', 'fetch_callback_received')}`);
  s = once(s, 'var body = \'response\' in xhr ? xhr.response : xhr.responseText',
    `options.__kcAsyncRequest = kcAsyncRequest;
      ${emit('kcAsyncRequest', 'fetch_callback_scheduled')}
      var body = 'response' in xhr ? xhr.response : xhr.responseText`);
  s = once(s, 'resolve(new Response(body, options))',
    `${emit('kcAsyncRequest', 'fetch_callback_executed')}\n        resolve(new Response(body, options))`);
  s = once(s, 'this.status = options.status === undefined ? 200 : options.status',
    `// ${MARK}: opaque observer metadata only, never a header.
  this.__kcAsyncRequest = options.__kcAsyncRequest;
  this.status = options.status === undefined ? 200 : options.status`);
  s = once(s, 'return this.text().then(JSON.parse)', `var kcId = this.__kcAsyncRequest;
    ${emit('kcId', 'body_read_entered')}
    if (this._bodyBlob) { ${emit('kcId', 'body_type_blob')} }
    else if (this._bodyArrayBuffer) { ${emit('kcId', 'body_type_buffer')} }
    else { ${emit('kcId', 'body_type_text')} }
    try { if (this._bodyBlob) this._bodyBlob.__kcAsyncRequest = kcId; } catch (_) {}
    return this.text().then(function(text) {
      ${emit('kcId', 'body_read_fulfilled')}
      ${emit('kcId', 'json_parse_entered')}
      try {
        var parsed = JSON.parse(text);
        ${emit('kcId', 'json_parse_completed')}
        return parsed;
      } catch (error) {
        ${emit('kcId', 'json_parse_failed')}
        throw error;
      }
    }, function(error) {
      ${emit('kcId', 'body_read_rejected')}
      throw error;
    })`);
  s = once(s, 'reader.readAsText(blob, encoding)', `try { reader.__kcAsyncRequest = blob.__kcAsyncRequest; } catch (_) {}
  reader.readAsText(blob, encoding)`);
  return s;
}
function reader(s) {
  if (s.includes(MARK)) return s;
  s = once(s, 'NativeFileReaderModule.readAsText(blob.data, encoding).then(',
    `// ${MARK}
    ${emit('this.__kcAsyncRequest', 'js_body_read_entered', ', blob.data.blobId')}
    NativeFileReaderModule.readAsText(blob.data, encoding).then(`);
  // Restrict edits to readAsText; other FileReader methods remain untouched.
  const begin = s.indexOf('  readAsText('), end = s.indexOf('\n  abort()', begin);
  let method = s.slice(begin, end < 0 ? undefined : end);
  method = once(method, '(text: string) => {', `(text: string) => {
        ${emit('this.__kcAsyncRequest', 'js_body_read_received')}`);
  method = once(method, 'error => {', `error => {
        ${emit('this.__kcAsyncRequest', 'js_body_read_rejected')}`);
  return s.slice(0, begin) + method + (end < 0 ? '' : s.slice(end));
}
module.exports = { xhr, fetch, reader, MARK };
