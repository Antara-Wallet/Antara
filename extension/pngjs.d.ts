// Minimal typing for the pngjs calls vite.extension.config.ts makes (icon resizing).
declare module 'pngjs' {
  class PNG {
    constructor(options?: { width?: number; height?: number });
    width: number;
    height: number;
    data: Buffer;
    static sync: { read(buffer: Buffer): PNG; write(png: PNG): Buffer };
  }
  const pngjs: { PNG: typeof PNG };
  export default pngjs;
}
