import * as vscode from 'vscode';
import { logger } from '../utils/logger';

const DEBOUNCE_MS = 600;
const MAX_TOKENS = 128;
const PREFIX_LINES = 30;
const SUFFIX_LINES = 10;

// FIM tokens for Qwen2.5-Coder and compatible models
const FIM_PREFIX = '<|fim_prefix|>';
const FIM_SUFFIX = '<|fim_suffix|>';
const FIM_MIDDLE = '<|fim_middle|>';

const STOP_TOKENS = ['\n\n', '<|endoftext|>', '<|fim_pad|>', '<|repo_name|>'];

let _debounceTimer: ReturnType<typeof setTimeout> | undefined;
let _lastRequestController: AbortController | undefined;

export function registerInlineCompletionProvider(
  context: vscode.ExtensionContext,
  getEndpoint: () => string | undefined,
  getModel: () => string | undefined,
): void {
  const provider = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    {
      async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _ctx: vscode.InlineCompletionContext,
        token: vscode.CancellationToken,
      ): Promise<vscode.InlineCompletionList | undefined> {
        const cfg = vscode.workspace.getConfiguration('apliarteAi');
        if (!cfg.get<boolean>('inlineCompletion', false)) return;

        const endpoint = getEndpoint();
        if (!endpoint) return;

        // Cancel previous in-flight request
        _lastRequestController?.abort();

        return new Promise((resolve) => {
          clearTimeout(_debounceTimer);

          _debounceTimer = setTimeout(async () => {
            if (token.isCancellationRequested) { resolve(undefined); return; }

            const controller = new AbortController();
            _lastRequestController = controller;
            token.onCancellationRequested(() => controller.abort());

            try {
              const completion = await fetchCompletion(
                endpoint,
                getModel(),
                document,
                position,
                controller.signal,
              );
              if (!completion || token.isCancellationRequested) {
                resolve(undefined);
                return;
              }
              resolve(new vscode.InlineCompletionList([
                new vscode.InlineCompletionItem(completion, new vscode.Range(position, position)),
              ]));
            } catch (err) {
              if ((err as Error)?.name !== 'AbortError') {
                logger.warn(`[inline] ${(err as Error).message}`);
              }
              resolve(undefined);
            }
          }, DEBOUNCE_MS);
        });
      },
    },
  );

  context.subscriptions.push(provider);
  logger.info('[inline] completion provider registered');
}

async function fetchCompletion(
  endpoint: string,
  model: string | undefined,
  document: vscode.TextDocument,
  position: vscode.Position,
  signal: AbortSignal,
): Promise<string | undefined> {
  const startLine = Math.max(0, position.line - PREFIX_LINES);
  const endLine = Math.min(document.lineCount - 1, position.line + SUFFIX_LINES);

  const prefix = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
  const suffix = document.getText(new vscode.Range(position, new vscode.Position(endLine, document.lineAt(endLine).text.length)));

  const prompt = FIM_PREFIX + prefix + FIM_SUFFIX + suffix + FIM_MIDDLE;

  const body: Record<string, unknown> = {
    prompt,
    max_tokens: MAX_TOKENS,
    temperature: 0.15,
    stop: STOP_TOKENS,
    stream: false,
  };
  if (model) body.model = model;

  const url = `${endpoint}/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) return undefined;

  const data = await response.json() as {
    choices?: Array<{ text?: string }>;
  };

  const text = data.choices?.[0]?.text ?? '';
  return text.trimEnd() || undefined;
}
