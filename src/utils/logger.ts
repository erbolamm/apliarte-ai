import * as vscode from 'vscode';

const channel = vscode.window.createOutputChannel('Gentle AI Connect');

export const logger = {
  activate(): void {
    // noop — canal ya creado
  },
  info(msg: string): void {
    channel.appendLine(`[INFO] ${msg}`);
  },
  error(msg: string): void {
    channel.appendLine(`[ERROR] ${msg}`);
  },
  warn(msg: string): void {
    channel.appendLine(`[WARN] ${msg}`);
  },
};
