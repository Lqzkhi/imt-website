/** Bound actual streamed bytes, including requests without Content-Length. */
export async function readBoundedText(request: Request, maximumBytes: number): Promise<string> {
  if (Number(request.headers.get('content-length')) > maximumBytes) throw new RangeError('Request body is too large.');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new RangeError('Request body is too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
