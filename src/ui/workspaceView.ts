import * as vscode from 'vscode';
import * as path from 'path';

const IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'coverage',
  '.turbo', '.cache', '.parcel-cache', 'vendor',
]);

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp', '.cs',
  '.html', '.css', '.scss', '.less', '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml', '.xml',
  '.md', '.txt', '.sh', '.bash', '.zsh',
  '.sql', '.graphql', '.prisma',
  '.env', '.gitignore', '.dockerignore',
  'Dockerfile', 'Makefile',
]);

interface FileNode {
  uri: vscode.Uri;
  name: string;
  isDir: boolean;
}

export class WorkspaceTreeProvider implements vscode.TreeDataProvider<FileNode> {
  private _onDidChange = new vscode.EventEmitter<FileNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private _checked = new Map<string, boolean>();

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getCheckedFiles(): vscode.Uri[] {
    const result: vscode.Uri[] = [];
    for (const [uriStr, on] of this._checked) {
      if (on) result.push(vscode.Uri.parse(uriStr));
    }
    return result;
  }

  toggleCheck(node: FileNode): void {
    const key = node.uri.toString();
    this._checked.set(key, !this._checked.get(key));
    this._onDidChange.fire(node);
  }

  clearChecks(): void {
    this._checked.clear();
    this._onDidChange.fire(undefined);
  }

  getTreeItem(node: FileNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.name,
      node.isDir
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    if (!node.isDir) {
      const checked = this._checked.get(node.uri.toString()) ?? false;
      item.iconPath = new vscode.ThemeIcon(checked ? 'check' : 'circle-outline');
      item.command = {
        command: 'apliarteAi.toggleFile',
        title: 'Toggle',
        arguments: [node],
      };
      item.description = checked ? '✓ seleccionado' : '';
    } else {
      item.iconPath = new vscode.ThemeIcon('folder');
    }

    return item;
  }

  async getChildren(node?: FileNode): Promise<FileNode[]> {
    const uri = node?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!uri) return [];

    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      const children: FileNode[] = [];

      for (const [name, type] of entries) {
        if (name.startsWith('.') && !name.startsWith('.env') && !name.startsWith('.git')) {
          if (IGNORED.has(name)) continue;
        }
        if (IGNORED.has(name)) continue;

        const childUri = vscode.Uri.joinPath(uri, name);
        const isDir = type === vscode.FileType.Directory;

        if (!isDir) {
          const ext = path.extname(name).toLowerCase();
          if (!CODE_EXTS.has(ext) && !CODE_EXTS.has(name)) continue;
        }

        children.push({ uri: childUri, name, isDir });
      }

      return children.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      return [];
    }
  }
}
