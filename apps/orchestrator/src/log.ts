const t = () => new Date().toISOString().slice(11, 23);

export const log = {
  info: (...a: unknown[]) => console.log(`[${t()}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${t()}] WARN`, ...a),
  error: (...a: unknown[]) => console.error(`[${t()}] ERR `, ...a),
  call: (callId: string, ...a: unknown[]) => console.log(`[${t()}] [${callId.slice(0, 8)}]`, ...a),
};
