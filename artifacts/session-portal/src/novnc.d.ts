declare module '@novnc/novnc/core/rfb.js' {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: any);
    scaleViewport: boolean;
    resizeSession: boolean;
    addEventListener(event: string, handler: (e: any) => void): void;
    removeEventListener(event: string, handler: (e: any) => void): void;
    disconnect(): void;
  }
}
