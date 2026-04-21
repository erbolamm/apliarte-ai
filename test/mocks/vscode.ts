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
