import * as vscode from 'vscode';
import * as path from 'path';
import { logger } from '../utils/logger';
import { getToolRegistry } from '../mcp/toolRegistry';
import type { ToolCall } from '../core/agentService';

/**
 * Tool executor — runs tools LOCALLY in the user's VS Code.
 *
 * Routing is delegated to the shared ToolRegistry:
 *   - built-in tools → handlers registered below
 *   - MCP tools      → tools/call via JSON-RPC (when a server manager is wired)
 *
 * Files never leave the user's machine without explicit action.
 */

export interface ToolResult {
  tool_call_id: string;
  role: 'tool';
  content: string;
}

// ---------------------------------------------------------------------------
// Built-in tool definitions (shared schemas and handlers)
// ---------------------------------------------------------------------------

const builtinSpecs = {
  readFile: {
    description: 'Read a text file from the workspace.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to workspace root' } },
      required: ['path'],
    },
  },
  writeFile: {
    description: 'Write content to a file in the workspace. Asks the user for confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to workspace root' },
        content: { type: 'string', description: 'File contents' },
      },
      required: ['path', 'content'],
    },
  },
  listFiles: {
    description: 'List files in a workspace directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory. Empty = workspace root.' },
        recursive: { type: 'boolean', description: 'Recurse into subdirectories' },
      },
    },
  },
  searchCode: {
    description: 'Search for a literal string across workspace files.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal text to search for' },
        path: { type: 'string', description: 'Optional subdirectory to limit the search' },
      },
      required: ['query'],
    },
  },
  runTerminal: {
    description: 'Run a shell command in the workspace. Asks the user for confirmation.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command to execute' } },
      required: ['command'],
    },
  },
  extractSignatures: {
    description: 'Extract function, class, interface and type signatures from a source file. Returns only the declarations (no bodies), reducing context by ~80%.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to workspace root' } },
      required: ['path'],
    },
  },
} as const;

// Register built-ins with the shared registry on module load. Idempotent enough
// — re-registering overwrites with a warning, which is fine for hot reload.
const _registry = getToolRegistry();
_registry.registerBuiltin('readFile', builtinSpecs.readFile, (args) => readFile(args.path as string));
_registry.registerBuiltin('writeFile', builtinSpecs.writeFile, (args) => writeFile(args.path as string, args.content as string));
_registry.registerBuiltin('listFiles', builtinSpecs.listFiles, (args) => listFiles(args.path as string, args.recursive as boolean));
_registry.registerBuiltin('searchCode', builtinSpecs.searchCode, (args) => searchCode(args.query as string, args.path as string | undefined));
_registry.registerBuiltin('runTerminal', builtinSpecs.runTerminal, (args) => runTerminal(args.command as string));
_registry.registerBuiltin('extractSignatures', builtinSpecs.extractSignatures, (args) => extractSignatures(args.path as string));

/**
 * Execute a tool call and return the result.
 * Shows confirmations for destructive operations (write, terminal).
 */
export async function executeTool(toolCall: ToolCall): Promise<ToolResult> {
  const { id, name, arguments: args } = toolCall;

  logger.info(`Tool call: ${name}(${JSON.stringify(args).slice(0, 100)})`);

  try {
    const content = await _registry.execute(name, args as Record<string, unknown>);
    return { tool_call_id: id, role: 'tool', content };
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
  const root = getWorkspaceRoot();
  const searchDir = dirPath ? path.resolve(root, dirPath) : root;

  // Try ripgrep first — respects .gitignore, no noise from node_modules/dist
  try {
    return await _searchRg(query, searchDir, root);
  } catch (rgErr) {
    const isNotFound = (rgErr as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound) {
      // rg ran but query produced no results (exit 1) — treat as empty
      return `No results for "${query}"`;
    }
    // rg not installed — fallback to VS Code findFiles
    logger.info('[searchCode] rg not found, using findFiles fallback');
  }

  // Fallback: findFiles + manual scan (no .gitignore awareness)
  const include = dirPath ? new vscode.RelativePattern(resolveWorkspacePath(dirPath), '**/*') : undefined;
  const pattern = include ?? new vscode.RelativePattern(root, '**/*');
  const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 200);
  const results: string[] = [];

  for (const file of files) {
    if (results.length >= 30) break;
    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      const content = Buffer.from(bytes).toString('utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(query)) {
          results.push(`${path.relative(root, file.fsPath)}:${i + 1}: ${lines[i].trim().slice(0, 150)}`);
          if (results.length >= 30) break;
        }
      }
    } catch { /* skip binary/unreadable */ }
  }

  return results.length === 0 ? `No results for "${query}"` : results.join('\n');
}

