const outputChannel = {
  appendLine: () => {},
  dispose: () => {},
};

export const window = {
  createOutputChannel: () => outputChannel,
  showErrorMessage: () => Promise.resolve(undefined),
  showInformationMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
};

export const workspace = {
  getConfiguration: () => ({ get: () => undefined }),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
};

export const Uri = {
  file: (path: string) => ({ fsPath: path, toString: () => path }),
};

export class EventEmitter<T> {
  private _listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void) => {
    this._listeners.push(listener);
    return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
  };
  fire(e: T): void { this._listeners.forEach(l => l(e)); }
  dispose(): void { this._listeners = []; }
}
