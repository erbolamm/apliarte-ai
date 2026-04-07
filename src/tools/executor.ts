import * as vscode from 'vscode';
import * as path from 'path';
import { logger } from '../utils/logger';
import type { ToolCall } from '../core/agentService';

/**
 * Tool executor — runs tools LOCALLY in the user's VS Code.
 * The agent backend requests tools, the extension executes them.
 * Files never leave the user's machine without explicit action.
 */

export interface ToolResult {
  tool_call_id: string;
  role: 'tool';
  content: string;
}

/**
 * Execute a tool call and return the result.
 * Shows confirmations for destructive operations (write, terminal).
 */
export async function executeTool(toolCall: ToolCall): Promise<ToolResult> {
  const { id, name, arguments: args } = toolCall;

  logger.info(`Tool call: ${name}(${JSON.stringify(args).slice(0, 100)})`);

  try {
    switch (name) {
      case 'readFile':
        return { tool_call_id: id, role: 'tool', content: await readFile(args.path as string) };

      case 'writeFile': {
        const content = await writeFile(args.path as string, args.content as string);
        return { tool_call_id: id, role: 'tool', content };
      }

      case 'listFiles':
        return {
          tool_call_id: id,
          role: 'tool',
          content: await listFiles(args.path as string, args.recursive as boolean),
        };

      case 'searchCode':
        return {
          tool_call_id: id,
          role: 'tool',
          content: await searchCode(args.query as string, args.path as string | undefined),
        };

      case 'runTerminal': {
        const output = await runTerminal(args.command as string);
        return { tool_call_id: id, role: 'tool', content: output };
      }

      default:
        return { tool_call_id: id, role: 'tool', content: `Unknown tool: ${name}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.info(`Tool error: ${name} → ${msg}`);
    return { tool_call_id: id, role: 'tool', content: `Error: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder open');
  }
  return folders[0].uri.fsPath;
}

function resolveWorkspacePath(relativePath: string): vscode.Uri {
  const root = getWorkspaceRoot();
  const resolved = path.resolve(root, relativePath);
  // Security: ensure the resolved path is within workspace
  if (!resolved.startsWith(root)) {
    throw new Error('Path escapes workspace boundary');
  }
  return vscode.Uri.file(resolved);
}

async function readFile(filePath: string): Promise<string> {
  const uri = resolveWorkspacePath(filePath);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const content = Buffer.from(bytes).toString('utf-8');
  // Truncate very large files
  if (content.length > 50000) {
    return content.slice(0, 50000) + '\n\n[... truncated at 50KB]';
  }
  return content;
}

async function writeFile(filePath: string, content: string): Promise<string> {
  // Ask for confirmation
  const uri = resolveWorkspacePath(filePath);
  const action = await vscode.window.showWarningMessage(
    `El agente quiere escribir en: ${filePath}`,
    { modal: true, detail: `${content.length} caracteres. ¿Permitir?` },
    'Permitir',
    'Ver cambios',
  );

  if (action === 'Ver cambios') {
    // Show diff
    const tempUri = vscode.Uri.parse(`untitled:${filePath}.proposed`);
    const doc = await vscode.workspace.openTextDocument(tempUri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(tempUri, new vscode.Position(0, 0), content);
    await vscode.workspace.applyEdit(edit);
    await vscode.window.showTextDocument(doc, { preview: true });
    return 'User is reviewing changes. File not written yet.';
  }

  if (action !== 'Permitir') {
    return 'User denied write permission.';
  }

  const bytes = Buffer.from(content, 'utf-8');
  await vscode.workspace.fs.writeFile(uri, bytes);
  return `File written: ${filePath} (${content.length} chars)`;
}

async function listFiles(dirPath: string, recursive?: boolean): Promise<string> {
  const root = getWorkspaceRoot();
  const targetDir = dirPath ? resolveWorkspacePath(dirPath) : vscode.Uri.file(root);

  if (recursive) {
    // Use workspace.findFiles for recursive listing
    const pattern = dirPath
      ? new vscode.RelativePattern(targetDir, '**/*')
      : new vscode.RelativePattern(root, '**/*');
    const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 500);
    const relativePaths = files.map((f) => path.relative(root, f.fsPath)).sort();
    return relativePaths.join('\n');
  }

  const entries = await vscode.workspace.fs.readDirectory(targetDir);
  return entries
    .map(([name, type]) => {
      const suffix = type === vscode.FileType.Directory ? '/' : '';
      return `${name}${suffix}`;
    })
    .sort()
    .join('\n');
}

async function searchCode(query: string, dirPath?: string): Promise<string> {
  // Use VS Code's built-in text search
  const root = getWorkspaceRoot();
  const include = dirPath ? new vscode.RelativePattern(resolveWorkspacePath(dirPath), '**/*') : undefined;

  const results: string[] = [];
  const maxResults = 30;

  // textSearchQuery was removed in newer VS Code — use findFiles + readFile fallback
  try {
    // Simple approach: use findFiles and grep through them
    const pattern = include ?? new vscode.RelativePattern(root, '**/*');
    const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 200);

    for (const file of files) {
      if (results.length >= maxResults) break;
      try {
        const bytes = await vscode.workspace.fs.readFile(file);
        const content = Buffer.from(bytes).toString('utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(query)) {
            const rel = path.relative(root, file.fsPath);
            results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 150)}`);
            if (results.length >= maxResults) break;
          }
        }
      } catch {
        // skip binary/unreadable files
      }
    }
  } catch (err) {
    return `Search error: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (results.length === 0) return `No results for "${query}"`;
  return results.join('\n');
}

async function runTerminal(command: string): Promise<string> {
  // Ask for confirmation — terminal commands can be destructive
  const action = await vscode.window.showWarningMessage(
    `El agente quiere ejecutar:`,
    { modal: true, detail: command },
    'Ejecutar',
    'Cancelar',
  );

  if (action !== 'Ejecutar') {
    return 'User denied terminal execution.';
  }

  return new Promise<string>((resolve) => {
    const root = getWorkspaceRoot();

    // Use child_process for capturing output
    const { execFile } = require('child_process') as typeof import('child_process');
    execFile(
      '/bin/sh',
      ['-c', command],
      { cwd: root, maxBuffer: 1024 * 1024, timeout: 30000 },
      (error, stdout, stderr) => {
        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n' : '') + stderr;
        if (error && !output) output = error.message;
        // Truncate output
        if (output.length > 10000) {
          output = output.slice(0, 10000) + '\n[... truncated]';
        }
        resolve(output || '(no output)');
      },
    );
  });
}

/**
 * Collect workspace files for indexing (RAG).
 * Returns file paths + contents for text files under a size limit.
 */
export async function collectWorkspaceFiles(): Promise<Array<{ path: string; content: string }>> {
  const root = getWorkspaceRoot();
  const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 2000);
  const results: Array<{ path: string; content: string }> = [];

  const textExtensions = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
    '.html', '.css', '.scss', '.less', '.vue', '.svelte',
    '.json', '.yaml', '.yml', '.toml', '.xml',
    '.md', '.txt', '.sh', '.bash', '.zsh',
    '.sql', '.graphql', '.prisma',
    '.env', '.gitignore', '.dockerignore',
    'Dockerfile', 'Makefile',
  ]);

  for (const file of files) {
    const ext = path.extname(file.fsPath).toLowerCase();
    const basename = path.basename(file.fsPath);
    if (!textExtensions.has(ext) && !textExtensions.has(basename)) continue;

    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      if (bytes.length > 100000) continue; // Skip files > 100KB
      const content = Buffer.from(bytes).toString('utf-8');
      const relPath = path.relative(root, file.fsPath);
      results.push({ path: relPath, content });
    } catch {
      // skip unreadable
    }
  }

  return results;
}