function _searchRg(query: string, searchDir: string, workspaceRoot: string): Promise<string> {
  const { execFile } = require('child_process') as typeof import('child_process');
  return new Promise<string>((resolve, reject) => {
    execFile(
      'rg',
      [
        '--line-number',
        '--max-count', '1',        // 1 match per file — context not needed for search
        '--max-columns', '150',
        '--max-filesize', '500K',
        '--smart-case',
        '--',
        query,
        searchDir,
      ],
      { cwd: workspaceRoot, maxBuffer: 512 * 1024, timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) {
          // exit code 1 = no matches (not an error), exit code 2 = real error
          if (error.code === 1) return resolve(`No results for "${query}"`);
          return reject(Object.assign(error, { stderr }));
        }
        const lines = stdout.trim().split('\n').filter(Boolean).slice(0, 50);
        const relative = lines.map((l) => {
          // rg outputs absolute paths when given absolute searchDir
          return l.startsWith(workspaceRoot)
            ? l.slice(workspaceRoot.length + 1)
            : l;
        });
        resolve(relative.length === 0 ? `No results for "${query}"` : relative.join('\n'));
      },
    );
  });
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

const SIGNATURE_PATTERNS: Record<string, RegExp[]> = {
  ts: [
    /^(export\s+)?(default\s+)?(async\s+)?function[\s*]\w+/,
    /^(export\s+)?(abstract\s+)?class\s+\w+/,
    /^(export\s+)?interface\s+\w+/,
    /^(export\s+)?type\s+\w+\s*[=<]/,
    /^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/,
  ],
  js: [
    /^(export\s+)?(default\s+)?(async\s+)?function[\s*]\w+/,
    /^(export\s+)?class\s+\w+/,
    /^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/,
  ],
  py: [
    /^(async\s+)?def\s+\w+/,
    /^class\s+\w+/,
  ],
  go: [
    /^func\s+(\(\w+\s+\*?\w+\)\s+)?\w+/,
    /^type\s+\w+\s+(struct|interface)/,
  ],
  rs: [
    /^(pub(\(\w+\))?\s+)?(async\s+)?fn\s+\w+/,
    /^(pub(\(\w+\))?\s+)?struct\s+\w+/,
    /^(pub(\(\w+\))?\s+)?trait\s+\w+/,
    /^(pub(\(\w+\))?\s+)?enum\s+\w+/,
  ],
};

async function extractSignatures(filePath: string): Promise<string> {
  const root = getWorkspaceRoot();
  const absPath = path.resolve(root, filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const patterns = SIGNATURE_PATTERNS[ext] ?? SIGNATURE_PATTERNS['js'];

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
  } catch {
    return `Cannot read file: ${filePath}`;
  }

  const lines = Buffer.from(bytes).toString('utf-8').split('\n');
  const hits: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (patterns.some(p => p.test(trimmed))) {
      hits.push(`  L${i + 1}: ${trimmed.slice(0, 120)}`);
    }
  }

  if (hits.length === 0) return `No signatures found in ${filePath}`;
  return `${filePath} — ${hits.length} signatures\n${hits.join('\n')}`;
}

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.html', '.css', '.scss', '.less', '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml', '.xml',
  '.md', '.txt', '.sh', '.bash', '.zsh',
  '.sql', '.graphql', '.prisma',
  '.env', '.gitignore', '.dockerignore',
  'Dockerfile', 'Makefile',
]);

async function listWorkspaceFiles(root: string): Promise<string[]> {
  const { execFile } = require('child_process') as typeof import('child_process');
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile('rg', ['--files', '--follow'], { cwd: root, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) { reject(err); return; }
        resolve(stdout);
      });
    });
    return output.split('\n').filter(Boolean).map(f => path.resolve(root, f));
  } catch {
    // rg not available — fallback to findFiles
    const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/dist/**}', 2000);
    return uris.map(u => u.fsPath);
  }
}

/**
 * Collect workspace files for indexing (RAG).
 * Uses rg --files when available (respects .gitignore), falls back to findFiles.
 */
export async function collectWorkspaceFiles(): Promise<Array<{ path: string; content: string }>> {
  const root = getWorkspaceRoot();
  const filePaths = await listWorkspaceFiles(root);
  const results: Array<{ path: string; content: string }> = [];

  for (const fsPath of filePaths) {
    const ext = path.extname(fsPath).toLowerCase();
    const basename = path.basename(fsPath);
    if (!TEXT_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(basename)) continue;

    try {
      const uri = vscode.Uri.file(fsPath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.length > 100000) continue;
      const content = Buffer.from(bytes).toString('utf-8');
      results.push({ path: path.relative(root, fsPath), content });
    } catch {
      // skip unreadable
    }
  }

  return results;
}
